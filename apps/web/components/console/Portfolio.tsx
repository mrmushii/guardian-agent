"use client";
import { useCallback, useEffect, useState } from "react";
import s from "./console.module.css";
import p from "./portfolio.module.css";
import { Icon } from "./icons";
import { api, short } from "./model";
import type { Ctl } from "./Hero";
import { AddFunds } from "./AddFunds";

type Check = { id: string; ok: boolean; detail: string };
export type Holding = {
  symbol: string; name: string; decimals: number; kind: string; hub: boolean; custom: boolean; token: string | null; feed: string | null;
  feeTier: number | null; status: "VERIFIED" | "PAPER" | "REJECTED" | "UNAVAILABLE"; checks: Check[]; priceUsd: number | null;
  balance: number; valueUsd: number | null; weightPct: number; verifiedAt: string; paperBalance: number; paperValueUsd: number | null; targetPct: number | null;
};
type Holdings = { totalUsd: number; hub: string; multi: boolean; driftPct: number | null; assets: Holding[] };

const STATUS: Record<Holding["status"], { label: string; cls: string; hint: string }> = {
  VERIFIED: { label: "Tradable", cls: p.ok, hint: "Verified on-chain: token, live price, USDC pool that fills a swap." },
  PAPER: { label: "Simulated", cls: p.paper, hint: "Live price, but no usable pool on this network: tracked in simulated mode only." },
  REJECTED: { label: "Rejected", cls: p.bad, hint: "Failed verification." },
  UNAVAILABLE: { label: "Not on this network", cls: p.off, hint: "No token or price feed on this network yet." },
};
const PALETTE = ["#7c8cff", "#4fd1e8", "#b57bff", "#4ade9b", "#fbbf4f", "#ff6b81", "#9aa6c4", "#f472b6"];
const usd = (v: number | null, d = 2) => (v == null ? "—" : v.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d }));
const amt = (v: number) => (v === 0 ? "0" : v < 0.0001 ? v.toExponential(2) : v.toLocaleString(undefined, { maximumFractionDigits: 6 }));

function Donut({ rows, total }: { rows: Holding[]; total: number }) {
  const held = rows.filter((r) => (r.valueUsd ?? 0) > 0);
  const R = 70, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className={p.donutWrap}>
      <svg viewBox="0 0 180 180" className={p.donut} role="img" aria-label={`Allocation: ${held.map((h) => `${h.symbol} ${h.weightPct.toFixed(1)}%`).join(", ")}`}>
        <circle cx="90" cy="90" r={R} fill="none" stroke="var(--line)" strokeWidth="18" />
        {held.map((h, i) => {
          const len = (h.weightPct / 100) * C;
          const el = <circle key={h.symbol} cx="90" cy="90" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="18" strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 90 90)" strokeLinecap="butt" />;
          offset += len;
          return el;
        })}
      </svg>
      <div className={p.donutCenter}><b>{usd(total)}</b><span>total value</span></div>
      <ul className={p.legend}>
        {held.map((h, i) => <li key={h.symbol}><i style={{ background: PALETTE[i % PALETTE.length] }} />{h.symbol}<span>{h.weightPct.toFixed(1)}%</span></li>)}
        {held.length === 0 && <li className="muted">No holdings yet</li>}
      </ul>
    </div>
  );
}

