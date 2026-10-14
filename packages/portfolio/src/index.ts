import { type HumanPolicy, type UsdPrice, WETH_DECIMALS, assertValidPrice } from "@guardian/policy";

export const USDC_DECIMALS = 6;
/** Internal USD fixed-point scale for valuation (not a token amount). */
const USD_SCALE = 18;

export interface PortfolioInput {
  wethWei: bigint;
  usdcRaw: bigint;
  wethUsd: UsdPrice;
  usdcUsd: UsdPrice;
}

export interface Valuation {
  /** USD values with 18 decimals. */
  wethUsd18: bigint;
  usdcUsd18: bigint;
  totalUsd18: bigint;
  /** WETH weight in basis points, floored (display only; decisions use exact comparisons). */
  wethWeightBps: bigint;
}

function toUsd18(amount: bigint, tokenDecimals: number, price: UsdPrice): bigint {
  assertValidPrice(price);
  if (amount < 0n) throw new Error("Negative balance");
  return (amount * price.answer * 10n ** BigInt(USD_SCALE)) / 10n ** BigInt(tokenDecimals + price.decimals);
}

export function valuePortfolio(p: PortfolioInput): Valuation {
  const wethUsd18 = toUsd18(p.wethWei, WETH_DECIMALS, p.wethUsd);
  const usdcUsd18 = toUsd18(p.usdcRaw, USDC_DECIMALS, p.usdcUsd);
  const totalUsd18 = wethUsd18 + usdcUsd18;
  if (totalUsd18 === 0n) throw new Error("Empty portfolio cannot be valued");
  return { wethUsd18, usdcUsd18, totalUsd18, wethWeightBps: (wethUsd18 * 10_000n) / totalUsd18 };
}

export type RebalanceAssessment =
  | { kind: "WITHIN_BAND"; valuation: Valuation }
  /** Reverse-direction (USDC → WETH) execution is outside the MVP. */
  | { kind: "UNDERWEIGHT_NO_EXECUTION"; valuation: Valuation }
  | { kind: "SELL_WETH"; valuation: Valuation; saleUsd18: bigint; amountInWei: bigint };

/**
 * Triggers only when WETH weight is strictly above ethMaxPct.
 * Sale: V_W − T·V_T, converted to WETH at the reference price and floored
 * (rounding toward selling slightly less).
 */
export function assessRebalance(p: PortfolioInput, policy: HumanPolicy): RebalanceAssessment {
  const v = valuePortfolio(p);
  if (v.wethUsd18 * 100n > BigInt(policy.ethMaxPct) * v.totalUsd18) {
    const saleUsd18 = (v.wethUsd18 * 100n - BigInt(policy.targetEthPct) * v.totalUsd18) / 100n;
    const amountInWei =
      (saleUsd18 * 10n ** BigInt(WETH_DECIMALS + p.wethUsd.decimals)) / (p.wethUsd.answer * 10n ** BigInt(USD_SCALE));
    return { kind: "SELL_WETH", valuation: v, saleUsd18, amountInWei };
  }
  if (v.wethUsd18 * 100n < BigInt(policy.ethMinPct) * v.totalUsd18) {
    return { kind: "UNDERWEIGHT_NO_EXECUTION", valuation: v };
  }
  return { kind: "WITHIN_BAND", valuation: v };
}
