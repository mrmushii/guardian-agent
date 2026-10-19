import { eq } from "drizzle-orm";
import { agentActions } from "@guardian/db";
import { prepareApproval } from "@guardian/engine";
import { HttpError, json, requireOwner, route } from "@/lib/server";
export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { account, ctx } = await requireOwner(); const { id } = await params;
  const [a] = await ctx.db.select({ accountId: agentActions.accountId }).from(agentActions).where(eq(agentActions.id, id));
  if (a?.accountId !== account.id) throw new HttpError(404, "Action not found");
  return json(await prepareApproval(ctx, id));
});