export function PortfolioView({ ctl }: { ctl: Ctl }) {
  const { dash, busy, run } = ctl;
  const [data, setData] = useState<Holdings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Holding | null>(null);
  const [adding, setAdding] = useState(false);
  const [funding, setFunding] = useState(false);
  const load = useCallback(async (fresh = false) => {
    try { setData(await api<Holdings>(`/api/assets${fresh ? "?fresh" : ""}`)); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);

  const held = data?.assets.filter((a) => a.balance > 0) ?? [];
  const tradable = data?.assets.filter((a) => a.status === "VERIFIED").length ?? 0;

  return (
    <>
      <div className={p.top}>
        <section className={`glass ${s.panel}`} aria-label="Allocation">
          <div className={s.panelHead}><h2>Allocation</h2><span className="muted tech" style={{ fontSize: "0.78rem" }}>{dash.network.name}</span></div>
          {data ? <Donut rows={data.assets} total={data.totalUsd} /> : <div className={p.skeleton} />}
        </section>
        <section className={`glass ${s.panel}`} aria-label="Portfolio summary">
          <div className={s.panelHead}><h2>Summary</h2></div>
          <div className={p.kpis}>
            <div><span>Total value</span><b>{usd(data?.totalUsd ?? null)}</b></div>
            <div><span>Assets held</span><b>{held.length}</b></div>
            <div><span>Tradable here</span><b>{tradable}</b></div>
            <div><span>{data?.multi ? "Drift band" : "Simulated"}</span><b>{data?.multi ? `±${data.driftPct} pts` : data?.assets.filter((a) => a.status === "PAPER").length ?? "—"}</b></div>
          </div>
          <p className={s.fine}>“Tradable” assets can be bought and sold here. “Simulated” ones have a live price but can't be traded on this test network.</p>
          <div className={s.row} style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => setFunding(true)}><Icon name="wallet" size={15} /> Add funds</button>
            <button onClick={() => setAdding(true)}><Icon name="up" size={15} /> Add token</button>
            <button disabled={!!busy} onClick={() => run("verify", async () => { await load(true); return "Re-verified every asset on-chain"; })}><Icon name="check" size={15} /> Re-verify</button>
          </div>
        </section>
      </div>

      <section className={`glass ${s.panel}`} aria-label="Holdings">
        <div className={s.panelHead}><h2>Assets</h2>{err && <span className={s.error}>{err}</span>}</div>
        <div className={s.tableWrap}>
          <table className={`${s.table} ${p.table}`}>
            <thead><tr><th>Asset</th><th>Status</th><th className={p.num}>Price</th><th className={p.num}>Balance</th><th className={p.num}>Value</th><th className={p.num}>Weight vs target</th><th /></tr></thead>
            <tbody>
              {(data?.assets ?? []).map((a, i) => (
                <tr key={`${a.symbol}-${a.token}`} className={p.rowBtn} onClick={() => setOpen(a)}>
                  <td><div className={p.asset}><span className={p.logo} style={{ background: PALETTE[i % PALETTE.length] }}>{a.symbol.slice(0, 1)}</span><div><b>{a.symbol}</b><small>{a.name}{a.hub ? " · hub" : a.custom ? " · added by you" : ""}</small></div></div></td>
                  <td><span className={`${p.badge} ${STATUS[a.status].cls}`} title={STATUS[a.status].hint}>{STATUS[a.status].label}</span></td>
                  <td className={p.num}>{usd(a.priceUsd, a.priceUsd && a.priceUsd < 10 ? 4 : 2)}</td>
                  <td className={p.num}>{amt(a.balance)}{a.paperBalance !== 0 && <small className={p.sim}>{a.symbol === "USDC" ? `${amt(a.paperBalance)} committed` : `+${amt(a.paperBalance)} simulated`}</small>}</td>
                  <td className={p.num}>{usd(a.valueUsd)}</td>
                  <td className={p.num}><Drift w={a.weightPct} t={a.targetPct} band={data?.driftPct ?? null} /></td>
                  <td><Icon name="chevron" size={14} /></td>
                </tr>
              ))}
              {!data && !err && [0, 1, 2].map((i) => <tr key={i}><td colSpan={7}><div className={p.skelRow} /></td></tr>)}
            </tbody>
          </table>
        </div>
      </section>

      {open && <AssetDrawer a={open} onClose={() => setOpen(null)} onRemove={open.custom && open.token ? () => run("remove", async () => {
        await api("/api/assets", { remove: open.token }); setOpen(null); await load(); return `Removed ${open.symbol}`;
      }) : undefined} />}
      {funding && <AddFunds ctl={ctl} onClose={() => setFunding(false)} onChanged={() => void load()} />}
      {adding && <AddToken onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await load(); }} />}
    </>
  );
}

/** Weight bar with the target tick and the allowed drift band shaded; red when outside the band. */
function Drift({ w, t, band }: { w: number; t: number | null; band: number | null }) {
  const out = t != null && band != null && Math.abs(w - t) > band;
  return (
    <div className={p.weight}>
      <span className={out ? p.outTxt : undefined}>{w.toFixed(1)}%{t != null && <small> / {t}%</small>}</span>
      <i className={p.track}>
        {t != null && band != null && <em style={{ left: `${Math.max(0, t - band)}%`, width: `${Math.min(100, t + band) - Math.max(0, t - band)}%` }} />}
        <b className={out ? p.barOut : undefined} style={{ width: `${Math.min(100, w)}%` }} />
        {t != null && <u style={{ left: `${t}%` }} />}
      </i>
    </div>
  );
}

