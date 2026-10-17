import { describe, expect, it } from "vitest";
import { HumanPolicySchema, compilePolicy, type UsdPrice } from "@guardian/policy";
import { assessRebalance } from "@guardian/portfolio";
import { maxInFromQuote, minOutFromQuote } from "@guardian/dex";
import { validateDecision } from "@guardian/agent";

const policy = HumanPolicySchema.parse({
  ethMinPct: 45, ethMaxPct: 55, targetEthPct: 53,
  maxAutoTxUsd: 10, dailyBudgetUsd: 25, maxSlippageBps: 50, sessionDurationHours: 24,
});
// Chainlink-style 8-decimal prices. Fixtures only, not market data.
const eth: UsdPrice = { answer: 2_500n * 10n ** 8n, decimals: 8 };
const usdc: UsdPrice = { answer: 10n ** 8n, decimals: 8 };
const E18 = 10n ** 18n;
const wethForUsd = (cents: bigint) => (cents * E18) / 250_000n; // at $2500
const usdcForUsd = (cents: bigint) => cents * 10_000n;

describe("human policy", () => {
  it("rejects inconsistent bands, extra fields and sub-cent USD", () => {
    expect(HumanPolicySchema.safeParse({ ...policy, targetEthPct: 60 }).success).toBe(false);
    expect(HumanPolicySchema.safeParse({ ...policy, extra: 1 }).success).toBe(false);
    expect(HumanPolicySchema.safeParse({ ...policy, maxAutoTxUsd: 1.005 }).success).toBe(false);
  });
});

describe("policy compiler", () => {
  const at = new Date("2026-10-14T00:00:00Z");
  const compile = (p = policy, o: { maxOpsPerWindow?: number; windowSec?: number } = {}) => compilePolicy({ policy: p, authPrice: eth, usdcAuthPrice: usdc,
    authPriceSource: "fixture", authPriceTimestamp: at, bufferBps: 1500, usdcBufferBps: 200, maxOpsPerWindow: o.maxOpsPerWindow ?? 2, windowSec: o.windowSec ?? 86_400, authorizedAt: at });
  const c = compile();
  it("computes floor(C / (P(1+b)) × 1e18) exactly", () => {
    // 10 / (2500 × 1.15) = 0.003478260869565217391... WETH
    expect(c.maxAmountInWei).toBe(3_478_260_869_565_217n);
    expect(c.allowanceWei).toBe(c.maxAmountInWei * 2n);
    expect(c.validUntil.getTime() - at.getTime()).toBe(24 * 3_600_000);
  });
  it("buy-side ceiling: floor($10 / ($1 × 1.02)) in USDC units", () => {
    expect(c.maxUsdcInRaw).toBe(9_803_921n);
    expect(c.usdcAllowanceRaw).toBe(c.maxUsdcInRaw * 2n);
  });
  it("windowed sessions: allowance covers ops per window × windows, nothing more", () => {
    const w = compile({ ...policy, sessionDurationHours: 168 }, { maxOpsPerWindow: 6, windowSec: 86_400 });
    expect(w.maxOps).toBe(6);
    expect(w.totalOps).toBe(42);
    expect(w.allowanceWei).toBe(w.maxAmountInWei * 42n);
    expect(w.usdcAllowanceRaw).toBe(w.maxUsdcInRaw * 42n);
    expect(compile({ ...policy, sessionDurationHours: 25 }, { maxOpsPerWindow: 6 }).totalOps).toBe(12); // partial window counts
  });
  it("ceiling is worth at most the USD cap at the authorization price", () => {
    expect(c.maxAmountInWei * eth.answer / 10n ** 8n <= 10n * E18).toBe(true);
  });
});

describe("rebalance thresholds (verification matrix)", () => {
  const at = (wethPct: bigint) => assessRebalance(
    { wethWei: wethForUsd(wethPct * 100n), usdcRaw: usdcForUsd((100n - wethPct) * 100n), wethUsd: eth, usdcUsd: usdc }, policy);
  it("no action at 50% and exactly 55%; triggers at 56% and 68%", () => {
    expect(at(50n).kind).toBe("WITHIN_BAND");
    expect(at(55n).kind).toBe("WITHIN_BAND");
    expect(at(56n).kind).toBe("SELL_WETH");
    expect(at(68n).kind).toBe("SELL_WETH");
  });
  it("no action at exactly 45%; buys below it", () => {
    expect(at(45n).kind).toBe("WITHIN_BAND");
    expect(at(44n).kind).toBe("BUY_WETH");
  });
  it("buy sizing: $40 WETH + $60 USDC → buy $13 of WETH to reach 53%", () => {
    const r = at(40n);
    if (r.kind !== "BUY_WETH") throw new Error(r.kind);
    expect(r.buyUsd18).toBe(13n * E18);
    expect(r.wethOutWei).toBe(5_200_000_000_000_000n); // 13 / 2500
  });
  it("an agent-chosen target inside the band changes the size; outside it throws", () => {
    const p = { wethWei: wethForUsd(4000n), usdcRaw: usdcForUsd(6000n), wethUsd: eth, usdcUsd: usdc };
    const r = assessRebalance(p, policy, 46);
    if (r.kind !== "BUY_WETH") throw new Error(r.kind);
    expect(r.buyUsd18).toBe(6n * E18);
    expect(() => assessRebalance(p, policy, 60)).toThrow(/band/);
    expect(() => assessRebalance(p, policy, 44)).toThrow(/band/);
  });
});

