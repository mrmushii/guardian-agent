"use client";
import { useEffect, useState } from "react";
import s from "./console.module.css";
import t from "./thinking.module.css";
import { ago, explain, humanize, short, STEPS, time, type Check, type Dash, type Ev } from "./model";

const ACTIVE = ["TRIGGERED", "PLANNING", "SIMULATING", "SUBMITTING", "PENDING", "REVALIDATING", "PENDING_APPROVAL", "MASTER_SIGNING"];
const FAILED = ["FAILED", "EXECUTION_FAILED", "REJECTED", "CANCELLED"];
const TIER: Record<string, string> = { TIER1_AGENT: "Agent signs alone", TIER2_MASTER: "Needs your signature", TIER3_REJECT: "Prohibited", SIMULATED: "Simulated (no on-chain trade)" };
const CHECK_LABEL: Record<Check["state"], string> = {
  checking: "Checking", in_band: "In range", out_of_band: "Out of range", evaluating: "Deciding", cooldown: "Cooldown", error: "Check failed",
};

/** Re-renders every second so "checked 4 s ago" and countdowns tick in real time. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return now;
}
const secs = (ms: number) => { const v = Math.max(0, Math.round(ms / 1000)); return v < 60 ? `${v}s` : `${Math.floor(v / 60)}m ${v % 60}s`; };

export function Evidence({ e }: { e: Ev }) {
  if (!e.data || typeof e.data.explorer !== "string") return null;
  return (
    <p className={s.feedWhy}>
      <a href={e.data.explorer} target="_blank" rel="noreferrer">Transaction {short(String(e.data.transactionHash))}</a>
      {e.data.userOpHash ? <> · UserOperation <span className="hash">{short(String(e.data.userOpHash))}</span></> : null}
    </p>
  );
}

/** What the worker is doing right now: last check, block, next check, and recent checks. */
function LiveStrip({ dash }: { dash: Dash }) {
  const now = useNow();
  const w = dash.watch, c = w.lastCheck;
  const beat = w.heartbeatAt ? new Date(w.heartbeatAt).getTime() : 0;
  const online = beat > 0 && now - beat < 45_000;
  if (!dash.monitoring.enabled) return <div className={`${t.live} ${t.paused}`}><i className={t.dotIdle} /><div><b>Paused</b><span>The agent is not watching. Resume it to restart checks.</span></div></div>;
  if (!online) return (
    <div className={`${t.live} ${t.offline}`}><i className={t.dotWarn} /><div>
      <b>Agent worker offline{beat ? ` since ${time(new Date(beat).toISOString())}` : ""}</b>
      <span>Nothing is watching your portfolio. Start the worker (<span className="hash">corepack pnpm worker</span>) to resume.</span>
    </div></div>
  );
  const next = c ? new Date(c.nextCheckAt).getTime() - now : 0;
  const busy = c?.state === "evaluating" || c?.state === "checking";
  return (
    <div className={`${t.live} ${busy ? t.busy : c?.state === "out_of_band" || c?.state === "error" ? t.alert : ""}`}>
      <i className={busy ? t.dotBusy : t.dotLive} />
      <div className={t.liveBody}>
        <b>{busy ? "Deciding now…" : "Watching"} <small>· checked {secs(now - beat)} ago{w.lastBlock ? ` at block ${Number(w.lastBlock).toLocaleString()}` : ""}{!busy && next > 0 ? ` · next check in ${secs(next)}` : ""}</small></b>
        {c && <span>{c.summary}</span>}
        {c?.recent && c.recent.length > 1 && (
          <details className={t.recent}>
            <summary>Recent checks ({c.recent.length})</summary>
            <ol>{c.recent.map((r, i) => <li key={i}><time>{time(r.at)}</time><em className={t[`st_${r.state}`]}>{CHECK_LABEL[r.state]}</em><span>{r.summary}</span></li>)}</ol>
          </details>
        )}
      </div>
    </div>
  );
}

type Inputs = { portfolio?: Record<string, string>; policy?: Record<string, number>; market?: Record<string, unknown> | null; proposedTrade?: { direction: string; usd: string; tier: string; reasons: string[]; risk: { score: number; classification: string } }; recentOutcomes?: unknown[]; trigger?: { detail: string } };

