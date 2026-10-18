import { type HumanPolicy, usdToCents } from "./human-policy.js";
import { type UsdPrice, assertValidPrice } from "./price.js";

export const WETH_DECIMALS = 18;
export const USDC_DECIMALS = 6;

export interface CompileInput {
  policy: HumanPolicy;
  /** WETH/USD reference price at authorization time (P_auth). */
  authPrice: UsdPrice;
  /** USDC/USD reference price at authorization time (buy-side cap). */
  usdcAuthPrice: UsdPrice;
  authPriceSource: string;
  authPriceTimestamp: Date;
  /** Appreciation safety buffer b, in basis points (plan proposes 1500 = 15%). */
  bufferBps: number;
  /** USDC depeg safety buffer, in basis points (USDC worth more than $1 shrinks the cap). */
  usdcBufferBps: number;
  /** Maximum autonomous operations per rate-limit window. */
  maxOpsPerWindow: number;
  /** Rate-limit window length; the count resets after it (Gate 0 addendum). */
  windowSec: number;
  authorizedAt: Date;
  /** Decimals of the asset sold for USDC (default WETH, 18). Multi-asset: one compilation per asset. */
  assetDecimals?: number;
}

/** Auditable result; on-chain values only. USD limits stay off-chain. */
export interface CompiledAuthority {
  /** Sell side: exactInputSingle amountIn ceiling (WETH wei). */
  maxAmountInWei: bigint;
  /** Buy side: exactOutputSingle amountInMaximum ceiling (USDC raw, 6 dp). */
  maxUsdcInRaw: bigint;
  /** Operations per window (rate limit). */
  maxOps: number;
  windowSec: number;
  /** Most operations the session can ever validate: maxOps × windows in the session. */
  totalOps: number;
  /** Bounded router allowances: per-op cap × totalOps. Never unlimited. */
  allowanceWei: bigint;
  usdcAllowanceRaw: bigint;
  validAfter: Date;
  validUntil: Date;
  evidence: {
    maxAutoTxUsdCents: bigint;
    authPrice: UsdPrice;
    authPriceSource: string;
    authPriceTimestamp: Date;
    bufferBps: number;
  };
}

/** floor(cents / (price × (1 + buffer)) × 10^decimals), exact in integers. */
function tokenCeiling(cents: bigint, price: UsdPrice, bufferBps: number, decimals: number): bigint {
  return (cents * 10n ** BigInt(decimals + price.decimals) * 10_000n) / (100n * price.answer * BigInt(10_000 + bufferBps));
}

/** maxAmountInWei = floor(C / (P_auth × (1 + b)) × 10^18); maxUsdcInRaw likewise at the USDC price. */
export function compilePolicy(input: CompileInput): CompiledAuthority {
  const { policy, authPrice, usdcAuthPrice, bufferBps, usdcBufferBps, maxOpsPerWindow, windowSec, authorizedAt } = input;
  assertValidPrice(authPrice);
  assertValidPrice(usdcAuthPrice);
  for (const [k, v] of [["bufferBps", bufferBps], ["usdcBufferBps", usdcBufferBps]] as const)
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer`);
  if (!Number.isInteger(maxOpsPerWindow) || maxOpsPerWindow < 1) throw new Error("maxOpsPerWindow must be a positive integer");
  if (!Number.isInteger(windowSec) || windowSec < 1) throw new Error("windowSec must be a positive integer");

  const cents = usdToCents(policy.maxAutoTxUsd);
  const maxAmountInWei = tokenCeiling(cents, authPrice, bufferBps, input.assetDecimals ?? WETH_DECIMALS);
  const maxUsdcInRaw = tokenCeiling(cents, usdcAuthPrice, usdcBufferBps, USDC_DECIMALS);
  if (maxAmountInWei === 0n || maxUsdcInRaw === 0n) throw new Error("Compiled ceiling rounds to zero");

  const durationSec = policy.sessionDurationHours * 3_600;
  const totalOps = maxOpsPerWindow * Math.ceil(durationSec / windowSec);
  return {
    maxAmountInWei,
    maxUsdcInRaw,
    maxOps: maxOpsPerWindow,
    windowSec,
    totalOps,
    allowanceWei: maxAmountInWei * BigInt(totalOps),
    usdcAllowanceRaw: maxUsdcInRaw * BigInt(totalOps),
    validAfter: authorizedAt,
    validUntil: new Date(authorizedAt.getTime() + durationSec * 1000),
    evidence: {
      maxAutoTxUsdCents: cents,
      authPrice,
      authPriceSource: input.authPriceSource,
      authPriceTimestamp: input.authPriceTimestamp,
      bufferBps,
    },
  };
}
