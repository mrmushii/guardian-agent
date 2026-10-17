export type Tier = "TIER1_AGENT" | "TIER2_MASTER" | "TIER3_REJECT";
export type SessionStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED" | "REAUTH_REQUIRED" | "NONE";

export interface RoutingInput {
  /** Structural violations from the deterministic planner (wrong asset/target/recipient, malformed proposal…). */
  violations: string[];
  riskClass: "LOW" | "MEDIUM" | "HIGH";
  hardGates: string[];
  requestedUsdCents: bigint;
  maxAutoTxUsdCents: bigint;
  /** Spent plus reserved today (UTC day, D1). */
  dailyUsedUsdCents: bigint;
  dailyBudgetUsdCents: bigint;
  /** Token amount the session would spend, in the input token's units (WETH wei to sell, USDC raw max to buy). */
  amountInRaw: bigint;
  /** Compiled on-chain ceiling for the same direction and units. */
  compiledMaxInRaw: bigint;
  sessionStatus: SessionStatus;
}

export interface RoutingDecision { tier: Tier; reasons: string[] }

/**
 * Plan §11. Tier 3 wins over Tier 2; Tier 1 only when every check passes.
 * The same financial amount is routed — authority never changes the rebalance size.
 */
export function routeAuthority(i: RoutingInput): RoutingDecision {
  const reject = [...i.violations, ...i.hardGates.map((g) => `HARD_GATE:${g}`)];
  if (i.riskClass === "HIGH") reject.push("RISK_HIGH");
  if (reject.length) return { tier: "TIER3_REJECT", reasons: reject };

  const master: string[] = [];
  if (i.requestedUsdCents > i.maxAutoTxUsdCents) master.push("ABOVE_AUTONOMOUS_USD_CAP");
  if (i.dailyUsedUsdCents + i.requestedUsdCents > i.dailyBudgetUsdCents) master.push("DAILY_BUDGET_EXCEEDED");
  if (i.amountInRaw > i.compiledMaxInRaw) master.push("ABOVE_COMPILED_TOKEN_CAP");
  if (i.sessionStatus !== "ACTIVE") master.push(`SESSION_${i.sessionStatus}`);
  if (i.riskClass === "MEDIUM") master.push("RISK_MEDIUM");
  if (master.length) return { tier: "TIER2_MASTER", reasons: master };

  return { tier: "TIER1_AGENT", reasons: ["ALL_TIER1_CHECKS_PASSED"] };
}

const CAP_ONLY = new Set(["ABOVE_AUTONOMOUS_USD_CAP", "ABOVE_COMPILED_TOKEN_CAP"]);

/**
 * E7: a Tier 2 decision whose only reasons are the per-trade caps may be stepped instead —
 * a capped trade at Tier 1 now, the rest on later evaluations — when the full move is at most
 * `maxMultiple` × the USD cap. Anything else (budget, session, risk) still needs the master.
 */
export function partialStepAllowed(d: RoutingDecision, requestedUsdCents: bigint, maxAutoTxUsdCents: bigint, maxMultiple: number): boolean {
  return d.tier === "TIER2_MASTER" && d.reasons.length > 0 && d.reasons.every((r) => CAP_ONLY.has(r))
    && requestedUsdCents <= maxAutoTxUsdCents * BigInt(maxMultiple);
}

/** D3: price rise since authorization that requires master reauthorization. */
export function reauthRequired(authPriceAnswer: bigint, currentAnswer: bigint, thresholdBps: number): boolean {
  return currentAnswer * 10_000n >= authPriceAnswer * BigInt(10_000 + thresholdBps);
}

/**
 * Applies the agent's stance to a deterministic route. It can only *narrow* authority:
 * ESCALATE turns Tier 1 into Tier 2; the rule-based fallback (AI unavailable) executes only a
 * Tier 1 LOW-risk trade and otherwise asks the master. Tier 3 is never relaxed.
 */
export function applyAgentStance(route: RoutingDecision, stance: { escalate: boolean; aiFallback: boolean; riskClass: "LOW" | "MEDIUM" | "HIGH" }): RoutingDecision {
  if (route.tier === "TIER3_REJECT") return route;
  if (stance.escalate && route.tier === "TIER1_AGENT") return { tier: "TIER2_MASTER", reasons: ["AI_ESCALATED"] };
  if (!stance.aiFallback) return route;
  if (route.tier === "TIER1_AGENT") return stance.riskClass === "LOW"
    ? { tier: "TIER1_AGENT", reasons: [...route.reasons, "RULE_BASED_FALLBACK"] }
    : { tier: "TIER2_MASTER", reasons: ["AI_UNAVAILABLE_NOT_LOW_RISK"] };
  return { tier: route.tier, reasons: [...route.reasons, "AI_UNAVAILABLE"] };
}
