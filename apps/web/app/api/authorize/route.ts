import { prepareAuthorization } from "@guardian/engine";
import { json, requireOwner, route } from "@/lib/server";
export const POST = route(async () => { const { account, ctx } = await requireOwner(); const p = await prepareAuthorization(ctx, account.id); return json({ userOperationId: p.userOperationId, userOpHash: p.userOpHash, permissionId: p.permissionId }); });