/** "Show what the AI thought": the model's reasoning (when the provider exposes it) and exactly what it was shown. */
export function AiThoughts({ data }: { data: Record<string, unknown> | null }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const reasoning = typeof data.reasoning === "string" ? data.reasoning : null;
  const inputs = (data.inputs ?? null) as Inputs | null;
  const provider = typeof data.provider === "string" ? data.provider : null;
  const errors = Array.isArray(data.fallbackErrors) ? (data.fallbackErrors as string[]) : [];
  if (!reasoning && !inputs && !errors.length) return null;
  const row = (k: string, v: unknown) => v === undefined || v === null || v === "" ? null : <div key={k}><dt>{k}</dt><dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd></div>;
  const m = inputs?.market as Record<string, unknown> | undefined, move = m?.recentMove as Record<string, string> | null | undefined;
  return (
    <details className={t.thoughts}>
      <summary>Show what the AI thought</summary>
      <div className={t.thoughtsBody}>
        <p className={t.meta}>{provider === "deterministic-fallback" ? "AI unavailable — the safe rule decided" : `Model ${provider ?? "unknown"}`}{typeof data.latencyMs === "number" && data.latencyMs > 0 ? ` · answered in ${(data.latencyMs / 1000).toFixed(1)}s` : ""}</p>
        {reasoning ? (
          <div className={t.reasoning}>
            <div className={t.reasoningHead}><b>Reasoning</b><button className="ghost" onClick={() => { void navigator.clipboard?.writeText(reasoning); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button></div>
            <pre>{reasoning}</pre>
          </div>
        ) : provider !== "deterministic-fallback" ? <p className={t.meta}>This model didn't share its reasoning — only its final answer.</p> : null}
        {errors.length > 0 && <p className={t.meta}>Provider errors: {errors.join(" · ")}</p>}
        {inputs && (
          <div className={t.inputs}>
            <b>What the AI saw</b>
            <dl>
              {row("Trigger", inputs.trigger?.detail)}
              {row("Portfolio", inputs.portfolio && `$${inputs.portfolio.totalUsd} · ${inputs.portfolio.wethWeightPct}${/^\d/.test(inputs.portfolio.wethWeightPct ?? "") ? "% WETH" : ""}`)}
              {row("Limits", inputs.policy && `band ${inputs.policy.ethMinPct}–${inputs.policy.ethMaxPct}%, target ${inputs.policy.targetEthPct}%, $${inputs.policy.maxAutoTxUsd}/trade, $${inputs.policy.dailyBudgetUsd}/day`)}
              {row("Proposed trade", inputs.proposedTrade && `${humanize(inputs.proposedTrade.direction)} ≈ $${inputs.proposedTrade.usd} · ${TIER[inputs.proposedTrade.tier] ?? inputs.proposedTrade.tier} · risk ${inputs.proposedTrade.risk.score} ${inputs.proposedTrade.risk.classification.toLowerCase()}`)}
              {row("Prices", m && `oracle $${m.oracleEthUsd} · pool $${m.quoteEthUsd} · divergence ${m.divergencePct}%${m.testnetPricing ? " (testnet)" : ""}`)}
              {row("Recent move", move && `${move.changePct}% over ${move.spanHours} h (range ${move.rangePct}%)`)}
              {row("Gas", m?.gasGwei !== undefined ? `${m.gasGwei} gwei` : undefined)}
              {row("Recent outcomes", inputs.recentOutcomes?.length ? `${inputs.recentOutcomes.length} previous actions` : undefined)}
            </dl>
          </div>
        )}
      </div>
    </details>
  );
}

/** Live status on top; then the current (or last) decision as the agent's train of thought. */
export function AgentThinking({ dash, events }: { dash: Dash; events: Ev[] }) {
  const now = useNow();
  const latest = dash.actions[0];
  const steps = latest ? events.filter((e) => e.actionId === latest.id).reverse() : [];
  const reached = Math.max(-1, ...steps.map((e) => STEPS.findIndex((st) => st.id === explain(e.type).step)));
  const active = latest && ACTIVE.includes(latest.state), failed = latest && FAILED.includes(latest.state);
  const decision = steps.find((e) => e.type === "AI_DECISION");
  const provider = (decision?.data as { provider?: string } | null)?.provider ?? latest?.decision?.provider;
  const risk = steps.find((e) => e.type === "RISK")?.message.match(/Risk (\d+) \((\w+)\)/);
  const usd = latest?.requestedUsdCents ? `$${(Number(latest.requestedUsdCents) / 100).toFixed(2)}` : null;
  const startedAt = steps[0] ? new Date(steps[0].createdAt).getTime() : latest ? new Date(latest.createdAt).getTime() : 0;
  const recent = latest && now - new Date(latest.updatedAt ?? latest.createdAt).getTime() < 120_000;

  const stepList = (
    <ol className={s.feed}>
      {steps.map((e, i) => {
        const x = explain(e.type);
        const isLast = active && i === steps.length - 1;
        return (
          <li key={e.id} className={`${s.feedItem} ${s[`lv_${e.level}`] ?? ""}`}>
            <span className={s.feedIcon} aria-hidden="true">{x.icon}</span>
            <div>
              <div className={s.feedTitle}>{x.title}<time dateTime={e.createdAt}>{time(e.createdAt)}</time></div>
              <p className={s.feedMsg}>{e.message}</p>
              {x.why && <p className={s.feedWhy}>{x.why}</p>}
              {e.type === "AI_DECISION" && <AiThoughts data={e.data} />}
              <Evidence e={e} />
              {isLast && <p className={t.inProgress}>in progress…</p>}
            </div>
          </li>
        );
      })}
      {steps.length === 0 && <li className={s.empty}>Loading the steps…</li>}
    </ol>
  );

  return (
    <section className={`glass ${s.panel}`} aria-label="Current progress">
      <div className={s.panelHead}>
        <h2>Agent thinking</h2>
        {latest && <span className={active ? t.livePill : "muted"} style={{ fontSize: "0.8rem" }}>{active ? `● live · ${secs(now - startedAt)}` : `last decision ${ago(latest.createdAt)}`}</span>}
      </div>
      <LiveStrip dash={dash} />
      {!latest ? (
        <p className={s.empty}>No decisions yet. When your portfolio leaves its range, you'll watch the agent reason through it here, step by step.</p>
      ) : (
        <div className={active ? t.current : t.last}>
          {!active && <p className={t.lastLabel}>Last decision · {ago(latest.createdAt)}</p>}
          <div className={s.steps} aria-hidden="true">
            {STEPS.map((st, i) => {
              const cls = failed && i === reached ? s.stepFail : i <= reached ? s.stepDone : active && i === reached + 1 ? s.stepNow : "";
              return <div key={st.id} className={`${s.stepItem} ${cls}`}><div className={s.stepBar} /><span>{st.label}</span></div>;
            })}
          </div>
          <div className={s.summary}>
            <span className={`${s.chip} ${latest.state === "CONFIRMED" ? s.chipGood : failed ? s.chipBad : latest.state === "NO_ACTION" ? "" : s.chipAccent}`}>{latest.tier === "SIMULATED" && latest.state === "CONFIRMED" ? "Simulated step recorded" : explain(latest.state).title}</span>
            {latest.plan?.direction && <span className={s.chip}>{/^BUY/.test(latest.plan.direction) ? "Buy" : "Sell"} {(latest.plan as { asset?: string }).asset ?? "WETH"}{usd ? ` · ≈ ${usd}` : ""}</span>}
            {latest.tier && <span className={s.chip}>{TIER[latest.tier] ?? latest.tier}</span>}
            {risk && <span className={`${s.chip} ${risk[2] === "LOW" ? s.chipGood : risk[2] === "HIGH" ? s.chipBad : s.chipWarn}`}>Risk {risk[1]} · {risk[2]!.toLowerCase()}</span>}
            {provider && <span className={`${s.chip} ${provider === "deterministic-fallback" ? s.chipWarn : ""}`}>{provider === "deterministic-fallback" ? "Safe rule (AI offline)" : `AI · ${provider}`}</span>}
          </div>
          {latest.decision && (
            <div className={s.quote}>“{latest.decision.reason}”<small>{latest.decision.decision === "REBALANCE" ? "Decided to rebalance" : humanize(latest.decision.decision)} — the AI chooses what to do; code computes every amount and the account enforces your limits.</small>
              {decision && <AiThoughts data={decision.data} />}
            </div>
          )}
          {latest.reasons?.length ? <p className={s.feedWhy}>Why: {latest.reasons.map(humanize).join(", ")}</p> : null}
          {active || recent ? stepList : <details className={t.allSteps}><summary>Show all {steps.length} steps</summary>{stepList}</details>}
        </div>
      )}
    </section>
  );
}
