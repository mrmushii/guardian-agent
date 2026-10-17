// Gate 0 addendum (Base Sepolia): two-way swap permission + resetting rate limit. SIMULATION ONLY:
// signed UserOperations run through EntryPoint.handleOps inside eth_simulateV1. Nothing is broadcast.
//
// Questions answered:
//  1. Can the buy side (USDC→WETH via exactOutputSingle, amountInMaximum ≤ USDC cap) sit next to the
//     sell rule in one call policy, with every field constrained?
//  2. Which rate-limit policy contract gives a per-window count that resets?
import {
  createPublicClient, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeFunctionData, http,
  keccak256, numberToHex, pad, parseAbi, toFunctionSelector, toHex, type Address, type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { createKernelAccount } from "@zerodev/sdk";
import { toKernelPluginManager } from "@zerodev/sdk/accounts";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
const RATE_LIMIT_POLICY_CONTRACT = "0xf63d4139B25c836334edD76641356c6b74C86873" as const; // SDK constants (not exported)
const RATE_LIMIT_POLICY_WITH_RESET_CONTRACT = "0x6a06358e6b283921deceabe7e8a3741d506cca9b" as const;
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { KERNEL_VERSION } from "@guardian/account";
import { BASE_SEPOLIA } from "@guardian/chain";
import { writeFileSync, mkdirSync } from "node:fs";

const env = process.env;
const N = BASE_SEPOLIA;
const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";
const FEE = N.feeTier;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_VERSION;
const client = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const pimlico = createPimlicoClient({ transport: http(`https://api.pimlico.io/v2/${baseSepolia.id}/rpc?apikey=${env.PIMLICO_API_KEY}`), entryPoint });
const owner = privateKeyToAccount(env.TESTNET_OWNER_PRIVATE_KEY as Hex);
const harness = privateKeyToAccount(env.TESTNET_HARNESS_PRIVATE_KEY as Hex).address;

const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const quoterAbi = parseAbi(["function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
const SELL = toFunctionSelector(routerAbi[0]);
const BUY = toFunctionSelector(routerAbi[1]);

// Fixed test caps (the compiler is not under test here).
const WETH_CAP = 3_000_000_000_000_000n; // 0.003 WETH
const USDC_CAP = 10_000_000n;            // 10 USDC
const now = Math.floor(Date.now() / 1000);
const validAfter = now - 60, validUntil = now + 7 * 86_400;
const WINDOW = 120; // short, so Pimlico paymaster signatures (minutes-valid) do not expire inside the simulation

const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion });
const account = (await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion })).address;
const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });

const word = (v: bigint | Address | number) => pad(typeof v === "string" ? v : toHex(v), { size: 32 });
const rule = (offset: number, condition: ParamCondition, v: bigint | Address | number) => ({ offset, condition, params: [word(v)] });
const callPolicy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: [
  { target: N.swapRouter02, selector: SELL, valueLimit: 0n, rules: [
    rule(0, ParamCondition.EQUAL, N.weth), rule(32, ParamCondition.EQUAL, N.usdc), rule(64, ParamCondition.EQUAL, FEE),
    rule(96, ParamCondition.EQUAL, account), rule(128, ParamCondition.LESS_THAN_OR_EQUAL, WETH_CAP), rule(192, ParamCondition.EQUAL, 0n)] },
  { target: N.swapRouter02, selector: BUY, valueLimit: 0n, rules: [
    rule(0, ParamCondition.EQUAL, N.usdc), rule(32, ParamCondition.EQUAL, N.weth), rule(64, ParamCondition.EQUAL, FEE),
    rule(96, ParamCondition.EQUAL, account), rule(160, ParamCondition.LESS_THAN_OR_EQUAL, USDC_CAP), rule(192, ParamCondition.EQUAL, 0n)] },
] });
const common = [toTimestampPolicy({ validAfter, validUntil })];
const gas = toGasPolicy({ allowed: 10n ** 16n, enforcePaymaster: true, allowedPaymaster: N.paymaster });

async function accountsFor(rateLimit: ReturnType<typeof toRateLimitPolicy>) {
  const permission = await toPermissionValidator(client, { entryPoint, kernelVersion, signer: sessionSigner, policies: [callPolicy, ...common, rateLimit, gas] });
  const enable = await createKernelAccount(client, { plugins: { sudo, regular: permission }, entryPoint, kernelVersion });
  const regular = await createKernelAccount(client, { plugins: await toKernelPluginManager(client, { regular: permission, isPreInstalled: true, entryPoint, kernelVersion, chainId: baseSepolia.id }), entryPoint, kernelVersion, address: account });
  if (enable.address !== account) throw new Error("account address mismatch");
  return { enable, regular };
}

