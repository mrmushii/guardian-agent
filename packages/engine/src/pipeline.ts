import { eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { agentActions, agentSessions, appendAudit, claimAction, dailyUsedCents, inCooldown, releaseBudget, reserveBudget,
  securityEvents, smartAccounts, transitionAction, userOperations, type AuditLevel } from "@guardian/db";
import { decideWithFallback, type AgentContext } from "@guardian/agent";
import { quoteWethToUsdc, minOutFromQuote } from "@guardian/dex";
import { assessRisk } from "@guardian/risk";
import { GUARDIAN_CONFIG, NETWORK_RISK, reauthRequired, routeAuthority, usdToCents, type Tier } from "@guardian/policy";
import { createSponsoredClient, swapRouterAbi } from "@guardian/account";
import { simulateHandleOps } from "@guardian/simulation";
import type { UserOperation } from "viem/account-abstraction";
import type { EngineContext } from "./context.js";
import { compiledFromRow, loadAccountState, loadAgent, sessionStatus } from "./state.js";
import { fmtBps, fmtUsd18, readPortfolio, usd18ToCents, type PortfolioSnapshot } from "./portfolio.js";
import { BundlerRejection, bundler, explorerTx, opHash, recordReceipt, serializeOp, submitSignedOp } from "./userops.js";

export interface Trigger { key: string; kind: string; detail: string; block?: bigint; userMessage?: string }

const PRE_SUBMIT = ["TRIGGERED", "PLANNING", "SIMULATING"] as const;

export const swapCall = (ctx: EngineContext, account: Address, amountIn: bigint, minOut: bigint) => ({
  to: ctx.network.swapRouter02, value: 0n,
  data: encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInputSingle", args: [{
    tokenIn: ctx.network.weth, tokenOut: ctx.network.usdc, fee: ctx.network.feeTier, recipient: account,
    amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }) as Hex,
});

const pct = (bps: bigint) => `${fmtBps(bps)}%`;

/** Deterministic plan shared by Tier 1 and Tier 2 (the authority path never changes the amount). */
export async function buildPlan(ctx: EngineContext, st: Awaited<ReturnType<typeof loadAccountState>>, snap: PortfolioSnapshot) {
  if (snap.assessment.kind !== "SELL_WETH") throw new Error("buildPlan requires a SELL_WETH assessment");
  const policy = st.policy!;
  const { amountInWei, saleUsd18 } = snap.assessment;
  const requestedUsdCents = usd18ToCents(saleUsd18);
  const quote = await quoteWethToUsdc(ctx.publicClient, ctx.network, amountInWei);
  const minOut = minOutFromQuote(quote.amountOutRaw, policy.maxSlippageBps);
  const dailyBudgetUsdCents = usdToCents(policy.dailyBudgetUsd);
  const risk = assessRisk({
    amountInWei, quoteOutRaw: quote.amountOutRaw, poolWethReserve: quote.poolWethReserve,
    wethUsd: snap.prices.wethUsd, usdcUsd: snap.prices.usdcUsd, requestedUsdCents, dailyBudgetUsdCents,
    maxDivergenceBps: NETWORK_RISK[ctx.chain.id]!.maxDivergenceBps,
  });
  const violations: string[] = [];
  if (amountInWei <= 0n) violations.push("NON_POSITIVE_AMOUNT");
  if (amountInWei > snap.wethWei) violations.push("AMOUNT_EXCEEDS_BALANCE");
  if (minOut <= 0n) violations.push("ZERO_MIN_OUTPUT");
  return { amountInWei, saleUsd18, requestedUsdCents, quote, minOut, risk, violations, dailyBudgetUsdCents };
}
export type Plan = Awaited<ReturnType<typeof buildPlan>>;

