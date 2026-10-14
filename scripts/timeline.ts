// Prints the audit timeline for one action (or the last N minutes). Usage: timeline.ts [actionId|minutes]
import { asc, eq, gt } from "drizzle-orm";
import { auditEvents, createDb } from "@guardian/db";
const { db, close } = createDb(process.env.DATABASE_URL!);
const arg = process.argv[2] ?? "10";
const where = /^\d+$/.test(arg) ? gt(auditEvents.createdAt, new Date(Date.now() - Number(arg) * 60_000)) : eq(auditEvents.actionId, arg);
for (const e of await db.select().from(auditEvents).where(where).orderBy(asc(auditEvents.id)))
  console.log(e.createdAt.toISOString().slice(11, 19), e.level.padEnd(7), e.type.padEnd(22), e.message.slice(0, 180), (e.data as { explorer?: string } | null)?.explorer ?? "");
await close();
