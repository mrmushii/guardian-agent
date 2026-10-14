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
  amountInWei: bigint;
  compiledMaxAmountInWei: bigint;
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
  if (i.amountInWei > i.compiledMaxAmountInWei) master.push("ABOVE_COMPILED_TOKEN_CAP");
  if (i.sessionStatus !== "ACTIVE") master.push(`SESSION_${i.sessionStatus}`);
  if (i.riskClass === "MEDIUM") master.push("RISK_MEDIUM");
  if (master.length) return { tier: "TIER2_MASTER", reasons: master };

  return { tier: "TIER1_AGENT", reasons: ["ALL_TIER1_CHECKS_PASSED"] };
}

/** D3: price rise since authorization that requires master reauthorization. */
export function reauthRequired(authPriceAnswer: bigint, currentAnswer: bigint, thresholdBps: number): boolean {
  return currentAnswer * 10_000n >= authPriceAnswer * BigInt(10_000 + thresholdBps);
}
