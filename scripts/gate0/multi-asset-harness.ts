// Gate 0 addendum 2 (Base Sepolia): multi-asset authority as ONE PERMISSION PER ASSET. SIMULATION ONLY:
// signed UserOperations run through EntryPoint.handleOps inside eth_simulateV1. Nothing is broadcast.
//
// Finding 1 (docs/evidence/gate0-multi-asset-shared-policy-rejected.json): CallPolicy V0_0_5 refuses two entries
// with the same target + selector ("duplicate permissionHash"), so one call policy cannot hold per-asset sell rules.
//
// Questions answered here:
//  1. Can two permission validators (separate session keys) be installed side by side on one Kernel account,
//     each with its own asset pair and its own caps, and does installing the second keep the first working?
//  2. Is each key confined to its own asset (the WETH key cannot trade asset B, and vice versa)?
// Asset B needs no pool: "validation passed, swap reverted" (EXECUTION_FAILED) proves authorization.
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
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { KERNEL_VERSION } from "@guardian/account";
import { BASE_SEPOLIA } from "@guardian/chain";
import { writeFileSync, mkdirSync } from "node:fs";

const env = process.env;
const N = BASE_SEPOLIA;
const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";
const ASSET_B: Address = "0x1111111111111111111111111111111111111111"; // stand-in second asset (no pool needed)
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
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const SELL = toFunctionSelector(routerAbi[0]);
const BUY = toFunctionSelector(routerAbi[1]);

// Deliberately different caps so a mixed-up cap is detectable: B's sell cap is 10x WETH's.
const WETH_CAP = 3_000_000_000_000_000n;   // 0.003 WETH
const B_CAP = 30_000_000_000_000_000n;     // 0.03 B
const USDC_CAP_WETH = 10_000_000n;         // 10 USDC to buy WETH
const USDC_CAP_B = 4_000_000n;             // 4 USDC to buy B
const now = Math.floor(Date.now() / 1000);

const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion });
const account = (await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion })).address;

const word = (v: bigint | Address | number) => pad(typeof v === "string" ? v : toHex(v), { size: 32 });
const rule = (offset: number, condition: ParamCondition, v: bigint | Address | number) => ({ offset, condition, params: [word(v)] });
/** Today's two-way layout, parameterised by asset: exactly what one per-asset permission would install. */
async function assetPermission(asset: Address, sellCap: bigint, usdcCap: bigint) {
  const signer = await toECDSASigner({ signer: privateKeyToAccount(generatePrivateKey()) });
  const permission = await toPermissionValidator(client, { entryPoint, kernelVersion, signer, policies: [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: [
      { target: N.swapRouter02, selector: SELL, valueLimit: 0n, rules: [
        rule(0, ParamCondition.EQUAL, asset), rule(32, ParamCondition.EQUAL, N.usdc), rule(64, ParamCondition.EQUAL, FEE),
        rule(96, ParamCondition.EQUAL, account), rule(128, ParamCondition.LESS_THAN_OR_EQUAL, sellCap), rule(192, ParamCondition.EQUAL, 0n)] },
      { target: N.swapRouter02, selector: BUY, valueLimit: 0n, rules: [
        rule(0, ParamCondition.EQUAL, N.usdc), rule(32, ParamCondition.EQUAL, asset), rule(64, ParamCondition.EQUAL, FEE),
        rule(96, ParamCondition.EQUAL, account), rule(160, ParamCondition.LESS_THAN_OR_EQUAL, usdcCap), rule(192, ParamCondition.EQUAL, 0n)] },
    ] }),
    toTimestampPolicy({ validAfter: now - 60, validUntil: now + 7 * 86_400 }),
    toRateLimitPolicy({ count: 50, interval: 0 }),
    toGasPolicy({ allowed: 10n ** 16n, enforcePaymaster: true, allowedPaymaster: N.paymaster }),
  ] });
  const enable = await createKernelAccount(client, { plugins: { sudo, regular: permission }, entryPoint, kernelVersion });
  const regular = await createKernelAccount(client, { plugins: await toKernelPluginManager(client, { regular: permission, isPreInstalled: true, entryPoint, kernelVersion, chainId: baseSepolia.id }), entryPoint, kernelVersion, address: account });
  if (enable.address !== account) throw new Error("account address mismatch");
  return { enable, regular, signer: signer.account.address };
}
const pWeth = await assetPermission(N.weth, WETH_CAP, USDC_CAP_WETH);
const pB = await assetPermission(ASSET_B, B_CAP, USDC_CAP_B);

type Call = { to: Address; value: bigint; data: Hex };
const sell = (tokenIn: Address, amountIn: bigint, p: Record<string, unknown> = {}): Call => ({ to: N.swapRouter02, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle",
  args: [{ tokenIn, tokenOut: N.usdc, fee: FEE, recipient: account, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n, ...p } as never] }) });
