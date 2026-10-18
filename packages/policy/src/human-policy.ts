import { z } from "zod";

/** USD amount with at most 2 decimal places, converted losslessly to cents. */
const usd = z
  .number()
  .positive()
  .refine((v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, {
    message: "USD amounts allow at most 2 decimal places",
  });

const pct = z.number().int().min(0).max(100);

/**
 * Owner-approved financial policy. The `eth*` fields denote the WETH share of the
 * WETH+USDC strategy portfolio (native ETH is not part of the strategy).
 */
export const HumanPolicySchema = z
  .strictObject({
    ethMinPct: pct,
    ethMaxPct: pct,
    targetEthPct: pct,
    maxAutoTxUsd: usd,
    dailyBudgetUsd: usd,
    maxSlippageBps: z.number().int().min(0).max(10_000),
    sessionDurationHours: z.number().int().positive(),
    /** Step toward target at Tier 1 (capped trades) instead of escalating a cap-exceeding move. Default true. */
    allowPartialAutonomy: z.boolean().optional(),
    /**
     * v3 multi-asset targets (whole percents summing to 100; USDC is the hub and must be listed). When present, the
     * portfolio rebalances when any asset drifts more than `driftPct` points from its target. The `eth*` fields then
     * mirror the WETH entry (target ± drift) so two-asset readers keep working.
     */
    assets: z.array(z.strictObject({ symbol: z.string().min(1).max(12), targetPct: pct })).min(2).max(8).optional(),
    driftPct: z.number().int().min(1).max(50).optional(),
  })
  .refine((p) => !p.assets || p.assets.reduce((s, a) => s + a.targetPct, 0) === 100, { message: "Asset targets must add up to 100%" })
  .refine((p) => !p.assets || p.assets.some((a) => a.symbol === "USDC"), { message: "USDC must be in the portfolio (every asset trades through it)" })
  .refine((p) => !p.assets || new Set(p.assets.map((a) => a.symbol.toUpperCase())).size === p.assets.length, { message: "Each asset can appear once" })
  .refine((p) => !p.assets || p.driftPct !== undefined, { message: "Set a drift band (driftPct) for a multi-asset portfolio" })
  .refine((p) => p.ethMinPct <= p.targetEthPct && p.targetEthPct <= p.ethMaxPct, {
    message: "Require ethMinPct <= targetEthPct <= ethMaxPct",
  })
  .refine((p) => p.maxAutoTxUsd <= p.dailyBudgetUsd, {
    message: "maxAutoTxUsd cannot exceed dailyBudgetUsd",
  });

export type HumanPolicy = z.infer<typeof HumanPolicySchema>;

export const usdToCents = (usd: number): bigint => BigInt(Math.round(usd * 100));

/** Multi-asset view of any policy: v3 targets as given, or the legacy WETH/USDC band as two targets. */
export function portfolioTargets(p: HumanPolicy): { assets: { symbol: string; targetPct: number }[]; driftPct: number; multi: boolean } {
  if (p.assets && p.driftPct !== undefined) return { assets: p.assets, driftPct: p.driftPct, multi: true };
  return { assets: [{ symbol: "WETH", targetPct: p.targetEthPct }, { symbol: "USDC", targetPct: 100 - p.targetEthPct }],
    driftPct: Math.max(1, Math.round((p.ethMaxPct - p.ethMinPct) / 2)), multi: false };
}

/**
 * Builds a v3 policy from targets + drift, keeping the legacy `eth*` fields consistent with the WETH entry
 * (or the previous values when WETH is not held). Validated by the caller with HumanPolicySchema.
 */
export function withTargets(base: HumanPolicy, assets: { symbol: string; targetPct: number }[], driftPct: number): HumanPolicy {
  const w = assets.find((a) => a.symbol === "WETH");
  const eth = w
    ? { targetEthPct: w.targetPct, ethMinPct: Math.max(0, w.targetPct - driftPct), ethMaxPct: Math.min(100, w.targetPct + driftPct) }
    : { targetEthPct: base.targetEthPct, ethMinPct: base.ethMinPct, ethMaxPct: base.ethMaxPct };
  return { ...base, ...eth, assets, driftPct };
}
