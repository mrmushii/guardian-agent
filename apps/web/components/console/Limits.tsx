"use client";
import { useEffect, useState } from "react";
import s from "./console.module.css";
import l from "./limits.module.css";
import { Icon } from "./icons";
import { AllocationChart, type Point } from "./Insights";
import { api, portfolioOf, type Policy } from "./model";
import type { Ctl } from "./Hero";

type WhatIf = { action: "NOTHING" | "AGENT" | "PARTIAL" | "ASK_OWNER"; text: string; wethPct: number; usd?: number };
const ACTION_LABEL: Record<WhatIf["action"], { label: string; tone: string }> = {
  NOTHING: { label: "Nothing to do", tone: l.toneQuiet }, AGENT: { label: "Agent acts alone", tone: l.toneGood },
  PARTIAL: { label: "Agent steps in parts", tone: l.toneAccent }, ASK_OWNER: { label: "Asks you first", tone: l.toneWarn },
};

/** Full-page limits editor with a live "what would the agent do right now" preview. */
export function LimitsEditor({ ctl, points }: { ctl: Ctl; points: Point[] }) {
  const { dash, run, busy } = ctl;
  const policy = dash.policy!;
  const [p, setP] = useState<Policy>(policy);
  const [preview, setPreview] = useState<WhatIf | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  useEffect(() => { setP(policy); }, [dash.policyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const error = p.ethMinPct >= p.ethMaxPct ? "The lower limit must be below the upper limit."
    : p.targetEthPct < p.ethMinPct || p.targetEthPct > p.ethMaxPct ? "The target must be inside the allowed range."
    : p.maxAutoTxUsd > p.dailyBudgetUsd ? "The per-trade cap can't exceed the daily budget."
    : p.maxAutoTxUsd <= 0 || p.dailyBudgetUsd <= 0 ? "Amounts must be above zero." : null;
  const changed = (Object.keys(policy) as (keyof Policy)[]).some((k) => policy[k] !== p[k]);

  useEffect(() => {
    if (error) { setPreview(null); return; }
    const t = setTimeout(() => {
      api<WhatIf>("/api/whatif", p).then((r) => { setPreview(r); setPreviewErr(null); }).catch((e) => setPreviewErr((e as Error).message));
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(p), error]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) });
  const save = () => run("policy", async () => {
    const r = await api<{ version: number }>("/api/policy", p);
    return `Saved limits v${r.version}. Sign the new permission (Overview → Your tasks) to apply them on-chain.`;
  });

  return (
    <div className={l.grid}>
      <section className={`glass ${s.panel}`} aria-label="Edit limits">
        <div className={s.panelHead}><h2>{policy.assets ? "Trading limits" : "Your rules for the agent"}</h2>{changed && <span className={`${s.chip} ${s.chipWarn}`}>unsaved</span>}</div>
        <div className={l.fields}>
          {!policy.assets && <><div className={l.field}>
            <div className={l.label}><span>Allowed WETH range</span><b>{p.ethMinPct}% – {p.ethMaxPct}%</b></div>
            <div className={l.dual}>
              <input type="range" min={1} max={99} value={p.ethMinPct} onChange={num("ethMinPct")} aria-label="Lower limit" />
              <input type="range" min={1} max={99} value={p.ethMaxPct} onChange={num("ethMaxPct")} aria-label="Upper limit" />
            </div>
            <small>The agent only acts when WETH leaves this range.</small>
          </div>
          <div className={l.field}>
            <div className={l.label}><span>Target</span><b>{p.targetEthPct}%</b></div>
            <input type="range" min={1} max={99} value={p.targetEthPct} onChange={num("targetEthPct")} aria-label="Target" />
            <small>Where it rebalances back to.</small>
          </div></>}
          <div className={l.pair}>
            <label className={l.field}><div className={l.label}><span>Max per trade</span></div><div className={l.money}><span>$</span><input type="number" min={1} step={1} value={p.maxAutoTxUsd} onChange={num("maxAutoTxUsd")} /></div><small>Bigger trades ask you.</small></label>
            <label className={l.field}><div className={l.label}><span>Daily budget</span></div><div className={l.money}><span>$</span><input type="number" min={1} step={1} value={p.dailyBudgetUsd} onChange={num("dailyBudgetUsd")} /></div><small>Total per day on its own.</small></label>
          </div>
          <div className={l.pair}>
            <label className={l.field}><div className={l.label}><span>Max slippage</span></div><div className={l.money}><input type="number" min={0.05} max={5} step={0.05} value={p.maxSlippageBps / 100} onChange={(e) => setP({ ...p, maxSlippageBps: Math.round(Number(e.target.value) * 100) })} /><span>%</span></div></label>
            <label className={l.field}><div className={l.label}><span>Permission lasts</span></div><div className={l.money}><input type="number" min={1} step={1} value={p.sessionDurationHours} onChange={num("sessionDurationHours")} /><span>h</span></div></label>
          </div>
        </div>
        {error && <p className={s.error} role="alert">{error}</p>}
        <div className={s.row} style={{ marginTop: 16 }}>
          <button className="primary" disabled={!!error || !changed || !!busy} onClick={save}>{busy === "policy" ? "Saving…" : "Save limits"}</button>
          <button disabled={!changed} onClick={() => setP(policy)}>Reset</button>
        </div>
        <p className={s.fine}>Saving creates policy v{(dash.policyVersion ?? 0) + 1}. The agent keeps the current on-chain limits until you sign the new permission.</p>
      </section>

      <div className={s.col}>
        <section className={`glass ${s.panel}`} aria-label="What if">
          <div className={s.panelHead}><h2><Icon name="brain" size={14} /> If you saved this now</h2></div>
          {preview ? (
            <div className={l.whatif}>
              <span className={`${l.verdict} ${ACTION_LABEL[preview.action].tone}`}>{ACTION_LABEL[preview.action].label}</span>
              <p>{preview.text}</p>
            </div>
          ) : <p className={s.empty}>{error ?? previewErr ?? "Calculating…"}</p>}
          <AllocationChart points={points} policy={policy} current={portfolioOf(dash)?.wethWeightPct ?? null} preview={changed ? p : undefined} />
          {changed && <p className={s.fine}>Shaded amber: your proposed range. Blue line: actual WETH share.</p>}
        </section>
      </div>
    </div>
  );
}
