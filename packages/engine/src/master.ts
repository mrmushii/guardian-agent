import { and, eq, inArray } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { agentActions, agentSessions, appendAudit, policyCompilations, releaseBudget, transitionAction, userOperations } from "@guardian/db";
import { GUARDIAN_CONFIG, compilePolicy } from "@guardian/policy";
import { readReferencePrices } from "@guardian/oracle";
import { CURRENT_PERMISSION_VERSION, RATE_LIMIT_WITH_RESET, authorizeAgentCalls, buildAgentPermission, encryptSessionKey, revokeAgentCalls, type HexCall } from "@guardian/account";
import type { EngineContext } from "./context.js";
import { loadAccountState } from "./state.js";
import { readPortfolio } from "./portfolio.js";
import { buildPlan, describeTrade, planJson, swapCall } from "./pipeline.js";
import { deserializeOp, prepareMasterOp, serializeOp, submitSignedOp } from "./userops.js";

export type MasterPurpose = "AUTHORIZE" | "REVOKE" | "REBALANCE";

async function storeForSignature(ctx: EngineContext, p: { accountId: string; purpose: MasterPurpose; owner: Address; calls: HexCall[]; actionId?: string; sessionId?: string }) {
  const { op, userOpHash } = await prepareMasterOp(ctx, p.owner, p.calls);
  const [row] = await ctx.db.insert(userOperations).values({
    accountId: p.accountId, actionId: p.actionId ?? null, sessionId: p.sessionId ?? null, authority: "MASTER", purpose: p.purpose,
    nonce: op.nonce.toString(), userOpHash, payload: serializeOp(op), state: "AWAITING_SIGNATURE",
  }).returning();
  return { userOperationId: row!.id, userOpHash };
}

/**
 * "Authorize Guardian": compiles the active policy at the live oracle price, creates a fresh session key
 * (encrypted at rest), and prepares the master batch (bounded approve + install + execute access).
 */
export async function prepareAuthorization(ctx: EngineContext, accountId: string) {
  const st = await loadAccountState(ctx, accountId);
  if (!st.policy || !st.policyRow) throw new Error("No active policy");
  if (st.session && st.session.status !== "PENDING_AUTHORIZATION") throw new Error(`Session already ${st.session.status}; revoke it first`);
  if (st.session) await ctx.db.update(agentSessions).set({ status: "ABANDONED" }).where(eq(agentSessions.id, st.session.id));

  const account = st.account.address as Address;
  const prices = await readReferencePrices(ctx.publicClient, ctx.network);
  const now = new Date();
  const S = GUARDIAN_CONFIG.session;
  const compiled = compilePolicy({ policy: st.policy, authPrice: prices.wethUsd, usdcAuthPrice: prices.usdcUsd, authPriceSource: `chainlink:${prices.wethUsd.feed}`,
    authPriceTimestamp: new Date(prices.wethUsd.updatedAt * 1000), bufferBps: S.bufferBps, usdcBufferBps: S.usdcBufferBps,
    maxOpsPerWindow: S.maxOpsPerWindow, windowSec: S.windowSec, authorizedAt: now });
  const version = CURRENT_PERMISSION_VERSION;
  const pk = generatePrivateKey();
  const signer = privateKeyToAccount(pk);
  const permission = await buildAgentPermission(ctx.publicClient, { network: ctx.network, smartAccount: account,
    sessionSigner: await toECDSASigner({ signer }), compiled, gasAllowanceWei: S.gasAllowanceWei, version });
  const permissionId = permission.getIdentifier();
  const enc = encryptSessionKey(ctx.keyring, pk, account, permissionId);

  const [session] = await ctx.db.insert(agentSessions).values({ accountId, policyId: st.policyRow.id, permissionId, signerAddress: signer.address,
    ...enc, validAfter: compiled.validAfter, validUntil: compiled.validUntil, status: "PENDING_AUTHORIZATION" }).returning();
  const n = ctx.network;
  await ctx.db.insert(policyCompilations).values({
    policyId: st.policyRow.id, sessionId: session!.id, authPriceAnswer: compiled.evidence.authPrice.answer.toString(), authPriceDecimals: compiled.evidence.authPrice.decimals,
    authPriceSource: compiled.evidence.authPriceSource, authPriceTimestamp: compiled.evidence.authPriceTimestamp, bufferBps: compiled.evidence.bufferBps,
    maxAmountInWei: compiled.maxAmountInWei.toString(), maxOps: compiled.maxOps, allowanceWei: compiled.allowanceWei.toString(),
    permissionVersion: version, maxUsdcInRaw: compiled.maxUsdcInRaw.toString(), usdcAllowanceRaw: compiled.usdcAllowanceRaw.toString(), windowSec: compiled.windowSec,
    gasAllowanceWei: S.gasAllowanceWei.toString(),
    restrictions: { target: n.swapRouter02, feeTier: n.feeTier, recipient: account, sqrtPriceLimitX96: "0", paymaster: n.paymaster,
      sell: { selector: "exactInputSingle", tokenIn: n.weth, tokenOut: n.usdc, amountIn: `<= ${compiled.maxAmountInWei}`, amountOutMinimum: "UNCONSTRAINED_ONCHAIN (off-chain check)" },
      buy: { selector: "exactOutputSingle", tokenIn: n.usdc, tokenOut: n.weth, amountInMaximum: `<= ${compiled.maxUsdcInRaw}`, amountOut: "UNCONSTRAINED_ONCHAIN (off-chain check)" },
      rateLimit: { policy: RATE_LIMIT_WITH_RESET, count: compiled.maxOps, intervalSec: compiled.windowSec }, totalOps: compiled.totalOps,
      validAfter: compiled.validAfter.toISOString(), validUntil: compiled.validUntil.toISOString(), kernelExecuteOnly: true },
  });
  const validationNonce = await ctx.publicClient.readContract({ address: account, abi: KernelV3_3AccountAbi, functionName: "currentNonce" });
  const calls = await authorizeAgentCalls(n, account, permission, { weth: compiled.allowanceWei, usdc: compiled.usdcAllowanceRaw }, validationNonce);
  const prepared = await storeForSignature(ctx, { accountId, purpose: "AUTHORIZE", owner: st.account.ownerAddress as Address, calls, sessionId: session!.id });
  await appendAudit(ctx.db, { accountId, type: "AUTHORIZATION_PREPARED", level: "INFO",
    message: `Authorization prepared: sell ≤ ${compiled.maxAmountInWei} wei WETH/op, buy ≤ ${Number(compiled.maxUsdcInRaw) / 1e6} USDC/op, ${compiled.maxOps} ops per ${compiled.windowSec / 3600} h, expires ${compiled.validUntil.toISOString()}`,
    data: { permissionId, signer: signer.address, authPrice: compiled.evidence.authPrice.answer } });
  return { ...prepared, sessionId: session!.id, permissionId, compiled };
}

