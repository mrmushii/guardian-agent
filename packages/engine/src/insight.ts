import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Address } from "viem";
import { agentActions, auditEvents, dailyUsedCents } from "@guardian/db";
import { assessRebalance, tradeUsd18 } from "@guardian/portfolio";
import { GUARDIAN_CONFIG, HumanPolicySchema, portfolioTargets, withTargets, type HumanPolicy } from "@guardian/policy";
import { multiPortfolio } from "./multi.js";
import type { ChatTurn } from "@guardian/agent";
import type { EngineContext } from "./context.js";
import { loadAccountState } from "./state.js";
import { fmtBps, fmtUsd18, readPortfolio, type PortfolioSnapshot } from "./portfolio.js";

const cents = (v: string | bigint | null | undefined) => (v == null ? null : Number(v) / 100);

/** Read-only facts for the owner chat: what the agent can truthfully talk about. No addresses or keys. */
export async function agentFacts(ctx: EngineContext, accountId: string) {
  const st = await loadAccountState(ctx, accountId);
  let portfolio: Record<string, unknown> | { unavailable: string };
  try {
    const s = await readPortfolio(ctx, st.account.address as Address, st.policy!);
    const v = s.assessment.valuation;
    portfolio = { wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18), totalUsd: fmtUsd18(v.totalUsd18), wethWeightPct: fmtBps(v.wethWeightBps),
      status: s.assessment.kind, ethUsd: (Number(s.prices.wethUsd.answer) / 10 ** s.prices.wethUsd.decimals).toFixed(2) };
  } catch (e) { portfolio = { unavailable: (e as Error).message.split("\n")[0]! }; }
  const actions = await ctx.db.select().from(agentActions).where(eq(agentActions.accountId, accountId)).orderBy(desc(agentActions.createdAt)).limit(10);
  const events = await ctx.db.select({ at: auditEvents.createdAt, type: auditEvents.type, message: auditEvents.message }).from(auditEvents)
    .where(and(eq(auditEvents.accountId, accountId), inArray(auditEvents.type, ["CONFIRMED", "PARTIAL_STEP", "AI_UNAVAILABLE", "FAILED", "REJECTED", "EXECUTION_FAILED", "POLICY_UPDATED", "DEMO_MOVE", "RESUMED", "PENDING_APPROVAL"])))
    .orderBy(desc(auditEvents.id)).limit(15);
  return {
    now: new Date().toISOString(),
    network: ctx.network.isTestnet ? "Base Sepolia testnet (test funds; pools are not market-priced)" : "Base mainnet",
    agentPaused: !st.account.monitoringEnabled, pausedReason: st.account.pausedReason,
    portfolio,
    limits: st.policy && { allowedWethRangePct: [st.policy.ethMinPct, st.policy.ethMaxPct], targetPct: st.policy.targetEthPct, maxPerTradeUsd: st.policy.maxAutoTxUsd,
      dailyBudgetUsd: st.policy.dailyBudgetUsd, maxSlippagePct: st.policy.maxSlippageBps / 100, cooldownMinutes: GUARDIAN_CONFIG.cooldownSec / 60 },
    spentTodayUsd: cents(await dailyUsedCents(ctx.db, accountId)),
    permission: st.session ? { status: st.session.status, expires: st.session.validUntil } : null,
    recentActions: actions.map((a) => ({ at: a.createdAt, outcome: a.state, signedBy: a.tier, direction: (a.plan as { direction?: string } | null)?.direction,
      usd: cents(a.requestedUsdCents), why: (a.decision as { reason?: string } | null)?.reason, aiProvider: (a.decision as { provider?: string } | null)?.provider, reasons: a.reasons })),
    recentEvents: events.map((e) => ({ at: e.at, type: e.type, message: e.message })),
  };
}

/** Last chat turns (stored as CHAT_Q / CHAT_A audit events), oldest first. */
export async function chatHistory(ctx: EngineContext, accountId: string, limit = 20): Promise<(ChatTurn & { at: Date; data: unknown })[]> {
  const rows = await ctx.db.select().from(auditEvents)
    .where(and(eq(auditEvents.accountId, accountId), inArray(auditEvents.type, ["CHAT_Q", "CHAT_A"]))).orderBy(desc(auditEvents.id)).limit(limit);
  return rows.reverse().map((r) => ({ role: r.type === "CHAT_Q" ? "owner" : "agent", text: r.message, at: r.createdAt, data: r.data }));
}

