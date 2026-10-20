// Durable-concurrency invariants (plan §12, architecture §9) against the real database.
// Uses a throwaway account and removes everything it created.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { agentActions, auditEvents, claimAction, createDb, dailyUsedCents, policies, releaseBudget, reserveBudget, smartAccounts, transitionAction, watcherCheckpoints } from "@guardian/db";

try { process.loadEnvFile(resolve(__dirname, "../../.env")); } catch { /* env provided */ }
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("database invariants", () => {
  const { db, close } = createDb(process.env.DATABASE_URL!);
  let accountId = "", policyId = "";
  beforeAll(async () => {
    const [a] = await db.insert(smartAccounts).values({ chainId: 84532, address: `0xtest${Date.now()}`, ownerAddress: "0xtest", kernelVersion: "test", entryPoint: "0xtest" }).returning();
    accountId = a!.id;
    const [p] = await db.insert(policies).values({ accountId, version: 1, policy: {}, active: true }).returning();
    policyId = p!.id;
  });
  afterAll(async () => {
    await db.delete(auditEvents).where(eq(auditEvents.accountId, accountId));
    await db.delete(agentActions).where(eq(agentActions.accountId, accountId));
    await db.delete(policies).where(eq(policies.accountId, accountId));
    // A running worker may have checkpointed this temporary account; clear that before deleting it.
    await db.delete(watcherCheckpoints).where(eq(watcherCheckpoints.accountId, accountId));
    await db.delete(smartAccounts).where(eq(smartAccounts.id, accountId));
    await close();
  });

  it("duplicate trigger is ignored (idempotency)", async () => {
    const a = await claimAction(db, { accountId, policyId, triggerKey: "t1", trigger: {} });
    expect(a).not.toBeNull();
    await transitionAction(db, a!.id, ["TRIGGERED"], "NO_ACTION");
    expect(await claimAction(db, { accountId, policyId, triggerKey: "t1", trigger: {} })).toBeNull();
  });

  it("only one active action per account, even under concurrent claims", async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimAction(db, { accountId, policyId, triggerKey: `c${i}`, trigger: {} })));
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    // PENDING_APPROVAL keeps the lock; a terminal state releases it.
    await transitionAction(db, won[0]!.id, ["TRIGGERED"], "PENDING_APPROVAL");
    expect(await claimAction(db, { accountId, policyId, triggerKey: "c-next", trigger: {} })).toBeNull();
    await transitionAction(db, won[0]!.id, ["PENDING_APPROVAL"], "CANCELLED");
    const next = await claimAction(db, { accountId, policyId, triggerKey: "c-next2", trigger: {} });
    expect(next).not.toBeNull();
    await transitionAction(db, next!.id, ["TRIGGERED"], "CONFIRMED");
  });

  it("transitions are optimistic: a stale `from` state does not apply", async () => {
    const a = await claimAction(db, { accountId, policyId, triggerKey: "opt", trigger: {} });
    expect(await transitionAction(db, a!.id, ["PLANNING"], "SIMULATING")).toBeNull();
    await transitionAction(db, a!.id, ["TRIGGERED"], "FAILED");
  });

  it("concurrent budget reservations never exceed the daily budget", async () => {
    const day = "2099-01-01";
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const [r] = await db.insert(agentActions).values({ accountId, policyId, triggerKey: `b${i}`, trigger: {}, state: "CONFIRMED" }).returning();
      ids.push(r!.id);
    }
    // 4 × $10 against a $25 budget: at most two may succeed.
    const res = await Promise.all(ids.map((actionId) => reserveBudget(db, { accountId, actionId, cents: 1000n, budgetCents: 2500n, day })));
    expect(res.filter((r) => r.ok)).toHaveLength(2);
    expect(await dailyUsedCents(db, accountId, day)).toBe(2000n);
    await releaseBudget(db, ids[res.findIndex((r) => r.ok)]!);
    expect(await dailyUsedCents(db, accountId, day)).toBe(1000n);
  });
});
