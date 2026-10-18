"use client";
import s from "./console.module.css";
import { ago, explain, humanize, short, STEPS, time, type Dash, type Ev } from "./model";

const ACTIVE = ["TRIGGERED", "PLANNING", "SIMULATING", "SUBMITTING", "PENDING", "REVALIDATING", "PENDING_APPROVAL", "MASTER_SIGNING"];
const FAILED = ["FAILED", "EXECUTION_FAILED", "REJECTED", "CANCELLED"];
const TIER: Record<string, string> = { TIER1_AGENT: "Agent signs alone", TIER2_MASTER: "Needs your signature", TIER3_REJECT: "Prohibited", SIMULATED: "Simulated (no on-chain trade)" };

export function Evidence({ e }: { e: Ev }) {
  if (!e.data || typeof e.data.explorer !== "string") return null;
  return (
    <p className={s.feedWhy}>
      <a href={e.data.explorer} target="_blank" rel="noreferrer">Transaction {short(String(e.data.transactionHash))}</a>
      {e.data.userOpHash ? <> · UserOperation <span className="hash">{short(String(e.data.userOpHash))}</span></> : null}
    </p>
  );
}

/** The latest action as the agent's train of thought: step bar, key facts, then each step explained. */
export function AgentThinking({ dash, events }: { dash: Dash; events: Ev[] }) {
  const latest = dash.actions[0];
  const steps = latest ? events.filter((e) => e.actionId === latest.id).reverse() : [];
  const reached = Math.max(-1, ...steps.map((e) => STEPS.findIndex((st) => st.id === explain(e.type).step)));
  const active = latest && ACTIVE.includes(latest.state), failed = latest && FAILED.includes(latest.state);
  const decision = steps.find((e) => e.type === "AI_DECISION");
  const provider = (decision?.data as { provider?: string } | null)?.provider ?? latest?.decision?.provider;
  const risk = steps.find((e) => e.type === "RISK")?.message.match(/Risk (\d+) \((\w+)\)/);
  const usd = latest?.requestedUsdCents ? `$${(Number(latest.requestedUsdCents) / 100).toFixed(2)}` : null;

  return (
    <section className={`glass ${s.panel}`} aria-label="Current progress">
      <div className={s.panelHead}>
        <h2>Agent thinking</h2>
        {latest && <span className="muted" style={{ fontSize: "0.8rem" }}>{active ? "live" : ago(latest.createdAt)}</span>}
      </div>
      {!latest ? (
        <p className={s.empty}>No decisions yet. When WETH leaves your {dash.policy?.ethMinPct ?? 45}–{dash.policy?.ethMaxPct ?? 55}% range, you'll watch the agent reason through it here, step by step.</p>
      ) : (
        <>
          <div className={s.steps} aria-hidden="true">
            {STEPS.map((st, i) => {
              const cls = failed && i === reached ? s.stepFail : i <= reached ? s.stepDone : active && i === reached + 1 ? s.stepNow : "";
              return <div key={st.id} className={`${s.stepItem} ${cls}`}><div className={s.stepBar} /><span>{st.label}</span></div>;
            })}
          </div>
          <div className={s.summary}>
            <span className={`${s.chip} ${latest.state === "CONFIRMED" ? s.chipGood : failed ? s.chipBad : latest.state === "NO_ACTION" ? "" : s.chipAccent}`}>{explain(latest.state).title}</span>
            {latest.plan?.direction && <span className={s.chip}>{/^BUY/.test(latest.plan.direction) ? "Buy" : "Sell"} {(latest.plan as { asset?: string }).asset ?? "WETH"}{usd ? ` · ≈ ${usd}` : ""}</span>}
            {latest.tier && <span className={s.chip}>{TIER[latest.tier] ?? latest.tier}</span>}
            {risk && <span className={`${s.chip} ${risk[2] === "LOW" ? s.chipGood : risk[2] === "HIGH" ? s.chipBad : s.chipWarn}`}>Risk {risk[1]} · {risk[2]!.toLowerCase()}</span>}
            {provider && <span className={`${s.chip} ${provider === "deterministic-fallback" ? s.chipWarn : ""}`}>{provider === "deterministic-fallback" ? "Safe rule (AI offline)" : `AI · ${provider}`}</span>}
          </div>
          {latest.decision && (
            <p className={s.quote}>“{latest.decision.reason}”<small>{latest.decision.decision === "REBALANCE" ? "Decided to rebalance" : humanize(latest.decision.decision)} — the AI chooses what to do; code computes every amount and the account enforces your limits.</small></p>
          )}
          {latest.reasons?.length ? <p className={s.feedWhy}>Why: {latest.reasons.map(humanize).join(", ")}</p> : null}
          <ol className={s.feed}>
            {steps.map((e) => {
              const x = explain(e.type);
              return (
                <li key={e.id} className={`${s.feedItem} ${s[`lv_${e.level}`] ?? ""}`}>
                  <span className={s.feedIcon} aria-hidden="true">{x.icon}</span>
                  <div>
                    <div className={s.feedTitle}>{x.title}<time dateTime={e.createdAt}>{time(e.createdAt)}</time></div>
                    <p className={s.feedMsg}>{e.message}</p>
                    {x.why && <p className={s.feedWhy}>{x.why}</p>}
                    <Evidence e={e} />
                  </div>
                </li>
              );
            })}
            {steps.length === 0 && <li className={s.empty}>Loading the steps…</li>}
          </ol>
        </>
      )}
    </section>
  );
}