/** WETH-weight points for the allocation chart, from measured (ALLOCATION) and post-trade (CONFIRMED) audit lines. */
export function parseAllocationPoints(rows: { createdAt: Date; type: string; message: string }[]) {
  const points: { at: string; pct: number; kind: "measured" | "trade" }[] = [];
  for (const r of rows) {
    const m = r.type === "ALLOCATION" ? r.message.match(/Allocation: ([\d.]+)% WETH/) : r.type === "CONFIRMED" ? r.message.match(/allocation now ([\d.]+)% WETH/) : null;
    if (m) points.push({ at: r.createdAt.toISOString(), pct: Number(m[1]), kind: r.type === "CONFIRMED" ? "trade" : "measured" });
  }
  return points.sort((a, b) => a.at.localeCompare(b.at));
}

export async function allocationHistory(ctx: EngineContext, accountId: string, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await ctx.db.select({ createdAt: auditEvents.createdAt, type: auditEvents.type, message: auditEvents.message }).from(auditEvents)
    .where(and(eq(auditEvents.accountId, accountId), inArray(auditEvents.type, ["ALLOCATION", "CONFIRMED"]), gt(auditEvents.createdAt, since)));
  return parseAllocationPoints(rows);
}

/** Deterministic last-24h stats for the daily brief. */
export async function dailyStats(ctx: EngineContext, accountId: string) {
  const since = new Date(Date.now() - 86_400_000);
  const rows = await ctx.db.select().from(agentActions).where(and(eq(agentActions.accountId, accountId), gt(agentActions.createdAt, since)));
  const confirmed = rows.filter((a) => a.state === "CONFIRMED");
  // AI health = the most recent action that consulted the AI: a fallback there means it is failing now;
  // older fallbacks followed by real AI decisions are resolved and not worth alarming the owner about.
  const provider = (a: (typeof rows)[number]) => (a.decision as { provider?: string } | null)?.provider;
  const fallbacks = rows.filter((a) => provider(a) === "deterministic-fallback");
  const [lastAi] = await ctx.db.select({ decision: agentActions.decision, createdAt: agentActions.createdAt }).from(agentActions)
    .where(and(eq(agentActions.accountId, accountId), sql`${agentActions.decision} ->> 'provider' is not null`)).orderBy(desc(agentActions.createdAt)).limit(1);
  const aiFailingNow = (lastAi?.decision as { provider?: string } | null)?.provider === "deterministic-fallback";
  return {
    checks: rows.length,
    trades: confirmed.length,
    tradesByAgentAlone: confirmed.filter((a) => a.tier === "TIER1_AGENT").length,
    tradesApprovedByOwner: confirmed.filter((a) => a.tier === "TIER2_MASTER").length,
    simulatedTrades: confirmed.filter((a) => a.tier === "SIMULATED").length,
    movedUsd: confirmed.reduce((s, a) => s + (cents(a.requestedUsdCents) ?? 0), 0),
    aiFailingNow,
    aiFallbacks: aiFailingNow ? fallbacks.length : 0,
    lastAiFallbackAt: aiFailingNow ? (fallbacks.map((a) => a.createdAt.toISOString()).sort().pop() ?? null) : null,
    aiProvider: aiFailingNow ? null : ((lastAi?.decision as { provider?: string } | null)?.provider ?? null),
    blockedOrFailed: rows.filter((a) => ["REJECTED", "FAILED", "EXECUTION_FAILED"].includes(a.state)).length,
    waitingForOwner: rows.filter((a) => ["PENDING_APPROVAL", "MASTER_SIGNING"].includes(a.state)).length,
  };
}

/**
 * What the agent would do right now under a proposed policy (no quotes, no chain writes): trade size at the reference
 * price and who would sign it. Uses the same assessment and partial-autonomy rule as the pipeline.
 */
