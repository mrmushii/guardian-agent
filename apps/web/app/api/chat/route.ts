import { appendAudit } from "@guardian/db";
import { chatWithAgent } from "@guardian/agent";
import { agentFacts, chatHistory } from "@guardian/engine";
import { HttpError, json, requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";
const lastAsk = new Map<string, number>();

/** Conversation history (agent memory), oldest first. */
export const GET = route(async () => {
  const { account, ctx } = await requireAccount();
  return json({ turns: await chatHistory(ctx, account.id, 30) });
});

/** Owner asks the agent a question. Read-only: the reply explains and suggests; it never triggers a trade. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  const question = (message ?? "").trim().slice(0, 500);
  if (!question) throw new HttpError(400, "Type a question for the agent");
  const now = Date.now();
  if (now - (lastAsk.get(account.id) ?? 0) < 3_000) throw new HttpError(429, "One question every few seconds, please");
  lastAsk.set(account.id, now);
  const [facts, history] = await Promise.all([agentFacts(ctx, account.id), chatHistory(ctx, account.id, 12)]);
  let reply;
  try { reply = await chatWithAgent(ctx.models, { question, facts, history: history.map(({ role, text }) => ({ role, text })) }); }
  catch (e) { throw new HttpError(503, `${(e as Error).message.split(" (")[0]}. Your limits still protect the account; try again shortly.`); }
  // Memory stores answered turns only, so a failed AI call leaves no orphan question.
  await appendAudit(ctx.db, { accountId: account.id, type: "CHAT_Q", level: "INFO", message: question });
  await appendAudit(ctx.db, { accountId: account.id, type: "CHAT_A", level: "INFO", message: reply.answer, data: { intent: reply.intent, suggestions: reply.suggestions, provider: reply.provider, reasoning: reply.reasoning } });
  return json(reply);
});