// ---------- calls ----------
const quoteIn = async (amountOut: bigint) => (await client.simulateContract({ address: N.quoterV2, abi: quoterAbi, functionName: "quoteExactOutputSingle",
  args: [{ tokenIn: N.usdc, tokenOut: N.weth, amount: amountOut, fee: FEE, sqrtPriceLimitX96: 0n }] })).result[0];
// Pick a WETH output whose USDC cost is ~half the cap, so amountInMaximum = cap is satisfiable.
const buyOut = 1_000_000_000_000n; // 0.000001 WETH (testnet pool price is irrelevant to authorization)
const buyIn = await quoteIn(buyOut);
type SellP = { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint };
type BuyP = { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountOut: bigint; amountInMaximum: bigint; sqrtPriceLimitX96: bigint };
const sell = (p: Partial<SellP> = {}) => ({ to: N.swapRouter02, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle",
  args: [{ tokenIn: N.weth, tokenOut: N.usdc, fee: FEE, recipient: account, amountIn: WETH_CAP / 4n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, ...p }] }) });
const buy = (p: Partial<BuyP> = {}) => ({ to: N.swapRouter02, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactOutputSingle",
  args: [{ tokenIn: N.usdc, tokenOut: N.weth, fee: FEE, recipient: account, amountOut: buyOut, amountInMaximum: USDC_CAP, sqrtPriceLimitX96: 0n, ...p }] }) });

// ---------- ops ----------
const fees = (await pimlico.getUserOperationGasPrice()).fast;
type Acct = Awaited<ReturnType<typeof accountsFor>>["enable"];
async function buildOp(acct: Acct, calls: { to: Address; value: bigint; data: Hex }[], enable: boolean, seq = 0n): Promise<UserOperation<"0.7">> {
  const op: UserOperation<"0.7"> = {
    sender: account, nonce: (await acct.getNonce()) + seq, callData: await acct.encodeCalls(calls),
    callGasLimit: 600_000n, verificationGasLimit: 5_000_000n, preVerificationGas: 120_000n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, signature: "0x",
    ...(enable ? await acct.getFactoryArgs() : {}),
  };
  const pm = await pimlico.getPaymasterData({ ...op, paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n, chainId: baseSepolia.id, entryPointAddress: entryPoint.address });
  Object.assign(op, { paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n }, pm);
  op.signature = await acct.signUserOperation(op);
  return op;
}

// ---------- state overrides: fund WETH + USDC and router allowances ----------
const mapSlot = (key: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const nestedSlot = (k1: Address, k2: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [k2, mapSlot(k1, slot)]));
// WETH9: balanceOf slot 3, allowance slot 4. FiatToken v2.2: balances slot 9, allowed slot 10 (asserted below).
for (const [token, slot] of [[N.weth, 3n], [N.usdc, 9n]] as const) {
  const live = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [N.pool] });
  const raw = BigInt(await client.getStorageAt({ address: token, slot: mapSlot(N.pool, slot) }) ?? "0x0");
  if (live !== (raw & ((1n << 255n) - 1n))) throw new Error(`balance slot assumption failed for ${token}`);
}
const stateOverrides = [
  { address: account, balance: 10n ** 18n },
  { address: N.weth, stateDiff: [
    { slot: mapSlot(account, 3n), value: numberToHex(10n ** 18n, { size: 32 }) },
    { slot: nestedSlot(account, N.swapRouter02, 4n), value: numberToHex(WETH_CAP * 10n, { size: 32 }) }] },
  { address: N.usdc, stateDiff: [
    { slot: mapSlot(account, 9n), value: numberToHex(1_000_000_000n, { size: 32 }) },
    { slot: nestedSlot(account, N.swapRouter02, 10n), value: numberToHex(USDC_CAP * 10n, { size: 32 }) }] },
];

