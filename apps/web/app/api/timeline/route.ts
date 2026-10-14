import { recentAudit } from "@guardian/db";
import { json, requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";
/** Persisted audit events after a cursor; the dashboard reloads from here after any disconnect. */
export const GET = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const after = new URL(req.url).searchParams.get("after");
  const events = await recentAudit(ctx.db, account.id, after && /^\d+$/.test(after) ? BigInt(after) : 0n, 300);
  return json({ events });
});
