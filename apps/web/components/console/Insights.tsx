"use client";
import { useMemo, useState } from "react";
import s from "./insights.module.css";
import { Icon } from "./icons";
import { useSay } from "./detail";
import type { Policy } from "./model";

export type Point = { at: string; pct: number; kind: "measured" | "trade" };
export type Brief = { checks: number; trades: number; tradesByAgentAlone: number; tradesApprovedByOwner: number; simulatedTrades: number; lastAiFallbackAt: string | null; aiFailingNow: boolean; aiProvider: string | null; movedUsd: number; aiFallbacks: number; blockedOrFailed: number; waitingForOwner: number; summary: string | null };

/** WETH-weight history: allowed band shaded, target dashed, measured line, trade markers, hover read-out. */
export function AllocationChart({ points, policy, current, preview }: { points: Point[]; policy: Policy; current?: number | null; preview?: Pick<Policy, "ethMinPct" | "ethMaxPct" | "targetEthPct"> }) {
  const [hover, setHover] = useState<number | null>(null), say = useSay();
  const W = 720, H = 240, L = 36, R = 12, T = 12, B = 26;
  const data = useMemo(() => {
    const pts = [...points];
    if (current != null) pts.push({ at: new Date().toISOString(), pct: current, kind: "measured" });
    return pts;
  }, [points, current]);
  const band = preview ?? policy;
  const vals = data.map((p) => p.pct).concat([band.ethMinPct, band.ethMaxPct]);
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 3) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...vals) + 3) / 10) * 10);
  const t0 = data.length ? new Date(data[0]!.at).getTime() : Date.now() - 86_400_000, t1 = Math.max(t0 + 60_000, Date.now());
  const x = (at: string) => L + ((new Date(at).getTime() - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = data.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
  const area = data.length ? `${line} L${x(data[data.length - 1]!.at).toFixed(1)},${H - B} L${x(data[0]!.at).toFixed(1)},${H - B} Z` : "";
  const ticks = Array.from({ length: (hi - lo) / 10 + 1 }, (_, i) => lo + i * 10);
  const hv = hover == null ? null : data[hover];
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!data.length) return;
    const r = e.currentTarget.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    data.forEach((p, i) => { if (Math.abs(x(p.at) - px) < Math.abs(x(data[best]!.at) - px)) best = i; });
    setHover(best);
  };
  return (
    <div className={s.chartWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={s.chart} role="img" aria-label={`WETH share over time, allowed ${band.ethMinPct} to ${band.ethMaxPct} percent`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="aFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient>
          <linearGradient id="aLine" x1="0" x2="1"><stop offset="0" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent-2)" /></linearGradient>
        </defs>
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 6} y={y(v) + 4} textAnchor="end" className={s.axis}>{v.toFixed(0)}%</text></g>)}
        <rect x={L} width={W - L - R} y={y(band.ethMaxPct)} height={y(band.ethMinPct) - y(band.ethMaxPct)} className={preview ? s.bandPreview : s.band} />
        <line x1={L} x2={W - R} y1={y(band.targetEthPct)} y2={y(band.targetEthPct)} className={s.target} />
        <text x={L + 6} y={y(band.targetEthPct) - 5} className={s.axis}>target {band.targetEthPct}%</text>
        {data.length > 1 && <><path d={area} fill="url(#aFill)" /><path d={line} fill="none" stroke="url(#aLine)" strokeWidth="2.5" strokeLinejoin="round" /></>}
        {data.map((p, i) => p.kind === "trade" && <circle key={i} cx={x(p.at)} cy={y(p.pct)} r="5" className={s.trade} />)}
        {data.length > 0 && <circle cx={x(data[data.length - 1]!.at)} cy={y(data[data.length - 1]!.pct)} r="5" className={s.now} />}
        {hv && <g><line x1={x(hv.at)} x2={x(hv.at)} y1={T} y2={H - B} stroke="var(--ink-3)" strokeDasharray="3 3" /><circle cx={x(hv.at)} cy={y(hv.pct)} r="6" fill="var(--ink)" /></g>}
        <text x={L} y={H - 6} className={s.axis}>{new Date(t0).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className={s.axis}>now</text>
      </svg>
      {hv && <div className={`glass ${s.tip}`} style={{ left: `${(x(hv.at) / W) * 100}%` }}><strong>{hv.pct.toFixed(1)}% {say("WETH")}</strong><span>{hv.kind === "trade" ? "after a trade" : "measured"} · {new Date(hv.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>}
      {data.length < 2 && <p className={s.emptyChart}>History builds up as the agent checks your portfolio.</p>}
      <div className={s.legend}><span><i className={s.lgBand} />allowed range</span><span><i className={s.lgLine} />{say("WETH share")}</span><span><i className={s.lgTrade} />trade</span></div>
    </div>
  );
}

export function DailyBrief({ brief, loading }: { brief: Brief | null; loading: boolean }) {
  const say = useSay();
  const kpi = (label: string, value: string | number, tone?: string) => <div className={s.kpi}><span>{label}</span><b className={tone}>{value}</b></div>;
  return (
    <section className={`glass ${s.brief}`} aria-label="Daily brief">
      <div className={s.briefHead}><span className={s.briefIcon}><Icon name="sparkle" size={16} /></span><h2>Last 24 hours</h2></div>
      {loading && !brief ? <div className={s.skeleton}><i /><i /><i /></div> : (
        <>
          <p className={s.summary}>{brief?.summary ? say(brief.summary) : (brief && brief.checks === 0 ? "A quiet day: your portfolio stayed in range, so I didn't need to do anything." : brief ? `I checked your portfolio ${brief.checks} times and made ${brief.trades} trade${brief.trades === 1 ? "" : "s"}.` : "No data yet.")}</p>
          {brief && <div className={s.kpis}>
            {kpi("Checks", brief.checks)}
            {kpi("Trades", brief.trades, brief.trades ? s.good : undefined)}
            {kpi("Moved", `$${brief.movedUsd.toFixed(2)}`)}
            {kpi("Needs you", brief.waitingForOwner, brief.waitingForOwner ? s.warn : undefined)}
          </div>}
          {brief?.aiFailingNow && <p className={s.note}><Icon name="bolt" size={14} /> The AI was unavailable {brief.aiFallbacks}×{brief.lastAiFallbackAt ? ` (last at ${new Date(brief.lastAiFallbackAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : ""} — the AI isn’t answering right now, so I’m using your own target as a safe fallback for small trades.</p>}
        </>
      )}
    </section>
  );
}
