"use client";
import { useEffect, useRef, useState } from "react";
import s from "./chat.module.css";
import { Icon } from "./icons";
import { AgentOrb, YourTasks, type Ctl } from "./Hero";
import { agentMode, api, portfolioOf, tasksOf, time, type Ev } from "./model";
import type { View } from "./Shell";
import { useSay } from "./detail";

export type Msg = {
  id: string; role: "owner" | "agent"; text: string; at: string;
  intent?: string; suggestions?: string[]; provider?: string; reasoning?: string; proactive?: boolean; link?: string; animate?: boolean; error?: boolean;
};

const STARTERS = ["How is my portfolio doing?", "Why did you trade last time?", "What would make you ask me for approval?", "Explain my limits simply"];
const INTENT_BUTTON: Record<string, { label: string; icon: string }> = {
  EVALUATE: { label: "Run a check now", icon: "bolt" }, EXPLAIN_LAST: { label: "Show last decision", icon: "brain" },
  EDIT_LIMITS: { label: "Open limits", icon: "limits" }, SIMULATE: { label: "Try a simulated move", icon: "flask" },
};

/** Turns notable engine events into the agent speaking first. */
export function proactiveFrom(e: Ev, maxAuto: number): Msg | null {
  const base = { id: `p-${e.id}`, role: "agent" as const, at: e.createdAt, proactive: true, animate: true, link: typeof e.data?.explorer === "string" ? e.data.explorer : undefined };
  switch (e.type) {
    case "CONFIRMED": return { ...base, text: `Done — my trade is confirmed on-chain. ${e.message.replace(/^Confirmed in block \d+;\s*/, "").replace(/^allocation now/, "Your allocation is now") || ""}`.trim() };
    case "PARTIAL_STEP": return { ...base, text: `This move is bigger than your $${maxAuto} per-trade cap, so I'm doing one capped step now and the rest after a short cooldown.` };
    case "PENDING_APPROVAL": return { ...base, text: "This one is above what I'm allowed to do alone, so I need your signature. It's waiting in your tasks — prices get rechecked before you sign." };
    case "AI_UNAVAILABLE": return { ...base, text: "My AI model didn't answer, so I'm falling back to your own target — only small, low-risk trades. If it keeps failing I'll pause myself to be safe." };
    case "FAILED": return { ...base, text: `I stopped this action: ${e.message}` };
    case "EXECUTION_FAILED": return { ...base, text: "The swap reverted on-chain (the market moved). My permission was fine and no funds were lost; I'll re-check on the next trigger." };
    case "SIMULATED_FILL": return { ...base, text: `Simulated step done (this asset cannot trade on this network): ${e.message.replace(/^Simulated fill recorded; /, "")}` };
    case "DEMO_MOVE": return { ...base, text: `Noticed: ${e.message.replace(/^Simulated market move: /, "")}. Let me look…` };
    default: return null;
  }
}

function Typewriter({ text, animate }: { text: string; animate?: boolean }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(text.length); return; }
    const step = Math.max(1, Math.round(text.length / 60));
    const t = setInterval(() => setN((v) => { if (v >= text.length) { clearInterval(t); return v; } return v + step; }), 16);
    return () => clearInterval(t);
  }, [text, animate]);
  return <>{text.slice(0, n)}{n < text.length && <span className={s.caret} />}</>;
}

