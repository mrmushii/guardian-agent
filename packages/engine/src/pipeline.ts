import { and, desc, eq, ne } from "drizzle-orm";
import { encodeFunctionData, formatGwei, type Address, type Hex } from "viem";
import { agentActions, agentSessions, appendAudit, claimAction, dailyUsedCents, inCooldown, releaseBudget, reserveBudget,
  securityEvents, smartAccounts, transitionAction, userOperations, type AuditLevel } from "@guardian/db";
import { DETERMINISTIC_FALLBACK, decideWithFallback, deterministicDecision, type AgentContext, type AgentDecision } from "@guardian/agent";
import { maxInFromQuote, minOutFromQuote, quoteUsdcToWeth, quoteWethToUsdc, type SwapQuote } from "@guardian/dex";
import { recentMove } from "@guardian/oracle";
import { assessRebalance, type TradeDirection } from "@guardian/portfolio";
import { assessRisk } from "@guardian/risk";
import { GUARDIAN_CONFIG, NETWORK_RISK, USDC_DECIMALS, WETH_DECIMALS, applyAgentStance, partialStepAllowed, reauthRequired, routeAuthority, usdToCents,
  type RoutingDecision, type SessionStatus, type UsdPrice } from "@guardian/policy";
import { createSponsoredClient, swapRouterAbi } from "@guardian/account";
import { simulateHandleOps } from "@guardian/simulation";
import type { UserOperation } from "viem/account-abstraction";
import type { EngineContext } from "./context.js";
import { compiledFromRow, isTwoWay, loadAccountState, loadAgent, sessionStatus } from "./state.js";
import { fmtBps, fmtUsd18, readPortfolio, usd18ToCents, type PortfolioSnapshot } from "./portfolio.js";
import { BundlerRejection, bundler, explorerTx, opHash, recordReceipt, serializeOp, submitSignedOp } from "./userops.js";

export interface Trigger { key: string; kind: string; detail: string; block?: bigint; userMessage?: string }
type AccountState = Awaited<ReturnType<typeof loadAccountState>>;

const PRE_SUBMIT = ["TRIGGERED", "PLANNING", "SIMULATING"] as const;
const USD18 = 10n ** 18n;

const pct = (bps: bigint) => `${fmtBps(bps)}%`;
const usd18ToToken = (usd18: bigint, price: UsdPrice, decimals: number) => (usd18 * 10n ** BigInt(decimals + price.decimals)) / (price.answer * USD18);
const tokenToUsd18 = (raw: bigint, price: UsdPrice, decimals: number) => (raw * price.answer * USD18) / 10n ** BigInt(decimals + price.decimals);
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/**
 * Deterministic plan shared by Tier 1 and Tier 2 (the authority path never changes the amount it is given).
 * `targetPct` is the WETH weight to move to (the agent may pick any whole percent inside the band).
 * `clamp` sizes the trade to the autonomous limits (partial step, E7): one cent under the USD cap and the on-chain cap.
 */
