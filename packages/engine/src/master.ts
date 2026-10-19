import { and, eq, inArray } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { agentActions, agentSessions, appendAudit, policyCompilations, releaseBudget, transitionAction, userOperations } from "@guardian/db";
import { GUARDIAN_CONFIG, compilePolicy, portfolioTargets } from "@guardian/policy";
import { readReferencePrices } from "@guardian/oracle";
import { CURRENT_PERMISSION_VERSION, KERNEL_EXECUTE_SELECTOR, RATE_LIMIT_WITH_RESET, authorizeAgentCallsMulti, buildAgentPermission, encryptSessionKey, revokeAgentCallsMulti, type AssetGrant, type HexCall } from "@guardian/account";
import type { EngineContext } from "./context.js";
import { loadAccountState, loadAgent, loadSessions } from "./state.js";
import { readPortfolio } from "./portfolio.js";
import { buildPlan, describeTrade, planJson, swapCall, type PlanLeg } from "./pipeline.js";
import { assetBySymbolFor, marketFor } from "./assets.js";
import { multiPortfolio } from "./multi.js";
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
 * "Authorize Guardian": for every tradable asset in the active policy (legacy policy: WETH), compiles that asset's
 * caps at its live oracle price, creates a fresh session key (encrypted at rest), and prepares ONE master batch:
 * bounded approvals, every per-asset permission installed together, and execute() access for each key.
 * Simulated (paper) assets need no on-chain authority and are skipped.
 */