/** "Revoke Agent": removes execute access, uninstalls the permission, and clears the router allowance. */
export async function prepareRevocation(ctx: EngineContext, accountId: string) {
  const st = await loadAccountState(ctx, accountId);
  if (!st.session || !st.compilation || st.session.status === "PENDING_AUTHORIZATION") throw new Error("No authorized session to revoke");
  const { loadAgent } = await import("./state.js");
  const { permission } = await loadAgent(ctx, st.account, st.session, st.compilation);
  const calls = await revokeAgentCalls(ctx.network, st.account.address as Address, permission, true);
  return storeForSignature(ctx, { accountId, purpose: "REVOKE", owner: st.account.ownerAddress as Address, calls, sessionId: st.session.id });
}

/**
 * Tier 2: revalidate a pending action with fresh balances, prices, and quote, then prepare a master batch.
 * The master temporarily raises the router allowance by exactly amountIn and restores it afterwards,
 * so master execution never widens the agent's allowance.
 */
export async function prepareApproval(ctx: EngineContext, actionId: string) {
  const [action] = await ctx.db.select().from(agentActions).where(eq(agentActions.id, actionId));
  if (!action || !["PENDING_APPROVAL", "MASTER_SIGNING"].includes(action.state)) throw new Error("Action is not awaiting approval");
  await transitionAction(ctx.db, actionId, ["PENDING_APPROVAL", "MASTER_SIGNING"], "REVALIDATING");
  const audit = (type: string, level: "INFO" | "WARNING" | "FAILURE", message: string, data?: unknown) =>
    appendAudit(ctx.db, { accountId: action.accountId, actionId, type, level, message, data });
  const st = await loadAccountState(ctx, action.accountId);
  const account = st.account.address as Address;
  const snap = await readPortfolio(ctx, account, st.policy!);
  if (snap.assessment.kind === "WITHIN_BAND") {
    await transitionAction(ctx.db, actionId, ["REVALIDATING"], "CANCELLED");
    await audit("CANCELLED", "INFO", "Revalidation: portfolio is back inside the band — approval cancelled");
    return { cancelled: true as const };
  }
  const prior = (action.plan as { direction?: string; targetPct?: number } | null) ?? {};
  if (prior.direction && prior.direction !== snap.assessment.kind) {
    await transitionAction(ctx.db, actionId, ["REVALIDATING"], "CANCELLED");
    await audit("CANCELLED", "INFO", "Revalidation: the required trade changed direction — approval cancelled");
    return { cancelled: true as const };
  }
  const plan = await buildPlan(ctx, st, snap, { targetPct: prior.targetPct });
  if (plan.violations.length || plan.risk.classification === "HIGH") {
    await transitionAction(ctx.db, actionId, ["REVALIDATING"], "REJECTED", { plan: planJson(plan) });
    await audit("REJECTED", "FAILURE", `Revalidation rejected: ${[...plan.violations, ...plan.risk.hardGates, plan.risk.classification].join(", ")}`);
    return { cancelled: true as const };
  }
  const tokenIn = plan.direction === "SELL_WETH" ? ctx.network.weth : ctx.network.usdc;
  const allowance = await ctx.publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [account, ctx.network.swapRouter02] });
  const approve = (v: bigint): HexCall => ({ to: tokenIn, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ctx.network.swapRouter02, v] }) });
  const calls = [approve(allowance + plan.amountInRaw), swapCall(ctx, account, plan), approve(allowance)];
  const prepared = await storeForSignature(ctx, { accountId: action.accountId, purpose: "REBALANCE", owner: st.account.ownerAddress as Address, calls, actionId });
  await transitionAction(ctx.db, actionId, ["REVALIDATING"], "MASTER_SIGNING", { plan: planJson(plan, { revalidated: true }), requestedUsdCents: plan.requestedUsdCents });
  await audit("REVALIDATED", "INFO", `Revalidated for master signature: ${describeTrade(plan)}, risk ${plan.risk.score}`);
  return { cancelled: false as const, ...prepared, plan: planJson(plan) };
}