export async function buildPlan(ctx: EngineContext, st: AccountState, snap: PortfolioSnapshot, opts: { targetPct?: number; clamp?: boolean } = {}) {
  const policy = st.policy!;
  const { wethUsd, usdcUsd } = snap.prices;
  const a = assessRebalance({ wethWei: snap.wethWei, usdcRaw: snap.usdcRaw, wethUsd, usdcUsd }, policy, opts.targetPct ?? policy.targetEthPct);
  if (a.kind === "WITHIN_BAND") throw new Error("buildPlan requires an out-of-band assessment");
  const compiled = st.compilation ? compiledFromRow(st.compilation) : null;
  const clamp = !!opts.clamp && !!compiled;
  const capUsd18 = (usdToCents(policy.maxAutoTxUsd) - 1n) * 10n ** 16n;
  const violations: string[] = [];
  let quote: SwapQuote, amountInRaw: bigint, compiledMaxInRaw: bigint, limitRaw: bigint, tradeUsd18: bigint;

  if (a.kind === "SELL_WETH") {
    const amountIn = clamp ? min(a.amountInWei, compiled!.maxAmountInWei, usd18ToToken(capUsd18, wethUsd, WETH_DECIMALS)) : a.amountInWei;
    if (amountIn <= 0n) throw Object.assign(new Error("Planned sale rounds to zero"), { code: "NON_POSITIVE_AMOUNT" });
    quote = await quoteWethToUsdc(ctx.publicClient, ctx.network, amountIn);
    limitRaw = minOutFromQuote(quote.usdcRaw, policy.maxSlippageBps);       // amountOutMinimum
    amountInRaw = amountIn;
    compiledMaxInRaw = compiled?.maxAmountInWei ?? 0n;
    tradeUsd18 = tokenToUsd18(amountIn, wethUsd, WETH_DECIMALS);
    if (amountIn > snap.wethWei) violations.push("AMOUNT_EXCEEDS_BALANCE");
    if (limitRaw <= 0n) violations.push("ZERO_MIN_OUTPUT");
  } else {
    let wethOut = clamp ? min(a.wethOutWei, usd18ToToken(capUsd18, wethUsd, WETH_DECIMALS)) : a.wethOutWei;
    if (wethOut <= 0n) throw Object.assign(new Error("Planned purchase rounds to zero"), { code: "NON_POSITIVE_AMOUNT" });
    quote = await quoteUsdcToWeth(ctx.publicClient, ctx.network, wethOut);
    let maxIn = maxInFromQuote(quote.usdcRaw, policy.maxSlippageBps);
    if (clamp) {
      // The buy spends USDC: scale the WETH output until the worst-case spend fits both caps.
      const usdcCap = min(compiled!.maxUsdcInRaw > 0n ? compiled!.maxUsdcInRaw : 0n, usd18ToToken(capUsd18, usdcUsd, USDC_DECIMALS));
      for (let i = 0; i < 3 && maxIn > usdcCap && usdcCap > 0n; i++) {
        wethOut = (wethOut * usdcCap * 999n) / (maxIn * 1_000n);
        if (wethOut <= 0n) break;
        quote = await quoteUsdcToWeth(ctx.publicClient, ctx.network, wethOut);
        maxIn = maxInFromQuote(quote.usdcRaw, policy.maxSlippageBps);
      }
    }
    limitRaw = maxIn;                                                         // amountInMaximum
    amountInRaw = maxIn;
    compiledMaxInRaw = isTwoWay(st.compilation) ? compiled!.maxUsdcInRaw : 0n; // sell-only sessions cannot buy
    tradeUsd18 = tokenToUsd18(maxIn, usdcUsd, USDC_DECIMALS);                 // worst-case spend, conservative
    if (maxIn > snap.usdcRaw) violations.push("AMOUNT_EXCEEDS_BALANCE");
  }

  const requestedUsdCents = usd18ToCents(tradeUsd18);
  const dailyBudgetUsdCents = usdToCents(policy.dailyBudgetUsd);
  const risk = assessRisk({
    wethWei: quote.wethWei, usdcRaw: quote.usdcRaw, poolWethReserve: quote.poolWethReserve,
    wethUsd, usdcUsd, requestedUsdCents, dailyBudgetUsdCents, maxDivergenceBps: NETWORK_RISK[ctx.chain.id]!.maxDivergenceBps,
  });
  return { direction: a.kind as TradeDirection, targetPct: a.targetPct, clamped: clamp, wethWei: quote.wethWei, amountInRaw, compiledMaxInRaw,
    limitRaw, tradeUsd18, requestedUsdCents, quote, risk, violations, dailyBudgetUsdCents };
}
export type Plan = Awaited<ReturnType<typeof buildPlan>>;

/** The single router call for a plan; target, tokens, fee and recipient are fixed by configuration. */
export function swapCall(ctx: EngineContext, account: Address, p: Pick<Plan, "direction" | "wethWei" | "amountInRaw" | "limitRaw">) {
  const n = ctx.network;
  const data = p.direction === "SELL_WETH"
    ? encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInputSingle", args: [{
        tokenIn: n.weth, tokenOut: n.usdc, fee: n.feeTier, recipient: account, amountIn: p.amountInRaw, amountOutMinimum: p.limitRaw, sqrtPriceLimitX96: 0n }] })
    : encodeFunctionData({ abi: swapRouterAbi, functionName: "exactOutputSingle", args: [{
        tokenIn: n.usdc, tokenOut: n.weth, fee: n.feeTier, recipient: account, amountOut: p.wethWei, amountInMaximum: p.limitRaw, sqrtPriceLimitX96: 0n }] });
  return { to: n.swapRouter02, value: 0n, data: data as Hex };
}

