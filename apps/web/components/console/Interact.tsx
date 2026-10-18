"use client";
import s from "./console.module.css";
import { api, portfolioOf } from "./model";
import type { Ctl } from "./Hero";

/** Testnet only: the demo wallet moves funds into the account so the owner can watch the agent react. */
export function SimulatePanel({ dash, busy, run }: Ctl) {
  if (!dash.network.isTestnet || !dash.demo.enabled) return null;
  const p = portfolioOf(dash), cap = dash.policy?.maxAutoTxUsd ?? 10, b = dash.demo.walletB;
  const expect = (usd: number, up: boolean) => {
    if (!p) return "";
    const total = Number(p.totalUsd), w = Number(p.wethUsd) + (up ? usd : 0);
    const pct = (w / (total + usd)) * 100;
    const outside = dash.policy && (pct > dash.policy.ethMaxPct || pct < dash.policy.ethMinPct);
    return `→ ≈ ${pct.toFixed(0)}% WETH${outside ? (usd > cap ? " · bigger than your cap" : " · agent rebalances") : " · stays in range"}`;
  };
  const go = (direction: "up" | "down", usd: number) => run(`sim-${direction}-${usd}`, async () => {
    const r = await api<{ how: string }>("/api/simulate", { direction, usd });
    return `Demo wallet ${r.how}. Watch “Agent thinking” — the worker reacts within a few seconds (or press Check now).`;
  });
  const btn = (direction: "up" | "down", usd: number, label: string) => (
    <button className={s.simBtn} disabled={!!busy} onClick={() => go(direction, usd)}>
      <strong>{busy === `sim-${direction}-${usd}` ? "Sending…" : label}</strong>
      <small>{expect(usd, direction === "up")}</small>
    </button>
  );
  return (
    <section className={`glass ${s.panel}`} aria-label="Simulate market move">
      <div className={s.panelHead}><h2>Simulate a market move</h2><span className={`${s.chip} ${s.chipWarn}`}>testnet</span></div>
      <p className={s.lead}>A separate demo wallet sends funds into your account, as if the market moved. Then watch the agent decide.</p>
      <div className={s.simGrid}>
        {btn("up", 5, "▲ WETH up $5")}
        {btn("up", Math.min(30, cap + 2), `▲ WETH up $${Math.min(30, cap + 2)}`)}
        {btn("down", 5, "▼ WETH down $5")}
        {btn("down", Math.min(30, cap + 2), `▼ WETH down $${Math.min(30, cap + 2)}`)}
      </div>
      {b && <p className={s.fine}>Demo wallet: ${b.wethUsd.toFixed(2)} WETH · {b.usdc.toFixed(2)} USDC. “Down” swaps its WETH to USDC if it has too little USDC.</p>}
    </section>
  );
}
