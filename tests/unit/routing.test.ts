import { describe, expect, it } from "vitest";
import { applyAgentStance, partialStepAllowed, routeAuthority, reauthRequired, type RoutingInput } from "@guardian/policy";
import { assessRisk } from "@guardian/risk";

const base: RoutingInput = {
  violations: [], riskClass: "LOW", hardGates: [], requestedUsdCents: 469n, maxAutoTxUsdCents: 1000n,
  dailyUsedUsdCents: 0n, dailyBudgetUsdCents: 2500n, amountInRaw: 10n ** 15n, compiledMaxInRaw: 2n * 10n ** 15n, sessionStatus: "ACTIVE",
};

describe("authority router", () => {
  it("Tier 1 when every check passes (Scenario 1, ~$4.69)", () => expect(routeAuthority(base).tier).toBe("TIER1_AGENT"));
  it("Tier 2 above $10 cap (Scenario 2, ~$14.10)", () => {
    const d = routeAuthority({ ...base, requestedUsdCents: 1410n, amountInRaw: 3n * 10n ** 15n });
    expect(d.tier).toBe("TIER2_MASTER");
    expect(d.reasons).toEqual(["ABOVE_AUTONOMOUS_USD_CAP", "ABOVE_COMPILED_TOKEN_CAP"]);
  });
  it("Tier 2 when daily budget would be exceeded", () =>
    expect(routeAuthority({ ...base, dailyUsedUsdCents: 2100n }).reasons).toEqual(["DAILY_BUDGET_EXCEEDED"]));
  it("Tier 2 at exactly the budget boundary is still Tier 1", () =>
    expect(routeAuthority({ ...base, dailyUsedUsdCents: 2031n }).tier).toBe("TIER1_AGENT"));
  it("Tier 2 for expired/revoked/exhausted/reauth session and MEDIUM risk", () => {
    for (const s of ["EXPIRED", "REVOKED", "EXHAUSTED", "REAUTH_REQUIRED", "NONE"] as const)
      expect(routeAuthority({ ...base, sessionStatus: s }).tier).toBe("TIER2_MASTER");
    expect(routeAuthority({ ...base, riskClass: "MEDIUM" }).tier).toBe("TIER2_MASTER");
  });
  it("Tier 3 beats Tier 2: violations, hard gates, HIGH risk", () => {
    expect(routeAuthority({ ...base, requestedUsdCents: 99999n, violations: ["WRONG_RECIPIENT"] }).tier).toBe("TIER3_REJECT");
    expect(routeAuthority({ ...base, hardGates: ["PRICE_DIVERGENCE_500BPS"] }).tier).toBe("TIER3_REJECT");
    expect(routeAuthority({ ...base, riskClass: "HIGH" }).tier).toBe("TIER3_REJECT");
  });
  it("buy side: compares the USDC spend with the USDC ceiling; a sell-only session (ceiling 0) escalates", () => {
    expect(routeAuthority({ ...base, amountInRaw: 9_500_000n, compiledMaxInRaw: 9_803_921n }).tier).toBe("TIER1_AGENT");
    expect(routeAuthority({ ...base, amountInRaw: 9_500_000n, compiledMaxInRaw: 0n }).reasons).toEqual(["ABOVE_COMPILED_TOKEN_CAP"]);
  });
  it("partial step only for cap-only escalations up to 3x the cap", () => {
    const capOnly = routeAuthority({ ...base, requestedUsdCents: 1410n, amountInRaw: 3n * 10n ** 15n });
    expect(partialStepAllowed(capOnly, 1410n, 1000n, 3)).toBe(true);
    expect(partialStepAllowed(capOnly, 3001n, 1000n, 3)).toBe(false);
    const budget = routeAuthority({ ...base, requestedUsdCents: 1410n, dailyUsedUsdCents: 2000n });
    expect(partialStepAllowed(budget, 1410n, 1000n, 3)).toBe(false);
    expect(partialStepAllowed(routeAuthority({ ...base, sessionStatus: "EXHAUSTED" }), 469n, 1000n, 3)).toBe(false);
    expect(partialStepAllowed(routeAuthority({ ...base, riskClass: "MEDIUM", requestedUsdCents: 1410n }), 1410n, 1000n, 3)).toBe(false);
    expect(partialStepAllowed(routeAuthority(base), 469n, 1000n, 3)).toBe(false); // already Tier 1
  });
  it("agent stance only narrows authority", () => {
    const t1 = routeAuthority(base), t2 = routeAuthority({ ...base, sessionStatus: "EXPIRED" }), t3 = routeAuthority({ ...base, riskClass: "HIGH" });
    const s = (o: Partial<Parameters<typeof applyAgentStance>[1]> = {}) => ({ escalate: false, aiFallback: false, riskClass: "LOW" as const, ...o });
    expect(applyAgentStance(t1, s())).toEqual(t1);
    expect(applyAgentStance(t1, s({ escalate: true }))).toEqual({ tier: "TIER2_MASTER", reasons: ["AI_ESCALATED"] });
    expect(applyAgentStance(t3, s({ escalate: true, aiFallback: true })).tier).toBe("TIER3_REJECT");
    // AI unavailable: rule-based execution only for Tier 1 LOW risk.
    expect(applyAgentStance(t1, s({ aiFallback: true }))).toEqual({ tier: "TIER1_AGENT", reasons: ["ALL_TIER1_CHECKS_PASSED", "RULE_BASED_FALLBACK"] });
    expect(applyAgentStance(t1, s({ aiFallback: true, riskClass: "MEDIUM" })).tier).toBe("TIER2_MASTER");
    expect(applyAgentStance(t2, s({ aiFallback: true })).reasons).toContain("AI_UNAVAILABLE");
  });
  it("reauth at +10% price rise, not below", () => {
    expect(reauthRequired(2500n, 2749n, 1000)).toBe(false);
    expect(reauthRequired(2500n, 2750n, 1000)).toBe(true);
  });
});

