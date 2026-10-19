import { eq } from "drizzle-orm";
import { appendAudit, smartAccounts } from "@guardian/db";
import { json, requireOwner, route } from "@/lib/server";
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireOwner();
  const { enabled } = (await req.json()) as { enabled: boolean };
  await ctx.db.update(smartAccounts).set({ monitoringEnabled: !!enabled, pausedReason: enabled ? null : "PAUSED_BY_OWNER" }).where(eq(smartAccounts.id, account.id));
  await appendAudit(ctx.db, { accountId: account.id, type: enabled ? "RESUMED" : "PAUSED", level: "INFO", message: enabled ? "Owner resumed autonomous monitoring" : "Owner paused autonomous monitoring" });
  return json({ enabled: !!enabled });
});
