import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { ACTIVE_ACTION_STATES, agentActions, auditEvents, smartAccounts } from "./schema.js";

export * from "./schema.js";
export { schema };

export function createDb(url: string) {
  const client = postgres(url, { ssl: "require", max: 5, prepare: false });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
export type Db = ReturnType<typeof createDb>["db"];

export type AuditLevel = "INFO" | "SUCCESS" | "WARNING" | "FAILURE";

/** Appends an audit event. bigint values are serialized as strings. */
export async function appendAudit(db: Db, e: { accountId?: string; actionId?: string; type: string; level: AuditLevel; message: string; data?: unknown }) {
  const data = e.data === undefined ? null : JSON.parse(JSON.stringify(e.data, (_, v) => (typeof v === "bigint" ? `${v}` : v)));
  const [row] = await db.insert(auditEvents).values({ ...e, data }).returning({ id: auditEvents.id });
  return row!.id;
}

/** UTC calendar day (decision D1). */
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

/**
 * Durable claim (plan §12): fails if the trigger was already handled (idempotency) or another
 * action for this account is still active (one-active-rebalance lock). Returns null in both cases.
 */
export async function claimAction(db: Db, v: { accountId: string; policyId: string; sessionId?: string | null; triggerKey: string; trigger: unknown; triggerBlock?: bigint }) {
  try {
    const [row] = await db.insert(agentActions).values({ ...v, sessionId: v.sessionId ?? null, state: "TRIGGERED" }).returning();
    return row!;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

/** Optimistic state transition: only applies if the action is still in one of `from`. */
export async function transitionAction(db: Db, id: string, from: readonly string[], to: string, patch: Partial<typeof agentActions.$inferInsert> = {}) {
  const rows = await db.update(agentActions).set({ ...patch, state: to, updatedAt: new Date() })
    .where(and(eq(agentActions.id, id), inArray(agentActions.state, [...from]))).returning();
  return rows[0] ?? null;
}

export async function activeAction(db: Db, accountId: string) {
  const [row] = await db.select().from(agentActions)
    .where(and(eq(agentActions.accountId, accountId), inArray(agentActions.state, [...ACTIVE_ACTION_STATES]))).limit(1);
  return row ?? null;
}

export async function inCooldown(db: Db, accountId: string, now = new Date()) {
  const [row] = await db.select({ id: agentActions.id }).from(agentActions)
    .where(and(eq(agentActions.accountId, accountId), gt(agentActions.cooldownUntil, now))).limit(1);
  return !!row;
}

/** Autonomous spending reserved/spent on a UTC day. */
export async function dailyUsedCents(db: Db, accountId: string, day = utcDay()): Promise<bigint> {
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${agentActions.reservedUsdCents}), 0)` }).from(agentActions)
    .where(and(eq(agentActions.accountId, accountId), eq(agentActions.budgetDay, day)));
  return BigInt(row!.total);
}

/**
 * Atomically reserves autonomous budget for an action. The account row lock serializes concurrent
 * reservations, so two actions cannot both fit under the same remaining budget.
 */
export async function reserveBudget(db: Db, p: { accountId: string; actionId: string; cents: bigint; budgetCents: bigint; day?: string }) {
  const day = p.day ?? utcDay();
  return db.transaction(async (tx) => {
    await tx.select({ id: smartAccounts.id }).from(smartAccounts).where(eq(smartAccounts.id, p.accountId)).for("update");
    const used = await dailyUsedCents(tx as unknown as Db, p.accountId, day);
    if (used + p.cents > p.budgetCents) return { ok: false as const, used };
    await tx.update(agentActions).set({ reservedUsdCents: p.cents, budgetDay: day, updatedAt: new Date() }).where(eq(agentActions.id, p.actionId));
    return { ok: true as const, used: used + p.cents };
  });
}

export async function releaseBudget(db: Db, actionId: string) {
  await db.update(agentActions).set({ reservedUsdCents: 0n, updatedAt: new Date() }).where(eq(agentActions.id, actionId));
}

export async function recentAudit(db: Db, accountId: string, afterId = 0n, limit = 200) {
  return db.select().from(auditEvents)
    .where(and(eq(auditEvents.accountId, accountId), gt(auditEvents.id, afterId))).orderBy(desc(auditEvents.id)).limit(limit);
}
