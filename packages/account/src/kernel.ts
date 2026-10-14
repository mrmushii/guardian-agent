import { http, type Address, type Chain, type Hex, type LocalAccount, type PublicClient } from "viem";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { toKernelPluginManager } from "@zerodev/sdk/accounts";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import type { PermissionPlugin } from "@zerodev/permissions";
import { createPimlicoClient } from "permissionless/clients/pimlico";

/**
 * Pinned by Gate 0 (docs/gate0-decision.md). Kernel v3.3 rather than v3.1: v3.1 has no
 * grantAccess, so a master-installed permission cannot be allowed to call execute().
 */
export const ENTRY_POINT = getEntryPoint("0.7");
export const KERNEL_VERSION = KERNEL_V3_3;

/** Master authority: the owner's ECDSA key as the Kernel root (sudo) validator. */
export async function createMasterAccount(client: PublicClient, owner: LocalAccount) {
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION });
  const account = await createKernelAccount(client, { plugins: { sudo }, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION });
  return { account, sudo };
}

/** Agent authority: signs only through an already-installed permission validator. */
export async function createAgentAccount(client: PublicClient, permission: PermissionPlugin, address: Address, chainId: number) {
  const plugins = await toKernelPluginManager(client, {
    regular: permission, isPreInstalled: true, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, chainId,
  });
  return createKernelAccount(client, { plugins, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, address });
}

export const pimlicoUrl = (chainId: number, apiKey: string) => `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}`;

export function createPaymaster(chainId: number, apiKey: string) {
  return createPimlicoClient({ transport: http(pimlicoUrl(chainId, apiKey)), entryPoint: ENTRY_POINT });
}

/** Sponsored UserOperation client. Gas fields come from bundler estimation, never fixed limits. */
export function createSponsoredClient(
  account: Awaited<ReturnType<typeof createKernelAccount>>, chain: Chain, publicClient: PublicClient, apiKey: string,
) {
  const paymaster = createPaymaster(chain.id, apiKey);
  return createKernelAccountClient({
    account, chain, client: publicClient, bundlerTransport: http(pimlicoUrl(chain.id, apiKey)), paymaster,
    userOperation: { estimateFeesPerGas: async () => (await paymaster.getUserOperationGasPrice()).fast },
  });
}

export type HexCall = { to: Address; value: bigint; data: Hex };