const buy = (tokenOut: Address, amountInMaximum: bigint, p: Record<string, unknown> = {}): Call => ({ to: N.swapRouter02, value: 0n, data: encodeFunctionData({ abi: routerAbi, functionName: "exactOutputSingle",
  args: [{ tokenIn: N.usdc, tokenOut, fee: FEE, recipient: account, amountOut: 1_000_000_000_000n, amountInMaximum, sqrtPriceLimitX96: 0n, ...p } as never] }) });

const fees = (await pimlico.getUserOperationGasPrice()).fast;
type Acct = typeof pWeth.enable;
/** `deploy`: include factory data (first op on the counterfactual account only). */
async function buildOp(acct: Acct, calls: Call[], deploy: boolean): Promise<UserOperation<"0.7">> {
  const op: UserOperation<"0.7"> = {
    sender: account, nonce: await acct.getNonce(), callData: await acct.encodeCalls(calls),
    callGasLimit: 900_000n, verificationGasLimit: 6_000_000n, preVerificationGas: 150_000n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, signature: "0x",
    ...(deploy ? await acct.getFactoryArgs() : {}),
  };
  const pm = await pimlico.getPaymasterData({ ...op, paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n, chainId: baseSepolia.id, entryPointAddress: entryPoint.address });
  Object.assign(op, { paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n }, pm);
  op.signature = await acct.signUserOperation(op);
  return op;
}

// Fund the counterfactual account with WETH + USDC and router allowances (same slot layout as the two-way harness).
const mapSlot = (key: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const nestedSlot = (k1: Address, k2: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [k2, mapSlot(k1, slot)]));
for (const [token, slot] of [[N.weth, 3n], [N.usdc, 9n]] as const) {
  const live = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [N.pool] });
  const raw = BigInt(await client.getStorageAt({ address: token, slot: mapSlot(N.pool, slot) }) ?? "0x0");
  if (live !== (raw & ((1n << 255n) - 1n))) throw new Error(`balance slot assumption failed for ${token}`);
}
const stateOverrides = [
  { address: account, balance: 10n ** 18n },
  { address: N.weth, stateDiff: [
    { slot: mapSlot(account, 3n), value: numberToHex(10n ** 18n, { size: 32 }) },
    { slot: nestedSlot(account, N.swapRouter02, 4n), value: numberToHex(10n ** 18n, { size: 32 }) }] },
  { address: N.usdc, stateDiff: [
    { slot: mapSlot(account, 9n), value: numberToHex(1_000_000_000n, { size: 32 }) },
    { slot: nestedSlot(account, N.swapRouter02, 10n), value: numberToHex(1_000_000_000n, { size: 32 }) }] },
];

type Result = "VALIDATION_REJECTED" | "EXECUTED_SUCCESS" | "EXECUTION_FAILED" | "CALL_FAILED";
/** Runs blocks in sequence (state carries over), one UserOperation per block. */
async function simulate(ops: UserOperation<"0.7">[]): Promise<{ result: Result; detail: string }[]> {
  const res = await client.simulateBlocks({ blocks: ops.map((op, i) => ({
    ...(i === 0 ? { stateOverrides } : {}), blockOverrides: { time: BigInt(now + 30 + i * 12) },
    calls: [{ account: harness, to: entryPoint.address, gas: 25_000_000n,
      data: encodeFunctionData({ abi: entryPoint07Abi, functionName: "handleOps", args: [[toPackedUserOperation(op)], harness] }) }] })), validation: false } as never);
  return res.map((b) => {
    const c = b.calls[0]!;
    if (c.status === "failure") {
      let detail = c.error?.message.split("\n")[0] ?? "reverted";
      try { const d = decodeErrorResult({ abi: entryPoint07Abi, data: c.data }); detail = `${d.errorName}(${d.args?.map(String).join(", ")})`; } catch {}
      return { result: /AA2|AA3|FailedOp/.test(detail) ? "VALIDATION_REJECTED" as const : "CALL_FAILED" as const, detail };
    }
    let ok: boolean | undefined, reason = "";
    for (const l of c.logs ?? []) { try { const e = decodeEventLog({ abi: entryPoint07Abi, data: l.data, topics: l.topics });
      if (e.eventName === "UserOperationEvent") ok = e.args.success;
      if (e.eventName === "UserOperationRevertReason") reason = e.args.revertReason; } catch {} }
    return ok ? { result: "EXECUTED_SUCCESS" as const, detail: "success=true" } : { result: "EXECUTION_FAILED" as const, detail: `success=false ${reason}`.trim() };
  });
}

