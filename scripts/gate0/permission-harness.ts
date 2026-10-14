// Gate 0 permission harness (Base Sepolia). SIMULATION ONLY:
// signed UserOperations are executed through EntryPoint.handleOps inside eth_simulateV1
// against real deployed contracts. Nothing is broadcast; eth_sendUserOperation is never called.
import {
  concat, createPublicClient, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeFunctionData, http,
  keccak256, maxUint256, numberToHex, pad, parseAbi, toFunctionSelector, toHex, zeroAddress, type Address, type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { createKernelAccount } from "@zerodev/sdk";
import { toKernelPluginManager } from "@zerodev/sdk/accounts";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { KERNEL_VERSION } from "@guardian/account";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { HumanPolicySchema, compilePolicy } from "@guardian/policy";
import { minOutFromQuote } from "@guardian/dex";
import { BASE_SEPOLIA } from "@guardian/chain";
import { writeFileSync, mkdirSync } from "node:fs";

const env = process.env;
const N = BASE_SEPOLIA;
const A = { weth: N.weth, usdc: N.usdc, router: N.swapRouter02, quoter: N.quoterV2, ethUsd: N.chainlinkEthUsd, paymaster: N.paymaster,
  attacker: "0x000000000000000000000000000000000000dEaD" } as const satisfies Record<string, Address>;
const FEE = N.feeTier;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_VERSION;
const pimlicoUrl = `https://api.pimlico.io/v2/${baseSepolia.id}/rpc?apikey=${env.PIMLICO_API_KEY}`;

const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const pimlico = createPimlicoClient({ transport: http(pimlicoUrl), entryPoint });
const owner = privateKeyToAccount(env.TESTNET_OWNER_PRIVATE_KEY as Hex);
const harness = privateKeyToAccount(env.TESTNET_HARNESS_PRIVATE_KEY as Hex).address;

const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const erc20Abi = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
const SELECTOR = toFunctionSelector(routerAbi[0]);

// ---------- 1. Compile policy with the live Chainlink price (our own compiler) ----------
const [, answer, , updatedAt] = await client.readContract({ address: A.ethUsd, abi: feedAbi, functionName: "latestRoundData" });
const now = Math.floor(Date.now() / 1000);
const policy = HumanPolicySchema.parse({ ethMinPct: 45, ethMaxPct: 55, targetEthPct: 53, maxAutoTxUsd: 10, dailyBudgetUsd: 25, maxSlippageBps: 50, sessionDurationHours: 24 });
const compiled = compilePolicy({ policy, authPrice: { answer, decimals: 8 }, authPriceSource: `chainlink:${A.ethUsd}`, authPriceTimestamp: new Date(Number(updatedAt) * 1000), bufferBps: 1500, maxOps: 2, authorizedAt: new Date(now * 1000) });
const cap = compiled.maxAmountInWei;
const validAfter = now - 60, validUntil = Math.floor(compiled.validUntil.getTime() / 1000);
const GAS_ALLOWANCE_WEI = 10n ** 16n; // 0.01 ETH cumulative gas authority for the session

// ---------- 2. Accounts ----------
const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion });
const masterAccount = await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion });
const account = masterAccount.address;

const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) }); // ephemeral, never stored
const word = (v: bigint | Address | number) => pad(typeof v === "string" ? v : toHex(v), { size: 32 });
const rule = (offset: number, condition: ParamCondition, v: bigint | Address | number) => ({ offset, condition, params: [word(v)] });
const callPolicy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: [{
      target: A.router, selector: SELECTOR, valueLimit: 0n,
      // ExactInputSingleParams is all-static, so each field is one inline 32-byte word.
      rules: [
        rule(0, ParamCondition.EQUAL, A.weth),          // tokenIn
        rule(32, ParamCondition.EQUAL, A.usdc),         // tokenOut
        rule(64, ParamCondition.EQUAL, FEE),            // fee
        rule(96, ParamCondition.EQUAL, account),        // recipient
        rule(128, ParamCondition.LESS_THAN_OR_EQUAL, cap), // amountIn
        rule(192, ParamCondition.EQUAL, 0n),            // sqrtPriceLimitX96
      ],
    }] });
const timestampPolicy = toTimestampPolicy({ validAfter, validUntil });
const rateLimitPolicy = toRateLimitPolicy({ count: compiled.maxOps, interval: 0 });
const gasPolicy = toGasPolicy({ allowed: GAS_ALLOWANCE_WEI, enforcePaymaster: true, allowedPaymaster: A.paymaster });
const permission = await toPermissionValidator(client, { entryPoint, kernelVersion, signer: sessionSigner,
  policies: [callPolicy, timestampPolicy, rateLimitPolicy, gasPolicy] }); // policy indexes 0..3 (PolicyFailed(i))
