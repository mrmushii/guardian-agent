import { and, eq, inArray } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { agentSessions, policies, policyCompilations, smartAccounts } from "@guardian/db";
import { HumanPolicySchema, type CompiledAuthority, type HumanPolicy, type SessionStatus } from "@guardian/policy";
import { buildAgentPermission, createAgentAccount, decryptSessionKey, KERNEL_EXECUTE_SELECTOR, permissionValidationId } from "@guardian/account";
import type { EngineContext } from "./context.js";

export type AccountRow = typeof smartAccounts.$inferSelect;
export type SessionRow = typeof agentSessions.$inferSelect;
export type CompilationRow = typeof policyCompilations.$inferSelect;

export async function loadAccountState(ctx: EngineContext, accountId: string) {
  const [account] = await ctx.db.select().from(smartAccounts).where(eq(smartAccounts.id, accountId));
  if (!account) throw new Error(`Unknown account ${accountId}`);
  const [policyRow] = await ctx.db.select().from(policies).where(and(eq(policies.accountId, accountId), eq(policies.active, true)));
  const policy: HumanPolicy | null = policyRow ? HumanPolicySchema.parse(policyRow.policy) : null;
  const [session] = await ctx.db.select().from(agentSessions)
    .where(and(eq(agentSessions.accountId, accountId), inArray(agentSessions.status, ["PENDING_AUTHORIZATION", "ACTIVE", "REAUTH_REQUIRED"])));
  const [compilation] = session ? await ctx.db.select().from(policyCompilations).where(eq(policyCompilations.sessionId, session.id)) : [];
  return { account, policyRow: policyRow ?? null, policy, session: session ?? null, compilation: compilation ?? null };
}

export function compiledFromRow(c: CompilationRow): CompiledAuthority {
  const r = c.restrictions as { validAfter: string; validUntil: string };
  return {
    maxAmountInWei: BigInt(c.maxAmountInWei), maxOps: c.maxOps, allowanceWei: BigInt(c.allowanceWei),
    validAfter: new Date(r.validAfter), validUntil: new Date(r.validUntil),
    evidence: { maxAutoTxUsdCents: 0n, authPrice: { answer: BigInt(c.authPriceAnswer), decimals: c.authPriceDecimals },
      authPriceSource: c.authPriceSource, authPriceTimestamp: c.authPriceTimestamp, bufferBps: c.bufferBps },
  };
}

/** Rebuilds the exact on-chain permission from persisted compilation + decrypted session key. */
export async function loadAgent(ctx: EngineContext, account: AccountRow, session: SessionRow, compilation: CompilationRow) {
  const pk = decryptSessionKey(ctx.keyring, session, account.address, session.permissionId);
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(pk) });
  const permission = await buildAgentPermission(ctx.publicClient, {
    network: ctx.network, smartAccount: account.address as `0x${string}`, sessionSigner,
    compiled: compiledFromRow(compilation), gasAllowanceWei: BigInt(compilation.gasAllowanceWei),
  });
  if (permission.getIdentifier() !== session.permissionId) throw new Error("Rebuilt permission does not match the authorized permission");
  const agentAccount = await createAgentAccount(ctx.publicClient, permission, account.address as `0x${string}`, ctx.chain.id);
  return { permission, agentAccount };
}

/** On-chain truth for session usability: installed with execute access, inside its time window. */
export async function sessionStatus(ctx: EngineContext, account: AccountRow, session: SessionRow | null, compilation: CompilationRow | null, now = new Date()): Promise<SessionStatus> {
  if (!session || !compilation) return "NONE";
  if (session.status === "REVOKED") return "REVOKED";
  if (session.status === "REAUTH_REQUIRED") return "REAUTH_REQUIRED";
  if (session.status !== "ACTIVE") return "NONE";
  if (now >= session.validUntil) return "EXPIRED";
  const vId = `0x02${session.permissionId.slice(2).padEnd(40, "0")}` as `0x${string}`;
  const allowed = await ctx.publicClient.readContract({ address: account.address as `0x${string}`, abi: KernelV3_3AccountAbi, functionName: "isAllowedSelector", args: [vId, KERNEL_EXECUTE_SELECTOR] });
  return allowed ? "ACTIVE" : "REVOKED";
}
export { permissionValidationId };
