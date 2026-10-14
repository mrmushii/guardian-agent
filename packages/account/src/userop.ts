import type { Chain } from "viem";
import type { SmartAccount, UserOperation } from "viem/account-abstraction";
import { ENTRY_POINT, createPaymaster, type HexCall } from "./kernel.js";

/**
 * Builds and signs a sponsored UserOperation with explicit gas limits, without bundler estimation.
 * For simulation/security harnesses, where the op must be constructed even if it will fail.
 * Production submission uses createSponsoredClient (bundler-estimated gas).
 */
export async function buildSignedUserOp(account: SmartAccount, chain: Chain, apiKey: string, o: {
  calls: HexCall[]; nonceOffset?: bigint; verificationGasLimit?: bigint; callGasLimit?: bigint; withFactory?: boolean;
}): Promise<UserOperation<"0.7">> {
  const paymaster = createPaymaster(chain.id, apiKey);
  const fees = (await paymaster.getUserOperationGasPrice()).fast;
  const op: UserOperation<"0.7"> = {
    sender: account.address,
    nonce: (await account.getNonce()) + (o.nonceOffset ?? 0n),
    callData: await account.encodeCalls(o.calls),
    callGasLimit: o.callGasLimit ?? 800_000n, verificationGasLimit: o.verificationGasLimit ?? 2_000_000n, preVerificationGas: 120_000n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, signature: "0x",
    ...(o.withFactory ? await account.getFactoryArgs() : {}),
    paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n,
  };
  Object.assign(op, await paymaster.getPaymasterData({ ...op, chainId: chain.id, entryPointAddress: ENTRY_POINT.address }));
  op.signature = await account.signUserOperation(op);
  return op;
}
