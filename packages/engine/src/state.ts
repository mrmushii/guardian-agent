import { and, eq, gt, inArray } from "drizzle-orm";
import { concatHex, pad, type Address } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { agentSessions, policies, policyCompilations, smartAccounts, userOperations } from "@guardian/db";
import { HumanPolicySchema, type CompiledAuthority, type HumanPolicy, type SessionStatus } from "@guardian/policy";
import { buildAgentPermission, createAgentAccount, decryptSessionKey, KERNEL_EXECUTE_SELECTOR, permissionValidationId, type PermissionVersion } from "@guardian/account";
import type { EngineContext } from "./context.js";

export type AccountRow = typeof smartAccounts.$inferSelect;
export type SessionRow = typeof agentSessions.$inferSelect;
export type CompilationRow = typeof policyCompilations.$inferSelect;

/** Account, active policy, and the agent session for one asset (legacy callers: WETH). */
export async function loadAccountState(ctx: EngineContext, accountId: string, asset = "WETH") {
  const [account] = await ctx.db.select().from(smartAccounts).where(eq(smartAccounts.id, accountId));
  if (!account) throw new Error(`Unknown account ${accountId}`);
  const [policyRow] = await ctx.db.select().from(policies).where(and(eq(policies.accountId, accountId), eq(policies.active, true)));
  const policy: HumanPolicy | null = policyRow ? HumanPolicySchema.parse(policyRow.policy) : null;
  const [session] = await ctx.db.select().from(agentSessions)
    .where(and(eq(agentSessions.accountId, accountId), eq(agentSessions.asset, asset), inArray(agentSessions.status, ["PENDING_AUTHORIZATION", "ACTIVE", "REAUTH_REQUIRED"])));
  const [compilation] = session ? await ctx.db.select().from(policyCompilations).where(eq(policyCompilations.sessionId, session.id)) : [];
  return { account, policyRow: policyRow ?? null, policy, session: session ?? null, compilation: compilation ?? null };
}

/** Every live agent session (one per traded asset) with its compilation. */
export async function loadSessions(ctx: EngineContext, accountId: string) {
  const sessions = await ctx.db.select().from(agentSessions)
    .where(and(eq(agentSessions.accountId, accountId), inArray(agentSessions.status, ["PENDING_AUTHORIZATION", "ACTIVE", "REAUTH_REQUIRED"])));
  const comps = sessions.length ? await ctx.db.select().from(policyCompilations).where(inArray(policyCompilations.sessionId, sessions.map((s) => s.id))) : [];
  return sessions.map((s) => ({ session: s, compilation: comps.find((c) => c.sessionId === s.id) ?? null }));
}

export const permissionVersionOf = (c: CompilationRow): PermissionVersion => (c.permissionVersion === 2 ? 2 : 1);
export const isTwoWay = (c: CompilationRow | null) => !!c && permissionVersionOf(c) === 2;

export function compiledFromRow(c: CompilationRow): CompiledAuthority {
  const r = c.restrictions as { validAfter: string; validUntil: string; totalOps?: number };
  return {
    maxAmountInWei: BigInt(c.maxAmountInWei), maxUsdcInRaw: BigInt(c.maxUsdcInRaw ?? 0), maxOps: c.maxOps,
    windowSec: c.windowSec ?? 0, totalOps: r.totalOps ?? c.maxOps,
    allowanceWei: BigInt(c.allowanceWei), usdcAllowanceRaw: BigInt(c.usdcAllowanceRaw ?? 0),
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
    compiled: compiledFromRow(compilation), gasAllowanceWei: BigInt(compilation.gasAllowanceWei), version: permissionVersionOf(compilation),
  });
  if (permission.getIdentifier() !== session.permissionId) throw new Error("Rebuilt permission does not match the authorized permission");
  const agentAccount = await createAgentAccount(ctx.publicClient, permission, account.address as `0x${string}`, ctx.chain.id);
  return { permission, agentAccount };
}

/**
 * Operations the agent permission has consumed, read from the EntryPoint nonce sequence for the
 * permission's validator key (Kernel v3 key: mode 0x00 | type 0x02 | permissionId | 0x0000).
 * Every validated op — including ones whose execution later reverted — advances it, exactly as the
 * rate-limit policy counts. Needs no session key.
 */
export async function agentOpsUsed(ctx: EngineContext, account: Address, permissionId: string): Promise<number> {
  const key = BigInt(pad(concatHex(["0x00", "0x02", pad(permissionId as `0x${string}`, { size: 20, dir: "right" }), "0x0000"]), { size: 24 }));
  const nonce = await ctx.publicClient.readContract({ address: ctx.network.entryPoint, abi: entryPoint07Abi, functionName: "getNonce", args: [account, key] });
  return Number(nonce & ((1n << 64n) - 1n));
}

/** Agent operations accepted by the bundler in the current rate-limit window (v2). The chain still enforces the count. */
export async function agentOpsInWindow(ctx: EngineContext, sessionId: string, windowSec: number, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - windowSec * 1000);
  const rows = await ctx.db.select({ id: userOperations.id }).from(userOperations).where(and(eq(userOperations.sessionId, sessionId),
    eq(userOperations.authority, "AGENT_SESSION"), inArray(userOperations.state, ["SUBMITTING", "SUBMITTED", "UNKNOWN", "INCLUDED"]), gt(userOperations.createdAt, since)));
  return rows.length;
}

/**
 * On-chain truth for session usability: installed with execute access, inside its time window, ops left.
 * v1: the op count is session-wide. v2: EXHAUSTED means "used up for this window" — it recovers on its own.
 */
export async function sessionStatus(ctx: EngineContext, account: AccountRow, session: SessionRow | null, compilation: CompilationRow | null, now = new Date()): Promise<SessionStatus> {
  if (!session || !compilation) return "NONE";
  if (session.status === "REVOKED") return "REVOKED";
  if (session.status === "REAUTH_REQUIRED") return "REAUTH_REQUIRED";
  if (session.status !== "ACTIVE") return "NONE";
  if (now >= session.validUntil) return "EXPIRED";
  const vId = `0x02${session.permissionId.slice(2).padEnd(40, "0")}` as `0x${string}`;
  const allowed = await ctx.publicClient.readContract({ address: account.address as `0x${string}`, abi: KernelV3_3AccountAbi, functionName: "isAllowedSelector", args: [vId, KERNEL_EXECUTE_SELECTOR] });
  if (!allowed) return "REVOKED";
  const c = compiledFromRow(compilation);
  const used = await agentOpsUsed(ctx, account.address as Address, session.permissionId);
  if (used >= c.totalOps) return "EXHAUSTED";
  if (isTwoWay(compilation) && (await agentOpsInWindow(ctx, session.id, c.windowSec, now)) >= c.maxOps) return "EXHAUSTED";
  return "ACTIVE";
}
export { permissionValidationId };
