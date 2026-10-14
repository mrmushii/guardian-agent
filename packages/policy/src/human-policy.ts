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
  })
  .refine((p) => p.ethMinPct <= p.targetEthPct && p.targetEthPct <= p.ethMaxPct, {
    message: "Require ethMinPct <= targetEthPct <= ethMaxPct",
  })
  .refine((p) => p.maxAutoTxUsd <= p.dailyBudgetUsd, {
    message: "maxAutoTxUsd cannot exceed dailyBudgetUsd",
  });

export type HumanPolicy = z.infer<typeof HumanPolicySchema>;

export const usdToCents = (usd: number): bigint => BigInt(Math.round(usd * 100));
