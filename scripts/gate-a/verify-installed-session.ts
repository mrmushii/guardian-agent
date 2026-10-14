// Verifies the DB-reconstructed agent (decrypted key + persisted compilation) against the permission
// actually installed on-chain. eth_simulateV1 only; the account's WETH balance is overridden in simulation.
import { encodeAbiParameters, keccak256, numberToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { and, eq } from "drizzle-orm";
import { smartAccounts } from "@guardian/db";
import { createEngineContext, loadAccountState, loadAgent, swapCall, compiledFromRow } from "@guardian/engine";
import { buildSignedUserOp } from "@guardian/account";
import { simulateHandleOps } from "@guardian/simulation";

const ctx = createEngineContext({ ...process.env, GUARDIAN_CHAIN_ID: "84532" });
const [row] = await ctx.db.select().from(smartAccounts).where(and(eq(smartAccounts.chainId, 84532), eq(smartAccounts.ownerAddress, privateKeyToAccount(process.env.TESTNET_OWNER_PRIVATE_KEY as Hex).address)));
const st = await loadAccountState(ctx, row!.id);
const { agentAccount } = await loadAgent(ctx, st.account, st.session!, st.compilation!); // throws if rebuilt permission ≠ authorized one
const account = st.account.address as Address, cap = compiledFromRow(st.compilation!).maxAmountInWei;
const op = (calls: ReturnType<typeof swapCall>[], nonceOffset = 0n) => buildSignedUserOp(agentAccount, ctx.chain, ctx.pimlicoApiKey, { calls, nonceOffset, verificationGasLimit: 2_000_000n });
const bad = { ...swapCall(ctx, account, cap, 1n) }; bad.data = bad.data.replace(account.slice(2).toLowerCase(), "000000000000000000000000000000000000dEaD".toLowerCase()) as Hex;
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, 3n]));
const res = await simulateHandleOps(ctx.publicClient, { beneficiary: account, watchTokens: [ctx.network.usdc],
  stateOverrides: [{ address: ctx.network.weth, stateDiff: [{ slot, value: numberToHex(10n ** 18n, { size: 32 }) }] }],
  blocks: [{ steps: [
    { kind: "userop", label: "DB-rebuilt agent: swap at cap", op: await op([swapCall(ctx, account, cap, 1n)]) },
    { kind: "userop", label: "DB-rebuilt agent: recipient = attacker", op: await op([bad], 1n) },
    { kind: "userop", label: "DB-rebuilt agent: cap + 1 wei", op: await op([swapCall(ctx, account, cap + 1n, 1n)], 1n) },
  ] }] });
const expect = ["EXECUTED_SUCCESS", "VALIDATION_REJECTED", "VALIDATION_REJECTED"];
res.forEach((r, i) => console.log(`${r.result === expect[i] ? "PASS" : "FAIL"}  ${r.label} → ${r.result}: ${r.detail}`));
await ctx.close();
