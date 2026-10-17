import { type HumanPolicy, type UsdPrice, USDC_DECIMALS, WETH_DECIMALS, assertValidPrice } from "@guardian/policy";

export { USDC_DECIMALS };
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
  /** Overweight WETH: sell `amountInWei` (exact input) for USDC. */
  | { kind: "SELL_WETH"; valuation: Valuation; targetPct: number; saleUsd18: bigint; amountInWei: bigint }
  /** Underweight WETH: buy `wethOutWei` (exact output) with USDC. */
  | { kind: "BUY_WETH"; valuation: Valuation; targetPct: number; buyUsd18: bigint; wethOutWei: bigint };

export type TradeDirection = "SELL_WETH" | "BUY_WETH";

const usd18ToWethWei = (usd18: bigint, price: UsdPrice) =>
  (usd18 * 10n ** BigInt(WETH_DECIMALS + price.decimals)) / (price.answer * 10n ** BigInt(USD_SCALE));

/**
 * Triggers only outside [ethMinPct, ethMaxPct] (strict). The trade moves WETH weight to `targetPct`
 * (default: the policy target; the agent may choose another value inside the band):
 *   sell: V_W − T·V_T     buy: T·V_T − V_W
 * converted to WETH at the reference price and floored (rounding toward trading slightly less).
 */
export function assessRebalance(p: PortfolioInput, policy: HumanPolicy, targetPct: number = policy.targetEthPct): RebalanceAssessment {
  if (!Number.isInteger(targetPct) || targetPct < policy.ethMinPct || targetPct > policy.ethMaxPct)
    throw new Error(`targetPct ${targetPct} is outside the owner-approved band`);
  const v = valuePortfolio(p);
  if (v.wethUsd18 * 100n > BigInt(policy.ethMaxPct) * v.totalUsd18) {
    const saleUsd18 = (v.wethUsd18 * 100n - BigInt(targetPct) * v.totalUsd18) / 100n;
    return { kind: "SELL_WETH", valuation: v, targetPct, saleUsd18, amountInWei: usd18ToWethWei(saleUsd18, p.wethUsd) };
  }
  if (v.wethUsd18 * 100n < BigInt(policy.ethMinPct) * v.totalUsd18) {
    const buyUsd18 = (BigInt(targetPct) * v.totalUsd18 - v.wethUsd18 * 100n) / 100n;
    return { kind: "BUY_WETH", valuation: v, targetPct, buyUsd18, wethOutWei: usd18ToWethWei(buyUsd18, p.wethUsd) };
  }
  return { kind: "WITHIN_BAND", valuation: v };
}

/** USD size of an out-of-band assessment (null when within band). */
export const tradeUsd18 = (a: RebalanceAssessment): bigint | null =>
  a.kind === "SELL_WETH" ? a.saleUsd18 : a.kind === "BUY_WETH" ? a.buyUsd18 : null;
