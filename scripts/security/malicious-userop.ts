// Defense B (plan §14, evidence E3/E6/E7) — TESTNET ONLY.
// Bypasses all application checks: signs forbidden UserOperations with the REAL installed session key and
// submits them via eth_sendUserOperation. Expected: bundler validation rejection, no transaction hash.
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUserOperationRequest } from "viem/account-abstraction";
import { and, eq } from "drizzle-orm";
import { agentSessions, policyCompilations, securityEvents, smartAccounts, appendAudit } from "@guardian/db";
import { desc } from "drizzle-orm";
import { buildSignedUserOp, ENTRY_POINT } from "@guardian/account";
import { bundler, compiledFromRow, createEngineContext, loadAccountState, loadAgent, swapCall } from "@guardian/engine";
import { mkdirSync, writeFileSync } from "node:fs";

const ctx = createEngineContext({ ...process.env, GUARDIAN_CHAIN_ID: "84532" });
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const [row] = await ctx.db.select().from(smartAccounts).where(and(eq(smartAccounts.chainId, 84532), eq(smartAccounts.ownerAddress, privateKeyToAccount(process.env.TESTNET_OWNER_PRIVATE_KEY as Hex).address)));
// --after-revoke: reuse the most recent (now revoked) session key; even previously-allowed calls must fail.
const afterRevoke = process.argv.includes("--after-revoke");
const st = await loadAccountState(ctx, row!.id);
if (afterRevoke) {
  const [latest] = await ctx.db.select().from(agentSessions).where(eq(agentSessions.accountId, row!.id)).orderBy(desc(agentSessions.createdAt)).limit(1);
  if (latest?.status !== "REVOKED") throw new Error("Latest session is not REVOKED");
  const [comp] = await ctx.db.select().from(policyCompilations).where(eq(policyCompilations.sessionId, latest.id));
  Object.assign(st, { session: latest, compilation: comp });
} else if (st.session?.status !== "ACTIVE") throw new Error("Needs an ACTIVE session (run `pnpm guardian authorize`)");
const { agentAccount } = await loadAgent(ctx, st.account, st.session!, st.compilation!);
const account = st.account.address as Address, cap = compiledFromRow(st.compilation!).maxAmountInWei;
const recipientSwap = swapCall(ctx, account, cap, 1n);
recipientSwap.data = recipientSwap.data.replace(account.slice(2).toLowerCase(), ATTACKER.slice(2).toLowerCase()) as Hex;

const attacks = afterRevoke ? [
  { id: "E7d", name: "After revocation: previously-ALLOWED swap at half cap", call: swapCall(ctx, account, cap / 2n, 1n) },
  { id: "E7e", name: "After revocation: transfer WETH to attacker", call: { to: ctx.network.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 10n ** 15n] }) } },
] : [
  { id: "E6", name: "Prompt-injection payload: transfer entire WETH balance to attacker", call: { to: ctx.network.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [ATTACKER, 10n ** 18n] }) } },
  { id: "E7a", name: "Approve attacker as WETH spender (unlimited)", call: { to: ctx.network.weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ATTACKER, 2n ** 256n - 1n] }) } },
  { id: "E7b", name: "Allowed router, recipient replaced with attacker", call: recipientSwap },
  { id: "E7c", name: "Allowed swap, amount = compiled cap + 1 wei", call: swapCall(ctx, account, cap + 1n, 1n) },
];

const results = [];
for (const a of attacks) {
  const op = await buildSignedUserOp(agentAccount, ctx.chain, ctx.pimlicoApiKey, { calls: [a.call], verificationGasLimit: 1_500_000n });
  const requestedAt = new Date().toISOString();
  let outcome: Record<string, unknown>;
  try {
    const hash = await bundler(ctx).request({ method: "eth_sendUserOperation", params: [formatUserOperationRequest(op), ENTRY_POINT.address] } as never);
    outcome = { rejected: false, userOpHash: hash, WARNING: "bundler accepted a forbidden operation" };
  } catch (e) {
    const err = e as { details?: string; shortMessage?: string; code?: number; message: string };
    outcome = { rejected: true, rpcCode: err.code ?? null, rpcError: (err.details ?? err.shortMessage ?? err.message).split("\n")[0], transactionHash: null };
  }
  const evidence = { ...a, call: { to: a.call.to, data: a.call.data }, sessionSigner: st.session!.signerAddress, permissionId: st.session!.permissionId, sessionStatus: st.session!.status,
    smartAccount: account, signedUserOperation: { ...op, signature: op.signature }, requestedAt, outcome };
  results.push(evidence);
  await ctx.db.insert(securityEvents).values({ accountId: row!.id, kind: `FORBIDDEN_SESSION_OP:${a.id}`, reason: String(outcome.rpcError ?? "ACCEPTED"), source: "BUNDLER",
    evidence: JSON.parse(JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v))) });
  await appendAudit(ctx.db, { accountId: row!.id, type: "SECURITY_TEST", level: outcome.rejected ? "SUCCESS" : "FAILURE",
    message: `Security test ${a.id}: ${a.name} — ${outcome.rejected ? `rejected by bundler (${String(outcome.rpcError).slice(0, 120)})` : "NOT REJECTED"}` });
  console.log(`${outcome.rejected ? "REJECTED" : "ACCEPTED!"}  ${a.id} ${a.name}\n          ${String(outcome.rpcError ?? outcome.userOpHash).slice(0, 220)}`);
}
mkdirSync("docs/evidence", { recursive: true });
writeFileSync(afterRevoke ? "docs/evidence/revocation-rejections.json" : "docs/evidence/defense-b-bundler-rejections.json", JSON.stringify({ generatedAt: new Date().toISOString(), network: "Base Sepolia (84532)",
  method: "Real session key; eth_sendUserOperation to Pimlico; application checks bypassed", results }, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
await ctx.close();