export async function prepareAuthorization(ctx: EngineContext, accountId: string) {
  const st = await loadAccountState(ctx, accountId);
  if (!st.policy || !st.policyRow) throw new Error("No active policy");
  const live = await loadSessions(ctx, accountId);
  // An installed permission (e.g. signing new limits) is replaced in the same owner batch: uninstall first, then install.
  // Uninstalling does not bump the Kernel validation nonce, so the install below stays valid in one UserOperation.
  const replacing = await installedGrants(ctx, st.account, live.filter((x) => x.session.status !== "PENDING_AUTHORIZATION" && x.compilation));
  for (const x of live.filter((x) => x.session.status === "PENDING_AUTHORIZATION")) await ctx.db.update(agentSessions).set({ status: "ABANDONED" }).where(eq(agentSessions.id, x.session.id));

  const account = st.account.address as Address;
  const symbols = portfolioTargets(st.policy).assets.map((a) => a.symbol).filter((s) => s !== "USDC");
  const assets = (await Promise.all(symbols.map((s) => assetBySymbolFor(ctx, accountId, s)))).filter((a) => a.status === "VERIFIED");
  if (!assets.length) throw new Error("None of your assets can trade on this network — simulated assets need no authorization");

  const usdcPrice = (await readReferencePrices(ctx.publicClient, ctx.network)).usdcUsd;
  const now = new Date();
  const S = GUARDIAN_CONFIG.session;
  const version = CURRENT_PERMISSION_VERSION;
  const n = ctx.network;
  const grants: AssetGrant[] = [];
  const created: { asset: string; sessionId: string; permissionId: string; compiled: ReturnType<typeof compilePolicy> }[] = [];
  let usdcAllowance = 0n;
  for (const a of assets) {
    const m = marketFor(ctx, a);
    const authPrice = (await readReferencePrices(m.publicClient, m.network)).wethUsd; // the asset's own USD feed
    const compiled = compilePolicy({ policy: st.policy, authPrice, usdcAuthPrice: usdcPrice, authPriceSource: `chainlink:${authPrice.feed}`,
      authPriceTimestamp: new Date(authPrice.updatedAt * 1000), bufferBps: S.bufferBps, usdcBufferBps: S.usdcBufferBps,
      maxOpsPerWindow: S.maxOpsPerWindow, windowSec: S.windowSec, authorizedAt: now, assetDecimals: a.decimals });
    const pk = generatePrivateKey();
    const signer = privateKeyToAccount(pk);
    const permission = await buildAgentPermission(m.publicClient, { network: m.network, smartAccount: account,
      sessionSigner: await toECDSASigner({ signer }), compiled, gasAllowanceWei: S.gasAllowanceWei, version });
    const permissionId = permission.getIdentifier();
    const enc = encryptSessionKey(ctx.keyring, pk, account, permissionId);
    const [session] = await ctx.db.insert(agentSessions).values({ accountId, asset: a.symbol, policyId: st.policyRow.id, permissionId, signerAddress: signer.address,
      ...enc, validAfter: compiled.validAfter, validUntil: compiled.validUntil, status: "PENDING_AUTHORIZATION" }).returning();
    await ctx.db.insert(policyCompilations).values({
      policyId: st.policyRow.id, sessionId: session!.id, authPriceAnswer: compiled.evidence.authPrice.answer.toString(), authPriceDecimals: compiled.evidence.authPrice.decimals,
      authPriceSource: compiled.evidence.authPriceSource, authPriceTimestamp: compiled.evidence.authPriceTimestamp, bufferBps: compiled.evidence.bufferBps,
      maxAmountInWei: compiled.maxAmountInWei.toString(), maxOps: compiled.maxOps, allowanceWei: compiled.allowanceWei.toString(),
      permissionVersion: version, maxUsdcInRaw: compiled.maxUsdcInRaw.toString(), usdcAllowanceRaw: compiled.usdcAllowanceRaw.toString(), windowSec: compiled.windowSec,
      gasAllowanceWei: S.gasAllowanceWei.toString(),
      restrictions: { asset: a.symbol, decimals: a.decimals, target: n.swapRouter02, feeTier: m.network.feeTier, recipient: account, sqrtPriceLimitX96: "0", paymaster: n.paymaster,
        sell: { selector: "exactInputSingle", tokenIn: m.network.weth, tokenOut: n.usdc, amountIn: `<= ${compiled.maxAmountInWei}`, amountOutMinimum: "UNCONSTRAINED_ONCHAIN (off-chain check)" },
        buy: { selector: "exactOutputSingle", tokenIn: n.usdc, tokenOut: m.network.weth, amountInMaximum: `<= ${compiled.maxUsdcInRaw}`, amountOut: "UNCONSTRAINED_ONCHAIN (off-chain check)" },
        rateLimit: { policy: RATE_LIMIT_WITH_RESET, count: compiled.maxOps, intervalSec: compiled.windowSec }, totalOps: compiled.totalOps,
        validAfter: compiled.validAfter.toISOString(), validUntil: compiled.validUntil.toISOString(), kernelExecuteOnly: true },
    });
    grants.push({ permission, token: m.network.weth, allowance: compiled.allowanceWei });
    usdcAllowance += compiled.usdcAllowanceRaw;
    created.push({ asset: a.symbol, sessionId: session!.id, permissionId, compiled });
  }
  const validationNonce = await ctx.publicClient.readContract({ address: account, abi: KernelV3_3AccountAbi, functionName: "currentNonce" });
  const calls = [...(replacing.length ? await revokeAgentCallsMulti(n, account, replacing) : []), ...(await authorizeAgentCallsMulti(n, account, grants, usdcAllowance, validationNonce))];
  const prepared = await storeForSignature(ctx, { accountId, purpose: "AUTHORIZE", owner: st.account.ownerAddress as Address, calls, sessionId: created[0]!.sessionId });
  await appendAudit(ctx.db, { accountId, type: "AUTHORIZATION_PREPARED", level: "INFO",
    message: `${replacing.length ? "Replacement authorization" : "Authorization"} prepared for ${created.map((x) => x.asset).join(", ")}: ${created.map((x) => `${x.asset} sell ≤ ${x.compiled.maxAmountInWei} raw/op, buy ≤ ${Number(x.compiled.maxUsdcInRaw) / 1e6} USDC/op`).join("; ")}; ${S.maxOpsPerWindow} ops per ${S.windowSec / 3600} h per asset`,
    data: { sessions: created.map((x) => ({ asset: x.asset, permissionId: x.permissionId })) } });
  const first = created[0]!;
  return { ...prepared, sessionId: first.sessionId, permissionId: first.permissionId, compiled: first.compiled, assets: created.map((x) => x.asset) };
}

/** Permissions of these sessions still installed on-chain (execute access granted); uninstalling a missing one would revert the batch. */
async function installedGrants(ctx: EngineContext, account: Awaited<ReturnType<typeof loadAccountState>>["account"], sessions: Awaited<ReturnType<typeof loadSessions>>) {
  const grants: { permission: Awaited<ReturnType<typeof loadAgent>>["permission"]; token: Address }[] = [];
  for (const x of sessions) {
    if (!x.compilation) continue;
    const m = x.session.asset === "WETH" ? ctx : marketFor(ctx, await assetBySymbolFor(ctx, account.id, x.session.asset));
    const vId = `0x02${x.session.permissionId.slice(2).padEnd(40, "0")}` as Hex;
    const installed = await ctx.publicClient.readContract({ address: account.address as Address, abi: KernelV3_3AccountAbi, functionName: "isAllowedSelector", args: [vId, KERNEL_EXECUTE_SELECTOR] });
    if (!installed) continue;
    const { permission } = await loadAgent(m, account, x.session, x.compilation);
    grants.push({ permission, token: m.network.weth });
  }
  return grants;
}