export const planJson = (p: Plan, extra: Record<string, unknown> = {}) => JSON.parse(JSON.stringify({
  amountInWei: p.amountInWei, saleUsd: fmtUsd18(p.saleUsd18), requestedUsdCents: p.requestedUsdCents,
  quote: { amountOutRaw: p.quote.amountOutRaw, block: p.quote.blockNumber, pool: p.quote.pool, feeTier: p.quote.feeTier, quotedAt: p.quote.quotedAt },
  minOutRaw: p.minOut, risk: p.risk, violations: p.violations, ...extra,
}, (_, v) => (typeof v === "bigint" ? `${v}` : v)));

/**
 * One rebalance attempt for one trigger. Holds the per-account lock from claim until a terminal state;
 * PENDING_APPROVAL and uncertain submissions keep it.
 */
export async function runRebalance(ctx: EngineContext, accountId: string, trigger: Trigger) {
  const st = await loadAccountState(ctx, accountId);
  if (!st.policy || !st.policyRow) return { skipped: "NO_ACTIVE_POLICY" };
  if (!st.account.monitoringEnabled) return { skipped: "PAUSED" };
  if (await inCooldown(ctx.db, accountId)) return { skipped: "COOLDOWN" };
  const action = await claimAction(ctx.db, { accountId, policyId: st.policyRow.id, sessionId: st.session?.id, triggerKey: trigger.key,
    trigger: { kind: trigger.kind, detail: trigger.detail, block: trigger.block?.toString() }, triggerBlock: trigger.block });
  if (!action) return { skipped: "LOCKED_OR_DUPLICATE" };

  const audit = (type: string, level: AuditLevel, message: string, data?: unknown) =>
    appendAudit(ctx.db, { accountId, actionId: action.id, type, level, message, data });
  const finish = async (from: readonly string[], to: string, level: AuditLevel, message: string, patch = {}) => {
    await transitionAction(ctx.db, action.id, from, to, patch);
    await audit(to, level, message);
    return { actionId: action.id, state: to };
  };
  const account = st.account.address as Address;
  const testnetNote = ctx.network.isTestnet ? " [TESTNET_PRICING: pools not market-representative]" : "";

  try {
    await audit("TRIGGER_DETECTED", "INFO", trigger.detail, { kind: trigger.kind, block: trigger.block });
    await transitionAction(ctx.db, action.id, ["TRIGGERED"], "PLANNING");

    const snap = await readPortfolio(ctx, account, st.policy);
    const v = snap.assessment.valuation;
    await audit("ALLOCATION", "INFO", `Allocation: ${pct(v.wethWeightBps)} WETH; band ${st.policy.ethMinPct}–${st.policy.ethMaxPct}%`, {
      block: snap.blockNumber, wethWei: snap.wethWei, usdcRaw: snap.usdcRaw, wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18),
      oracle: { ethUsd: snap.prices.wethUsd.answer, ethUsdAgeSec: snap.prices.wethUsd.ageSec, usdcUsd: snap.prices.usdcUsd.answer } });
    if (snap.assessment.kind !== "SELL_WETH") {
      return finish(["PLANNING"], "NO_ACTION", "INFO", snap.assessment.kind === "UNDERWEIGHT_NO_EXECUTION"
        ? "WETH below minimum; reverse swaps are outside the MVP — no execution" : "Allocation within band — no action");
    }

    // AI proposes intent only; deterministic code owns amounts, addresses, calldata, and authority.
    if (!ctx.models.length) throw Object.assign(new Error("No LLM provider configured"), { code: "AI_UNAVAILABLE" });
    const agentCtx: AgentContext = {
      trigger: { kind: trigger.kind, detail: trigger.detail },
      portfolio: { wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18), totalUsd: fmtUsd18(v.totalUsd18), wethWeightPct: fmtBps(v.wethWeightBps) },
      policy: { ethMinPct: st.policy.ethMinPct, ethMaxPct: st.policy.ethMaxPct, targetEthPct: st.policy.targetEthPct, maxAutoTxUsd: st.policy.maxAutoTxUsd, dailyBudgetUsd: st.policy.dailyBudgetUsd },
      recentOutcomes: [], ...(trigger.userMessage ? { userMessage: trigger.userMessage } : {}),
    };
    const ai = await decideWithFallback(ctx.models, agentCtx, st.policy.targetEthPct);
    if (!ai.ok) {
      await ctx.db.update(smartAccounts).set({ monitoringEnabled: false, pausedReason: "AI_UNAVAILABLE_OR_INVALID" }).where(eq(smartAccounts.id, accountId));
      await audit("AI_UNAVAILABLE", "FAILURE", "No valid AI decision — new autonomous actions paused (fail closed)", { errors: ai.errors });
      return finish(["PLANNING"], "FAILED", "FAILURE", "Action stopped: AI decision unavailable", { error: ai.errors.join(" | ").slice(0, 1000) });
    }
    await transitionAction(ctx.db, action.id, ["PLANNING"], "PLANNING", { decision: ai.decision });
    await audit("AI_DECISION", "INFO", `AI decision: ${ai.decision.decision} — ${ai.decision.reason}`, { provider: ai.provider, decision: ai.decision, fallbackErrors: ai.errors });
    if (ai.decision.decision === "WAIT" || ai.decision.decision === "NO_ACTION") {
      return finish(["PLANNING"], ai.decision.decision, "INFO", `Agent chose ${ai.decision.decision}`);
    }

    const plan = await buildPlan(ctx, st, snap);
    await audit("PLAN", "INFO", `Target: ${st.policy.targetEthPct}%; required sale ≈ $${fmtUsd18(plan.saleUsd18)} (${plan.amountInWei} wei WETH)`);
    await audit("QUOTE", "INFO", `Quote: ${Number(plan.quote.amountOutRaw) / 1e6} USDC; minimum output ${Number(plan.minOut) / 1e6} USDC (${st.policy.maxSlippageBps} bps)${testnetNote}`,
      { block: plan.quote.blockNumber, pool: plan.quote.pool, feeTier: plan.quote.feeTier });
    await audit("RISK", plan.risk.classification === "LOW" ? "INFO" : "WARNING",
      `Risk ${plan.risk.score} (${plan.risk.classification}); divergence ${(plan.risk.divergenceBps / 100).toFixed(2)}%${plan.risk.hardGates.length ? `; gates: ${plan.risk.hardGates.join(", ")}` : ""}`, plan.risk);

    // Session usability, including D3 reauthorization on price rise.
    let status = await sessionStatus(ctx, st.account, st.session, st.compilation);
    if (status === "ACTIVE" && st.compilation && reauthRequired(BigInt(st.compilation.authPriceAnswer), snap.prices.wethUsd.answer, GUARDIAN_CONFIG.reauthPriceRiseBps)) {
      await ctx.db.update(agentSessions).set({ status: "REAUTH_REQUIRED" }).where(eq(agentSessions.id, st.session!.id));
      await audit("SESSION_REAUTH_REQUIRED", "WARNING", "WETH price rose ≥10% since authorization — owner must reauthorize the agent");
      status = "REAUTH_REQUIRED";
    }
    const compiled = st.compilation ? compiledFromRow(st.compilation) : null;
    const used = await dailyUsedCents(ctx.db, accountId);
    const route = routeAuthority({
      violations: plan.violations, riskClass: plan.risk.classification, hardGates: plan.risk.hardGates,
      requestedUsdCents: plan.requestedUsdCents, maxAutoTxUsdCents: usdToCents(st.policy.maxAutoTxUsd),
      dailyUsedUsdCents: used, dailyBudgetUsdCents: plan.dailyBudgetUsdCents,
      amountInWei: plan.amountInWei, compiledMaxAmountInWei: compiled?.maxAmountInWei ?? 0n, sessionStatus: status,
    });
    let tier: Tier = route.tier;
    const reasons = [...route.reasons];
    if (ai.decision.decision === "ESCALATE" && tier === "TIER1_AGENT") { tier = "TIER2_MASTER"; reasons.splice(0, reasons.length, "AI_ESCALATED"); }
    await transitionAction(ctx.db, action.id, ["PLANNING"], "PLANNING", { tier, reasons, plan: planJson(plan), requestedUsdCents: plan.requestedUsdCents });
    await audit("ROUTING", tier === "TIER3_REJECT" ? "FAILURE" : "INFO", `Authority: ${tier} — ${reasons.join(", ")}`, { tier, reasons, dailyUsedUsdCents: used, sessionStatus: status });

    if (tier === "TIER3_REJECT") {
      await ctx.db.insert(securityEvents).values({ accountId, kind: "PROHIBITED_ACTION", reason: reasons.join(", "), source: "APPLICATION", evidence: { actionId: action.id } });
      return finish(["PLANNING"], "REJECTED", "FAILURE", "Rejected by deterministic policy (Tier 3)");
    }
    if (tier === "TIER2_MASTER") return finish(["PLANNING"], "PENDING_APPROVAL", "WARNING", "Awaiting master approval (Tier 2)");

    // ---- Tier 1: reserve autonomous budget atomically, simulate, sign with the session, submit ----
    const reservation = await reserveBudget(ctx.db, { accountId, actionId: action.id, cents: plan.requestedUsdCents, budgetCents: plan.dailyBudgetUsdCents });
    if (!reservation.ok) {
      await transitionAction(ctx.db, action.id, ["PLANNING"], "PLANNING", { tier: "TIER2_MASTER", reasons: ["DAILY_BUDGET_EXCEEDED"] });
      return finish(["PLANNING"], "PENDING_APPROVAL", "WARNING", "Daily budget reached concurrently — awaiting master approval (Tier 2)");
    }
    await transitionAction(ctx.db, action.id, ["PLANNING"], "SIMULATING");
    const { agentAccount } = await loadAgent(ctx, st.account, st.session!, st.compilation!);
    const client = createSponsoredClient(agentAccount, ctx.chain, ctx.publicClient, ctx.pimlicoApiKey);
    const call = swapCall(ctx, account, plan.amountInWei, plan.minOut);
    // Bundler estimation runs full validation (permissions included) without broadcasting.
    const op = (await client.prepareUserOperation({ calls: [call] })) as UserOperation<"0.7">;
    op.signature = await agentAccount.signUserOperation(op);
    const [sim] = await simulateHandleOps(ctx.publicClient, { beneficiary: account, blocks: [{ steps: [{ kind: "userop", label: "rebalance", op }] }], watchTokens: [ctx.network.usdc] });
    const received = (sim?.tokenTransfers ?? []).filter((t) => t.to.toLowerCase() === account.toLowerCase()).reduce((a, t) => a + t.value, 0n);
    if (sim?.result !== "EXECUTED_SUCCESS" || received < plan.minOut) {
      await releaseBudget(ctx.db, action.id);
      return finish(PRE_SUBMIT, "FAILED", "FAILURE", `Simulation failed: ${sim?.result} ${sim?.detail ?? ""}`.trim(), { error: sim?.detail });
    }
    await audit("SIMULATION_PASSED", "SUCCESS", `Simulation passed; predicted ${Number(received) / 1e6} USDC ≥ minimum ${Number(plan.minOut) / 1e6}`);

    // Persist intent before external submission (architecture §10).
    const [row] = await ctx.db.insert(userOperations).values({ actionId: action.id, accountId, sessionId: st.session!.id, authority: "AGENT_SESSION",
      purpose: "REBALANCE", nonce: op.nonce.toString(), userOpHash: opHash(ctx, op), payload: serializeOp(op), state: "INTENT" }).returning();
    await transitionAction(ctx.db, action.id, ["SIMULATING"], "SUBMITTING");
    await audit("SESSION_VALIDATED", "SUCCESS", "Tier 1 authority: restricted session signer; permission validated by bundler simulation", { permissionId: st.session!.permissionId, signer: st.session!.signerAddress });
    let hash: Hex;
    try {
      hash = await submitSignedOp(ctx, row!.id, op);
    } catch (e) {
      if (e instanceof BundlerRejection) {
        await releaseBudget(ctx.db, action.id);
        await ctx.db.insert(securityEvents).values({ accountId, kind: "BUNDLER_REJECTION", reason: e.message, source: "BUNDLER", evidence: { userOperationId: row!.id } });
        return finish(["SUBMITTING"], "FAILED", "FAILURE", `Bundler rejected the UserOperation (no transaction broadcast): ${e.message}`);
      }
      await transitionAction(ctx.db, action.id, ["SUBMITTING"], "PENDING", { error: "SUBMISSION_OUTCOME_UNKNOWN" });
      await audit("SUBMISSION_UNKNOWN", "WARNING", "Submission outcome unknown — lock held until reconciled");
      return { actionId: action.id, state: "PENDING" };
    }
    await transitionAction(ctx.db, action.id, ["SUBMITTING"], "PENDING");
    await audit("SUBMITTED", "INFO", `UserOperation submitted: ${hash}`, { userOpHash: hash });
    try {
      const receipt = await bundler(ctx).waitForUserOperationReceipt({ hash, timeout: 90_000 });
      await finalizeRebalance(ctx, action.id, row!.id, receipt);
    } catch {
      await audit("RECEIPT_PENDING", "INFO", "Receipt not yet available — the reconciler will finalize");
    }
    return { actionId: action.id, state: "PENDING" };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "ERROR";
    await releaseBudget(ctx.db, action.id);
    await transitionAction(ctx.db, action.id, PRE_SUBMIT, "FAILED", { error: `${code}: ${(e as Error).message}`.slice(0, 1000) });
    await audit("FAILED", "FAILURE", `Action failed closed (${code}): ${(e as Error).message.split("\n")[0]}`);
    return { actionId: action.id, state: "FAILED" };
  }
}

