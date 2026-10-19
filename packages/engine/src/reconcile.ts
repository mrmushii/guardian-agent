import { and, eq, inArray, lt } from "drizzle-orm";
import { agentSessions, appendAudit, transitionAction, userOperations } from "@guardian/db";
import type { EngineContext } from "./context.js";
import { finalizeRebalance } from "./pipeline.js";
import { bundler, explorerTx, recordReceipt } from "./userops.js";

/**
 * Resolves submitted/uncertain operations from chain evidence (architecture §10). Runs on startup
 * before new work, then periodically. An operation with no receipt stays unresolved (lock held);
 * a timeout never counts as "not submitted".
 */
export async function reconcile(ctx: EngineContext) {
  const rows = await ctx.db.select().from(userOperations).where(inArray(userOperations.state, ["SUBMITTING", "SUBMITTED", "UNKNOWN"]));
  for (const row of rows) {
    if (!row.userOpHash) continue;
    let receipt;
    try { receipt = await bundler(ctx).getUserOperationReceipt({ hash: row.userOpHash as `0x${string}` }); } catch { continue; }
    if (!receipt) continue;
    const audit = (type: string, level: "SUCCESS" | "FAILURE" | "INFO", message: string, data?: unknown) =>
      appendAudit(ctx.db, { accountId: row.accountId, actionId: row.actionId ?? undefined, type, level, message, data });
    const evidence = { userOpHash: receipt.userOpHash, transactionHash: receipt.receipt.transactionHash, block: receipt.receipt.blockNumber, explorer: explorerTx(ctx, receipt.receipt.transactionHash), authority: row.authority };

    if (row.purpose === "REBALANCE" && row.actionId) { await finalizeRebalance(ctx, row.actionId, row.id, receipt); continue; }
    await recordReceipt(ctx, row.id, receipt);
    if (row.purpose === "AUTHORIZE" && row.sessionId) {
      // Multi-asset: one authorization installs every per-asset session prepared with it (older pending ones were abandoned).
      // A replacement authorization uninstalled the previous permissions in the same batch.
      if (receipt.success) await ctx.db.update(agentSessions).set({ status: "REVOKED", revokedAt: new Date(), revokeUserOpHash: receipt.userOpHash })
        .where(and(eq(agentSessions.accountId, row.accountId), inArray(agentSessions.status, ["ACTIVE", "REAUTH_REQUIRED"])));
      await ctx.db.update(agentSessions).set({ status: receipt.success ? "ACTIVE" : "FAILED", authorizeUserOpHash: receipt.userOpHash })
        .where(and(eq(agentSessions.accountId, row.accountId), eq(agentSessions.status, "PENDING_AUTHORIZATION")));
      await audit(receipt.success ? "AGENT_AUTHORIZED" : "AUTHORIZATION_FAILED", receipt.success ? "SUCCESS" : "FAILURE",
        receipt.success ? "Master authorized the agent session on-chain" : "Authorization UserOperation execution failed", evidence);
    }
    if (row.purpose === "REVOKE" && row.sessionId) {
      // Revocation removes every per-asset session of the account in one batch.
      if (receipt.success) await ctx.db.update(agentSessions).set({ status: "REVOKED", revokedAt: new Date(), revokeUserOpHash: receipt.userOpHash })
        .where(and(eq(agentSessions.accountId, row.accountId), inArray(agentSessions.status, ["ACTIVE", "REAUTH_REQUIRED"])));
      await audit(receipt.success ? "AGENT_REVOKED" : "REVOCATION_FAILED", receipt.success ? "SUCCESS" : "FAILURE",
        receipt.success ? "Master revoked the agent session; allowance cleared" : "Revocation UserOperation execution failed", evidence);
    }
  }
}

/** Expires sessions past validUntil, and abandons master preparations the owner never signed. */
export async function housekeeping(ctx: EngineContext, now = new Date()) {
  await ctx.db.update(agentSessions).set({ status: "EXPIRED" }).where(and(eq(agentSessions.status, "ACTIVE"), lt(agentSessions.validUntil, now)));
  const stale = new Date(now.getTime() - 30 * 60_000);
  const abandoned = await ctx.db.update(userOperations).set({ state: "ABANDONED" })
    .where(and(eq(userOperations.state, "AWAITING_SIGNATURE"), lt(userOperations.createdAt, stale))).returning();
  for (const r of abandoned) if (r.actionId) await transitionAction(ctx.db, r.actionId, ["MASTER_SIGNING"], "PENDING_APPROVAL");
}