// "AUTHORIZED" = validation passed (the swap may still revert for an asset without a pool).
type Expect = "AUTHORIZED" | "VALIDATION_REJECTED";
const steps: { name: string; expect: Expect; op: UserOperation<"0.7"> }[] = [];
// Block 1 deploys the account and enables the WETH permission; block 2 enables the B permission alongside it.
steps.push({ name: "Install WETH permission + sell WETH within its cap", expect: "AUTHORIZED", op: await buildOp(pWeth.enable, [sell(N.weth, WETH_CAP)], true) });
steps.push({ name: "Install B permission (second validator) + sell B within its cap (10x the WETH cap)", expect: "AUTHORIZED", op: await buildOp(pB.enable, [sell(ASSET_B, B_CAP)], false) });
// Remaining blocks use both permissions as pre-installed.
const after: [string, Expect, Acct, Call[]][] = [
  ["WETH key still works after B was installed: buy WETH within its USDC cap", "AUTHORIZED", pWeth.regular, [buy(N.weth, USDC_CAP_WETH)]],
  ["WETH key: sell above WETH cap", "VALIDATION_REJECTED", pWeth.regular, [sell(N.weth, WETH_CAP + 1n)]],
  ["WETH key cannot trade asset B (sell B)", "VALIDATION_REJECTED", pWeth.regular, [sell(ASSET_B, 1n)]],
  ["WETH key cannot trade asset B (buy B)", "VALIDATION_REJECTED", pWeth.regular, [buy(ASSET_B, 1n)]],
  ["B key cannot trade WETH (sell WETH within WETH cap)", "VALIDATION_REJECTED", pB.regular, [sell(N.weth, 1n)]],
  ["B key: sell above B cap", "VALIDATION_REJECTED", pB.regular, [sell(ASSET_B, B_CAP + 1n)]],
  ["B key: buy B above its USDC cap (below WETH's)", "VALIDATION_REJECTED", pB.regular, [buy(ASSET_B, USDC_CAP_B + 1n)]],
  ["B key: buy B within its USDC cap", "AUTHORIZED", pB.regular, [buy(ASSET_B, USDC_CAP_B)]],
  ["B key: recipient = attacker", "VALIDATION_REJECTED", pB.regular, [sell(ASSET_B, 1n, { recipient: ATTACKER })]],
  ["B key: direct B→WETH (bypassing the USDC hub)", "VALIDATION_REJECTED", pB.regular, [sell(ASSET_B, 1n, { tokenOut: N.weth })]],
  ["WETH key: permitted sell batched with USDC.transfer to attacker", "VALIDATION_REJECTED", pWeth.regular, [sell(N.weth, 1n),
    { to: N.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 1n] }) }]],
];
// Nonces are per validator; build sequentially and bump our local count for consecutive ops by the same key.
const used = new Map<Acct, bigint>();
for (const [name, expect, acct, calls] of after) {
  const op = await buildOp(acct, calls, false);
  // A rejected op does not consume its nonce, so only authorized steps advance the key's nonce.
  op.nonce += used.get(acct) ?? 0n;
  op.signature = await acct.signUserOperation(op);
  if (expect === "AUTHORIZED") used.set(acct, (used.get(acct) ?? 0n) + 1n);
  steps.push({ name, expect, op });
}

const results = await simulate(steps.map((s) => s.op));
const cases = steps.map((s, i) => {
  const o = results[i]!;
  const pass = s.expect === "AUTHORIZED" ? o.result === "EXECUTED_SUCCESS" || o.result === "EXECUTION_FAILED" : o.result === "VALIDATION_REJECTED";
  return { name: s.name, expect: s.expect, ...o, pass };
});
const allPass = cases.every((c) => c.pass);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/gate0-multi-asset-permissions.json", JSON.stringify({
  generatedAt: new Date().toISOString(), network: "Base Sepolia (84532)", method: "eth_simulateV1 → EntryPoint.handleOps (no broadcast), sequential blocks",
  design: "one permission validator (session key) per asset, USDC hub", smartAccount: account, router: N.swapRouter02, feeTier: FEE,
  keys: { weth: pWeth.signer, b: pB.signer }, assets: { weth: N.weth, standInB: ASSET_B, hub: N.usdc },
  caps: { wethSell: `${WETH_CAP}`, bSell: `${B_CAP}`, usdcForWeth: `${USDC_CAP_WETH}`, usdcForB: `${USDC_CAP_B}` },
  priorFinding: "Single call policy with duplicate target+selector entries is rejected at install: 'duplicate permissionHash' (gate0-multi-asset-shared-policy-rejected.json)",
  cases, allPass,
}, null, 2));
for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  → ${c.result}: ${c.detail.slice(0, 120)}`);
console.log(allPass ? "\nALL CASES MATCH EXPECTATIONS" : "\nSOME CASES DID NOT MATCH");
