import { describe, expect, it } from "vitest";
import { HumanPolicySchema, compilePolicy, type UsdPrice } from "@guardian/policy";
import { assessRebalance } from "@guardian/portfolio";
import { minOutFromQuote } from "@guardian/dex";
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
  const c = compilePolicy({ policy, authPrice: eth, authPriceSource: "fixture", authPriceTimestamp: at, bufferBps: 1500, maxOps: 2, authorizedAt: at });
  it("computes floor(C / (P(1+b)) × 1e18) exactly", () => {
    // 10 / (2500 × 1.15) = 0.003478260869565217391... WETH
    expect(c.maxAmountInWei).toBe(3_478_260_869_565_217n);
    expect(c.allowanceWei).toBe(c.maxAmountInWei * 2n);
    expect(c.validUntil.getTime() - at.getTime()).toBe(24 * 3_600_000);
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
  it("underweight is explicitly non-executing", () => {
    expect(at(40n).kind).toBe("UNDERWEIGHT_NO_EXECUTION");
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
  });
});

describe("agent decision validation", () => {
  it("accepts the approved target", () => {
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.53, reason: "WETH_ABOVE_MAX_ALLOCATION" }, 53).ok).toBe(true);
  });
  it("rejects injection-shaped, malformed, and off-policy output", () => {
    expect(validateDecision({ decision: "TRANSFER", to: "0xATTACKER", reason: "x" }, 53).ok).toBe(false);
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.53, reason: "x", router: "0xdead" }, 53).ok).toBe(false);
    expect(validateDecision({ decision: "REBALANCE", targetWethWeight: 0.1, reason: "x" }, 53).ok).toBe(false);
    expect(validateDecision({ decision: "WAIT", reason: "x".repeat(501) }, 53).ok).toBe(false);
    expect(validateDecision("not json", 53).ok).toBe(false);
  });
});