/** "Revoke Agent": removes execute access and uninstalls every per-asset permission, clearing each router allowance. */
export async function prepareRevocation(ctx: EngineContext, accountId: string) {
  const st = await loadAccountState(ctx, accountId);
  const live = (await loadSessions(ctx, accountId)).filter((x) => x.session.status !== "PENDING_AUTHORIZATION" && x.compilation);
  if (!live.length) throw new Error("No authorized session to revoke");
  const grants = await installedGrants(ctx, st.account, live);
  if (!grants.length) throw new Error("The agent permission is no longer installed on-chain — nothing to revoke");
  const calls = await revokeAgentCallsMulti(ctx.network, st.account.address as Address, grants);
  return storeForSignature(ctx, { accountId, purpose: "REVOKE", owner: st.account.ownerAddress as Address, calls, sessionId: live[0]!.session.id });
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
  let st = await loadAccountState(ctx, action.accountId);
  const account = st.account.address as Address;
  const prior = (action.plan as { direction?: string; targetPct?: number; asset?: string } | null) ?? {};
  const cancel = async (why: string) => {
    await transitionAction(ctx.db, actionId, ["REVALIDATING"], "CANCELLED");
    await audit("CANCELLED", "INFO", `Revalidation: ${why} — approval cancelled`);
    return { cancelled: true as const };
  };
  // Multi-asset leg: re-plan the whole portfolio and take this asset's fresh leg in its own market.
  let c = ctx, legOpts: { leg?: PlanLeg; decimals?: number } = {}, symbol = "WETH";
  if (prior.asset && st.policy && portfolioTargets(st.policy).multi) {
    const mp = await multiPortfolio(ctx, action.accountId, account, st.policy);
    const leg = mp.assessment.drifted ? mp.assessment.legs.find((l) => l.symbol === prior.asset) : undefined;
    if (!leg) return cancel(`${prior.asset} is back inside its drift band`);
    if ((leg.side === "SELL" ? "SELL_WETH" : "BUY_WETH") !== prior.direction) return cancel("the required trade changed direction");
    const asset = mp.rows.find((r) => r.symbol === leg.symbol)!;
    symbol = asset.symbol;
    st = { ...(await loadAccountState(ctx, action.accountId, asset.symbol)), policy: st.policy, policyRow: st.policyRow };
    c = marketFor(ctx, asset);
    legOpts = { leg: { side: leg.side, usdCents: leg.usdCents, targetPct: leg.targetPct }, decimals: asset.decimals };
  }
  const snap = await readPortfolio(c, account, st.policy!);
  if (!legOpts.leg) {
    if (snap.assessment.kind === "WITHIN_BAND") return cancel("portfolio is back inside the band");
    if (prior.direction && prior.direction !== snap.assessment.kind) return cancel("the required trade changed direction");
  }
  const plan = await buildPlan(c, st, snap, legOpts.leg ? legOpts : { targetPct: prior.targetPct });
  if (plan.violations.length || plan.risk.classification === "HIGH") {
    await transitionAction(ctx.db, actionId, ["REVALIDATING"], "REJECTED", { plan: planJson(plan) });
    await audit("REJECTED", "FAILURE", `Revalidation rejected: ${[...plan.violations, ...plan.risk.hardGates, plan.risk.classification].join(", ")}`);
    return { cancelled: true as const };
  }
  const tokenIn = plan.direction === "SELL_WETH" ? c.network.weth : c.network.usdc;
  const allowance = await ctx.publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [account, c.network.swapRouter02] });
  const approve = (v: bigint): HexCall => ({ to: tokenIn, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.network.swapRouter02, v] }) });
  const calls = [approve(allowance + plan.amountInRaw), swapCall(c, account, plan), approve(allowance)];
  const prepared = await storeForSignature(ctx, { accountId: action.accountId, purpose: "REBALANCE", owner: st.account.ownerAddress as Address, calls, actionId });
  const extra = legOpts.leg ? { revalidated: true, asset: symbol, decimals: legOpts.decimals } : { revalidated: true };
  await transitionAction(ctx.db, actionId, ["REVALIDATING"], "MASTER_SIGNING", { plan: planJson(plan, extra), requestedUsdCents: plan.requestedUsdCents });
  await audit("REVALIDATED", "INFO", `Revalidated for master signature: ${describeTrade(plan, symbol, legOpts.decimals)}, risk ${plan.risk.score}`);
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