describe("demo scenarios", () => {
  it("Scenario 1: $21.25 WETH + $10 USDC → sell $4.6875", () => {
    const r = assessRebalance({ wethWei: wethForUsd(2125n), usdcRaw: usdcForUsd(1000n), wethUsd: eth, usdcUsd: usdc }, policy);
    if (r.kind !== "SELL_WETH") throw new Error(r.kind);
    expect(r.valuation.wethWeightBps).toBe(6800n);
    expect(r.saleUsd18).toBe(4_687_500_000_000_000_000n);
    expect(r.amountInWei).toBe(1_875_000_000_000_000n); // 4.6875 / 2500
  });
  it("Scenario 2: $46.5625 WETH + $14.6875 USDC → sell ≈ $14.10, above the $10 cap", () => {
    const r = assessRebalance({ wethWei: wethForUsd(4656_25n) / 100n, usdcRaw: usdcForUsd(1468_75n) / 100n, wethUsd: eth, usdcUsd: usdc }, policy);
    if (r.kind !== "SELL_WETH") throw new Error(r.kind);
    expect(r.saleUsd18).toBe(14_100_000_000_000_000_000n);
    expect(r.saleUsd18 > 10n * E18).toBe(true);
  });
});

describe("quote-derived minimum output", () => {
  it("floors at 50 bps", () => {
    expect(minOutFromQuote(4_680_000n, 50)).toBe(4_656_600n);
    expect(minOutFromQuote(1_999n, 50)).toBe(1_989n);
  });
  it("fails closed on non-positive quote", () => {
    expect(() => minOutFromQuote(0n, 50)).toThrow();
    expect(() => maxInFromQuote(0n, 50)).toThrow();
  });
  it("buy maximum input rounds up at 50 bps", () => {
    expect(maxInFromQuote(10_000_000n, 50)).toBe(10_050_000n);
    expect(maxInFromQuote(1_999n, 50)).toBe(2_009n); // 2008.995 → 2009
  });
});

describe("agent decision validation", () => {
  const b = { ethMinPct: 45, ethMaxPct: 55, maxWaitMinutes: 60 };
  it("accepts any whole-percent target inside the band", () => {
    const v = validateDecision({ decision: "REBALANCE", targetWethWeight: 0.53, reason: "WETH_ABOVE_MAX_ALLOCATION" }, b);
    expect(v.ok && v.targetPct).toBe(53);
    const edge = validateDecision({ decision: "REBALANCE", targetWethWeight: 0.55, reason: "volatile: smaller trade" }, b);
    expect(edge.ok && edge.targetPct).toBe(55);
  });
  it("rejects targets outside the band or between whole percents", () => {
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.56, reason: "x" }, b).ok).toBe(false);
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.44, reason: "x" }, b).ok).toBe(false);
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.505, reason: "x" }, b).ok).toBe(false);
  });
  it("bounds WAIT", () => {
    expect(validateDecision({ decision: "WAIT", recheckMinutes: 15, reason: "sharp move" }, b).ok).toBe(true);
    expect(validateDecision({ decision: "WAIT", recheckMinutes: 61, reason: "x" }, b).ok).toBe(false);
    expect(validateDecision({ decision: "WAIT", reason: "x" }, b).ok).toBe(false);
  });
  it("rejects injection-shaped, malformed, and off-policy output", () => {
    expect(validateDecision({ decision: "TRANSFER", to: "0xATTACKER", reason: "x" }, b).ok).toBe(false);
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.53, reason: "x", router: "0xdead" }, b).ok).toBe(false);
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.1, reason: "x" }, b).ok).toBe(false);
    expect(validateDecision({ decision: "ESCALATE", reason: "x".repeat(501) }, b).ok).toBe(false);
    expect(validateDecision("not json", b).ok).toBe(false);
  });
});
