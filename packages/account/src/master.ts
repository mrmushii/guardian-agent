import { concatHex, encodeFunctionData, erc20Abi, pad, toFunctionSelector, zeroAddress, type Address } from "viem";
import type { PermissionPlugin } from "@zerodev/permissions";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { VALIDATOR_TYPE } from "@zerodev/sdk/constants";
import type { NetworkConfig } from "@guardian/chain";
import type { HexCall } from "./kernel.js";

export const permissionValidationId = (permission: PermissionPlugin) =>
  concatHex([VALIDATOR_TYPE.PERMISSION, pad(permission.getIdentifier(), { size: 20, dir: "right" })]);

/** Kernel execute(bytes32,bytes): the only selector the agent permission may validate for. */
export const KERNEL_EXECUTE_SELECTOR = toFunctionSelector("function execute(bytes32,bytes)");

const grantExecute = (account: Address, permission: PermissionPlugin, allow: boolean): HexCall => ({
  to: account, value: 0n,
  data: encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: "grantAccess", args: [permissionValidationId(permission), KERNEL_EXECUTE_SELECTOR, allow] }),
});

const approve = (token: Address, n: NetworkConfig, amount: bigint): HexCall => ({
  to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [n.swapRouter02, amount] }),
});

/** Bounded router allowances granted with a session. `usdc` is absent for sell-only (v1) permissions. */
export interface AgentAllowances { weth: bigint; usdc?: bigint }

/**
 * Master-only batch for "Authorize Guardian": bounded WETH (and, for two-way sessions, USDC) allowances to the
 * router (never unlimited), on-chain installation of the agent permission, and access to execute() only.
 * `validationNonce` must be the Kernel's current validation nonce.
 */
export async function authorizeAgentCalls(n: NetworkConfig, account: Address, permission: PermissionPlugin, allowance: AgentAllowances, validationNonce: number): Promise<HexCall[]> {
  if (allowance.weth <= 0n || (allowance.usdc !== undefined && allowance.usdc <= 0n)) throw new Error("allowance must be positive and bounded");
  const install = encodeFunctionData({
    abi: KernelV3_3AccountAbi, functionName: "installValidations",
    args: [[permissionValidationId(permission)], [{ nonce: validationNonce, hook: zeroAddress }], [await permission.getEnableData(account)], ["0x"]],
  });
  const approvals = [approve(n.weth, n, allowance.weth), ...(allowance.usdc !== undefined ? [approve(n.usdc, n, allowance.usdc)] : [])];
  return [...approvals, { to: account, value: 0n, data: install }, grantExecute(account, permission, true)];
}

/** Master-only batch for "Revoke Agent": uninstall the permission and optionally clear both router allowances. */
export async function revokeAgentCalls(n: NetworkConfig, account: Address, permission: PermissionPlugin, clearAllowance: boolean): Promise<HexCall[]> {
  const uninstall = encodeFunctionData({
    abi: KernelV3_3AccountAbi, functionName: "uninstallValidation",
    args: [permissionValidationId(permission), await permission.getEnableData(account), "0x"],
  });
  const calls: HexCall[] = [grantExecute(account, permission, false), { to: account, value: 0n, data: uninstall }];
  if (clearAllowance) calls.push(approve(n.weth, n, 0n), approve(n.usdc, n, 0n));
  return calls;
}
