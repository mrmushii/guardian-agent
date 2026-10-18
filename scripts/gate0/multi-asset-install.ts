// Gate 0 addendum 2b (Base Sepolia): batch install + batch revoke of per-asset permissions. SIMULATION ONLY
// (eth_simulateV1 → EntryPoint.handleOps, sequential blocks; nothing is broadcast).
//
// Question: can the owner install several per-asset permissions in ONE master UserOperation
// (authorizeAgentCallsMulti: one installValidations call with arrays), use each key, and remove them all in one
// revocation (revokeAgentCallsMulti), after which the keys are rejected?
import {
  createPublicClient, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeFunctionData, http,
  keccak256, numberToHex, parseAbi, type Address, type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { createKernelAccount, KernelV3_3AccountAbi } from "@zerodev/sdk";
import { toKernelPluginManager } from "@zerodev/sdk/accounts";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { KERNEL_VERSION, authorizeAgentCallsMulti, buildAgentPermission, revokeAgentCallsMulti, swapRouterAbi } from "@guardian/account";
import { BASE_SEPOLIA } from "@guardian/chain";
import type { CompiledAuthority } from "@guardian/policy";
import { writeFileSync, mkdirSync } from "node:fs";

const env = process.env;
const N = BASE_SEPOLIA;
const ASSET_B: Address = "0x1111111111111111111111111111111111111111";
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_VERSION;
const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const pimlico = createPimlicoClient({ transport: http(`https://api.pimlico.io/v2/${baseSepolia.id}/rpc?apikey=${env.PIMLICO_API_KEY}`), entryPoint });
const owner = privateKeyToAccount(env.TESTNET_OWNER_PRIVATE_KEY as Hex);
const harness = privateKeyToAccount(env.TESTNET_HARNESS_PRIVATE_KEY as Hex).address;
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const now = Math.floor(Date.now() / 1000);

const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion });
const master = await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion });
const account = master.address;
if (!(await client.getCode({ address: account }))) throw new Error("expects the deployed owner account");

// Two per-asset permissions built exactly as production does (v2 layout per asset market).
const compiled = (maxIn: bigint, usdcCap: bigint): CompiledAuthority => ({
  maxAmountInWei: maxIn, maxUsdcInRaw: usdcCap, maxOps: 6, windowSec: 86_400, totalOps: 42, allowanceWei: maxIn * 42n, usdcAllowanceRaw: usdcCap * 42n,
  validAfter: new Date((now - 60) * 1000), validUntil: new Date((now + 7 * 86_400) * 1000),
  evidence: { maxAutoTxUsdCents: 1000n, authPrice: { answer: 1n, decimals: 8 }, authPriceSource: "gate", authPriceTimestamp: new Date(), bufferBps: 0 },
});
const marketB = { ...N, weth: ASSET_B };
async function perm(n: typeof N, c: CompiledAuthority) {
  const signer = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const permission = await buildAgentPermission(client, { network: n, smartAccount: account, sessionSigner: signer, compiled: c, gasAllowanceWei: 10n ** 16n, version: 2 });
  const agent = await createKernelAccount(client, { plugins: await toKernelPluginManager(client, { regular: permission, isPreInstalled: true, entryPoint, kernelVersion, chainId: baseSepolia.id }), entryPoint, kernelVersion, address: account });
  return { permission, agent };
}
const W = await perm(N, compiled(3_000_000_000_000_000n, 10_000_000n));
const B = await perm(marketB, compiled(30_000_000_000_000_000n, 4_000_000n));

const validationNonce = await client.readContract({ address: account, abi: KernelV3_3AccountAbi, functionName: "currentNonce" });
const authCalls = await authorizeAgentCallsMulti(N, account, [
  { permission: W.permission, token: N.weth, allowance: 10n ** 17n }, { permission: B.permission, token: ASSET_B, allowance: 10n ** 18n }], 500_000_000n, validationNonce);
const revokeCalls = await revokeAgentCallsMulti(N, account, [{ permission: W.permission, token: N.weth }, { permission: B.permission, token: ASSET_B }]);

