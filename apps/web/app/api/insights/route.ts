import { briefSummary } from "@guardian/agent";
import { allocationHistory, dailyStats } from "@guardian/engine";
import { json, requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";
/** The AI sentence costs a model call; reuse it for 10 minutes unless the stats change. */
const briefCache = new Map<string, { at: number; key: string; summary: string | null }>();

export const GET = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const days = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 7)));
  const [history, stats] = await Promise.all([allocationHistory(ctx, account.id, days), dailyStats(ctx, account.id)]);
  const key = JSON.stringify(stats), hit = briefCache.get(account.id);
  let summary = hit && hit.key === key && Date.now() - hit.at < 600_000 ? hit.summary : undefined;
  if (summary === undefined) {
    summary = await briefSummary(ctx.models, stats).catch(() => null);
    briefCache.set(account.id, { at: Date.now(), key, summary });
  }
  return json({ history, brief: { ...stats, summary } });
});
