"use client";
import s from "./console.module.css";
import { api, short, until, usdcFmt, weth } from "./model";
import type { Ctl } from "./Hero";
import { More } from "./detail";

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
        <span className={s.liveBadge}><i className={live ? s.liveDot : s.deadDot} />{live ? "Active" : sess ? (sess.onChain === "REVOKED" ? "Switched off" : "Needs your OK") : "Not set up"}</span>
      </div>
      <p className={s.lead}>What the agent is allowed to do. Your wallet blocks anything outside these limits, even if the AI were tricked.</p>
      {!live && sess && <p className={s.note}>The agent can't trade right now. To switch it back on, use the sign button in <strong>Your tasks</strong>: one wallet signature gives it access again.</p>}
      {sess && c ? (
        <div className={s.limits}>
          <div className={s.limitRow}><span>Biggest trade on its own</span><strong>${pol?.maxAutoTxUsd}</strong></div>
          <div className={s.limit}>
            <div className={s.limitRow}><span>Spent today</span><strong>${used.toFixed(2)} of ${budget.toFixed(2)}</strong></div>
            <div className={`${s.meter} ${usedPct > 80 ? s.meterWarn : ""}`}><i style={{ width: `${usedPct}%` }} /></div>
          </div>
          <div className={s.limitRow}><span>Agent access ends</span><strong>in {until(sess.validUntil)}</strong></div>
        </div>
      ) : <p className={s.empty}>No agent permission yet. Authorize Guardian from “Your tasks”.</p>}
      <div className={s.row} style={{ marginTop: 16 }}>
        {onEdit && <button disabled={!pol} onClick={onEdit}>Edit limits</button>}
        {sess && sess.status !== "PENDING_AUTHORIZATION" && (
          <button className="danger" disabled={!!busy} onClick={() => run("revoke", async () => masterSign(await api("/api/revoke", {}), "Revocation signed"))}>Remove agent access</button>
        )}
      </div>
      {sess && c && pol && (
        <More>
          <div className={s.limits}>
            <div className={s.limitRow}><span>Per sale</span><strong>{weth(c.maxAmountInWei)} WETH</strong></div>
            {c.twoWay && <div className={s.limitRow}><span>Per purchase</span><strong>{usdcFmt(c.maxUsdcInRaw)} USDC</strong></div>}
            <div className={s.limit}>
              <div className={s.limitRow}><span>Swaps left</span><strong>{opsLeft ?? "?"} of {c.maxOps}{c.twoWay ? ` (per ${windowHours} h, resets)` : ""}</strong></div>
              <div className={s.meter}><i style={{ width: `${opsLeft == null ? 0 : (opsLeft / c.maxOps) * 100}%` }} /></div>
            </div>
            <div className={s.limitRow}><span>Re-authorize when</span><strong>ETH ≥ ${c.reauthAtPrice.toFixed(0)}</strong></div>
            <div className={s.limitRow}><span>Max slippage</span><strong>{(pol.maxSlippageBps / 100).toFixed(2)}%</strong></div>
          </div>
          {dash.sessions.length > 0 && (
            <div className={s.limits} style={{ marginTop: 14 }}>
              <div className={s.limitRow}><span>Agent keys (one per tradable asset)</span><strong>{dash.sessions.length}</strong></div>
              {dash.sessions.map((k) => (
                <div key={k.permissionId} className={s.limitRow}><span>{k.asset} ↔ USDC</span><strong>{k.status === "ACTIVE" ? "active" : k.status.replaceAll("_", " ").toLowerCase()} · <span className="hash">{k.permissionId}</span></strong></div>
              ))}
            </div>
          )}
          <p className={s.lead} style={{ margin: "14px 0 6px", fontWeight: 650 }}>Compiled on-chain permission (USD → EVM)</p>
          <div className={s.limits} style={{ marginTop: 10 }}>
            <div className={s.limitRow}><span>Sell ceiling formula</span><span className="hash">floor(${pol.maxAutoTxUsd} / (P_auth × (1 + b)) × 10^18)</span></div>
            <div className={s.limitRow}><span>Authorization price P_auth</span><strong>${c.authPrice.toFixed(2)} · b = +{(c.bufferBps / 100).toFixed(0)}% · re-auth at ${c.reauthAtPrice.toFixed(0)}</strong></div>
            <div className={s.limitRow}><span>exactInputSingle · amountIn (word 4) ≤</span><strong><span className="hash">{c.maxAmountInWei}</span> wei ({weth(c.maxAmountInWei)} WETH)</strong></div>
            {c.twoWay && <div className={s.limitRow}><span>exactOutputSingle · amountInMaximum (word 5) ≤</span><strong><span className="hash">{c.maxUsdcInRaw}</span> raw ({usdcFmt(c.maxUsdcInRaw)} USDC)</strong></div>}
            <div className={s.limitRow}><span>CallPolicy target</span><strong>Uniswap V3 SwapRouter02 · {c.twoWay ? "exactInputSingle, exactOutputSingle" : "exactInputSingle"} only · value 0</strong></div>
            <div className={s.limitRow}><span>Pinned fields</span><strong>tokenIn, tokenOut, fee tier, sqrtPriceLimitX96 = 0</strong></div>
            <div className={s.limitRow}><span>recipient (word 3) ==</span><strong className="hash">{short(dash.identities.smartAccount)} (self only)</strong></div>
            <div className={s.limitRow}><span>{c.twoWay ? "RateLimitPolicyWithReset" : "RateLimitPolicy"}</span><strong>{c.maxOps} ops{windowHours ? ` per ${windowHours} h, resetting` : " total"}</strong></div>
            <div className={s.limitRow}><span>TimestampPolicy</span><strong>valid until {new Date(sess.validUntil).toLocaleString()}</strong></div>
            <div className={s.limitRow}><span>GasPolicy</span><strong>paymaster-enforced gas allowance</strong></div>
            <div className={s.limitRow}><span>Router allowance (bounded)</span><strong>{weth(c.allowanceWei)} WETH · never type(uint256).max</strong></div>
          </div>
          <p className={s.fine}>Anything outside this spec — another contract, selector, recipient or a bigger amount — fails the account&apos;s validation, so the bundler never includes it.</p>
          <p className={s.fine}>Permission <span className="hash">{sess.permissionId}</span>{dash.policyVersion ? ` · policy v${dash.policyVersion}` : ""}</p>
        </More>
      )}
    </section>
  );
}