/** Sell call with explicit amounts (security harnesses construct out-of-policy calls deliberately). */
export const sellCall = (ctx: EngineContext, account: Address, amountIn: bigint, minOut: bigint) =>
  swapCall(ctx, account, { direction: "SELL_WETH", wethWei: amountIn, amountInRaw: amountIn, limitRaw: minOut });
/** Buy call with explicit amounts (security harnesses). */
export const buyCall = (ctx: EngineContext, account: Address, wethOut: bigint, maxUsdcIn: bigint) =>
  swapCall(ctx, account, { direction: "BUY_WETH", wethWei: wethOut, amountInRaw: maxUsdcIn, limitRaw: maxUsdcIn });

const weth = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);
const usdc = (raw: bigint) => (Number(raw) / 1e6).toFixed(2);
export const describeTrade = (p: Plan) => p.direction === "SELL_WETH"
  ? `sell ${weth(p.wethWei)} WETH (≈ $${fmtUsd18(p.tradeUsd18)}) for ≥ ${usdc(p.limitRaw)} USDC`
  : `buy ${weth(p.wethWei)} WETH for ≤ ${usdc(p.limitRaw)} USDC (≈ $${fmtUsd18(p.tradeUsd18)})`;

export const planJson = (p: Plan, extra: Record<string, unknown> = {}) => JSON.parse(JSON.stringify({
  direction: p.direction, targetPct: p.targetPct, clamped: p.clamped, wethWei: p.wethWei, amountInRaw: p.amountInRaw, limitRaw: p.limitRaw,
  tradeUsd: fmtUsd18(p.tradeUsd18), requestedUsdCents: p.requestedUsdCents,
  quote: { usdcRaw: p.quote.usdcRaw, block: p.quote.blockNumber, pool: p.quote.pool, feeTier: p.quote.feeTier, quotedAt: p.quote.quotedAt },
  risk: p.risk, violations: p.violations, ...extra,
}, (_, v) => (typeof v === "bigint" ? `${v}` : v)));

/** Market facts for the agent. Every value is a deterministic read; failures degrade to null, never block. */
async function marketContext(ctx: EngineContext, snap: PortfolioSnapshot, p: Plan): Promise<NonNullable<AgentContext["market"]>> {
  const { wethUsd, usdcUsd } = snap.prices;
  const quoteUsd = (Number(p.quote.usdcRaw) / 1e6) * (Number(usdcUsd.answer) / 10 ** usdcUsd.decimals) / (Number(p.quote.wethWei) / 1e18);
  const [move, gas] = await Promise.all([
    recentMove(ctx.publicClient, ctx.network.chainlinkEthUsd).catch(() => null),
    ctx.publicClient.getGasPrice().catch(() => null),
  ]);
  return {
    oracleEthUsd: (Number(wethUsd.answer) / 10 ** wethUsd.decimals).toFixed(2),
    quoteEthUsd: quoteUsd.toFixed(2),
    divergencePct: (p.risk.divergenceBps / 100).toFixed(2),
    recentMove: move && { spanHours: (move.spanSec / 3600).toFixed(1), changePct: (move.changeBps / 100).toFixed(2), rangePct: (move.rangeBps / 100).toFixed(2) },
    gasGwei: gas === null ? "unknown" : Number(formatGwei(gas)).toFixed(4),
    testnetPricing: ctx.network.isTestnet,
  };
}

async function recentOutcomes(ctx: EngineContext, accountId: string, excludeId: string) {
  const rows = await ctx.db.select().from(agentActions).where(and(eq(agentActions.accountId, accountId), ne(agentActions.id, excludeId)))
    .orderBy(desc(agentActions.createdAt)).limit(5);
  return rows.map((r) => {
    const plan = r.plan as { direction?: string; tradeUsd?: string } | null;
    return { at: r.createdAt.toISOString(), state: r.state, ...(plan?.direction ? { direction: plan.direction } : {}),
      ...(plan?.tradeUsd ? { usd: plan.tradeUsd } : {}), ...(r.tier ? { tier: r.tier } : {}) };
  });
}

