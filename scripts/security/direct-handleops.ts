// Defense C (plan §14, evidence E4) — TESTNET ONLY, security harness, not a production path.
// A funded test EOA calls EntryPoint.handleOps([forbidden op signed by the real session key]) with an explicit
// gas limit so local estimation cannot stop it. Expected: the transaction is mined and REVERTS with
// FailedOpWithRevert(AA23 …) — permission validation failing on-chain.
import { createWalletClient, decodeErrorResult, encodeFunctionData, erc20Abi, formatEther, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import { and, eq } from "drizzle-orm";
import { appendAudit, securityEvents, smartAccounts } from "@guardian/db";
import { buildSignedUserOp, ENTRY_POINT } from "@guardian/account";
import { createEngineContext, loadAccountState, loadAgent } from "@guardian/engine";
import { mkdirSync, writeFileSync } from "node:fs";

const ctx = createEngineContext({ ...process.env, GUARDIAN_CHAIN_ID: "84532" });
if (ctx.chain.id !== 84532) throw new Error("testnet only");
const harness = privateKeyToAccount(process.env.TESTNET_HARNESS_PRIVATE_KEY as Hex);
const balance = await ctx.publicClient.getBalance({ address: harness.address });
if (balance < 10n ** 14n) { console.log(`Harness ${harness.address} has ${formatEther(balance)} ETH — fund it with Base Sepolia ETH, then rerun.`); await ctx.close(); process.exit(2); }

const [row] = await ctx.db.select().from(smartAccounts).where(and(eq(smartAccounts.chainId, 84532), eq(smartAccounts.ownerAddress, privateKeyToAccount(process.env.TESTNET_OWNER_PRIVATE_KEY as Hex).address)));
const st = await loadAccountState(ctx, row!.id);
if (st.session?.status !== "ACTIVE") throw new Error("Needs an ACTIVE session");
const { agentAccount } = await loadAgent(ctx, st.account, st.session, st.compilation!);
const attacker = "0x000000000000000000000000000000000000dEaD" as Address;
const call = { to: ctx.network.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 10n ** 18n] }) };
const op = await buildSignedUserOp(agentAccount, ctx.chain, ctx.pimlicoApiKey, { calls: [call], verificationGasLimit: 1_500_000n });

// Precheck by simulation that the revert is the permission failure, not nonce/funding/signature setup.
const data = encodeFunctionData({ abi: entryPoint07Abi, functionName: "handleOps", args: [[toPackedUserOperation(op)], harness.address] });
let expected = "";
try { await ctx.publicClient.call({ account: harness.address, to: ENTRY_POINT.address, data, gas: 3_000_000n }); }
catch (e) { const raw = (e as { data?: Hex; cause?: { data?: Hex } }).data ?? (e as { cause?: { data?: Hex } }).cause?.data;
  if (raw) { const d = decodeErrorResult({ abi: entryPoint07Abi, data: raw }); expected = `${d.errorName}(${d.args?.map(String).join(", ")})`; } }
if (!/AA23/.test(expected)) throw new Error(`Precheck did not isolate the permission failure (got "${expected}"); refusing to send`);

const wallet = createWalletClient({ account: harness, chain: ctx.chain, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
const tx = await wallet.sendTransaction({ to: ENTRY_POINT.address, data, gas: 3_000_000n });
const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx });
const evidence = { generatedAt: new Date().toISOString(), network: "Base Sepolia (84532)", submitter: harness.address, entryPoint: ENTRY_POINT.address,
  attempted: { to: call.to, data: call.data, description: "WETH.transfer(attacker, 1 WETH) signed by the real session key" },
  sessionSigner: st.session.signerAddress, permissionId: st.session.permissionId, precheckRevert: expected,
  transactionHash: tx, block: receipt.blockNumber, status: receipt.status, explorer: `https://sepolia.basescan.org/tx/${tx}` };
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/defense-c-onchain-validation-failure.json", JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
await ctx.db.insert(securityEvents).values({ accountId: row!.id, kind: "FORCED_ONCHAIN_VALIDATION_FAILURE", reason: expected, source: "ONCHAIN", evidence: JSON.parse(JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v))) });
await appendAudit(ctx.db, { accountId: row!.id, type: "SECURITY_TEST", level: receipt.status === "reverted" ? "SUCCESS" : "FAILURE",
  message: `Security test E4: forbidden session op forced on-chain — transaction ${receipt.status} (${expected})`, data: { transactionHash: tx, explorer: evidence.explorer } });
console.log(JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
await ctx.close();
