import { prepareAuthorization } from "@guardian/engine";
import { json, requireAccount, route } from "@/lib/server";
export const POST = route(async () => { const { account, ctx } = await requireAccount(); const p = await prepareAuthorization(ctx, account.id); return json({ userOperationId: p.userOperationId, userOpHash: p.userOpHash, permissionId: p.permissionId }); });
