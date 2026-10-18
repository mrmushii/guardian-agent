// Multi-asset policy (v3) and planner: target weights + drift band through the USDC hub.
import { describe, expect, it } from "vitest";
import { assessMulti } from "@guardian/portfolio";
import { HumanPolicySchema, portfolioTargets, withTargets } from "@guardian/policy";

const base = { ethMinPct: 45, ethMaxPct: 55, targetEthPct: 53, maxAutoTxUsd: 10, dailyBudgetUsd: 25, maxSlippageBps: 50, sessionDurationHours: 168 };
const c = (usd: number) => BigInt(Math.round(usd * 100));

describe("policy v3", () => {
  it("accepts targets summing to 100 with USDC and a drift band, mirroring WETH into the legacy fields", () => {
    const p = HumanPolicySchema.parse(withTargets(base, [{ symbol: "WETH", targetPct: 40 }, { symbol: "cbBTC", targetPct: 20 }, { symbol: "USDC", targetPct: 40 }], 5));
    expect([p.ethMinPct, p.targetEthPct, p.ethMaxPct]).toEqual([35, 40, 45]);
    expect(portfolioTargets(p).multi).toBe(true);
  });
  it("rejects targets that do not add to 100, a missing USDC hub, duplicates, or no drift band", () => {
    const bad = (assets: { symbol: string; targetPct: number }[], drift?: number) => HumanPolicySchema.safeParse({ ...base, assets, driftPct: drift }).success;
    expect(bad([{ symbol: "WETH", targetPct: 60 }, { symbol: "USDC", targetPct: 30 }], 5)).toBe(false);
    expect(bad([{ symbol: "WETH", targetPct: 50 }, { symbol: "cbBTC", targetPct: 50 }], 5)).toBe(false);
    expect(bad([{ symbol: "WETH", targetPct: 50 }, { symbol: "WETH", targetPct: 0 }, { symbol: "USDC", targetPct: 50 }], 5)).toBe(false);
    expect(bad([{ symbol: "WETH", targetPct: 50 }, { symbol: "USDC", targetPct: 50 }])).toBe(false);
  });
  it("reads a legacy policy as WETH/USDC targets", () => {
    expect(portfolioTargets(base)).toEqual({ assets: [{ symbol: "WETH", targetPct: 53 }, { symbol: "USDC", targetPct: 47 }], driftPct: 5, multi: false });
  });
});

describe("assessMulti", () => {
  const targets = [{ symbol: "WETH", targetPct: 40 }, { symbol: "cbBTC", targetPct: 20 }, { symbol: "USDC", targetPct: 40 }];
  it("does nothing while every asset is inside the band", () => {
    const a = assessMulti([{ symbol: "WETH", usdCents: c(42) }, { symbol: "cbBTC", usdCents: c(19) }, { symbol: "USDC", usdCents: c(39) }], targets, 5);
    expect(a.drifted).toBe(false);
    expect(a.legs).toEqual([]);
  });
  it("plans sells before buys, each to target, when one asset drifts out", () => {
    const a = assessMulti([{ symbol: "WETH", usdCents: c(60) }, { symbol: "cbBTC", usdCents: c(10) }, { symbol: "USDC", usdCents: c(30) }], targets, 5);
    expect(a.drifted).toBe(true);
    expect(a.legs.map((l) => [l.symbol, l.side, Number(l.usdCents) / 100])).toEqual([["WETH", "SELL", 20], ["cbBTC", "BUY", 10]]);
  });
  it("sells down an asset that is held but no longer targeted", () => {
    const a = assessMulti([{ symbol: "WETH", usdCents: c(40) }, { symbol: "LINK", usdCents: c(20) }, { symbol: "USDC", usdCents: c(40) }],
      [{ symbol: "WETH", targetPct: 50 }, { symbol: "USDC", targetPct: 50 }], 5);
    expect(a.legs.find((l) => l.symbol === "LINK")).toMatchObject({ side: "SELL", usdCents: c(20) });
  });
  it("leaves dust below the minimum trade", () => {
    const a = assessMulti([{ symbol: "WETH", usdCents: c(70) }, { symbol: "cbBTC", usdCents: c(0.5) }, { symbol: "USDC", usdCents: c(29.5) }],
      [{ symbol: "WETH", targetPct: 70 }, { symbol: "cbBTC", targetPct: 1 }, { symbol: "USDC", targetPct: 29 }], 0.2 as never);
    expect(a.legs).toEqual([]);
  });
  it("weights always sum to 100 and planned legs restore every target", () => {
    for (let i = 0; i < 200; i++) {
      const vals = [Math.random() * 100, Math.random() * 100, Math.random() * 100 + 1];
      const h = [{ symbol: "WETH", usdCents: c(vals[0]!) }, { symbol: "cbBTC", usdCents: c(vals[1]!) }, { symbol: "USDC", usdCents: c(vals[2]!) }];
      const a = assessMulti(h, targets, 1, { minTradeCents: 1n });
      expect(Math.abs(a.weights.reduce((s, w) => s + w.pct, 0) - 100)).toBeLessThan(0.01);
      if (!a.drifted) continue;
      const after = h.map((x) => { const l = a.legs.find((y) => y.symbol === x.symbol); return l ? (l.side === "BUY" ? x.usdCents + l.usdCents : x.usdCents - l.usdCents) : x.usdCents; });
      for (const [j, t] of [[0, 40], [1, 20]] as const) expect(Math.abs(Number((after[j]! * 10_000n) / a.totalCents) / 100 - t)).toBeLessThan(0.05);
    }
  });
});
