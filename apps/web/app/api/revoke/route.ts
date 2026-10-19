import { prepareRevocation } from "@guardian/engine";
import { json, requireOwner, route } from "@/lib/server";
export const POST = route(async () => { const { account, ctx } = await requireOwner(); return json(await prepareRevocation(ctx, account.id)); });
