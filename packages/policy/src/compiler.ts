import { type HumanPolicy, usdToCents } from "./human-policy.js";
import { type UsdPrice, assertValidPrice } from "./price.js";

export const WETH_DECIMALS = 18;

export interface CompileInput {
  policy: HumanPolicy;
  /** WETH/USD reference price at authorization time (P_auth). */
  authPrice: UsdPrice;
  authPriceSource: string;
  authPriceTimestamp: Date;
  /** Appreciation safety buffer b, in basis points (plan proposes 1500 = 15%). */
  bufferBps: number;
  /** Maximum autonomous operations per session (plan's initial example: 2). */
  maxOps: number;
  authorizedAt: Date;
}

/** Auditable result; on-chain values only. USD limits stay off-chain. */
export interface CompiledAuthority {
  maxAmountInWei: bigint;
  maxOps: number;
  /** Bounded WETH allowance: maxAmountInWei × maxOps. Never unlimited. */
  allowanceWei: bigint;
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

/** maxAmountInWei = floor(C / (P_auth × (1 + b)) × 10^18), computed exactly in integers. */
export function compilePolicy(input: CompileInput): CompiledAuthority {
  const { policy, authPrice, bufferBps, maxOps, authorizedAt } = input;
  assertValidPrice(authPrice);
  if (!Number.isInteger(bufferBps) || bufferBps < 0) throw new Error("bufferBps must be a non-negative integer");
  if (!Number.isInteger(maxOps) || maxOps < 1) throw new Error("maxOps must be a positive integer");

  const cents = usdToCents(policy.maxAutoTxUsd);
  const numerator = cents * 10n ** BigInt(WETH_DECIMALS + authPrice.decimals) * 10_000n;
  const denominator = 100n * authPrice.answer * BigInt(10_000 + bufferBps);
  const maxAmountInWei = numerator / denominator;
  if (maxAmountInWei === 0n) throw new Error("Compiled ceiling rounds to zero");

  return {
    maxAmountInWei,
    maxOps,
    allowanceWei: maxAmountInWei * BigInt(maxOps),
    validAfter: authorizedAt,
    validUntil: new Date(authorizedAt.getTime() + policy.sessionDurationHours * 3_600_000),
    evidence: {
      maxAutoTxUsdCents: cents,
      authPrice,
      authPriceSource: input.authPriceSource,
      authPriceTimestamp: input.authPriceTimestamp,
      bufferBps,
    },
  };
}
