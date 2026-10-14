import { prepareRevocation } from "@guardian/engine";
import { json, requireAccount, route } from "@/lib/server";
export const POST = route(async () => { const { account, ctx } = await requireAccount(); return json(await prepareRevocation(ctx, account.id)); });
