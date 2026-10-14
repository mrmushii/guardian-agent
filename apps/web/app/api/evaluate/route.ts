import { runRebalance } from "@guardian/engine";
import { json, requireAccount, route } from "@/lib/server";
/** Owner-requested evaluation. The optional message is untrusted data passed to the agent, never authority. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  return json(await runRebalance(ctx, account.id, { key: `manual:${Date.now()}`, kind: message ? "OWNER_MESSAGE" : "MANUAL", detail: "Owner requested an evaluation", userMessage: message?.slice(0, 1000) }));
});
