// Deploys the master-owned Kernel smart account on Base Sepolia with a sponsored no-op UserOperation.
// TESTNET ONLY. Idempotent: does nothing if the account is already deployed.
import { createPublicClient, http, zeroAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { createMasterAccount, createSponsoredClient } from "@guardian/account";

const env = process.env;
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const { account } = await createMasterAccount(publicClient, privateKeyToAccount(env.TESTNET_OWNER_PRIVATE_KEY as Hex));

if (await publicClient.getCode({ address: account.address })) {
  console.log(`Already deployed: ${account.address}`);
} else {
  const client = createSponsoredClient(account, baseSepolia, publicClient, env.PIMLICO_API_KEY!);
  const userOpHash = await client.sendUserOperation({ calls: [{ to: zeroAddress, value: 0n, data: "0x" }] });
  console.log(`UserOperation submitted: ${userOpHash}`);
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
  console.log(JSON.stringify({ smartAccount: account.address, userOpHash, success: receipt.success,
    transactionHash: receipt.receipt.transactionHash, block: `${receipt.receipt.blockNumber}`,
    bundler: receipt.receipt.from, explorer: `https://sepolia.basescan.org/tx/${receipt.receipt.transactionHash}` }, null, 2));
}
await new Promise((r) => setTimeout(r, 4000)); // RPC catch-up after inclusion
const nonce = await publicClient.readContract({ address: account.address, abi: KernelV3_3AccountAbi, functionName: "currentNonce" });
console.log(`Kernel validation currentNonce: ${nonce}`);