/** Preceding actions in a row whose decision came from the deterministic fallback (AI unavailable). */
async function consecutiveAiFailures(ctx: EngineContext, accountId: string, excludeId: string, lookback: number) {
  const rows = await ctx.db.select({ decision: agentActions.decision }).from(agentActions)
    .where(and(eq(agentActions.accountId, accountId), ne(agentActions.id, excludeId))).orderBy(desc(agentActions.createdAt)).limit(lookback);
  let n = 0;
  for (const r of rows) { if ((r.decision as { provider?: string } | null)?.provider !== DETERMINISTIC_FALLBACK) break; n++; }
  return n;
}

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
  const policy = st.policy;
  const testnetNote = ctx.network.isTestnet ? " [TESTNET_PRICING: pools not market-representative]" : "";

  try {
    await audit("TRIGGER_DETECTED", "INFO", trigger.detail, { kind: trigger.kind, block: trigger.block });
    await transitionAction(ctx.db, action.id, ["TRIGGERED"], "PLANNING");

    const snap = await readPortfolio(ctx, account, policy);
    const v = snap.assessment.valuation;
    await audit("ALLOCATION", "INFO", `Allocation: ${pct(v.wethWeightBps)} WETH; band ${policy.ethMinPct}–${policy.ethMaxPct}%`, {
      block: snap.blockNumber, wethWei: snap.wethWei, usdcRaw: snap.usdcRaw, wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18),
      oracle: { ethUsd: snap.prices.wethUsd.answer, ethUsdAgeSec: snap.prices.wethUsd.ageSec, usdcUsd: snap.prices.usdcUsd.answer } });
    if (snap.assessment.kind === "WITHIN_BAND") return finish(["PLANNING"], "NO_ACTION", "INFO", "Allocation within band — no action");

    // Session usability, including D3 reauthorization on price rise.
    let status: SessionStatus = await sessionStatus(ctx, st.account, st.session, st.compilation);
    if (status === "ACTIVE" && st.compilation && reauthRequired(BigInt(st.compilation.authPriceAnswer), snap.prices.wethUsd.answer, GUARDIAN_CONFIG.reauthPriceRiseBps)) {
      await ctx.db.update(agentSessions).set({ status: "REAUTH_REQUIRED" }).where(eq(agentSessions.id, st.session!.id));
      await audit("SESSION_REAUTH_REQUIRED", "WARNING", "WETH price rose ≥10% since authorization — owner must reauthorize the agent");
      status = "REAUTH_REQUIRED";
    }
    const used = await dailyUsedCents(ctx.db, accountId);
    const routeFor = (p: Plan) => routeAuthority({
      violations: p.violations, riskClass: p.risk.classification, hardGates: p.risk.hardGates,
      requestedUsdCents: p.requestedUsdCents, maxAutoTxUsdCents: usdToCents(policy.maxAutoTxUsd),
      dailyUsedUsdCents: used, dailyBudgetUsdCents: p.dailyBudgetUsdCents, amountInRaw: p.amountInRaw, compiledMaxInRaw: p.compiledMaxInRaw, sessionStatus: status,
    });

    // Provisional plan at the owner's target: the facts the agent decides on.
    const provisional = await buildPlan(ctx, st, snap);
    const provisionalRoute = routeFor(provisional);

    // AI decides intent inside the owner's band; deterministic code owns amounts, addresses, calldata, and authority.
    const agentCtx: AgentContext = {
      trigger: { kind: trigger.kind, detail: trigger.detail },
      portfolio: { wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18), totalUsd: fmtUsd18(v.totalUsd18), wethWeightPct: fmtBps(v.wethWeightBps) },
      policy: { ethMinPct: policy.ethMinPct, ethMaxPct: policy.ethMaxPct, targetEthPct: policy.targetEthPct, maxAutoTxUsd: policy.maxAutoTxUsd, dailyBudgetUsd: policy.dailyBudgetUsd },
      market: await marketContext(ctx, snap, provisional),
      proposedTrade: { direction: provisional.direction, usd: fmtUsd18(provisional.tradeUsd18), tier: provisionalRoute.tier, reasons: provisionalRoute.reasons,
        risk: { score: provisional.risk.score, classification: provisional.risk.classification, hardGates: provisional.risk.hardGates } },
      recentOutcomes: await recentOutcomes(ctx, accountId, action.id),
      ...(trigger.userMessage ? { userMessage: trigger.userMessage } : {}),
    };
    const bounds = { ethMinPct: policy.ethMinPct, ethMaxPct: policy.ethMaxPct, maxWaitMinutes: GUARDIAN_CONFIG.maxWaitMinutes };
    const ai = ctx.models.length ? await decideWithFallback(ctx.models, agentCtx, bounds) : { ok: false as const, errors: ["No LLM provider configured"] };

    let decision: AgentDecision, targetPct = policy.targetEthPct, provider: string;
    if (ai.ok) {
      decision = ai.decision; provider = ai.provider;
      if (ai.targetPct !== undefined) targetPct = ai.targetPct;
    } else {
      // Fail-safe, not fail-stop: a rule-based rebalance to the owner's target, executable only at Tier 1 / LOW risk.
      const prior = await consecutiveAiFailures(ctx, accountId, action.id, GUARDIAN_CONFIG.aiFailurePauseThreshold);
      await audit("AI_UNAVAILABLE", "WARNING", `No valid AI decision (${prior + 1} in a row) — using the rule-based fallback`, { errors: ai.errors });
      if (prior + 1 >= GUARDIAN_CONFIG.aiFailurePauseThreshold) {
        await ctx.db.update(smartAccounts).set({ monitoringEnabled: false, pausedReason: "AI_UNAVAILABLE_OR_INVALID" }).where(eq(smartAccounts.id, accountId));
        return finish(["PLANNING"], "FAILED", "FAILURE", `AI unavailable ${prior + 1} times in a row — new autonomous actions paused (fail closed)`,
          { error: ai.errors.join(" | ").slice(0, 1000), decision: { provider: DETERMINISTIC_FALLBACK, paused: true } });
      }
      decision = deterministicDecision(policy.targetEthPct); provider = DETERMINISTIC_FALLBACK;
    }
    await transitionAction(ctx.db, action.id, ["PLANNING"], "PLANNING", { decision: { ...decision, provider } });
    await audit("AI_DECISION", "INFO", `AI decision: ${decision.decision}${decision.decision === "REBALANCE" ? ` to ${targetPct}% WETH` : ""} — ${decision.reason}`,
      { provider, decision, fallbackErrors: ai.errors });
    if (decision.decision === "WAIT") {
      return finish(["PLANNING"], "WAIT", "INFO", `Agent chose to wait ${decision.recheckMinutes} min`,
        { cooldownUntil: new Date(Date.now() + decision.recheckMinutes * 60_000) });
    }
    if (decision.decision === "NO_ACTION") return finish(["PLANNING"], "NO_ACTION", "INFO", "Agent chose NO_ACTION");

    let plan = targetPct === provisional.targetPct ? provisional : await buildPlan(ctx, st, snap, { targetPct });
    let route: RoutingDecision = plan === provisional ? provisionalRoute : routeFor(plan);

    // E7 partial step: a move that only exceeds the per-trade caps is stepped at Tier 1 instead of escalated.
    if (decision.decision === "REBALANCE" && policy.allowPartialAutonomy !== false
      && partialStepAllowed(route, plan.requestedUsdCents, usdToCents(policy.maxAutoTxUsd), GUARDIAN_CONFIG.partialAutonomyMaxMultiple)) {
      const step = await buildPlan(ctx, st, snap, { targetPct, clamp: true });
      const stepRoute = routeFor(step);
      if (stepRoute.tier === "TIER1_AGENT") {
        await audit("PARTIAL_STEP", "INFO", `Full move ≈ $${fmtUsd18(plan.tradeUsd18)} exceeds the per-trade cap; stepping at the cap now, the rest after the cooldown`);
        plan = step; route = { tier: "TIER1_AGENT", reasons: ["PARTIAL_STEP_WITHIN_CAP"] };
      }
    }

    await audit("PLAN", "INFO", `Target: ${plan.targetPct}%; ${describeTrade(plan)}`);
    await audit("QUOTE", "INFO", `Quote: ${plan.direction === "SELL_WETH" ? `${usdc(plan.quote.usdcRaw)} USDC out; minimum ${usdc(plan.limitRaw)}` : `${usdc(plan.quote.usdcRaw)} USDC in; maximum ${usdc(plan.limitRaw)}`} (${policy.maxSlippageBps} bps)${testnetNote}`,
      { block: plan.quote.blockNumber, pool: plan.quote.pool, feeTier: plan.quote.feeTier });
    await audit("RISK", plan.risk.classification === "LOW" ? "INFO" : "WARNING",
      `Risk ${plan.risk.score} (${plan.risk.classification}); divergence ${(plan.risk.divergenceBps / 100).toFixed(2)}%${plan.risk.hardGates.length ? `; gates: ${plan.risk.hardGates.join(", ")}` : ""}`, plan.risk);

    const { tier, reasons } = applyAgentStance(route,
      { escalate: decision.decision === "ESCALATE", aiFallback: provider === DETERMINISTIC_FALLBACK, riskClass: plan.risk.classification });
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
    const call = swapCall(ctx, account, plan);
    // Bundler estimation runs full validation (permissions included) without broadcasting.
    const op = (await client.prepareUserOperation({ calls: [call] })) as UserOperation<"0.7">;
    op.signature = await agentAccount.signUserOperation(op);
    const [sim] = await simulateHandleOps(ctx.publicClient, { beneficiary: account, blocks: [{ steps: [{ kind: "userop", label: "rebalance", op }] }], watchTokens: [ctx.network.usdc, ctx.network.weth] });
    const moved = (token: Address, dir: "to" | "from") => (sim?.tokenTransfers ?? [])
      .filter((t) => t.token.toLowerCase() === token.toLowerCase() && t[dir].toLowerCase() === account.toLowerCase()).reduce((a, t) => a + t.value, 0n);
    const simOk = sim?.result === "EXECUTED_SUCCESS" && (plan.direction === "SELL_WETH"
      ? moved(ctx.network.usdc, "to") >= plan.limitRaw
      : moved(ctx.network.weth, "to") >= plan.wethWei && moved(ctx.network.usdc, "from") <= plan.limitRaw);
    if (!simOk) {
      await releaseBudget(ctx.db, action.id);
      return finish(PRE_SUBMIT, "FAILED", "FAILURE", `Simulation failed: ${sim?.result} ${sim?.detail ?? ""}`.trim(), { error: sim?.detail });
    }
    await audit("SIMULATION_PASSED", "SUCCESS", plan.direction === "SELL_WETH"
      ? `Simulation passed; predicted ${usdc(moved(ctx.network.usdc, "to"))} USDC ≥ minimum ${usdc(plan.limitRaw)}`
      : `Simulation passed; ${weth(moved(ctx.network.weth, "to"))} WETH for ${usdc(moved(ctx.network.usdc, "from"))} USDC ≤ maximum ${usdc(plan.limitRaw)}`);

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
  let snap: PortfolioSnapshot | null = null;
  try { if (st.policy) snap = await readPortfolio(ctx, account, st.policy, { atLeastBlock: receipt.receipt.blockNumber }); } catch { /* valuation unavailable; receipt still recorded */ }
  const balancesAfter = snap ? { wethWei: snap.wethWei, usdcRaw: snap.usdcRaw } : null;
  await recordReceipt(ctx, userOperationId, receipt, { balancesAfter });
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
  const allocation = snap ? ` allocation now ${pct(snap.assessment.valuation.wethWeightBps)} WETH` : "";
  const won = await transitionAction(ctx.db, actionId, ["PENDING", "SUBMITTING"], "CONFIRMED", { cooldownUntil: new Date(Date.now() + GUARDIAN_CONFIG.cooldownSec * 1000) });
  if (!won) return;
  await audit("CONFIRMED", "SUCCESS", `Confirmed in block ${receipt.receipt.blockNumber};${allocation}`, evidence);
}