type Outcome = { result: "VALIDATION_REJECTED" | "EXECUTED_SUCCESS" | "EXECUTION_FAILED" | "CALL_FAILED"; detail: string };
async function simulate(blocksOps: UserOperation<"0.7">[][], times: number[]): Promise<Outcome[]> {
  const res = await client.simulateBlocks({ blocks: blocksOps.map((ops, i) => ({
    ...(i === 0 ? { stateOverrides } : {}), blockOverrides: { time: BigInt(times[i]!) },
    calls: ops.map((op) => ({ account: harness, to: entryPoint.address, gas: 20_000_000n,
      data: encodeFunctionData({ abi: entryPoint07Abi, functionName: "handleOps", args: [[toPackedUserOperation(op)], harness] }) })),
  })), validation: false } as never);
  return res.flatMap((b) => b.calls).map((c): Outcome => {
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

// ---------- cases ----------
const cases: { name: string; expect: Outcome["result"]; outcome: Outcome }[] = [];
const t0 = now + 30;
const base = await accountsFor(toRateLimitPolicy({ count: 10, interval: 0 }));
const one = async (name: string, expect: Outcome["result"], call: ReturnType<typeof sell>) =>
  cases.push({ name, expect, outcome: (await simulate([[await buildOp(base.enable, [call], true)]], [t0]))[0]! });

await one("Sell: allowed WETH→USDC exactInputSingle", "EXECUTED_SUCCESS", sell());
await one("Buy: allowed USDC→WETH exactOutputSingle, amountInMaximum = cap", "EXECUTED_SUCCESS", buy());
await one("Buy: amountInMaximum = cap + 1", "VALIDATION_REJECTED", buy({ amountInMaximum: USDC_CAP + 1n }));
await one("Buy: recipient = attacker", "VALIDATION_REJECTED", buy({ recipient: ATTACKER }));
await one("Buy: reversed tokens (WETH→USDC via exactOutputSingle)", "VALIDATION_REJECTED", buy({ tokenIn: N.weth, tokenOut: N.usdc }));
await one("Buy: tokenOut = attacker token", "VALIDATION_REJECTED", buy({ tokenOut: ATTACKER }));
await one("Buy: wrong fee tier", "VALIDATION_REJECTED", buy({ fee: 500 }));
await one("Buy: non-zero sqrtPriceLimitX96", "VALIDATION_REJECTED", buy({ sqrtPriceLimitX96: 1n }));
await one("Sell: USDC tokens via exactInputSingle (sell rule)", "VALIDATION_REJECTED", sell({ tokenIn: N.usdc, tokenOut: N.weth }));
await one("Sell: amountIn = cap + 1", "VALIDATION_REJECTED", sell({ amountIn: WETH_CAP + 1n }));
await one("USDC.transfer to attacker", "VALIDATION_REJECTED", { to: N.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, USDC_CAP] }) });

// Rate limit: count 2 per WINDOW. Ops 1–2 in window 1, op 3 in window 1 (expect reject), op 4 after the window.
const rateCases = async (label: string, policy: ReturnType<typeof toRateLimitPolicy>, afterWindow: Outcome["result"]) => {
  const a = await accountsFor(policy);
  const ops = [await buildOp(a.enable, [sell()], true), await buildOp(a.regular, [buy()], false),
    await buildOp(a.regular, [sell()], false, 1n), await buildOp(a.regular, [sell()], false, 1n)];
  // Block 1: ops 1,2. Block 2 (+60 s): op 3. Block 3 (+WINDOW+120 s): op 3' (same nonce, op 3 was rejected).
  const r = await simulate([[ops[0]!, ops[1]!], [ops[2]!], [ops[3]!]], [t0, t0 + 60, t0 + WINDOW + 120]);
  cases.push({ name: `${label}: op 1 (sell)`, expect: "EXECUTED_SUCCESS", outcome: r[0]! });
  cases.push({ name: `${label}: op 2 (buy)`, expect: "EXECUTED_SUCCESS", outcome: r[1]! });
  cases.push({ name: `${label}: op 3 in the same window`, expect: "VALIDATION_REJECTED", outcome: r[2]! });
  cases.push({ name: `${label}: op 3 after the window has passed`, expect: afterWindow, outcome: r[3]! });
};
// Finding: only the with-reset contract restores the count after the window; the plain one never does.
await rateCases("RateLimit (plain, interval=120s)", toRateLimitPolicy({ count: 2, interval: WINDOW }), "VALIDATION_REJECTED");
await rateCases("RateLimit (with-reset, interval=120s)", toRateLimitPolicy({ policyAddress: RATE_LIMIT_POLICY_WITH_RESET_CONTRACT, count: 2, interval: WINDOW }), "EXECUTED_SUCCESS");

const pass = cases.every((c) => c.outcome.result === c.expect);
const report = {
  generatedAt: new Date().toISOString(), network: "Base Sepolia (84532)", method: "eth_simulateV1 → EntryPoint.handleOps (no broadcast)",
  smartAccount: account, sessionSigner: sessionSigner.account.address, router: N.swapRouter02, feeTier: FEE,
  caps: { wethCapWei: `${WETH_CAP}`, usdcCapRaw: `${USDC_CAP}` }, buyQuote: { amountOutWei: `${buyOut}`, quotedUsdcIn: `${buyIn}` },
  rateLimitContracts: { plain: RATE_LIMIT_POLICY_CONTRACT, withReset: RATE_LIMIT_POLICY_WITH_RESET_CONTRACT, windowSec: WINDOW },
  cases: cases.map((c) => ({ ...c, pass: c.outcome.result === c.expect })), allPass: pass,
};
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/gate0-two-way-permissions.json", JSON.stringify(report, null, 2));
for (const c of report.cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  → ${c.outcome.result}: ${c.outcome.detail}`);
console.log(pass ? "\nALL CASES MATCH EXPECTATIONS" : "\nSOME CASES DID NOT MATCH");
