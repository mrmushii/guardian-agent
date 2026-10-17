import { pad, parseAbi, toFunctionSelector, toHex, type Address, type PublicClient } from "viem";
import { toPermissionValidator } from "@zerodev/permissions";
import type { ModularSigner } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import type { NetworkConfig } from "@guardian/chain";
import type { CompiledAuthority } from "@guardian/policy";
import { ENTRY_POINT, KERNEL_VERSION } from "./kernel.js";

export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
export const EXACT_INPUT_SINGLE = toFunctionSelector(swapRouterAbi[0]);
export const EXACT_OUTPUT_SINGLE = toFunctionSelector(swapRouterAbi[1]);

/** ZeroDev RateLimitPolicyWithReset (SDK constant, not exported). Gate 0 addendum: the count resets after `interval`. */
export const RATE_LIMIT_WITH_RESET: Address = "0x6a06358e6b283921deceabe7e8a3741d506cca9b";

/**
 * Permission layout version, persisted with each compilation so an installed permission can always be rebuilt
 * byte-for-byte (its identifier must match). 1: sell-only, session-total op count. 2: sell + buy, per-window count.
 */
export type PermissionVersion = 1 | 2;
export const CURRENT_PERMISSION_VERSION: PermissionVersion = 2;

const word = (v: bigint | number | Address) => pad(typeof v === "string" ? v : toHex(v), { size: 32 });
const rule = (offset: number, condition: ParamCondition, v: bigint | number | Address) => ({ offset, condition, params: [word(v)] });

export interface AgentPermissionInput {
  network: NetworkConfig;
  smartAccount: Address;
  sessionSigner: ModularSigner;
  compiled: CompiledAuthority;
  /** Cumulative gas cost (wei) the session may consume. */
  gasAllowanceWei: bigint;
  version: PermissionVersion;
}

/**
 * Compiled authority → on-chain session permission. Rule offsets proven in Gate 0 (and the two-way addendum):
 * both param tuples are all-static, so field i is the 32-byte word at offset i × 32.
 * Sell (exactInputSingle): amountOutMinimum (offset 160) is intentionally unconstrained — market quality is off-chain.
 * Buy (exactOutputSingle): amountInMaximum (offset 160) ≤ USDC cap, so the most it can spend is bound on-chain.
 * Policy order fixes PolicyFailed(i) indexes: 0 call, 1 timestamp, 2 rate limit, 3 gas.
 */
export function agentPolicies({ network: n, smartAccount, compiled, gasAllowanceWei, version }: Omit<AgentPermissionInput, "sessionSigner">) {
  const sell = { target: n.swapRouter02, selector: EXACT_INPUT_SINGLE, valueLimit: 0n, rules: [
    rule(0, ParamCondition.EQUAL, n.weth),
    rule(32, ParamCondition.EQUAL, n.usdc),
    rule(64, ParamCondition.EQUAL, n.feeTier),
    rule(96, ParamCondition.EQUAL, smartAccount),
    rule(128, ParamCondition.LESS_THAN_OR_EQUAL, compiled.maxAmountInWei),
    rule(192, ParamCondition.EQUAL, 0n),
  ] };
  const buy = { target: n.swapRouter02, selector: EXACT_OUTPUT_SINGLE, valueLimit: 0n, rules: [
    rule(0, ParamCondition.EQUAL, n.usdc),
    rule(32, ParamCondition.EQUAL, n.weth),
    rule(64, ParamCondition.EQUAL, n.feeTier),
    rule(96, ParamCondition.EQUAL, smartAccount),
    rule(160, ParamCondition.LESS_THAN_OR_EQUAL, compiled.maxUsdcInRaw),
    rule(192, ParamCondition.EQUAL, 0n),
  ] };
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: version === 1 ? [sell] : [sell, buy] }),
    toTimestampPolicy({ validAfter: Math.floor(compiled.validAfter.getTime() / 1000), validUntil: Math.floor(compiled.validUntil.getTime() / 1000) }),
    version === 1
      // v1: interval 0, count is session-wide with no reset (Gate 0 evidence).
      ? toRateLimitPolicy({ count: compiled.maxOps, interval: 0 })
      // v2: count per window, restored after windowSec (Gate 0 two-way addendum).
      : toRateLimitPolicy({ policyAddress: RATE_LIMIT_WITH_RESET, count: compiled.maxOps, interval: compiled.windowSec }),
    toGasPolicy({ allowed: gasAllowanceWei, enforcePaymaster: true, allowedPaymaster: n.paymaster }),
  ];
}

export function buildAgentPermission(client: PublicClient, input: AgentPermissionInput) {
  return toPermissionValidator(client, {
    entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, signer: input.sessionSigner, policies: agentPolicies(input),
  });
}
