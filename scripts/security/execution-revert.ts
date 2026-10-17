// Evidence E8 (plan §14 "Distinguish authorization from execution failures") — TESTNET ONLY.
// A permitted swap (assets, recipient, amount within cap) with an impossible amountOutMinimum:
// validation passes (minOut is not constrained on-chain), execution reverts in the router.
// Expected: included UserOperation with success=false, classified EXECUTION_FAILED — not an authorization result.
import { decodeErrorResult, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUserOperationRequest } from "viem/account-abstraction";
import { and, eq } from "drizzle-orm";
import { appendAudit, smartAccounts } from "@guardian/db";
import { buildSignedUserOp, ENTRY_POINT } from "@guardian/account";
import { bundler, createEngineContext, explorerTx, loadAccountState, loadAgent, sellCall } from "@guardian/engine";
import { mkdirSync, writeFileSync } from "node:fs";

const ctx = createEngineContext({ ...process.env, GUARDIAN_CHAIN_ID: "84532" });
const [row] = await ctx.db.select().from(smartAccounts).where(and(eq(smartAccounts.chainId, 84532), eq(smartAccounts.ownerAddress, privateKeyToAccount(process.env.TESTNET_OWNER_PRIVATE_KEY as Hex).address)));
const st = await loadAccountState(ctx, row!.id);
if (st.session?.status !== "ACTIVE") throw new Error("Needs an ACTIVE session");
const { agentAccount } = await loadAgent(ctx, st.account, st.session, st.compilation!);
const amountIn = 10n ** 14n; // 0.0001 WETH, well inside the cap
const impossibleMinOut = 10n ** 12n; // 1,000,000 USDC
const op = await buildSignedUserOp(agentAccount, ctx.chain, ctx.pimlicoApiKey, {
  calls: [sellCall(ctx, st.account.address as `0x${string}`, amountIn, impossibleMinOut)], verificationGasLimit: 1_500_000n, callGasLimit: 400_000n });
const hash = await bundler(ctx).request({ method: "eth_sendUserOperation", params: [formatUserOperationRequest(op), ENTRY_POINT.address] } as never) as Hex;
const r = await bundler(ctx).waitForUserOperationReceipt({ hash, timeout: 120_000 });
let reason = r.reason ?? "";
try { if (reason.startsWith("0x")) { const d = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], data: reason as Hex }); reason = String(d.args?.[0]); } } catch { /* keep raw */ }
const evidence = { generatedAt: new Date().toISOString(), id: "E8", network: "Base Sepolia (84532)", sessionSigner: st.session.signerAddress, permissionId: st.session.permissionId,
  call: { amountInWei: amountIn, amountOutMinimum: impossibleMinOut, note: "permitted target/selector/assets/recipient/amount; minOut unconstrained on-chain" },
  userOpHash: hash, transactionHash: r.receipt.transactionHash, block: r.receipt.blockNumber, outerTransactionStatus: r.receipt.status, userOperationSuccess: r.success,
  revertReason: reason, classification: r.success ? "UNEXPECTED_SUCCESS" : "EXECUTION_FAILED (authorization passed)", explorer: explorerTx(ctx, r.receipt.transactionHash) };
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/e8-execution-revert.json", JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
await appendAudit(ctx.db, { accountId: row!.id, type: "RESILIENCE_TEST", level: r.success ? "FAILURE" : "SUCCESS",
  message: `E8: permitted swap with impossible minimum output — outer tx ${r.receipt.status}, UserOperation success=${r.success} (${reason || "reverted"})`, data: { userOpHash: hash, transactionHash: r.receipt.transactionHash, explorer: evidence.explorer } });
console.log(JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? `${v}` : v), 2));
await ctx.close();
