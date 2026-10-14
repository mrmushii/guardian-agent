// Gate 0 dry run: build, sponsor-quote, sign and bundler-SIMULATE a Kernel UserOperation.
// Never calls eth_sendUserOperation — nothing is broadcast, no funds are spent.
import { createPublicClient, http, zeroAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getUserOperationHash } from "viem/account-abstraction";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createPimlicoClient } from "permissionless/clients/pimlico";

const env = process.env;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1; // candidate; to be pinned in the Gate 0 manifest
const pimlicoUrl = `https://api.pimlico.io/v2/${baseSepolia.id}/rpc?apikey=${env.PIMLICO_API_KEY}`;

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const owner = privateKeyToAccount(env.TESTNET_OWNER_PRIVATE_KEY as `0x${string}`);
const sudo = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion });
const account = await createKernelAccount(publicClient, { plugins: { sudo }, entryPoint, kernelVersion });
const deployed = !!(await publicClient.getCode({ address: account.address }));

const pimlico = createPimlicoClient({ transport: http(pimlicoUrl), entryPoint });
const client = createKernelAccountClient({
  account, chain: baseSepolia, client: publicClient, bundlerTransport: http(pimlicoUrl), paymaster: pimlico,
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
});

// Harmless no-op: zero-value empty call to the zero address.
const userOp = await client.prepareUserOperation({ calls: [{ to: zeroAddress, value: 0n, data: "0x" }] });
userOp.signature = await account.signUserOperation(userOp);
const hash = getUserOperationHash({ userOperation: userOp, entryPointAddress: entryPoint.address, entryPointVersion: "0.7", chainId: baseSepolia.id });

console.log(JSON.stringify({
  network: "Base Sepolia (84532)",
  entryPoint: entryPoint.address,
  kernelVersion,
  masterOwner: owner.address,
  smartAccount: account.address,
  smartAccountDeployed: deployed,
  includesFactoryDeployment: !!userOp.factory,
  paymaster: userOp.paymaster ?? null,
  gas: { callGasLimit: `${userOp.callGasLimit}`, verificationGasLimit: `${userOp.verificationGasLimit}`, preVerificationGas: `${userOp.preVerificationGas}` },
  signedLocally: true,
  userOpHashIfSubmitted: hash,
  submitted: false,
}, null, 2));
