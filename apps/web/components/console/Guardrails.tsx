"use client";
import s from "./console.module.css";
import { api, until, usdcFmt, weth } from "./model";
import type { Ctl } from "./Hero";

/** What the agent is allowed to do, as the smart account enforces it. */
export function Guardrails({ dash, busy, run, masterSign, onEdit }: Ctl & { onEdit?: () => void }) {
  const c = dash.compiled, pol = dash.policy, sess = dash.session;
  const live = sess?.onChain === "ACTIVE";
  const opsLeft = c?.twoWay ? (c.opsInWindow == null ? null : Math.max(0, c.maxOps - c.opsInWindow)) : c?.opsUsed == null ? null : Math.max(0, c.maxOps - c.opsUsed);
  const windowHours = c?.windowSec ? c.windowSec / 3600 : null;
  const used = Number(dash.budget.usedCents) / 100, budget = dash.budget.budgetCents / 100;
  const usedPct = budget ? Math.min(100, (used / budget) * 100) : 0;

  return (
    <section className={`glass ${s.panel}`} aria-label="Agent authority">
      <div className={s.panelHead}>
        <h2>Guardrails</h2>
        <span className={s.liveBadge}><i className={live ? s.liveDot : s.deadDot} />{live ? "Active on-chain" : sess ? `Not usable: ${sess.onChain.toLowerCase().replaceAll("_", " ")}` : "No permission"}</span>
      </div>
      <p className={s.lead}>The agent holds a limited key. Your smart account refuses anything outside these limits — even if the AI were tricked.</p>
      {sess && c ? (
        <div className={s.limits}>
          <div className={s.limitRow}><span>Per sale</span><strong>{weth(c.maxAmountInWei)} WETH <span className="muted">(≤ ${pol?.maxAutoTxUsd})</span></strong></div>
          {c.twoWay && <div className={s.limitRow}><span>Per purchase</span><strong>{usdcFmt(c.maxUsdcInRaw)} USDC</strong></div>}
          <div className={s.limit}>
            <div className={s.limitRow}><span>Spent today</span><strong>${used.toFixed(2)} of ${budget.toFixed(2)}</strong></div>
            <div className={`${s.meter} ${usedPct > 80 ? s.meterWarn : ""}`}><i style={{ width: `${usedPct}%` }} /></div>
          </div>
          <div className={s.limit}>
            <div className={s.limitRow}><span>Swaps left</span><strong>{opsLeft ?? "?"} of {c.maxOps}{c.twoWay ? ` (per ${windowHours} h, resets)` : ""}</strong></div>
            <div className={s.meter}><i style={{ width: `${opsLeft == null ? 0 : (opsLeft / c.maxOps) * 100}%` }} /></div>
          </div>
          <div className={s.limitRow}><span>Permission expires</span><strong>in {until(sess.validUntil)}</strong></div>
          <div className={s.limitRow}><span>Re-authorize when</span><strong>ETH ≥ ${c.reauthAtPrice.toFixed(0)}</strong></div>
          <div className={s.limitRow}><span>Max slippage</span><strong>{((pol?.maxSlippageBps ?? 0) / 100).toFixed(2)}%</strong></div>
        </div>
      ) : <p className={s.empty}>No agent permission yet. Authorize Guardian from “Your tasks”.</p>}
      <div className={s.row} style={{ marginTop: 16 }}>
        {onEdit && <button disabled={!pol} onClick={onEdit}>Edit limits</button>}
        {sess && sess.status !== "PENDING_AUTHORIZATION" && (
          <button className="danger" disabled={!!busy} onClick={() => run("revoke", async () => masterSign(await api("/api/revoke", {}), "Revocation signed"))}>Revoke agent</button>
        )}
      </div>
      {dash.sessions.length > 0 && (
        <div className={s.limits} style={{ marginTop: 14 }}>
          <div className={s.limitRow}><span>Agent keys (one per tradable asset)</span><strong>{dash.sessions.length}</strong></div>
          {dash.sessions.map((k) => (
            <div key={k.permissionId} className={s.limitRow}><span>{k.asset} ↔ USDC</span><strong>{k.status === "ACTIVE" ? "active" : k.status.replaceAll("_", " ").toLowerCase()} · <span className="hash">{k.permissionId}</span></strong></div>
          ))}
        </div>
      )}
      <p className={s.fine}>Permission <span className="hash">{sess?.permissionId ?? "—"}</span>{dash.policyVersion ? ` · policy v${dash.policyVersion}` : ""}</p>
    </section>
  );
}