const eth = { answer: 2_500n * 10n ** 8n, decimals: 8 }, usdc = { answer: 10n ** 8n, decimals: 8 };
const risk = (o: Partial<Parameters<typeof assessRisk>[0]> = {}) => assessRisk({
  wethWei: 1_875_000_000_000_000n, usdcRaw: 4_687_500n, poolWethReserve: 100n * 10n ** 18n,
  wethUsd: eth, usdcUsd: usdc, requestedUsdCents: 469n, dailyBudgetUsdCents: 2500n, maxDivergenceBps: 200, ...o });

describe("risk engine", () => {
  it("market-priced small swap is LOW", () => {
    const r = risk();
    expect(r.divergenceBps).toBe(0);
    expect(r.classification).toBe("LOW");
    expect(r.hardGates).toEqual([]);
  });
  it("divergence beyond the network threshold is a hard gate (HIGH)", () => {
    const r = risk({ usdcRaw: 4_500_000n }); // -4% vs oracle
    expect(r.hardGates[0]).toMatch(/^PRICE_DIVERGENCE_/);
    expect(r.classification).toBe("HIGH");
  });
  it("USDC depeg is a hard gate", () => expect(risk({ usdcUsd: { answer: 97_000_000n, decimals: 8 } }).hardGates.some((g) => g.startsWith("USDC_DEPEG"))).toBe(true));
  it("large share of pool liquidity raises score to MEDIUM/HIGH", () =>
    expect(risk({ poolWethReserve: 10n ** 17n }).classification).not.toBe("LOW"));
  it("testnet threshold (200%) tolerates Sepolia's ~2x pool price", () => {
    const r = risk({ usdcRaw: 9_843_750n, maxDivergenceBps: 20_000 }); // +110%
    expect(r.hardGates).toEqual([]);
    expect(r.classification).toBe("LOW");
  });
});