/** Receipt → outcome. Execution failure (included, success=false) is distinct from authorization failure. */
export async function finalizeRebalance(ctx: EngineContext, actionId: string, userOperationId: string,
  receipt: Awaited<ReturnType<ReturnType<typeof bundler>["getUserOperationReceipt"]>>) {
  const [action] = await ctx.db.select().from(agentActions).where(eq(agentActions.id, actionId));
  if (!action) return;
  const st = await loadAccountState(ctx, action.accountId);
  const account = st.account.address as Address;
  const [weth, usdc] = await Promise.all([
    ctx.publicClient.readContract({ address: ctx.network.weth, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    ctx.publicClient.readContract({ address: ctx.network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  ]);
  await recordReceipt(ctx, userOperationId, receipt, { balancesAfter: { wethWei: weth, usdcRaw: usdc } });
  const audit = (type: string, level: AuditLevel, message: string, data?: unknown) => appendAudit(ctx.db, { accountId: action.accountId, actionId, type, level, message, data });
  const evidence = { userOpHash: receipt.userOpHash, transactionHash: receipt.receipt.transactionHash, block: receipt.receipt.blockNumber, explorer: explorerTx(ctx, receipt.receipt.transactionHash) };
  // Only the caller that wins the state transition records the outcome (pipeline wait and reconciler may race).
  if (!receipt.success) {
    const won = await transitionAction(ctx.db, actionId, ["PENDING", "SUBMITTING"], "EXECUTION_FAILED", { error: receipt.reason ?? "UserOperation execution reverted" });
    if (!won) return;
    await releaseBudget(ctx.db, actionId);
    await audit("EXECUTION_FAILED", "FAILURE", "Included, but swap execution reverted (not an authorization failure)", { ...evidence, reason: receipt.reason });
    return;
  }
  let allocation = "";
  try { if (st.policy) { const snap = await readPortfolio(ctx, account, st.policy); allocation = ` allocation now ${pct(snap.assessment.valuation.wethWeightBps)} WETH`; } } catch { /* valuation unavailable; receipt still recorded */ }
  const won = await transitionAction(ctx.db, actionId, ["PENDING", "SUBMITTING"], "CONFIRMED", { cooldownUntil: new Date(Date.now() + GUARDIAN_CONFIG.cooldownSec * 1000) });
  if (!won) return;
  await audit("CONFIRMED", "SUCCESS", `Confirmed in block ${receipt.receipt.blockNumber};${allocation}`, evidence);
}
