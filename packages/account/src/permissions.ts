import { pad, parseAbi, toFunctionSelector, toHex, type Address, type PublicClient } from "viem";
import { toPermissionValidator } from "@zerodev/permissions";
import type { ModularSigner } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import type { NetworkConfig } from "@guardian/chain";
import type { CompiledAuthority } from "@guardian/policy";
import { ENTRY_POINT, KERNEL_VERSION } from "./kernel.js";

export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
export const EXACT_INPUT_SINGLE = toFunctionSelector(swapRouterAbi[0]);

const word = (v: bigint | number | Address) => pad(typeof v === "string" ? v : toHex(v), { size: 32 });
const rule = (offset: number, condition: ParamCondition, v: bigint | number | Address) => ({ offset, condition, params: [word(v)] });

export interface AgentPermissionInput {
  network: NetworkConfig;
  smartAccount: Address;
  sessionSigner: ModularSigner;
  compiled: CompiledAuthority;
  /** Cumulative gas cost (wei) the session may consume. */
  gasAllowanceWei: bigint;
}

/**
 * Compiled authority → on-chain session permission. Rule offsets proven in Gate 0:
 * ExactInputSingleParams is all-static, so field i is the 32-byte word at offset i × 32.
 * amountOutMinimum (offset 160) is intentionally unconstrained: market quality is checked off-chain.
 * Policy order fixes PolicyFailed(i) indexes: 0 call, 1 timestamp, 2 rate limit, 3 gas.
 */
export function agentPolicies({ network: n, smartAccount, compiled, gasAllowanceWei }: Omit<AgentPermissionInput, "sessionSigner">) {
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: [{
      target: n.swapRouter02, selector: EXACT_INPUT_SINGLE, valueLimit: 0n,
      rules: [
        rule(0, ParamCondition.EQUAL, n.weth),
        rule(32, ParamCondition.EQUAL, n.usdc),
        rule(64, ParamCondition.EQUAL, n.feeTier),
        rule(96, ParamCondition.EQUAL, smartAccount),
        rule(128, ParamCondition.LESS_THAN_OR_EQUAL, compiled.maxAmountInWei),
        rule(192, ParamCondition.EQUAL, 0n),
      ],
    }] }),
    toTimestampPolicy({ validAfter: Math.floor(compiled.validAfter.getTime() / 1000), validUntil: Math.floor(compiled.validUntil.getTime() / 1000) }),
    // interval 0: count is session-wide with no reset (Gate 0 evidence).
    toRateLimitPolicy({ count: compiled.maxOps, interval: 0 }),
    toGasPolicy({ allowed: gasAllowanceWei, enforcePaymaster: true, allowedPaymaster: n.paymaster }),
  ];
}

export function buildAgentPermission(client: PublicClient, input: AgentPermissionInput) {
  return toPermissionValidator(client, {
    entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, signer: input.sessionSigner, policies: agentPolicies(input),
  });
}