export function AgentChat({ ctl, proactive, setView, onSeen, initialAsk, onInitialAsk }: { ctl: Ctl; proactive: Msg[]; setView: (v: View) => void; onSeen: () => void; initialAsk?: string | null; onInitialAsk?: () => void }) {
  const say = useSay();
  const { dash, busy, run } = ctl;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const mode = agentMode(dash), p = portfolioOf(dash);

  useEffect(() => {
    api<{ turns: { role: "owner" | "agent"; text: string; at: string; data: { intent?: string; suggestions?: string[]; provider?: string; reasoning?: string } | null }[] }>("/api/chat")
      .then(({ turns }) => setMsgs(turns.map((t, i) => ({ id: `h-${i}`, role: t.role, text: t.text, at: t.at, intent: t.data?.intent, provider: t.data?.provider, reasoning: t.data?.reasoning }))))
      .catch(() => { /* history is a convenience */ });
  }, []);
  useEffect(() => { onSeen(); }, [proactive.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = [...msgs, ...proactive.filter((m) => !msgs.some((x) => x.id === m.id))].sort((a, b) => a.at.localeCompare(b.at));
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [all.length, thinking]);

  const ask = async (q: string) => {
    if (!q.trim() || thinking) return;
    const now = new Date().toISOString();
    setMsgs((m) => [...m, { id: `o-${now}`, role: "owner", text: q.trim(), at: now }]);
    setText(""); setThinking(true);
    try {
      const r = await api<{ answer: string; intent: string; suggestions: string[]; provider: string; reasoning?: string }>("/api/chat", { message: q.trim() });
      setMsgs((m) => [...m, { id: `a-${Date.now()}`, role: "agent", text: r.answer, at: new Date().toISOString(), intent: r.intent, suggestions: r.suggestions, provider: r.provider, reasoning: r.reasoning, animate: true }]);
    } catch (e) {
      setMsgs((m) => [...m, { id: `e-${Date.now()}`, role: "agent", text: (e as Error).message, at: new Date().toISOString(), error: true }]);
    } finally { setThinking(false); }
  };
  const doIntent = (intent: string) => {
    if (intent === "EVALUATE") void run("ask", async () => {
      const r = await api<{ skipped?: string; state?: string }>("/api/evaluate", {});
      return r.skipped === "COOLDOWN" ? "In cooldown after a recent trade — try again in a few minutes." : r.skipped ? `Skipped: ${r.skipped.replaceAll("_", " ").toLowerCase()}` : "Checking now — watch the steps on Overview.";
    });
    else if (intent === "EXPLAIN_LAST" || intent === "SIMULATE") setView(intent === "SIMULATE" ? "settings" : "overview");
    else if (intent === "EDIT_LIMITS") setView("limits");
  };
  useEffect(() => { if (initialAsk) { onInitialAsk?.(); void ask(initialAsk); } }, [initialAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastAgent = [...all].reverse().find((m) => m.role === "agent" && m.suggestions?.length);

  return (
    <section className={`glass ${s.chat}`} aria-label="Agent chat">
      <header className={s.head}>
        <AgentOrb mode={mode} />
        <div className={s.headText}>
          <strong>Guardian</strong>
          <span>{dash.agent.models[0] ? `AI · ${dash.agent.models[0]}` : "AI not configured"}{p ? ` · ${say("WETH")} ${p.wethWeightPct.toFixed(1)}%` : ""}</span>
        </div>
        <span className={s.safe}><Icon name="limits" size={14} /> Read-only chat</span>
      </header>

      <div className={s.stream} aria-live="polite">
        {tasksOf(dash).length > 0 && <div className={s.card}><YourTasks {...ctl} /></div>}
        {all.length === 0 && (
          <div className={s.welcome}>
            <AgentOrb mode={mode} large />
            <h2>Hi, I'm your Guardian agent.</h2>
            <p>I keep your {say("WETH")}/USDC mix between {dash.policy?.ethMinPct}% and {dash.policy?.ethMaxPct}%. Ask me anything about your portfolio, my decisions, or your limits.</p>
            <div className={s.starters}>{STARTERS.map((q) => <button key={q} onClick={() => void ask(q)}><Icon name="sparkle" size={14} />{q}</button>)}</div>
          </div>
        )}
        {all.map((m) => (
          <div key={m.id} className={`${s.row} ${m.role === "owner" ? s.rowMe : ""}`}>
            {m.role === "agent" && <span className={s.avatar}><Icon name="agent" size={15} /></span>}
            <div className={`${s.bubble} ${m.role === "owner" ? s.me : s.agent} ${m.proactive ? s.proactive : ""} ${m.error ? s.err : ""}`}>
              {m.proactive && <span className={s.tag}><Icon name="bolt" size={12} /> Update</span>}
              <p><Typewriter text={say(m.text)} animate={m.animate} /></p>
              {m.link && <a href={m.link} target="_blank" rel="noreferrer" className={s.link}><Icon name="external" size={13} /> View transaction</a>}
              {m.intent && INTENT_BUTTON[m.intent] && (
                <button className={s.intent} disabled={!!busy} onClick={() => doIntent(m.intent!)}><Icon name={INTENT_BUTTON[m.intent].icon} size={14} />{INTENT_BUTTON[m.intent].label}</button>
              )}
              {m.reasoning && <details className={s.why}><summary>How I got this answer</summary><pre>{m.reasoning}</pre></details>}
              <span className={s.meta}>{time(m.at)}{m.provider ? ` · ${m.provider === "deterministic-fallback" ? "safe rule" : m.provider.split(":")[0]}` : ""}</span>
            </div>
          </div>
        ))}
        {thinking && <div className={s.row}><span className={s.avatar}><Icon name="agent" size={15} /></span><div className={`${s.bubble} ${s.agent}`}><span className={s.dots}><i /><i /><i /></span><span className={s.meta}>Reading your portfolio and history…</span></div></div>}
        <div ref={end} />
      </div>

      {lastAgent?.suggestions?.length ? <div className={s.chips}>{lastAgent.suggestions.map((q) => <button key={q} disabled={thinking} onClick={() => void ask(q)}>{q}</button>)}</div> : null}
      <form className={s.composer} onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Guardian anything…" maxLength={500} aria-label="Message the agent" />
        <button className="primary" type="submit" disabled={thinking || !text.trim()} aria-label="Send"><Icon name="send" size={16} /></button>
      </form>
      <p className={s.fine}>Guardian answers from your live data. Chat can't move money or change your limits.</p>
    </section>
  );
}
