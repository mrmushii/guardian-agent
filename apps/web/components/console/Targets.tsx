"use client";
import { useEffect, useMemo, useState } from "react";
import s from "./console.module.css";
import t from "./targets.module.css";
import { Icon } from "./icons";
import { api } from "./model";
import type { Ctl } from "./Hero";
import type { Holding } from "./Portfolio";

type Row = { symbol: string; targetPct: number };
type WhatIf = { action: string; text: string };
const COLORS = ["#7c8cff", "#4fd1e8", "#b57bff", "#4ade9b", "#fbbf4f", "#ff6b81", "#9aa6c4", "#f472b6"];

/** Owner sets a target weight per asset (summing to 100) and a drift band; USDC is the hub and always included. */
export function TargetEditor({ ctl }: { ctl: Ctl }) {
  const { dash, run, busy } = ctl;
  const pol = dash.policy!;
  const initial: Row[] = pol.assets?.length ? pol.assets : [{ symbol: "WETH", targetPct: pol.targetEthPct }, { symbol: "USDC", targetPct: 100 - pol.targetEthPct }];
  const initialDrift = pol.driftPct ?? Math.max(1, Math.round((pol.ethMaxPct - pol.ethMinPct) / 2));
  const [rows, setRows] = useState<Row[]>(initial);
  const [drift, setDrift] = useState(initialDrift);
  const [assets, setAssets] = useState<Holding[]>([]);
  const [preview, setPreview] = useState<WhatIf | null>(null);
  useEffect(() => { api<{ assets: Holding[] }>("/api/assets").then((r) => setAssets(r.assets)).catch(() => {}); }, []);
  useEffect(() => { setRows(initial); setDrift(initialDrift); }, [dash.policyVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = rows.reduce((a, r) => a + r.targetPct, 0);
  const changed = JSON.stringify(rows) !== JSON.stringify(initial) || drift !== initialDrift;
  const error = total !== 100 ? `Targets add up to ${total}% — they must total 100%` : !rows.some((r) => r.symbol === "USDC") ? "USDC must stay in the portfolio" : null;
  const addable = useMemo(() => assets.filter((a) => a.status !== "UNAVAILABLE" && a.status !== "REJECTED" && !rows.some((r) => r.symbol === a.symbol)), [assets, rows]);
  const statusOf = (sym: string) => assets.find((a) => a.symbol === sym)?.status;

  useEffect(() => {
    if (error) { setPreview(null); return; }
    const h = setTimeout(() => api<WhatIf>("/api/whatif", { assets: rows, driftPct: drift }).then(setPreview).catch(() => setPreview(null)), 400);
    return () => clearTimeout(h);
  }, [JSON.stringify(rows), drift, error]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (sym: string, v: number) => setRows(rows.map((r) => (r.symbol === sym ? { ...r, targetPct: Math.max(0, Math.min(100, Math.round(v))) } : r)));
  const fillUsdc = () => { const others = rows.filter((r) => r.symbol !== "USDC").reduce((a, r) => a + r.targetPct, 0); set("USDC", 100 - others); };
  const save = () => run("targets", async () => {
    const r = await api<{ version: number }>("/api/policy", { assets: rows.filter((x) => x.targetPct > 0 || x.symbol === "USDC"), driftPct: drift });
    return `Saved targets (policy v${r.version}). Sign the new permission in Your tasks if a tradable asset was added.`;
  });
  const simple = () => run("targets", async () => { const r = await api<{ version: number }>("/api/policy", { assets: null }); return `Back to WETH/USDC mode (policy v${r.version})`; });

  return (
    <section className={`glass ${s.panel}`} aria-label="Portfolio targets">
      <div className={s.panelHead}>
        <h2>Portfolio targets</h2>
        <span className={`${s.chip} ${total === 100 ? s.chipGood : s.chipWarn}`}>{total}% of 100%</span>
      </div>
      <p className={s.lead}>Choose what you want to hold. The agent rebalances when any asset drifts more than ±{drift} points from its target. Every trade goes through USDC.</p>
      <div className={t.stack} aria-hidden="true">{rows.map((r, i) => r.targetPct > 0 && <i key={r.symbol} style={{ width: `${r.targetPct}%`, background: COLORS[i % COLORS.length] }} title={`${r.symbol} ${r.targetPct}%`} />)}</div>
      <ul className={t.rows}>
        {rows.map((r, i) => (
          <li key={r.symbol}>
            <span className={t.sym}><i style={{ background: COLORS[i % COLORS.length] }} />{r.symbol}
              {statusOf(r.symbol) === "PAPER" && <small className={t.paper}>simulated</small>}
              {r.symbol === "USDC" && <small className={t.hub}>hub</small>}</span>
            <input type="range" min={0} max={100} value={r.targetPct} onChange={(e) => set(r.symbol, Number(e.target.value))} aria-label={`${r.symbol} target`} />
            <span className={t.pct}><input type="number" min={0} max={100} value={r.targetPct} onChange={(e) => set(r.symbol, Number(e.target.value))} aria-label={`${r.symbol} percent`} />%</span>
            {r.symbol !== "USDC" ? <button className="ghost" aria-label={`Remove ${r.symbol}`} onClick={() => setRows(rows.filter((x) => x.symbol !== r.symbol))}><Icon name="x" size={14} /></button> : <span />}
          </li>
        ))}
      </ul>
      <div className={s.row}>
        {addable.length > 0 && (
          <select aria-label="Add asset" value="" onChange={(e) => e.target.value && setRows([...rows.filter((x) => x.symbol !== "USDC"), { symbol: e.target.value, targetPct: 0 }, ...rows.filter((x) => x.symbol === "USDC")])} style={{ width: "auto" }}>
            <option value="">+ Add asset…</option>
            {addable.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}{a.status === "PAPER" ? " (simulated here)" : ""}</option>)}
          </select>
        )}
        <button onClick={fillUsdc} disabled={total === 100}>Put the rest in USDC</button>
      </div>
      <div className={t.drift}>
        <label>Drift band <b>±{drift} points</b></label>
        <input type="range" min={1} max={20} value={drift} onChange={(e) => setDrift(Number(e.target.value))} aria-label="Drift band" />
        <small>Smaller = tighter tracking but more trades.</small>
      </div>
      {error ? <p className={s.error}>{error}</p> : preview && <p className={t.preview}><Icon name="brain" size={14} /> {preview.text}</p>}
      <div className={s.row} style={{ marginTop: 12 }}>
        <button className="primary" disabled={!!error || !changed || !!busy} onClick={save}>{busy === "targets" ? "Saving…" : "Save targets"}</button>
        <button disabled={!changed} onClick={() => { setRows(initial); setDrift(initialDrift); }}>Reset</button>
        {pol.assets && <button className="ghost" disabled={!!busy} onClick={simple}>Use simple WETH/USDC mode</button>}
      </div>
    </section>
  );
}