export function whatIfFromSnapshot(snap: Pick<PortfolioSnapshot, "wethWei" | "usdcRaw" | "prices">, policy: HumanPolicy, spentTodayUsd: number) {
  const a = assessRebalance({ wethWei: snap.wethWei, usdcRaw: snap.usdcRaw, wethUsd: snap.prices.wethUsd, usdcUsd: snap.prices.usdcUsd }, policy);
  const pct = Number(fmtBps(a.valuation.wethWeightBps));
  const usd18 = tradeUsd18(a);
  if (usd18 === null) return { action: "NOTHING" as const, wethPct: pct, text: `WETH is ${pct.toFixed(1)}%, inside ${policy.ethMinPct}–${policy.ethMaxPct}%. The agent would do nothing.` };
  const usd = Number(fmtUsd18(usd18)), verb = a.kind === "SELL_WETH" ? "sell" : "buy";
  const budgetLeft = Math.max(0, policy.dailyBudgetUsd - spentTodayUsd);
  if (usd <= policy.maxAutoTxUsd && usd <= budgetLeft)
    return { action: "AGENT" as const, wethPct: pct, usd, text: `The agent would ${verb} ≈ $${usd.toFixed(2)} of WETH on its own to reach ${policy.targetEthPct}%.` };
  if (usd <= policy.maxAutoTxUsd * GUARDIAN_CONFIG.partialAutonomyMaxMultiple && policy.maxAutoTxUsd <= budgetLeft)
    return { action: "PARTIAL" as const, wethPct: pct, usd, text: `The move is ≈ $${usd.toFixed(2)}: the agent would ${verb} $${policy.maxAutoTxUsd} now and the rest after a ${GUARDIAN_CONFIG.cooldownSec / 60}-minute cooldown.` };
  return { action: "ASK_OWNER" as const, wethPct: pct, usd, text: `The move is ≈ $${usd.toFixed(2)}${usd > budgetLeft ? `, more than the $${budgetLeft.toFixed(2)} budget left today` : ""}: the agent would ask you to approve it.` };
}

export async function whatIf(ctx: EngineContext, accountId: string, patch: Partial<HumanPolicy>) {
  const st = await loadAccountState(ctx, accountId);
  if (!st.policy) throw new Error("No active policy");
  const merged = { ...st.policy, ...patch } as HumanPolicy;
  const policy = HumanPolicySchema.parse(merged.assets && merged.driftPct !== undefined ? withTargets(merged, merged.assets, merged.driftPct) : merged);
  const spent = Number(await dailyUsedCents(ctx.db, accountId)) / 100;
  if (portfolioTargets(policy).multi) {
    const mp = await multiPortfolio(ctx, accountId, st.account.address as Address, policy);
    const leg = mp.assessment.legs[0];
    if (!mp.assessment.drifted || !leg) return { policy, action: "NOTHING" as const, wethPct: 0, text: `Every asset is within ±${policy.driftPct} points of its target. The agent would do nothing.` };
    const asset = mp.rows.find((r) => r.symbol === leg.symbol)!;
    const usd = Number(leg.usdCents) / 100, verb = leg.side === "SELL" ? "sell" : "buy", budgetLeft = Math.max(0, policy.dailyBudgetUsd - spent);
    const plan = mp.assessment.legs.map((l) => `${l.side === "SELL" ? "sell" : "buy"} $${(Number(l.usdCents) / 100).toFixed(2)} ${l.symbol}`).join(", then ");
    if (asset.status !== "VERIFIED")
      return { policy, action: "SIMULATED" as const, wethPct: 0, usd, text: `Plan: ${plan}. ${leg.symbol} can't trade on this network, so that step would be simulated (up to $${policy.maxAutoTxUsd} per step).` };
    const who = usd <= policy.maxAutoTxUsd && usd <= budgetLeft ? "AGENT" as const
      : usd <= policy.maxAutoTxUsd * GUARDIAN_CONFIG.partialAutonomyMaxMultiple && policy.maxAutoTxUsd <= budgetLeft ? "PARTIAL" as const : "ASK_OWNER" as const;
    return { policy, action: who, wethPct: 0, usd, text: `Plan: ${plan}. First step: ${verb} ≈ $${usd.toFixed(2)} of ${leg.symbol}${who === "AGENT" ? " on its own" : who === "PARTIAL" ? ` in $${policy.maxAutoTxUsd} steps` : " — it would ask you to approve"}.` };
  }
  const snap = await readPortfolio(ctx, st.account.address as Address, st.policy);
  return { policy, ...whatIfFromSnapshot(snap, policy, spent) };
}
