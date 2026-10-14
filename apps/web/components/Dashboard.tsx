"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";
import { connectWallet, signRaw, signText } from "./wallet";
import s from "./Dashboard.module.css";

type Dash = {
  network: { chainId: number; name: string; isTestnet: boolean };
  identities: { masterOwner: string; smartAccount: string; entryPoint: string; kernelVersion: string; sessionSigner: string | null };
  monitoring: { enabled: boolean; pausedReason: string | null };
  policy: { ethMinPct: number; ethMaxPct: number; targetEthPct: number; maxAutoTxUsd: number; dailyBudgetUsd: number; maxSlippageBps: number } | null;
  session: { status: string; onChain: string; permissionId: string; validUntil: string; authorizeUserOpHash: string | null } | null;
  compiled: { maxAmountInWei: string; maxOps: number; opsUsed: number; allowanceWei: string; authPrice: number; bufferBps: number; reauthAtPrice: number } | null;
  budget: { day: string; usedCents: string; budgetCents: number };
  portfolio: { wethUsd: string; usdcUsd: string; totalUsd: string; wethWeightPct: number; assessment: string; ethUsd: number; block: string } | { error: string };
  actions: { id: string; state: string; tier: string | null; reasons: string[] | null; plan: Record<string, unknown> | null; requestedUsdCents: string | null; createdAt: string; error: string | null; decision: { decision: string; reason: string } | null }[];
  outcomes: Record<string, number>;
  operations: { id: string; authority: string; purpose: string; state: string; userOpHash: string | null; transactionHash: string | null; block: string | null; userOpSuccess: boolean | null; explorer: string | null; createdAt: string }[];
  pendingSignatures: { id: string; purpose: string; userOpHash: string; actionId: string | null }[];
};
type Ev = { id: string; type: string; level: "INFO" | "SUCCESS" | "WARNING" | "FAILURE"; message: string; data: Record<string, unknown> | null; createdAt: string; actionId: string | null };

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Request failed (${r.status})`), { status: r.status });
  return j as T;
};
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const weth = (wei?: string) => (wei ? (Number(wei) / 1e18).toFixed(6) : "—");
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Lifecycle shown as a rail; the current step of the latest action is highlighted. */
const RAIL = ["TRIGGERED", "PLANNING", "SIMULATING", "SUBMITTING", "PENDING", "CONFIRMED"] as const;
const STATE_LABEL: Record<string, string> = {
  TRIGGERED: "Triggered", PLANNING: "Planning", SIMULATING: "Simulating", SUBMITTING: "Submitting", PENDING: "Waiting for inclusion", CONFIRMED: "Confirmed",
  PENDING_APPROVAL: "Waiting for your approval", REVALIDATING: "Revalidating", MASTER_SIGNING: "Waiting for your signature", REJECTED: "Rejected by policy",
  FAILED: "Stopped", EXECUTION_FAILED: "Swap reverted", NO_ACTION: "No action needed", WAIT: "Agent waiting", CANCELLED: "Cancelled",
};
const TIER_LABEL: Record<string, string> = { TIER1_AGENT: "Agent session", TIER2_MASTER: "Master approval", TIER3_REJECT: "Prohibited" };

export default function Dashboard() {
  const [dash, setDash] = useState<Dash | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [message, setMessage] = useState("");
  const cursor = useRef("0");

  const load = useCallback(async () => {
    try {
      setDash(await api<Dash>("/api/dashboard"));
      const { events: fresh } = await api<{ events: Ev[] }>(`/api/timeline?after=${cursor.current}`);
      if (fresh.length) {
        cursor.current = fresh[0]!.id;
        setEvents((prev) => [...fresh, ...prev].slice(0, 400));
      }
      setNeedsLogin(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) setNeedsLogin(true);
      else if (status === 404) setNotice({ kind: "err", text: (e as Error).message });
    }
  }, []);

  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label); setNotice(null);
    try { const text = await fn(); if (text) setNotice({ kind: "ok", text }); await load(); }
    catch (e) { setNotice({ kind: "err", text: (e as Error).message.split("\n")[0]! }); }
    finally { setBusy(null); }
  };

  const signIn = () => run("signin", async () => {
    const address = await connectWallet();
    const { nonce, chainId } = await api<{ nonce: string; chainId: number }>("/api/auth/nonce", { address });
    const msg = createSiweMessage({ address, chainId, domain: location.host, nonce, uri: location.origin, version: "1", statement: "Sign in to Guardian as the wallet owner." });
    await api("/api/auth/verify", { message: msg, signature: await signText(address, msg) });
    return "Signed in";
  });

  /** Master operations: the server prepares, the owner's wallet signs the exact userOpHash, the server verifies and submits. */
  const masterSign = async (prepared: { userOperationId: string; userOpHash: Hex }, done: string) => {
    const address = await connectWallet();
    if (dash && address.toLowerCase() !== dash.identities.masterOwner.toLowerCase())
      throw new Error(`Switch your wallet to the master owner ${short(dash.identities.masterOwner)} to sign`);
    const signature = await signRaw(address as Address, prepared.userOpHash);
    const { userOpHash } = await api<{ userOpHash: string }>(`/api/signatures/${prepared.userOperationId}`, { signature });
    return `${done} — UserOperation ${short(userOpHash)} submitted`;
  };

  if (needsLogin) return (
    <main className={s.login}>
      <h1>Guardian</h1>
      <p>An AI agent that rebalances your WETH/USDC portfolio, inside limits your smart account enforces on its own.</p>
      <button className="primary" onClick={signIn} disabled={busy === "signin"}>{busy === "signin" ? "Waiting for wallet…" : "Sign in with owner wallet"}</button>
      {notice && <p className={notice.kind === "err" ? s.err : s.ok} role="status">{notice.text}</p>}
    </main>
  );
  if (!dash) return <main className={s.loadingPage}><p className="muted">Loading account…</p>{notice && <p className={s.err}>{notice.text}</p>}</main>;

  const p = "error" in dash.portfolio ? null : dash.portfolio;
  const pol = dash.policy;
  const latest = dash.actions[0];
  const pending = dash.actions.filter((a) => a.state === "PENDING_APPROVAL" || a.state === "MASTER_SIGNING");
  const sessionLive = dash.session?.onChain === "ACTIVE";
  const usedUsd = Number(dash.budget.usedCents) / 100;
  const opsLeft = dash.compiled ? Math.max(0, dash.compiled.maxOps - dash.compiled.opsUsed) : 0;
  const counts = (k: string[]) => k.reduce((n, x) => n + (dash.outcomes[x] ?? 0), 0);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div className={s.brand}><strong>Guardian</strong><span className="hash">{short(dash.identities.smartAccount)}</span></div>
        <div className={s.headerRight}>
          <span className={dash.network.isTestnet ? s.netTest : s.netMain}>{dash.network.name}{dash.network.isTestnet ? " · test funds only" : ""}</span>
          <button onClick={() => run("monitor", async () => { await api("/api/monitoring", { enabled: !dash.monitoring.enabled }); })} disabled={!!busy}>
            {dash.monitoring.enabled ? "Pause agent" : "Resume agent"}
          </button>
        </div>
      </header>
      {notice && <p className={`${s.notice} ${notice.kind === "err" ? s.err : s.ok}`} role="status">{notice.text}</p>}
      {!dash.monitoring.enabled && <p className={`${s.notice} ${s.warn}`}>Autonomous actions are paused{dash.monitoring.pausedReason ? ` (${dash.monitoring.pausedReason.replaceAll("_", " ").toLowerCase()})` : ""}. Pending operations are still tracked.</p>}

      <section className={s.hero} aria-label="WETH allocation">
        <div className={s.heroFigure}>
          <span className={s.bigPct}>{p ? `${p.wethWeightPct.toFixed(2)}%` : "—"}</span>
          <span className={s.heroCaption}>of the portfolio is WETH{p ? ` · $${p.totalUsd} total at ETH $${p.ethUsd.toFixed(2)}` : ""}</span>
        </div>
        {pol && (
          <div className={s.fenceWrap}>
            <div className={s.fence} role="img" aria-label={`Allowed band ${pol.ethMinPct} to ${pol.ethMaxPct} percent, target ${pol.targetEthPct}, current ${p?.wethWeightPct ?? "unknown"}`}>
              <div className={s.band} style={{ left: `${pol.ethMinPct}%`, width: `${pol.ethMaxPct - pol.ethMinPct}%` }} />
              <div className={s.target} style={{ left: `${pol.targetEthPct}%` }} />
              {p && <div className={`${s.marker} ${p.wethWeightPct > pol.ethMaxPct ? s.markerOut : ""}`} style={{ left: `${Math.min(100, Math.max(0, p.wethWeightPct))}%` }} />}
            </div>
            <div className={s.fenceScale}><span>0%</span><span style={{ left: `${pol.ethMinPct}%` }}>{pol.ethMinPct}</span><span style={{ left: `${pol.targetEthPct}%` }}>target {pol.targetEthPct}</span><span style={{ left: `${pol.ethMaxPct}%` }}>{pol.ethMaxPct}</span><span>100%</span></div>
            <p className={s.heroStatus}>
              {!p ? `Portfolio unavailable: ${"error" in dash.portfolio ? dash.portfolio.error : ""}`
                : p.assessment === "SELL_WETH" ? `Above the ${pol.ethMaxPct}% limit. The agent sells WETH back toward ${pol.targetEthPct}%.`
                : p.assessment === "UNDERWEIGHT_NO_EXECUTION" ? `Below ${pol.ethMinPct}%. Buying WETH is outside this version, so nothing executes.`
                : "Inside the allowed band. Nothing to do."}
              {p && <> WETH ${p.wethUsd} · USDC ${p.usdcUsd}</>}
            </p>
          </div>
        )}
      </section>

      <div className={s.grid}>
        <div className={s.main}>
          <section className={s.panel} aria-label="Current progress">
            <h2>Current action</h2>
            {!latest ? <p className="muted">No actions yet. The agent starts when WETH rises above {pol?.ethMaxPct ?? 55}%.</p> : (
              <>
                <ol className={s.rail}>
                  {RAIL.map((st) => {
                    const idx = RAIL.indexOf(latest.state as (typeof RAIL)[number]);
                    const here = RAIL.indexOf(st);
                    const cls = idx === -1 ? "" : here < idx ? s.done : here === idx ? s.now : "";
                    return <li key={st} className={cls}>{STATE_LABEL[st]}</li>;
                  })}
                </ol>
                <p className={s.railNote}>
                  <span className={s[`state_${latest.state}`] ?? ""}>{STATE_LABEL[latest.state] ?? latest.state}</span>
                  {latest.tier && <> · authority: {TIER_LABEL[latest.tier] ?? latest.tier}</>}
                  {latest.requestedUsdCents && <> · sale ≈ ${(Number(latest.requestedUsdCents) / 100).toFixed(2)}</>}
                  {latest.reasons?.length ? <> · {latest.reasons.join(", ").replaceAll("_", " ").toLowerCase()}</> : null}
                </p>
                {latest.decision && <p className={s.decision}>Agent: <strong>{latest.decision.decision}</strong> — {latest.decision.reason}</p>}
              </>
            )}
          </section>

          <section className={s.panel} aria-label="Activity timeline">
            <h2>Activity</h2>
            {events.length === 0 ? <p className="muted">Events appear here as the agent observes, decides, and acts.</p> : (
              <ol className={s.timeline}>
                {events.map((e) => (
                  <li key={e.id} className={s[`lv_${e.level}`]}>
                    <time dateTime={e.createdAt}>{time(e.createdAt)}</time>
                    <div>
                      <p>{e.message}</p>
                      {e.data && typeof e.data.explorer === "string" && <p className={s.evidence}>
                        <a href={e.data.explorer} target="_blank" rel="noreferrer">Transaction {short(String(e.data.transactionHash))}</a>
                        {e.data.userOpHash ? <> · UserOperation <span className="hash">{short(String(e.data.userOpHash))}</span></> : null}
                        {e.data.authority ? <> · signed by {String(e.data.authority) === "MASTER" ? "master owner" : "agent session"}</> : null}
                      </p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className={s.panel} aria-label="Operations">
            <h2>Operations</h2>
            <p className="muted">Transaction and UserOperation are separate: a bundler sends the transaction; your account validates the UserOperation signature.</p>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr><th>Purpose</th><th>Signed by</th><th>Status</th><th>UserOperation</th><th>Transaction</th></tr></thead>
                <tbody>
                  {dash.operations.map((o) => (
                    <tr key={o.id}>
                      <td>{o.purpose.toLowerCase()}</td>
                      <td>{o.authority === "MASTER" ? "Master owner" : "Agent session"}</td>
                      <td>{o.state === "INCLUDED" ? (o.userOpSuccess ? "Succeeded" : "Execution failed") : o.state.replaceAll("_", " ").toLowerCase()}</td>
                      <td className="hash">{short(o.userOpHash)}</td>
                      <td>{o.explorer ? <a className="hash" href={o.explorer} target="_blank" rel="noreferrer">{short(o.transactionHash)}</a> : <span className="muted">none</span>}</td>
                    </tr>
                  ))}
                  {dash.operations.length === 0 && <tr><td colSpan={5} className="muted">No operations yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className={s.side}>
          <section className={`${s.panel} ${s.authority}`} aria-label="Agent authority">
            <h2>Agent authority</h2>
            {dash.session ? (
              <>
                <p className={sessionLive ? s.live : s.dead}>{sessionLive ? "Active on-chain" : `Not usable: ${dash.session.onChain.toLowerCase().replaceAll("_", " ")}`}</p>
                <dl className={s.facts}>
                  <dt>Per swap</dt><dd>{weth(dash.compiled?.maxAmountInWei)} WETH <span className="muted">(≤ ${pol?.maxAutoTxUsd} at ${dash.compiled?.authPrice.toFixed(0)})</span></dd>
                  <dt>Swaps left</dt><dd>{opsLeft} of {dash.compiled?.maxOps}</dd>
                  <dt>Today</dt><dd>${usedUsd.toFixed(2)} of ${(dash.budget.budgetCents / 100).toFixed(2)}</dd>
                  <dt>Expires</dt><dd>{new Date(dash.session.validUntil).toLocaleString()}</dd>
                  <dt>Reauthorize at</dt><dd>ETH ≥ ${dash.compiled?.reauthAtPrice.toFixed(0)}</dd>
                  <dt>Permission</dt><dd className="hash">{dash.session.permissionId}</dd>
                </dl>
                <p className="muted">The agent can only swap WETH for USDC on Uniswap, back to this account, within these limits. Anything else is refused by the account itself.</p>
              </>
            ) : <p className="muted">No agent session. Authorize Guardian to let it rebalance within your limits.</p>}
            <div className={s.actions}>
              {!sessionLive && <button className="primary" disabled={!!busy} onClick={() => run("authorize", async () => masterSign(await api("/api/authorize", {}), "Authorization signed"))}>Authorize Guardian</button>}
              {dash.session && dash.session.status !== "PENDING_AUTHORIZATION" && <button className="danger" disabled={!!busy} onClick={() => run("revoke", async () => masterSign(await api("/api/revoke", {}), "Revocation signed"))}>Revoke agent</button>}
            </div>
          </section>

          {pending.length > 0 && (
            <section className={`${s.panel} ${s.approvals}`} aria-label="Waiting for your approval">
              <h2>Waiting for your approval</h2>
              {pending.map((a) => (
                <div key={a.id} className={s.approval}>
                  <p>Sell ≈ ${(Number(a.requestedUsdCents ?? 0) / 100).toFixed(2)} of WETH ({weth(String(a.plan?.amountInWei ?? ""))} WETH)</p>
                  <p className="muted">Needs you because: {(a.reasons ?? []).join(", ").replaceAll("_", " ").toLowerCase()}. Prices are rechecked before you sign.</p>
                  <div className={s.actions}>
                    <button className="primary" disabled={!!busy} onClick={() => run("approve", async () => {
                      const r = await api<{ cancelled: boolean; userOperationId: string; userOpHash: Hex }>(`/api/approvals/${a.id}/prepare`, {});
                      if (r.cancelled) return "No longer needed after rechecking prices — cancelled";
                      return masterSign(r, "Rebalance approved");
                    })}>Review and sign</button>
                    <button disabled={!!busy} onClick={() => run("decline", async () => { await api(`/api/approvals/${a.id}/decline`, {}); return "Declined"; })}>Decline</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className={s.panel} aria-label="Outcomes">
            <h2>Outcomes</h2>
            <dl className={s.outcomes}>
              <div className={s.oGood}><dt>Confirmed</dt><dd>{counts(["CONFIRMED"])}</dd></div>
              <div className={s.oWarn}><dt>Needed approval</dt><dd>{counts(["PENDING_APPROVAL", "MASTER_SIGNING", "CANCELLED"])}</dd></div>
              <div className={s.oBad}><dt>Blocked by policy</dt><dd>{counts(["REJECTED"])}</dd></div>
              <div className={s.oBad}><dt>Stopped or reverted</dt><dd>{counts(["FAILED", "EXECUTION_FAILED"])}</dd></div>
              <div><dt>No action</dt><dd>{counts(["NO_ACTION", "WAIT"])}</dd></div>
            </dl>
          </section>

          <section className={s.panel} aria-label="Ask the agent">
            <h2>Ask the agent to check now</h2>
            <label htmlFor="msg" className="muted">Optional note for the agent. It can only suggest; it cannot change your limits.</label>
            <textarea id="msg" rows={3} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
            <div className={s.actions}>
              <button disabled={!!busy} onClick={() => run("evaluate", async () => {
                const r = await api<{ state?: string; skipped?: string }>("/api/evaluate", { message: message || undefined });
                setMessage("");
                return r.skipped ? `Not started: ${r.skipped.replaceAll("_", " ").toLowerCase()}` : `Evaluation finished: ${STATE_LABEL[r.state ?? ""] ?? r.state}`;
              })}>{busy === "evaluate" ? "Checking…" : "Check now"}</button>
            </div>
          </section>

          <section className={s.panel} aria-label="Identities">
            <h2>Who signs what</h2>
            <dl className={s.facts}>
              <dt>Master owner</dt><dd className="hash">{dash.identities.masterOwner}</dd>
              <dt>Smart account</dt><dd className="hash">{dash.identities.smartAccount}</dd>
              <dt>Agent signer</dt><dd className="hash">{dash.identities.sessionSigner ?? "none"}</dd>
              <dt>EntryPoint</dt><dd className="hash">{dash.identities.entryPoint}</dd>
            </dl>
            <p className="muted">On the explorer, the sender is the bundler. Who authorized an action is shown by its UserOperation signature.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
