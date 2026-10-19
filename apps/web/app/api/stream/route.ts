import { eq } from "drizzle-orm";
import { recentAudit, watcherCheckpoints } from "@guardian/db";
import { requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";
/** Server-sent events: new audit events as they are written, so the console shows the agent's steps live. */
export const GET = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const start = new URL(req.url).searchParams.get("after");
  let cursor = start && /^\d+$/.test(start) ? BigInt(start) : 0n;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { clearInterval(timer); } };
      let polling = false, lastBeat = 0;
      const tick = async () => {
        if (polling) return;
        polling = true;
        try {
          const rows = await recentAudit(ctx.db, account.id, cursor, 100);
          if (rows.length) {
            cursor = rows[0]!.id;
            send(`data: ${JSON.stringify(rows.reverse(), (_, v) => (typeof v === "bigint" ? `${v}` : v))}\n\n`);
          }
          // Live watch status: pushed whenever the worker records a new check.
          const [cp] = await ctx.db.select().from(watcherCheckpoints).where(eq(watcherCheckpoints.accountId, account.id));
          if (cp && cp.heartbeatAt.getTime() !== lastBeat) {
            lastBeat = cp.heartbeatAt.getTime();
            send(`event: watch\ndata: ${JSON.stringify({ heartbeatAt: cp.heartbeatAt, lastBlock: `${cp.lastBlock}`, lastCheck: cp.lastCheck, workerOnline: true })}\n\n`);
          } else if (!rows.length) send(": ping\n\n");
        } catch { /* transient DB error: next tick retries */ }
        finally { polling = false; }
      };
      void tick();
      timer = setInterval(tick, 1_500);
      req.signal.addEventListener("abort", () => { clearInterval(timer); try { controller.close(); } catch { /* already closed */ } });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
});
