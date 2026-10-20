"use client";
import { useState } from "react";
import s from "./console.module.css";
import { explain, short, time, type Dash, type Ev } from "./model";
import { AiThoughts, Evidence } from "./Thinking";
import { More, useDetail } from "./detail";

type Tab = "activity" | "transactions" | "account";
const TAB_LABEL: Record<Tab, string> = { activity: "Activity", account: "Results", transactions: "Transactions" };
const FILTERS = { all: () => true, trades: (e: Ev) => ["CONFIRMED", "SUBMITTED", "AI_DECISION", "PLAN", "DEMO_MOVE"].includes(e.type), problems: (e: Ev) => e.level === "WARNING" || e.level === "FAILURE" };

export function History({ dash, events }: { dash: Dash; events: Ev[] }) {
  const { full } = useDetail();
  const [picked, setTab] = useState<Tab>("activity");
  const tab: Tab = picked === "transactions" && !full ? "activity" : picked;
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [limit, setLimit] = useState(25);
  const o = dash.outcomes;
  const matching = events.filter(FILTERS[filter]);
  const shown = matching.slice(0, limit);
  return (
    <section className={`glass ${s.panel}`} aria-label="History">
      <div className={s.panelHead}>
        <h2>History</h2>
        <div className={s.tabs} role="tablist">
          {(["activity", "account", ...(full ? ["transactions"] : [])] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`${s.tab} ${tab === t ? s.tabOn : ""}`} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>
          ))}
        </div>
      </div>

      {tab === "activity" && (
        <div aria-label="Activity timeline" role="region">
          <div className={s.tabs} style={{ marginBottom: 10 }}>
            {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
              <button key={f} className={`${s.tab} ${filter === f ? s.tabOn : ""}`} onClick={() => setFilter(f)}>{f[0]!.toUpperCase() + f.slice(1)}</button>
            ))}
          </div>
          {shown.length === 0 ? <p className={s.empty}>Nothing here yet.</p> : (
            <ol className={`${s.feed} ${s.scroll}`}>
              {shown.map((e) => {
                const x = explain(e.type);
                return (
                  <li key={e.id} className={`${s.feedItem} ${s[`lv_${e.level}`] ?? ""}`}>
                    <span className={s.feedIcon} aria-hidden="true">{x.icon}</span>
                    <div>
                      <div className={s.feedTitle}>{x.title}<time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })} {time(e.createdAt)}</time></div>
                      <p className={s.feedMsg}>{e.message}</p>
                      {e.type === "AI_DECISION" && <AiThoughts data={e.data} />}
                      <Evidence e={e} />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {matching.length > limit && <button style={{ marginTop: 10 }} onClick={() => setLimit(limit + 25)}>Show more ({matching.length - limit} older)</button>}
        </div>
      )}

      {tab === "transactions" && (
        <div aria-label="Operations" role="region">
          <p className={s.lead}>Every on-chain operation. A bundler sends the transaction; your smart account checks who signed the operation.</p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>When</th><th>What</th><th>Signed by</th><th>Status</th><th>Transaction</th></tr></thead>
              <tbody>
                {dash.operations.map((op) => (
                  <tr key={op.id}>
                    <td className="muted">{new Date(op.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>{op.purpose.toLowerCase()}</td>
                    <td>{op.authority === "MASTER" ? "Master owner" : "Agent session"}</td>
                    <td>{op.state === "INCLUDED" ? (op.userOpSuccess ? <span style={{ color: "var(--good)" }}>Succeeded</span> : <span style={{ color: "var(--bad)" }}>Execution failed</span>) : op.state.replaceAll("_", " ").toLowerCase()}</td>
                    <td>{op.explorer ? <a className="hash" href={op.explorer} target="_blank" rel="noreferrer">{short(op.transactionHash)}</a> : <span className="muted">none</span>}</td>
                  </tr>
                ))}
                {dash.operations.length === 0 && <tr><td colSpan={5} className="muted">No operations yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "account" && (
        <div aria-label="Identities" role="region">
          <div className={s.outcomes}>
            <div className={s.outcome}><b style={{ color: "var(--good)" }}>{o.agentConfirmed}</b><span>Done by the agent</span></div>
            <div className={s.outcome}><b>{o.masterConfirmed}</b><span>Done with your approval</span></div>
            <div className={s.outcome}><b style={{ color: "var(--warn)" }}>{o.waiting}</b><span>Waiting for you</span></div>
            <div className={s.outcome}><b style={{ color: "var(--bad)" }}>{o.blocked}</b><span>Blocked by policy</span></div>
            <div className={s.outcome}><b>{o.stopped}</b><span>Stopped or reverted</span></div>
            <div className={s.outcome}><b>{o.noAction}</b><span>No action needed</span></div>
          </div>
          <More label="Addresses and network">
          <dl className={s.kv}>
            <dt>You (master owner)</dt><dd className="hash">{dash.identities.masterOwner}</dd>
            <dt>Smart account</dt><dd className="hash">{dash.identities.smartAccount}</dd>
            <dt>Agent key</dt><dd className="hash">{dash.identities.sessionSigner ?? "—"}</dd>
            <dt>EntryPoint</dt><dd className="hash">{dash.identities.entryPoint}</dd>
            <dt>AI models</dt><dd>{dash.agent.models.join(" → ") || "none configured"}</dd>
            <dt>Network</dt><dd>{dash.network.name} ({dash.network.chainId})</dd>
          </dl>
          </More>
        </div>
      )}
    </section>
  );
}
