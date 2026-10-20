"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";
import { connectWallet, signRaw, signText } from "./wallet";
import s from "./console/console.module.css";
import sh from "./console/shell.module.css";
import { agentMode, api, short, type Dash, type Ev } from "./console/model";
import { AgentOrb, StatusHero, YourTasks, type Ctl } from "./console/Hero";
import { AgentThinking } from "./console/Thinking";
import { Guardrails } from "./console/Guardrails";
import { SimulatePanel } from "./console/Interact";
import { SecurityCenter } from "./console/Security";
import { History } from "./console/History";
import { Onboarding, seenOnboarding } from "./console/Onboarding";
import { CommandPalette, Sidebar, VIEWS, type Command, type View } from "./console/Shell";
import { AllocationChart, DailyBrief, type Brief, type Point } from "./console/Insights";
import { AgentChat, proactiveFrom, type Msg } from "./console/AgentChat";
import { LimitsEditor } from "./console/Limits";
import { Icon } from "./console/icons";
import { PortfolioView } from "./console/Portfolio";
import { TargetEditor } from "./console/Targets";
import { DetailProvider, DetailSwitch, More, useDetail } from "./console/detail";

type Theme = "dark" | "light" | null;
const THEME_KEY = "guardian.theme";
const HIDDEN_EVENTS = new Set(["CHAT_Q", "CHAT_A"]);
const viewFromHash = (): View => { const h = typeof location === "undefined" ? "" : location.hash.slice(1); return (VIEWS.some((v) => v.id === h) ? h : "overview") as View; };

export default function Dashboard() {
  return <DetailProvider><Console /></DetailProvider>;
}