// Control: identical permission WITHOUT the gas policy, to attribute gas/paymaster rejections.
const controlPermission = await toPermissionValidator(client, { entryPoint, kernelVersion, signer: sessionSigner,
  policies: [callPolicy, timestampPolicy, rateLimitPolicy] });
const controlAcct = await createKernelAccount(client, { plugins: { sudo, regular: controlPermission }, entryPoint, kernelVersion });
// Enable mode (first use carries the owner's enable signature) vs regular mode (already installed).
const enableAcct = await createKernelAccount(client, { plugins: { sudo, regular: permission }, entryPoint, kernelVersion });
// isPreInstalled: sign in default mode, as after op #1 installed the permission inside the simulation.
const regularPlugins = await toKernelPluginManager(client, { regular: permission, isPreInstalled: true, entryPoint, kernelVersion, chainId: baseSepolia.id });
const regularAcct = await createKernelAccount(client, { plugins: regularPlugins, entryPoint, kernelVersion, address: account });
if (enableAcct.address !== account) throw new Error("account address mismatch");

// ---------- 3. Quote and call builders ----------
const quote = async (amountIn: bigint) => (await client.simulateContract({ address: A.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: A.weth, tokenOut: A.usdc, amountIn, fee: FEE, sqrtPriceLimitX96: 0n }] })).result[0];
const swapAmount = cap;
const minOut = minOutFromQuote(await quote(swapAmount), policy.maxSlippageBps);
type P = { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint };
const good: P = { tokenIn: A.weth, tokenOut: A.usdc, fee: FEE, recipient: account, amountIn: swapAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
const swap = (p: Partial<P> = {}) => ({ to: A.router as Address, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ ...good, ...p }] }) });

// ---------- 4. UserOperation construction, sponsorship, signing ----------
const fees = (await pimlico.getUserOperationGasPrice()).fast;
type OpOpts = { control?: boolean; calls: { to: Address; value: bigint; data: Hex }[]; mode: "enable" | "regular"; seq?: bigint; callType?: "call" | "delegatecall";
  paymaster?: "pimlico" | "none" | "foreign"; feeMultiplier?: bigint };
async function buildOp(o: OpOpts): Promise<UserOperation<"0.7">> {
  const acct = o.control ? controlAcct : o.mode === "enable" ? enableAcct : regularAcct;
  const nonce = (await acct.getNonce()) + (o.seq ?? 0n);
  const op: UserOperation<"0.7"> = {
    sender: account, nonce,
    callData: o.callType ? await acct.encodeCalls(o.calls, o.callType) : await acct.encodeCalls(o.calls),
    callGasLimit: 600_000n, verificationGasLimit: 5_000_000n, preVerificationGas: 120_000n,
    maxFeePerGas: fees.maxFeePerGas * (o.feeMultiplier ?? 1n), maxPriorityFeePerGas: fees.maxPriorityFeePerGas, signature: "0x",
    ...(o.mode === "enable" ? await acct.getFactoryArgs() : {}),
  };
  if ((o.paymaster ?? "pimlico") === "pimlico") {
    const pm = await pimlico.getPaymasterData({ ...op, paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n, chainId: baseSepolia.id, entryPointAddress: entryPoint.address });
    Object.assign(op, { paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n }, pm);
  } else if (o.paymaster === "foreign") {
    Object.assign(op, { paymaster: "0x1111111111111111111111111111111111111111", paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n, paymasterData: "0x" });
  }
  op.signature = await acct.signUserOperation(op);
  return op;
}

// ---------- 5. Simulation through EntryPoint.handleOps in eth_simulateV1 ----------
const mapSlot = (key: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const nestedSlot = (k1: Address, k2: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [k2, mapSlot(k1, slot)]));
// WETH9 storage: balanceOf at slot 3, allowance at slot 4 (asserted below against live reads).
const wethFund = 10n ** 18n, allowance = compiled.allowanceWei;
const stateOverrides = [
  { address: account, balance: 10n ** 18n }, // so "no paymaster" cannot fail merely for lack of prefund
  { address: A.weth, stateDiff: [
    { slot: mapSlot(account, 3n), value: numberToHex(wethFund, { size: 32 }) },
    { slot: nestedSlot(account, A.router, 4n), value: numberToHex(allowance, { size: 32 }) },
  ] },
];

