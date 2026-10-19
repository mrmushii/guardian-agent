import { publishPolicy } from "@guardian/engine";
import { HttpError, json, requireOwner, route } from "@/lib/server";
/** Owner publishes a new policy version. The agent's on-chain permission changes only after the owner signs a new authorization. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireOwner();
  const patch = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!patch || typeof patch !== "object") throw new HttpError(400, "Send the policy fields to change");
  const allowed = ["ethMinPct", "ethMaxPct", "targetEthPct", "maxAutoTxUsd", "dailyBudgetUsd", "maxSlippageBps", "sessionDurationHours", "assets", "driftPct"];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  try { return json(await publishPolicy(ctx, account.id, clean)); }
  catch (e) {
    const issues = (e as { name?: string; issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if ((e as Error).name === "ZodError" && issues) throw new HttpError(400, issues.map((i) => `${i.path.map(String).join(".") || "policy"}: ${i.message}`).join("; "));
    throw e;
  }
});
