// Gate A by simulation (Base Sepolia, eth_simulateV1, no broadcast):
// agent-before-authorization → master authorize → agent swap → over-cap → master revoke → agent-after-revoke.
import { createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, numberToHex, decodeFunctionResult, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { BASE_SEPOLIA as N } from "@guardian/chain";
import { HumanPolicySchema, compilePolicy } from "@guardian/policy";
import { authorizeAgentCalls, buildAgentPermission, buildSignedUserOp, createAgentAccount, createMasterAccount, revokeAgentCalls, swapRouterAbi } from "@guardian/account";
import { simulateHandleOps, type StepOutcome } from "@guardian/simulation";
import { writeFileSync, mkdirSync } from "node:fs";

const env = process.env, key = env.PIMLICO_API_KEY!;
const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const beneficiary = privateKeyToAccount(env.TESTNET_HARNESS_PRIVATE_KEY as Hex).address;
const { account: master } = await createMasterAccount(client, privateKeyToAccount(env.TESTNET_OWNER_PRIVATE_KEY as Hex));
const account = master.address;
if (!(await client.getCode({ address: account }))) throw new Error("run scripts/setup-account.ts first");

const [, answer, , updatedAt] = await client.readContract({ address: N.chainlinkEthUsd, abi: [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }], functionName: "latestRoundData" });
const now = Math.floor(Date.now() / 1000);
const policy = HumanPolicySchema.parse({ ethMinPct: 45, ethMaxPct: 55, targetEthPct: 53, maxAutoTxUsd: 10, dailyBudgetUsd: 25, maxSlippageBps: 50, sessionDurationHours: 24 });
const compiled = compilePolicy({ policy, authPrice: { answer, decimals: 8 }, authPriceSource: `chainlink:${N.chainlinkEthUsd}`, authPriceTimestamp: new Date(Number(updatedAt) * 1000), bufferBps: 1500, usdcAuthPrice: { answer: 10n ** 8n, decimals: 8 }, usdcBufferBps: 200, maxOpsPerWindow: 2, windowSec: 86_400, /* v1-equivalent: one 24 h window = 2 ops per session */ authorizedAt: new Date((now - 60) * 1000) });

const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
const permission = await buildAgentPermission(client, { network: N, smartAccount: account, sessionSigner, compiled, gasAllowanceWei: 10n ** 16n, version: 1 });
const agent = await createAgentAccount(client, permission, account, baseSepolia.id);
const validationNonce = await client.readContract({ address: account, abi: KernelV3_3AccountAbi, functionName: "currentNonce" });

const swap = (amountIn: bigint) => ({ to: N.swapRouter02, value: 0n, data: encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInputSingle",
  args: [{ tokenIn: N.weth, tokenOut: N.usdc, fee: N.feeTier, recipient: account, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });
const allowanceCall = (label: string) => ({ kind: "call" as const, label, to: N.weth, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [account, N.swapRouter02] }) });
const op = (acct: typeof master, calls: ReturnType<typeof swap>[], nonceOffset = 0n) => buildSignedUserOp(acct, baseSepolia, key, { calls, nonceOffset, verificationGasLimit: 3_000_000n, callGasLimit: 4_000_000n });

const cap = compiled.maxAmountInWei;
const blocks = [
  { steps: [
    { kind: "userop" as const, label: "Agent swap BEFORE authorization", op: await op(agent, [swap(cap)]) },
    { kind: "userop" as const, label: "Master: authorize (bounded approve + install permission)", op: await op(master, await authorizeAgentCalls(N, account, permission, { weth: compiled.allowanceWei }, validationNonce)) },
    allowanceCall("WETH allowance after authorize"),
    { kind: "userop" as const, label: "Agent swap at cap after authorization", op: await op(agent, [swap(cap)]) },
    { kind: "userop" as const, label: "Agent swap cap+1 wei", op: await op(agent, [swap(cap + 1n)], 1n) },
  ] },
  { time: now + 120, steps: [
    { kind: "userop" as const, label: "Master: revoke (uninstall + clear allowance)", op: await op(master, await revokeAgentCalls(N, account, permission, true), 1n) },
    allowanceCall("WETH allowance after revoke"),
    { kind: "userop" as const, label: "Agent swap AFTER revocation", op: await op(agent, [swap(cap / 2n)], 1n) },
  ] },
];
const expected: StepOutcome["result"][] = ["VALIDATION_REJECTED", "EXECUTED_SUCCESS", "CALL_OK", "EXECUTED_SUCCESS", "VALIDATION_REJECTED", "EXECUTED_SUCCESS", "CALL_OK", "VALIDATION_REJECTED"];

// Simulated WETH balance only; allowance is set by the master's authorize op itself.
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, 3n]));
const outcomes = await simulateHandleOps(client, { beneficiary, blocks, watchTokens: [N.weth, N.usdc],
  stateOverrides: [{ address: N.weth, stateDiff: [{ slot, value: numberToHex(10n ** 18n, { size: 32 }) }] }] });

const allowanceOf = (o: StepOutcome) => o.returnData ? `${decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: o.returnData })}` : "?";
const rows = outcomes.map((o, i) => ({ ...o, expect: expected[i], pass: o.result === expected[i] && (o.label !== "WETH allowance after authorize" || allowanceOf(o) === `${compiled.allowanceWei}`) && (o.label !== "WETH allowance after revoke" || allowanceOf(o) === "0"),
  ...(o.kind === undefined && o.returnData ? { allowance: allowanceOf(o) } : {}) }));
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.label} → ${r.result}: ${r.detail}${r.returnData ? ` (allowance ${allowanceOf(r)}; expected ${r.label.includes("revoke") ? 0 : compiled.allowanceWei})` : ""}`);
const allPass = rows.every((r) => r.pass);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/gate-a-simulation.json", JSON.stringify({ generatedAt: new Date().toISOString(), method: "eth_simulateV1 → EntryPoint.handleOps (no broadcast)",
  smartAccount: account, permissionId: permission.getIdentifier(), validationNonce, compiled: { maxAmountInWei: `${cap}`, allowanceWei: `${compiled.allowanceWei}`, maxOps: compiled.maxOps },
  stateOverrides: "WETH balance 1 WETH for the smart account (simulation only)", steps: rows, allPass }, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
console.log(allPass ? "\nALL STEPS MATCH EXPECTATIONS" : "\nSOME STEPS DID NOT MATCH");