export async function declineApproval(ctx: EngineContext, actionId: string) {
  const row = await transitionAction(ctx.db, actionId, ["PENDING_APPROVAL", "MASTER_SIGNING", "REVALIDATING"], "CANCELLED");
  if (!row) throw new Error("Action is not awaiting approval");
  await releaseBudget(ctx.db, actionId);
  await ctx.db.update(userOperations).set({ state: "ABANDONED" }).where(and(eq(userOperations.actionId, actionId), eq(userOperations.state, "AWAITING_SIGNATURE")));
  await appendAudit(ctx.db, { accountId: row.accountId, actionId, type: "DECLINED", level: "INFO", message: "Owner declined the master approval" });
}

/**
 * Accepts the owner's wallet signature over the exact prepared userOpHash, verifies it recovers the
 * master owner, and submits. The server never holds the master key.
 */
export async function submitMasterSignature(ctx: EngineContext, userOperationId: string, signature: Hex) {
  const [row] = await ctx.db.select().from(userOperations).where(and(eq(userOperations.id, userOperationId), eq(userOperations.state, "AWAITING_SIGNATURE")));
  if (!row) throw new Error("No operation awaiting signature");
  const st = await loadAccountState(ctx, row.accountId);
  const ok = await verifyMessage({ address: st.account.ownerAddress as Address, message: { raw: row.userOpHash as Hex }, signature });
  if (!ok) throw new Error("Signature does not recover the master owner");
  const op = deserializeOp(row.payload as Record<string, unknown>);
  op.signature = signature;
  await ctx.db.update(userOperations).set({ payload: serializeOp(op) }).where(eq(userOperations.id, row.id));
  if (row.actionId) await transitionAction(ctx.db, row.actionId, ["MASTER_SIGNING"], "SUBMITTING");
  const hash = await submitSignedOp(ctx, row.id, op).catch(async (e) => {
    if (row.actionId) await transitionAction(ctx.db, row.actionId, ["SUBMITTING"], "FAILED", { error: (e as Error).message.slice(0, 500) });
    throw e;
  });
  if (row.actionId) await transitionAction(ctx.db, row.actionId, ["SUBMITTING"], "PENDING");
  await appendAudit(ctx.db, { accountId: row.accountId, actionId: row.actionId ?? undefined, type: "MASTER_SUBMITTED", level: "INFO",
    message: `Master-signed ${row.purpose} UserOperation submitted: ${hash}`, data: { userOpHash: hash, authority: "MASTER" } });
  return { userOpHash: hash };
}

/** Pending master items for the dashboard (only rows still awaiting a signature). */
export async function pendingSignatures(ctx: EngineContext, accountId: string) {
  return ctx.db.select({ id: userOperations.id, purpose: userOperations.purpose, userOpHash: userOperations.userOpHash, actionId: userOperations.actionId, createdAt: userOperations.createdAt })
    .from(userOperations).where(and(eq(userOperations.accountId, accountId), inArray(userOperations.state, ["AWAITING_SIGNATURE"])));
}