const sell = (tokenIn: Address, amountIn: bigint) => ({ to: N.swapRouter02, value: 0n, data: encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInputSingle",
  args: [{ tokenIn, tokenOut: N.usdc, fee: N.feeTier, recipient: account, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) });

const fees = (await pimlico.getUserOperationGasPrice()).fast;
type Acct = typeof master;
async function buildOp(acct: Acct, calls: { to: Address; value: bigint; data: Hex }[], nonceBump = 0n): Promise<UserOperation<"0.7">> {
  const op: UserOperation<"0.7"> = {
    sender: account, nonce: (await acct.getNonce()) + nonceBump, callData: await acct.encodeCalls(calls),
    callGasLimit: 9_000_000n, verificationGasLimit: 3_000_000n, preVerificationGas: 200_000n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, signature: "0x",
  };
  const pm = await pimlico.getPaymasterData({ ...op, paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n, chainId: baseSepolia.id, entryPointAddress: entryPoint.address });
  Object.assign(op, { paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n }, pm);
  op.signature = await acct.signUserOperation(op);
  return op;
}

const mapSlot = (key: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const stateOverrides = [{ address: N.weth, stateDiff: [{ slot: mapSlot(account, 3n), value: numberToHex(10n ** 18n, { size: 32 }) }] }];
void erc20Abi;

type Result = "VALIDATION_REJECTED" | "EXECUTED_SUCCESS" | "EXECUTION_FAILED" | "CALL_FAILED";
async function simulate(ops: UserOperation<"0.7">[]) {
  const res = await client.simulateBlocks({ blocks: ops.map((op, i) => ({
    ...(i === 0 ? { stateOverrides } : {}), blockOverrides: { time: BigInt(now + 30 + i * 12) },
    calls: [{ account: harness, to: entryPoint.address, gas: 25_000_000n,
      data: encodeFunctionData({ abi: entryPoint07Abi, functionName: "handleOps", args: [[toPackedUserOperation(op)], harness] }) }] })), validation: false } as never);
  return res.map((b): { result: Result; detail: string } => {
    const c = b.calls[0]!;
    if (c.status === "failure") {
      let detail = c.error?.message.split("\n")[0] ?? "reverted";
      try { const d = decodeErrorResult({ abi: entryPoint07Abi, data: c.data }); detail = `${d.errorName}(${d.args?.map(String).join(", ")})`; } catch {}
      return { result: /AA2|AA3|FailedOp/.test(detail) ? "VALIDATION_REJECTED" : "CALL_FAILED", detail };
    }
    let ok: boolean | undefined, reason = "";
    for (const l of c.logs ?? []) { try { const e = decodeEventLog({ abi: entryPoint07Abi, data: l.data, topics: l.topics });
      if (e.eventName === "UserOperationEvent") ok = e.args.success;
      if (e.eventName === "UserOperationRevertReason") reason = e.args.revertReason; } catch {} }
    return ok ? { result: "EXECUTED_SUCCESS", detail: "success=true" } : { result: "EXECUTION_FAILED", detail: `success=false ${reason}`.trim() };
  });
}

type Expect = "EXECUTED_SUCCESS" | "AUTHORIZED" | "VALIDATION_REJECTED";
const steps: [string, Expect, UserOperation<"0.7">][] = [
  ["Owner: install WETH + B permissions in one batch (approve each, one USDC approve, installValidations[2], grant execute ×2)", "EXECUTED_SUCCESS", await buildOp(master, authCalls)],
  ["WETH key sells WETH within its cap", "AUTHORIZED", await buildOp(W.agent, [sell(N.weth, 3_000_000_000_000_000n)])],
  ["B key sells B within its (larger) cap", "AUTHORIZED", await buildOp(B.agent, [sell(ASSET_B, 30_000_000_000_000_000n)])],
  ["WETH key cannot sell B", "VALIDATION_REJECTED", await buildOp(W.agent, [sell(ASSET_B, 1n)], 1n)],
  ["Owner: revoke both in one batch (deny execute, uninstall ×2, clear allowances)", "EXECUTED_SUCCESS", await buildOp(master, revokeCalls, 1n)],
  ["WETH key after revocation", "VALIDATION_REJECTED", await buildOp(W.agent, [sell(N.weth, 1n)], 1n)],
  ["B key after revocation", "VALIDATION_REJECTED", await buildOp(B.agent, [sell(ASSET_B, 1n)], 1n)],
];
const results = await simulate(steps.map((s) => s[2]));
const cases = steps.map(([name, expect], i) => {
  const o = results[i]!;
  const pass = expect === "AUTHORIZED" ? o.result === "EXECUTED_SUCCESS" || o.result === "EXECUTION_FAILED" : o.result === expect;
  return { name, expect, ...o, pass };
});
const allPass = cases.every((c) => c.pass);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/gate0-multi-asset-install.json", JSON.stringify({ generatedAt: new Date().toISOString(), network: "Base Sepolia (84532)",
  method: "eth_simulateV1 → EntryPoint.handleOps (no broadcast), sequential blocks", smartAccount: account, validationNonce, cases, allPass }, null, 2));
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  → ${c.result}: ${c.detail.slice(0, 140)}`);
console.log(allPass ? "\nALL CASES MATCH EXPECTATIONS" : "\nSOME CASES DID NOT MATCH");
