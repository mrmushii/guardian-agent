import { whatIf } from "@guardian/engine";
import { HttpError, json, requireAccount, route } from "@/lib/server";

/** Preview what the agent would do right now under proposed limits. Nothing is saved or sent. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const patch = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!patch) throw new HttpError(400, "Send the proposed limits");
  const allowed = ["ethMinPct", "ethMaxPct", "targetEthPct", "maxAutoTxUsd", "dailyBudgetUsd", "maxSlippageBps", "sessionDurationHours", "assets", "driftPct"];
  try { return json(await whatIf(ctx, account.id, Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))))); }
  catch (e) {
    const issues = (e as { name?: string; issues?: { message: string }[] }).issues;
    if ((e as Error).name === "ZodError" && issues) throw new HttpError(400, issues.map((i) => i.message).join("; "));
    throw e;
  }
});
