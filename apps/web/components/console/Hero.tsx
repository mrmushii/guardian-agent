"use client";
import type { Hex } from "viem";
import s from "./console.module.css";
import { agentMode, api, headline, MODE_LABEL, multiOf, portfolioOf, tasksOf, type AgentMode, type Dash, type Task } from "./model";

export function AgentOrb({ mode, large }: { mode: AgentMode; large?: boolean }) {
  return <span className={`${s.orb} ${s[`orb_${mode}`]} ${large ? s.orbLg : ""}`} role="img" aria-label={`Agent ${MODE_LABEL[mode].toLowerCase()}`} />;
}

/** Semicircle gauge: 0–100% WETH, allowed band highlighted, target tick, live marker. */
function Gauge({ pct, min, max, target }: { pct: number | null; min: number; max: number; target: number }) {
  const cx = 130, cy = 130, r = 104;
  const pt = (v: number, rr = r) => { const a = Math.PI + (Math.min(100, Math.max(0, v)) / 100) * Math.PI; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as const; };
  const arc = (a: number, b: number) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `M ${x1} ${y1} A ${r} ${r} 0 ${b - a > 50 ? 1 : 0} 1 ${x2} ${y2}`; };
  const out = pct !== null && (pct < min || pct > max);
  const [mx, my] = pct === null ? [0, 0] : pt(pct);
  const [t1x, t1y] = pt(target, r - 14), [t2x, t2y] = pt(target, r + 14);
  return (
    <svg className={s.gauge} viewBox="0 0 260 150" role="img" aria-label={`Allowed band ${min} to ${max} percent, target ${target}, current ${pct ?? "unknown"}`}>
      <defs>
        <linearGradient id="gBand" x1="0" x2="1"><stop offset="0" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent-2)" /></linearGradient>
        <filter id="gGlow"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      <path d={arc(0, 100)} fill="none" stroke="var(--line)" strokeWidth="16" strokeLinecap="round" />
      <path d={arc(min, max)} fill="none" stroke="url(#gBand)" strokeWidth="16" strokeLinecap="round" />
      <line x1={t1x} y1={t1y} x2={t2x} y2={t2y} stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" opacity="0.85" />
      {pct !== null && <>
        <circle cx={mx} cy={my} r="13" fill={out ? "var(--bad)" : "var(--good)"} filter="url(#gGlow)" opacity="0.7" />
        <circle cx={mx} cy={my} r="8" fill={out ? "var(--bad)" : "var(--good)"} stroke="var(--bg)" strokeWidth="3" />
      </>}
      <text x="18" y="148" fontSize="10" fill="var(--ink-3)">0%</text>
      <text x="226" y="148" fontSize="10" fill="var(--ink-3)">100%</text>
    </svg>
  );
}

/** Multi-asset hero: one bar per asset with its target tick and drift band; out-of-band assets turn red. */
function MultiBars({ m }: { m: NonNullable<ReturnType<typeof multiOf>> }) {
  return (
    <div className={s.multi} role="img" aria-label={`Allocation: ${m.weights.map((w) => `${w.symbol} ${w.pct.toFixed(1)} percent, target ${w.targetPct}`).join("; ")}`}>
      {m.weights.map((w) => {
        const out = Math.abs(w.driftPct) > m.driftPct;
        return (
          <div key={w.symbol} className={s.mRow}>
            <span className={s.mSym}>{w.symbol}{w.status === "PAPER" && <small>sim</small>}</span>
            <div className={s.mTrack}>
              <em style={{ left: `${Math.max(0, w.targetPct - m.driftPct)}%`, width: `${Math.min(100, w.targetPct + m.driftPct) - Math.max(0, w.targetPct - m.driftPct)}%` }} />
              <b className={out ? s.mOut : undefined} style={{ width: `${Math.min(100, w.pct)}%` }} />
              <u style={{ left: `${w.targetPct}%` }} />
            </div>
            <span className={out ? s.mPctOut : s.mPct}>{w.pct.toFixed(1)}%<small>/{w.targetPct}</small></span>
          </div>
        );
      })}
      <div className={s.gaugeLegend}><span><i className={s.dot} style={{ background: "var(--good)" }} />±{m.driftPct} pt band</span><span><i className={s.dot} style={{ background: "var(--ink)" }} />target</span></div>
    </div>
  );
}