function Checklist({ checks }: { checks: Check[] }) {
  const label: Record<string, string> = { token: "Token contract", feed: "Chainlink price", pool: "USDC pool", quote: "Test swap ($1)" };
  return <ul className={p.checks}>{checks.map((c) => <li key={c.id} className={c.ok ? p.cOk : p.cBad}><Icon name={c.ok ? "check" : "x"} size={14} /><div><b>{label[c.id] ?? c.id}</b><span>{c.detail}</span></div></li>)}</ul>;
}

function AssetDrawer({ a, onClose, onRemove }: { a: Holding; onClose: () => void; onRemove?: () => void }) {
  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <aside className={`glass ${s.drawer}`} role="dialog" aria-modal="true" aria-label={`${a.symbol} details`}>
        <div className={s.panelHead}><h2>{a.symbol} · {a.name}</h2><button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <span className={`${p.badge} ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span>
        <p className={s.lead} style={{ margin: 0 }}>{STATUS[a.status].hint}</p>
        <Checklist checks={a.checks} />
        <dl className={s.kv}>
          <dt>Price</dt><dd>{usd(a.priceUsd, 4)}</dd>
          <dt>Your balance</dt><dd>{amt(a.balance)} {a.symbol}</dd>
          <dt className="tech">Token</dt><dd className="hash tech">{a.token ? short(a.token) : "—"}</dd>
          <dt className="tech">Price feed</dt><dd className="hash tech">{a.feed ? short(a.feed) : "—"}</dd>
          <dt className="tech">Pool fee</dt><dd className="tech">{a.feeTier ? `${a.feeTier / 10_000}%` : "—"}</dd>
          <dt>Checked</dt><dd>{new Date(a.verifiedAt).toLocaleString()}</dd>
        </dl>
        {onRemove && <button className="danger" onClick={onRemove}>Remove token</button>}
      </aside>
    </>
  );
}

function AddToken({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [token, setToken] = useState(""), [feed, setFeed] = useState(""), [kind, setKind] = useState<"volatile" | "stable">("volatile");
  const [busy, setBusy] = useState(false), [result, setResult] = useState<{ saved: boolean; symbol: string; status: string; checks: Check[] } | null>(null), [err, setErr] = useState<string | null>(null);
  const verify = async () => {
    setBusy(true); setErr(null); setResult(null);
    try { setResult(await api("/api/assets", { token: token.trim(), feed: feed.trim() || undefined, kind })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <aside className={`glass ${s.drawer}`} role="dialog" aria-modal="true" aria-label="Add token">
        <div className={s.panelHead}><h2>Add a token</h2><button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <p className={s.lead} style={{ margin: 0 }}>Guardian checks the token on-chain before adding it: contract, Chainlink USD price, a USDC pool, and a $1 test swap.</p>
        <label className={s.field}><span>Token address</span><input value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
        <label className={s.field}><span>Chainlink USD feed (optional)</span><input value={feed} onChange={(e) => setFeed(e.target.value)} placeholder="0x… — needed for a price" spellCheck={false} /></label>
        <div className={s.row}>
          <button className={kind === "volatile" ? "primary" : ""} onClick={() => setKind("volatile")}>Volatile</button>
          <button className={kind === "stable" ? "primary" : ""} onClick={() => setKind("stable")}>Stablecoin</button>
        </div>
        <button className="primary" disabled={busy || !token.trim()} onClick={() => void verify()}>{busy ? "Verifying on-chain…" : "Verify and add"}</button>
        {err && <p className={s.error}>{err}</p>}
        {result && (
          <div className={p.result}>
            <b>{result.symbol}: {result.saved ? (result.status === "VERIFIED" ? "added as tradable" : "added in simulated mode") : "not added"}</b>
            <Checklist checks={result.checks} />
            {result.saved && <button onClick={onAdded}>Done</button>}
          </div>
        )}
      </aside>
    </>
  );
}