function Console() {
  const detail = useDetail();
  const [dash, setDash] = useState<Dash | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [help, setHelp] = useState(false);
  const [theme, setTheme] = useState<Theme>(null);
  const [view, setViewState] = useState<View>("overview");
  const [palette, setPalette] = useState(false);
  const [insights, setInsights] = useState<{ history: Point[]; brief: Brief } | null>(null);
  const [proactive, setProactive] = useState<Msg[]>([]);
  const [unread, setUnread] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const cursor = useRef("0");
  const live = useRef(false);
  const viewRef = useRef<View>("overview");
  const capRef = useRef(10);

  const setView = useCallback((v: View) => { setViewState(v); viewRef.current = v; if (location.hash.slice(1) !== v) history.replaceState(null, "", `#${v}`); }, []);
  useEffect(() => { const v = viewFromHash(); setViewState(v); viewRef.current = v; const on = () => setView(viewFromHash()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, [setView]);

  /** Merge new audit events (oldest-first or newest-first input) and turn notable ones into proactive agent messages. */
  const ingest = useCallback((incoming: Ev[], announce: boolean) => {
    const fresh = incoming.filter((e) => !HIDDEN_EVENTS.has(e.type));
    if (incoming.length) {
      const maxId = incoming.reduce((m, e) => (BigInt(e.id) > BigInt(m) ? e.id : m), cursor.current);
      cursor.current = maxId;
    }
    if (!fresh.length) return;
    setEvents((prev) => { const seen = new Set(prev.map((e) => e.id)); return [...fresh.filter((e) => !seen.has(e.id)).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))), ...prev].slice(0, 500); });
    if (announce) {
      const msgs = fresh.map((e) => proactiveFrom(e, capRef.current)).filter((m): m is Msg => !!m);
      if (msgs.length) { setProactive((p) => [...p, ...msgs]); if (viewRef.current !== "agent") setUnread((n) => n + msgs.length); }
    }
  }, []);

  const loadDash = useCallback(async (fresh = false) => {
    try { const d = await api<Dash>(`/api/dashboard${fresh ? "?fresh" : ""}`); capRef.current = d.policy?.maxAutoTxUsd ?? 10; setDash(d); setNeedsLogin(false); }
    catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) setNeedsLogin(true);
      else if (status === 404) setNotice({ kind: "err", text: (e as Error).message });
    }
  }, []);
  const loadEvents = useCallback(async (announce: boolean) => {
    try { const { events: more } = await api<{ events: Ev[] }>(`/api/timeline?after=${cursor.current}`); ingest(more, announce); } catch { /* next poll retries */ }
  }, [ingest]);
  const loadInsights = useCallback(async () => { try { setInsights(await api("/api/insights")); } catch { /* optional panel */ } }, []);
  const load = useCallback(async (fresh = false) => { await loadDash(fresh); if (!live.current) await loadEvents(true); }, [loadDash, loadEvents]);

  // Initial load, then dashboard polling; events come from the live stream when available.
  useEffect(() => {
    let stop = false;
    void (async () => { await loadDash(); await loadEvents(false); void loadInsights(); })();
    const t = setInterval(() => { if (!stop) void load(); }, 4000);
    const ti = setInterval(() => { if (!stop) void loadInsights(); }, 60_000);
    return () => { stop = true; clearInterval(t); clearInterval(ti); };
  }, [load, loadDash, loadEvents, loadInsights]);

  useEffect(() => {
    if (!dash || needsLogin) return;
    let es: EventSource | null = null, refresh: ReturnType<typeof setTimeout> | undefined;
    try {
      es = new EventSource(`/api/stream?after=${cursor.current}`);
      es.onopen = () => { live.current = true; };
      es.onmessage = (m) => {
        const rows = JSON.parse(m.data) as Ev[];
        ingest(rows, true);
        clearTimeout(refresh);
        refresh = setTimeout(() => { void loadDash(); if (rows.some((r) => r.type === "CONFIRMED")) void loadInsights(); }, 400);
      };
      // Live watch status from the worker: updates the "what is happening now" strip without a full reload.
      es.addEventListener("watch", (m) => { const w = JSON.parse((m as MessageEvent).data) as Dash["watch"]; setDash((prev) => (prev ? { ...prev, watch: w } : prev)); });
      es.onerror = () => { live.current = false; };
    } catch { live.current = false; }
    return () => { es?.close(); live.current = false; clearTimeout(refresh); };
  }, [!!dash, needsLogin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { const t = localStorage.getItem(THEME_KEY) as Theme; if (t) { setTheme(t); document.documentElement.dataset.theme = t; } } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => { if (dash && !seenOnboarding()) setHelp(true); }, [!!dash]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (notice?.kind !== "ok") return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((o) => !o); } };
    addEventListener("keydown", on); return () => removeEventListener("keydown", on);
  }, []);

  const toggleTheme = useCallback(() => {
    const dark = theme ? theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
    const next: Theme = dark ? "light" : "dark";
    setTheme(next); document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  }, [theme]);

  const run: Ctl["run"] = async (label, fn) => {
    setBusy(label); setNotice(null);
    try { const text = await fn(); if (text) setNotice({ kind: "ok", text }); await load(true); }
    catch (e) { setNotice({ kind: "err", text: (e as Error).message.split("\n")[0]! }); }
    finally { setBusy(null); }
  };

  const signIn = () => run("signin", async () => {
    const address = await connectWallet();
    const { nonce, chainId } = await api<{ nonce: string; chainId: number }>("/api/auth/nonce", { address });
    const msg = createSiweMessage({ address, chainId, domain: location.host, nonce, uri: location.origin, version: "1", statement: "Sign in to Guardian as the wallet owner." });
    await api("/api/auth/verify", { message: msg, signature: await signText(address, msg) });
    await loadEvents(false); void loadInsights();
  });
  /** Testnet only: no wallet needed; the server opens a sandbox session on the live demo account. */
  const sandboxSignIn = () => run("sandbox", async () => {
    const r = await api<{ smartAccount: string }>("/api/auth/demo", {});
    await loadEvents(false); void loadInsights();
    return `Entered Judge Sandbox — viewing live Base Sepolia smart account ${short(r.smartAccount)} (owner signatures still require the master wallet)`;
  });

  /** Ends this session (owner or sandbox) and returns to the sign-in card, where either login can be chosen. */
  const signOut = () => run("signout", async () => {
    await api("/api/auth/logout", {});
    setDash(null); setEvents([]); setProactive([]); setInsights(null); cursor.current = "0"; setNeedsLogin(true);
    return "Signed out — choose the owner wallet or the Judge Sandbox";
  });

  /** Master operations: the server prepares, the owner's wallet signs the exact userOpHash, the server verifies and submits. */
  const masterSign: Ctl["masterSign"] = async (prepared: { userOperationId: string; userOpHash: Hex }, done: string) => {
    const address = await connectWallet();
    if (dash && address.toLowerCase() !== dash.identities.masterOwner.toLowerCase())
      throw new Error(`Switch your wallet to the master owner ${short(dash.identities.masterOwner)} to sign`);
    const signature = await signRaw(address as Address, prepared.userOpHash);
    const { userOpHash } = await api<{ userOpHash: string }>(`/api/signatures/${prepared.userOperationId}`, { signature });
    return `${done} — operation ${short(userOpHash)} submitted`;
  };

  const pause = () => dash && run("monitor", async () => { await api("/api/monitoring", { enabled: !dash.monitoring.enabled }); return dash.monitoring.enabled ? "Agent paused" : "Agent resumed"; });
  const evaluate = () => run("ask", async () => {
    const r = await api<{ skipped?: string }>("/api/evaluate", {});
    return r.skipped === "COOLDOWN" ? "In cooldown after a recent trade — try again in a few minutes." : r.skipped ? `Skipped: ${r.skipped.replaceAll("_", " ").toLowerCase()}` : "Checking now — watch Agent thinking.";
  });
  const simulate = (direction: "up" | "down", usd: number) => run(`sim-${direction}-${usd}`, async () => {
    const r = await api<{ how: string }>("/api/simulate", { direction, usd });
    setView("overview");
    return `Demo wallet ${r.how}. Watch the agent react.`;
  });

  const commands: Command[] = useMemo(() => {
    if (!dash) return [];
    const c: Command[] = [
      ...VIEWS.map((v) => ({ id: `go-${v.id}`, label: `Go to ${v.label}`, icon: v.icon, run: () => setView(v.id), keywords: "open view navigate" })),
      { id: "check", label: "Check portfolio now", hint: "run the agent", icon: "bolt", run: () => void evaluate(), keywords: "evaluate rebalance" },
      { id: "pause", label: dash.monitoring.enabled ? "Pause agent" : "Resume agent", icon: dash.monitoring.enabled ? "pause" : "play", run: () => void pause(), keywords: "stop start monitoring" },
      { id: "security", label: "Run security tests", hint: "Settings", icon: "key", run: () => setView("settings"), keywords: "attack injection proof audit safe" },
      { id: "limits", label: "Edit limits", icon: "limits", run: () => setView("limits"), keywords: "policy band target budget cap" },
      { id: "ask-why", label: "Ask: why did you trade last time?", icon: "agent", run: () => { setPendingAsk("Why did you trade last time?"); setView("agent"); } },
      { id: "ask-how", label: "Ask: how is my portfolio doing?", icon: "agent", run: () => { setPendingAsk("How is my portfolio doing?"); setView("agent"); } },
      { id: "signout", label: dash.sandbox ? "Leave Judge Sandbox" : "Sign out", hint: "switch account", icon: "hand", run: () => void signOut(), keywords: "logout sandbox owner switch account" },
      { id: "theme", label: "Toggle light / dark theme", icon: "sun", run: toggleTheme, keywords: "appearance" },
      { id: "detail", label: detail.full ? "Hide technical details" : "Show technical details", icon: "help", run: () => detail.setFull(!detail.full), keywords: "simple advanced expert addresses" },
      { id: "help", label: "How Guardian works", icon: "help", run: () => setHelp(true), keywords: "onboarding guide" },
    ];
    if (dash.network.isTestnet && dash.demo.enabled) c.push(
      { id: "sim-up", label: "Simulate: WETH up $5", hint: "testnet", icon: "up", run: () => void simulate("up", 5), keywords: "demo market move" },
      { id: "sim-down", label: "Simulate: WETH down $5", hint: "testnet", icon: "down", run: () => void simulate("down", 5), keywords: "demo market move" },
    );
    return c;
  }, [dash, toggleTheme, detail.full]); // eslint-disable-line react-hooks/exhaustive-deps

  if (needsLogin) return (
    <main className={s.login}>
      <div className={`glass ${s.loginCard}`}>
        <AgentOrb mode="watching" large />
        <h1>Guardian Agent</h1>
        <p>Pick the mix you want. Guardian keeps your WETH and USDC there for you, and it can never trade outside the limits you sign.</p>
        <div className={s.features}>
          <div className={s.feature}><Icon name="limits" /> <span>Your wallet enforces your limits, not the AI. Even a tricked agent can't break them.</span></div>
          <div className={s.feature}><Icon name="agent" /> <span>Ask it anything. It explains every trade in plain words.</span></div>
          <div className={s.feature}><Icon name="hand" /> <span>Big trades wait for your signature. Pause or switch it off any time.</span></div>
        </div>
        <button className="primary" onClick={signIn} disabled={busy === "signin"} style={{ width: "100%" }}>{busy === "signin" ? "Waiting for wallet…" : "Sign in with owner wallet"}</button>
        <button onClick={sandboxSignIn} disabled={!!busy} style={{ width: "100%", marginTop: 10 }}>{busy === "sandbox" ? "Opening sandbox…" : "Try the live demo (no wallet needed)"}</button>
        <p className={s.fine}>The demo runs on a real test account. You can watch the agent, chat with it and simulate price moves. Only the owner can change limits.</p>
        {notice && <p className={notice.kind === "err" ? s.toastErr : s.toastOk} role="status">{notice.text}</p>}
      </div>
    </main>
  );
  if (!dash) return <main className={s.loading}><div style={{ textAlign: "center" }}><AgentOrb mode="thinking" large /><p className="muted">Waking up your agent…</p>{notice && <p className={s.toastErr}>{notice.text}</p>}</div></main>;

  const mode = agentMode(dash);
  const ctl: Ctl = { dash, busy, run, masterSign };
  const head = (title: string, sub: string, right?: React.ReactNode) => (
    <div className={sh.viewHead}><div><h1 className={sh.viewTitle}>{title}</h1><p className={sh.viewSub}>{sub}</p></div>{right}</div>
  );

  return (
    <div className={sh.app}>
      <Sidebar dash={dash} mode={mode} view={view} setView={(v) => { setView(v); if (v === "agent") setUnread(0); }} onPause={() => void pause()} busy={!!busy} onPalette={() => setPalette(true)} unread={unread} />
      <main className={sh.main}>
        {dash.sandbox && <div className={`glass ${s.toast} ${s.row}`} role="note" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span>Live demo · you can look around and test, but not change limits<span className="tech"> · account {short(dash.identities.smartAccount)} on {dash.network.name}</span></span>
          <button disabled={!!busy} onClick={signOut}>{busy === "signout" ? "Signing out…" : "Switch to owner wallet"}</button>
        </div>}
        {notice && <p className={`glass ${s.toast} ${notice.kind === "err" ? s.toastErr : s.toastOk}`} role="status">{notice.text}</p>}

        {view === "overview" && <>
          <StatusHero dash={dash} />
          <div className={s.grid}>
            <div className={s.col}>
              <YourTasks {...ctl} />
              <AgentThinking dash={dash} events={events} />
            </div>
            <div className={s.col}>
              <DailyBrief brief={insights?.brief ?? null} loading={!insights} />
              <Guardrails {...ctl} onEdit={() => setView("limits")} />
            </div>
          </div>
          {dash.policy && (
            <section className={`glass ${s.panel}`} aria-label="Allocation history">
              <div className={s.panelHead}><h2>WETH share · last 7 days</h2><button className="ghost" onClick={() => setView("activity")}>See activity <Icon name="chevron" size={14} /></button></div>
              <AllocationChart points={insights?.history ?? []} policy={dash.policy} current={"error" in dash.portfolio ? null : dash.portfolio.wethWeightPct} />
            </section>
          )}
        </>}

        {view === "portfolio" && <>
          {head("Portfolio", "What you hold and what it's worth right now.")}
          <PortfolioView ctl={ctl} />
        </>}

        {view === "agent" && <>
          {head("Agent", "Ask about your money, its decisions or your limits.")}
          <AgentChatWithAsk ctl={ctl} proactive={proactive} setView={setView} onSeen={() => setUnread(0)} pendingAsk={pendingAsk} clearAsk={() => setPendingAsk(null)} />
        </>}

        {view === "activity" && <>
          {head("Activity", "Everything the agent noticed, decided and did.")}
          <History dash={dash} events={events} />
        </>}

        {view === "limits" && dash.policy && <>
          {head("Limits", "The rules the agent has to follow. See the effect before you save.")}
          <TargetEditor ctl={ctl} />
          <LimitsEditor ctl={ctl} points={insights?.history ?? []} />
          <Guardrails {...ctl} />
        </>}

        {view === "settings" && <>
          {head("Settings", "Security, display and demo tools.")}
          <SecurityCenter {...ctl} />
          <div className={s.grid}>
            <div className={s.col}>
              <section className={`glass ${s.panel}`} aria-label="AI model">
                <div className={s.panelHead}><h2>AI model</h2></div>
                <p className={s.lead}>If the AI is ever unavailable, Guardian falls back to your own target for small trades, and pauses after 3 failures in a row.</p>
                <More label={`Models in use (${dash.agent.models.length})`}><ol className={s.feed}>{(dash.agent.models.length ? dash.agent.models : ["none configured"]).map((m, i) => (
                  <li key={m} className={s.feedItem}><span className={s.feedIcon}>{i + 1}</span><div><div className={s.feedTitle}>{m.split(":")[1] ?? m}</div><p className={s.feedWhy}>{i === 0 ? "Primary" : "Fallback"} · {m.split(":")[0]}</p></div></li>
                ))}</ol></More>
              </section>
              <section className={`glass ${s.panel}`} aria-label="Appearance">
                <div className={s.panelHead}><h2>Display & help</h2></div>
                <DetailSwitch />
                <div style={{ height: 14 }} />
                <div className={s.row}>
                  <button onClick={toggleTheme}><Icon name="sun" size={16} /> Toggle theme</button>
                  <button onClick={() => setHelp(true)}><Icon name="help" size={16} /> How Guardian works</button>
                  <button onClick={() => setPalette(true)}><Icon name="search" size={16} /> Commands <kbd>⌘K</kbd></button>
                  <button disabled={!!busy} onClick={signOut}>{busy === "signout" ? "Signing out…" : dash.sandbox ? "Leave sandbox" : "Sign out"}</button>
                </div>
              </section>
            </div>
            <div className={s.col}><SimulatePanel {...ctl} /></div>
          </div>
        </>}
      </main>

      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} onAsk={(q) => { setPendingAsk(q); setView("agent"); }} />
      {help && <Onboarding onClose={() => setHelp(false)} maxAuto={dash.policy?.maxAutoTxUsd ?? 10} />}
    </div>
  );
}

/** Chat view that also sends a question queued from the command palette. */
function AgentChatWithAsk({ pendingAsk, clearAsk, ...props }: Parameters<typeof AgentChat>[0] & { pendingAsk: string | null; clearAsk: () => void }) {
  return <AgentChat {...props} initialAsk={pendingAsk} onInitialAsk={clearAsk} />;
}