export function StatusHero({ dash }: { dash: Dash }) {
  const m = multiOf(dash);
  const p = portfolioOf(dash), pol = dash.policy, mode = agentMode(dash), h = headline(dash);
  const out = p && pol && (p.wethWeightPct < pol.ethMinPct || p.wethWeightPct > pol.ethMaxPct);
  return (
    <section className={`glass ${s.hero}`} aria-label="Agent status">
      <div>
        <div className={s.heroSay}>
          <AgentOrb mode={mode} large />
          <div>
            <span className={`${s.modeTag} ${s[`mode_${mode}`]}`}>● {MODE_LABEL[mode]}</span>
            <h1 className={s.heroTitle}>{h.title}</h1>
            <p className={s.heroBody}>{h.body}</p>
          </div>
        </div>
        {m && <div className={s.stats}><div className={s.stat}><div className={s.statLabel}>Portfolio</div><div className={s.statValue}>${m.totalUsd}</div></div><div className={s.stat}><div className={s.statLabel}>Assets</div><div className={s.statValue}>{m.weights.length}</div></div><div className={s.stat}><div className={s.statLabel}>Band</div><div className={s.statValue}>±{m.driftPct} pts</div></div></div>}
        {p && !m && (
          <div className={s.stats}>
            <div className={s.stat}><div className={s.statLabel}>Portfolio</div><div className={s.statValue}>${Number(p.totalUsd).toFixed(2)}</div></div>
            <div className={s.stat}><div className={s.statLabel}>WETH</div><div className={s.statValue}>${Number(p.wethUsd).toFixed(2)}</div></div>
            <div className={s.stat}><div className={s.statLabel}>USDC</div><div className={s.statValue}>${Number(p.usdcUsd).toFixed(2)}</div></div>
          </div>
        )}
      </div>
      {m && <MultiBars m={m} />}
      {pol && !m && (
        <div>
          <div className={s.gaugeWrap}>
            <Gauge pct={p?.wethWeightPct ?? null} min={pol.ethMinPct} max={pol.ethMaxPct} target={pol.targetEthPct} />
            <div className={s.gaugeCenter}>
              <div><div className={s.gaugePct} style={{ color: out ? "var(--bad)" : undefined }}>{p ? `${p.wethWeightPct.toFixed(1)}%` : "—"}</div><div className={s.gaugeCap}>of portfolio is WETH</div></div>
            </div>
          </div>
          <div className={s.gaugeLegend}>
            <span><i className={s.dot} style={{ background: "var(--accent)" }} />allowed {pol.ethMinPct}–{pol.ethMaxPct}%</span>
            <span><i className={s.dot} style={{ background: "var(--ink)" }} />target {pol.targetEthPct}%</span>
            {p && <span>ETH ${p.ethUsd.toFixed(0)}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

export type Ctl = {
  dash: Dash; busy: string | null;
  run: (label: string, fn: () => Promise<string | void>) => Promise<void>;
  masterSign: (p: { userOperationId: string; userOpHash: Hex }, done: string) => Promise<string>;
};

export function YourTasks({ dash, busy, run, masterSign }: Ctl) {
  const tasks = tasksOf(dash);
  const authorize = () => run("authorize", async () => masterSign(await api("/api/authorize", {}), "Permission signed"));
  const button = (t: Task) => {
    switch (t.kind) {
      case "approve": return <>
        <button className="primary" disabled={!!busy} onClick={() => run("approve", async () => {
          const r = await api<{ cancelled: boolean; userOperationId: string; userOpHash: Hex }>(`/api/approvals/${t.action!.id}/prepare`, {});
          if (r.cancelled) return "No longer needed after rechecking prices — cancelled";
          return masterSign(r, "Trade approved");
        })}>Review and sign</button>
        <button disabled={!!busy} onClick={() => run("decline", async () => { await api(`/api/approvals/${t.action!.id}/decline`, {}); return "Declined"; })}>Decline</button>
      </>;
      case "sign-policy": case "authorize": return <button className="primary" disabled={!!busy} onClick={authorize}>{busy === "authorize" ? "Waiting for wallet…" : t.kind === "sign-policy" ? "Sign new limits" : "Authorize Guardian"}</button>;
      case "resume": return <button className="primary" disabled={!!busy} onClick={() => run("monitor", async () => { await api("/api/monitoring", { enabled: true }); return "Agent resumed"; })}>Resume agent</button>;
      default: return null;
    }
  };
  return (
    <section className={`glass ${s.panel} ${tasks.length ? s.tasks : ""}`} aria-label="Your tasks">
      <div className={s.panelHead}><h2>Your tasks</h2>{tasks.length > 0 && <span className={`${s.chip} ${s.chipWarn}`}>{tasks.length} waiting</span>}</div>
      {tasks.length === 0 ? (
        <div className={s.allSet}><span className={s.check}>✓</span><div><strong>You're all set.</strong><div className="muted">Guardian handles moves up to ${dash.policy?.maxAutoTxUsd ?? 10} on its own. Anything bigger will show up here for your signature.</div></div></div>
      ) : tasks.map((t, i) => (
        <div key={i} className={s.task} aria-label={t.kind === "approve" ? "Waiting for your approval" : undefined}>
          <div className={s.taskTitle}>✋ {t.title}</div>
          <p className={s.taskDetail}>{t.detail}</p>
          {t.action?.decision?.reason && <p className={s.taskDetail}><em>Agent: “{t.action.decision.reason}”</em></p>}
          <div className={s.row}>{button(t)}</div>
        </div>
      ))}
    </section>
  );
}