type Outcome = { result: "VALIDATION_REJECTED" | "EXECUTED_SUCCESS" | "EXECUTION_FAILED" | "CALL_FAILED"; detail: string; usdcReceived?: string };
async function simulate(ops: UserOperation<"0.7">[][], times?: number[]): Promise<Outcome[]> {
  const blocks = ops.map((batch, i) => ({
    ...(i === 0 ? { stateOverrides } : {}),
    blockOverrides: times?.[i] ? { time: BigInt(times[i]!) } : undefined,
    calls: batch.map((op) => ({ account: harness, to: entryPoint.address, gas: 20_000_000n,
      data: encodeFunctionData({ abi: entryPoint07Abi, functionName: "handleOps", args: [[toPackedUserOperation(op)], harness] }) })),
  }));
  const res = await client.simulateBlocks({ blocks, validation: false } as never);
  const out: Outcome[] = [];
  for (const b of res) for (const c of b.calls) {
    if (c.status === "failure") {
      let detail = c.error?.message.split("\n")[0] ?? "reverted";
      try { const d = decodeErrorResult({ abi: entryPoint07Abi, data: c.data }); detail = `${d.errorName}(${d.args?.map(String).join(", ")})`; } catch {}
      out.push({ result: /AA2|AA3|FailedOp/.test(detail) ? "VALIDATION_REJECTED" : "CALL_FAILED", detail }); continue;
    }
    let ok: boolean | undefined, reason = "", usdc = 0n;
    for (const l of c.logs ?? []) {
      try { const e = decodeEventLog({ abi: entryPoint07Abi, data: l.data, topics: l.topics });
        if (e.eventName === "UserOperationEvent") ok = e.args.success;
        if (e.eventName === "UserOperationRevertReason") reason = e.args.revertReason; } catch {}
      if (l.address.toLowerCase() === A.usdc.toLowerCase()) { try { const t = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }); if (t.eventName === "Transfer" && t.args.to.toLowerCase() === account.toLowerCase()) usdc += t.args.value; } catch {} }
    }
    out.push(ok ? { result: "EXECUTED_SUCCESS", detail: "UserOperationEvent success=true", usdcReceived: (Number(usdc) / 1e6).toFixed(6) }
               : { result: "EXECUTION_FAILED", detail: `UserOperationEvent success=false ${reason}` });
  }
  return out;
}

// ---------- 6. Sanity: storage-slot assumption for WETH9 ----------
const pool = N.pool;
const live = await client.readContract({ address: A.weth, abi: erc20Abi, functionName: "balanceOf", args: [pool] });
const raw = BigInt(await client.getStorageAt({ address: A.weth, slot: mapSlot(pool, 3n) }) ?? "0x0");
if (live !== raw) throw new Error("WETH balance slot assumption failed");

