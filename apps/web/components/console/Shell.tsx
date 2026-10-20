"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import s from "./shell.module.css";
import { Icon, type IconName } from "./icons";
import { AgentOrb } from "./Hero";
import { MODE_LABEL, short, tasksOf, type AgentMode, type Dash } from "./model";

export type View = "overview" | "portfolio" | "agent" | "activity" | "limits" | "settings";
export const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "portfolio", label: "Portfolio", icon: "wallet" },
  { id: "agent", label: "Agent", icon: "agent" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "limits", label: "Limits", icon: "limits" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function Sidebar({ dash, mode, view, setView, onPause, busy, onPalette, unread }: {
  dash: Dash; mode: AgentMode; view: View; setView: (v: View) => void; onPause: () => void; busy: boolean; onPalette: () => void; unread: number;
}) {
  const tasks = tasksOf(dash).length;
  return (
    <>
      <nav className={`glass ${s.sidebar}`} aria-label="Main">
        <div className={s.agentCard}>
          <AgentOrb mode={mode} />
          <div className={s.agentText}>
            <strong>Guardian</strong>
            <span className={s[`mode_${mode}`]}>{MODE_LABEL[mode]}</span>
          </div>
        </div>
        <button className={s.search} onClick={onPalette}><Icon name="search" size={16} /><span>Search or command</span><kbd>⌘K</kbd></button>
        <ul className={s.nav}>
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button className={`${s.navItem} ${view === v.id ? s.navOn : ""}`} aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>
                <Icon name={v.icon} />
                <span>{v.label}</span>
                {v.id === "overview" && tasks > 0 && <i className={s.badgeWarn}>{tasks}</i>}
                {v.id === "agent" && unread > 0 && <i className={s.badge}>{unread}</i>}
              </button>
            </li>
          ))}
        </ul>
        <div className={s.foot}>
          <span className={`${s.net} ${dash.network.isTestnet ? s.netTest : s.netMain}`}>{dash.network.name}</span>
          <span className={`${s.acct} tech`}>Account <span className="hash">{short(dash.identities.smartAccount)}</span></span>
          <button className={s.pause} onClick={onPause} disabled={busy}>
            <Icon name={dash.monitoring.enabled ? "pause" : "play"} size={16} />{dash.monitoring.enabled ? "Pause agent" : "Resume agent"}
          </button>
        </div>
      </nav>
      <nav className={`glass ${s.tabbar}`} aria-label="Main (mobile)">
        {VIEWS.map((v) => (
          <button key={v.id} className={`${s.tabItem} ${view === v.id ? s.tabOn : ""}`} onClick={() => setView(v.id)} aria-label={v.label}>
            <Icon name={v.icon} size={20} /><span>{v.label}</span>
            {v.id === "overview" && tasks > 0 && <i className={s.dotWarn} />}
            {v.id === "agent" && unread > 0 && <i className={s.dot} />}
          </button>
        ))}
      </nav>
    </>
  );
}

export type Command = { id: string; label: string; hint?: string; icon: IconName; run: () => void; keywords?: string };

/** ⌘K / Ctrl+K palette. Fuzzy-ish match: every query word must appear in label, hint or keywords. */
export function CommandPalette({ open, onClose, commands, onAsk }: { open: boolean; onClose: () => void; commands: Command[]; onAsk: (q: string) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(""); setI(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(w)));
    return q.trim() ? [...hits, { id: "ask", label: `Ask the agent: “${q.trim()}”`, icon: "agent" as IconName, run: () => onAsk(q.trim()) }] : hits;
  }, [q, commands, onAsk]);
  if (!open) return null;
  const choose = (c: Command | undefined) => { if (!c) return; onClose(); c.run(); };
  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <div className={`glass ${s.palette}`} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className={s.paletteInput}>
          <Icon name="search" />
          <input ref={input} value={q} placeholder="Type a command, or ask the agent anything…" aria-label="Command"
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((i + 1) % Math.max(1, list.length)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setI((i - 1 + list.length) % Math.max(1, list.length)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(list[i]); }
              else if (e.key === "Escape") onClose();
            }} />
          <kbd>esc</kbd>
        </div>
        <ul className={s.results} role="listbox">
          {list.map((c, n) => (
            <li key={c.id} role="option" aria-selected={n === i}>
              <button className={`${s.result} ${n === i ? s.resultOn : ""}`} onMouseEnter={() => setI(n)} onClick={() => choose(c)}>
                <Icon name={c.icon} size={16} /><span>{c.label}</span>{c.hint && <small>{c.hint}</small>}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className={s.noResult}>No matching command</li>}
        </ul>
      </div>
    </>
  );
}