// ---------- 7. Cases ----------
const ATTACK_TRANSFER = { to: A.weth as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [A.attacker, wethFund] }) };
const exactOut = { to: A.router as Address, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactOutputSingle", args: [{ tokenIn: A.weth, tokenOut: A.usdc, fee: FEE, recipient: account, amountOut: 1n, amountInMaximum: cap, sqrtPriceLimitX96: 0n }] }) };
const single = async (name: string, expect: Outcome["result"], o: OpOpts, time?: number) => ({ name, expect, outcome: (await simulate([[await buildOp(o)]], time ? [time] : undefined))[0]! });

const cases = [] as { name: string; expect: string; outcome: Outcome }[];
cases.push(await single("Allowed swap at compiled cap (enable mode)", "EXECUTED_SUCCESS", { mode: "enable", calls: [swap()] }));
cases.push(await single("Wrong target: WETH.transfer to attacker", "VALIDATION_REJECTED", { mode: "enable", calls: [ATTACK_TRANSFER] }));
cases.push(await single("Wrong selector: exactOutputSingle", "VALIDATION_REJECTED", { mode: "enable", calls: [exactOut] }));
cases.push(await single("Wrong tokenIn (USDC)", "VALIDATION_REJECTED", { mode: "enable", calls: [swap({ tokenIn: A.usdc, tokenOut: A.weth })] }));
cases.push(await single("Wrong tokenOut (attacker token)", "VALIDATION_REJECTED", { mode: "enable", calls: [swap({ tokenOut: A.attacker })] }));
cases.push(await single("Wrong fee tier (500)", "VALIDATION_REJECTED", { mode: "enable", calls: [swap({ fee: 500 })] }));
cases.push(await single("Wrong recipient (attacker)", "VALIDATION_REJECTED", { mode: "enable", calls: [swap({ recipient: A.attacker })] }));
cases.push(await single("amountIn = cap + 1 wei", "VALIDATION_REJECTED", { mode: "enable", calls: [swap({ amountIn: cap + 1n })] }));
cases.push(await single("Non-zero sqrtPriceLimitX96", "VALIDATION_REJECTED", { mode: "enable", calls: [swap({ sqrtPriceLimitX96: 1n })] }));
cases.push(await single("Batch: allowed swap + attacker transfer", "VALIDATION_REJECTED", { mode: "enable", calls: [swap(), ATTACK_TRANSFER] }));
cases.push(await single("Delegatecall to router", "VALIDATION_REJECTED", { mode: "enable", calls: [swap()], callType: "delegatecall" }));
cases.push(await single("No paymaster (account self-pays)", "VALIDATION_REJECTED", { mode: "enable", calls: [swap()], paymaster: "none" }));
cases.push(await single("Unapproved paymaster", "VALIDATION_REJECTED", { mode: "enable", calls: [swap()], paymaster: "foreign" }));
cases.push(await single("Abnormal gas price (1000x) with approved paymaster", "VALIDATION_REJECTED", { mode: "enable", calls: [swap()], feeMultiplier: 1000n }));
cases.push(await single("CONTROL: no gas policy, no paymaster", "EXECUTED_SUCCESS", { control: true, mode: "enable", calls: [swap()], paymaster: "none" }));
cases.push(await single("CONTROL: no gas policy, unapproved paymaster", "VALIDATION_REJECTED", { control: true, mode: "enable", calls: [swap()], paymaster: "foreign" }));
cases.push(await single("Expired: block time after validUntil", "VALIDATION_REJECTED", { mode: "enable", calls: [swap()] }, validUntil + 60));

// Rate limit: ops 1..3 in sequence (op1 enables the permission). Then a much later block (still before expiry).
const half = compiled.maxAmountInWei / 2n;
const seqSwap = () => swap({ amountIn: half, amountOutMinimum: 0n });
const seqOps = [await buildOp({ mode: "enable", calls: [seqSwap()] }), await buildOp({ mode: "regular", calls: [seqSwap()] }), await buildOp({ mode: "regular", calls: [seqSwap()], seq: 1n })];
const seq = await simulate([[seqOps[0]!, seqOps[1]!], [seqOps[2]!]], [now + 30, validUntil - 60]);
cases.push({ name: "Rate limit op #1 (enable mode)", expect: "EXECUTED_SUCCESS", outcome: seq[0]! });
cases.push({ name: "Rate limit op #2 (regular mode)", expect: "EXECUTED_SUCCESS", outcome: seq[1]! });
cases.push({ name: "Rate limit op #3, ~24h later (count=2, interval=0)", expect: "VALIDATION_REJECTED", outcome: seq[2]! });

// ---------- 8. Report ----------
const pass = cases.every((c) => c.outcome.result === c.expect);
const report = {
  generatedAt: new Date().toISOString(), network: "Base Sepolia (84532)", method: "eth_simulateV1 → EntryPoint.handleOps (no broadcast)",
  entryPoint: entryPoint.address, kernelVersion, callPolicy: CallPolicyVersion.V0_0_5, masterOwner: owner.address, smartAccount: account,
  sessionSigner: sessionSigner.account.address, permissionId: permission.getIdentifier(), router: A.router, feeTier: FEE,
  compiled: { authPrice: `${answer}`, bufferBps: 1500, maxAmountInWei: `${cap}`, maxOps: compiled.maxOps, allowanceWei: `${allowance}`, validAfter, validUntil, gasAllowanceWei: `${GAS_ALLOWANCE_WEI}` },
  simulationStateOverrides: "account: 1 ETH; WETH balance 1 WETH; WETH allowance(account→router) = compiled allowance",
  cases: cases.map((c) => ({ ...c, pass: c.outcome.result === c.expect })), allPass: pass,
};
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/gate0-permissions.json", JSON.stringify(report, null, 2));
for (const c of report.cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  → ${c.outcome.result}: ${c.outcome.detail}${c.outcome.usdcReceived ? ` (USDC +${c.outcome.usdcReceived})` : ""}`);
console.log(pass ? "\nALL CASES MATCH EXPECTATIONS" : "\nSOME CASES DID NOT MATCH");
