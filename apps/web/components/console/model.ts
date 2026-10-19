// Shared types, API helper, formatting, and the plain-language layer that turns engine data into explanations.

export type Policy = { ethMinPct: number; ethMaxPct: number; targetEthPct: number; maxAutoTxUsd: number; dailyBudgetUsd: number; maxSlippageBps: number; sessionDurationHours: number;
  assets?: { symbol: string; targetPct: number }[]; driftPct?: number };
export type Portfolio = { wethUsd: string; usdcUsd: string; totalUsd: string; wethWeightPct: number; assessment: string; ethUsd: number; block: string };
export type Action = {
  id: string; state: string; tier: string | null; reasons: string[] | null;
  plan: { direction?: string; wethWei?: string; limitRaw?: string; targetPct?: number; clamped?: boolean } | null;
  requestedUsdCents: string | null; createdAt: string; updatedAt?: string; error: string | null;
  decision: { decision: string; reason: string; provider?: string } | null;
};
export type Dash = {
  network: { chainId: number; name: string; isTestnet: boolean };
  identities: { masterOwner: string; smartAccount: string; entryPoint: string; kernelVersion: string; sessionSigner: string | null };
  monitoring: { enabled: boolean; pausedReason: string | null };
  policy: Policy | null;
  policyVersion: number | null;
  policyAheadOfSession: boolean;
  multi: { totalUsd: string; drifted: boolean; driftPct: number; weights: { symbol: string; pct: number; targetPct: number; driftPct: number; status: string | null }[]; legs: { symbol: string; side: string; usd: string }[] } | { error: string } | null;
  sessions: { asset: string; status: string; permissionId: string; validUntil: string }[];
  watch: Watch;
  agent: { models: string[] };
  demo: { enabled: boolean; walletB: { address: string; wethUsd: number; usdc: number } | null };
  session: { status: string; onChain: string; permissionId: string; validUntil: string; authorizeUserOpHash: string | null } | null;
  compiled: { twoWay: boolean; maxAmountInWei: string; maxUsdcInRaw: string | null; windowSec: number | null; opsInWindow: number | null; maxOps: number; opsUsed: number | null; allowanceWei: string; authPrice: number; bufferBps: number; reauthAtPrice: number } | null;
  budget: { day: string; usedCents: string; budgetCents: number };
  portfolio: Portfolio | { error: string };
  actions: Action[];
  outcomes: { agentConfirmed: number; masterConfirmed: number; waiting: number; blocked: number; stopped: number; noAction: number };
  operations: { id: string; authority: string; purpose: string; state: string; userOpHash: string | null; transactionHash: string | null; block: string | null; userOpSuccess: boolean | null; explorer: string | null; createdAt: string }[];
  pendingSignatures: { id: string; purpose: string; userOpHash: string; actionId: string | null }[];
};
export type Check = { at: string; block: string | null; state: "checking" | "in_band" | "out_of_band" | "evaluating" | "cooldown" | "error"; summary: string; nextCheckAt: string };
export type Watch = { heartbeatAt: string | null; lastBlock: string | null; lastCheck: (Check & { recent?: Check[] }) | null; workerOnline: boolean };
export type Ev = { id: string; type: string; level: "INFO" | "SUCCESS" | "WARNING" | "FAILURE"; message: string; data: Record<string, unknown> | null; createdAt: string; actionId: string | null };

export const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Request failed (${r.status})`), { status: r.status });
  return j as T;
};

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const weth = (wei?: string) => (wei ? (Number(wei) / 1e18).toFixed(6) : "—");
export const usdcFmt = (raw?: string | null) => (raw ? (Number(raw) / 1e6).toFixed(2) : "—");
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const until = (iso: string) => {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return "expired";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
export const humanize = (s: string) => s.replaceAll("_", " ").toLowerCase();
export const portfolioOf = (d: Dash) => ("error" in d.portfolio ? null : d.portfolio);

/** What the agent is doing right now — drives the orb, the headline, and the page accent. */
export type AgentMode = "watching" | "thinking" | "acting" | "needs-you" | "paused" | "offline";
const THINKING = ["TRIGGERED", "PLANNING"], ACTING = ["SIMULATING", "SUBMITTING", "PENDING", "REVALIDATING"];
export function agentMode(d: Dash): AgentMode {
  if (!d.monitoring.enabled) return "paused";
  const latest = d.actions[0];
  if (latest && THINKING.includes(latest.state)) return "thinking";
  if (latest && ACTING.includes(latest.state)) return "acting";
  if (tasksOf(d).length) return "needs-you";
  if (d.session?.onChain !== "ACTIVE") return "offline";
  return "watching";
}
export const MODE_LABEL: Record<AgentMode, string> = {
  watching: "Watching", thinking: "Thinking", acting: "Acting", "needs-you": "Needs you", paused: "Paused", offline: "No authority",
};

/** Owner to-do items, most urgent first. */
export type Task = { kind: "approve" | "sign-policy" | "authorize" | "resume" | "signature"; title: string; detail: string; action?: Action };
export function tasksOf(d: Dash): Task[] {
  const t: Task[] = [];
  for (const a of d.actions.filter((a) => a.state === "PENDING_APPROVAL" || a.state === "MASTER_SIGNING"))
    t.push({ kind: "approve", action: a,
      title: a.plan?.direction === "BUY_WETH" ? `Approve a purchase of ${weth(a.plan?.wethWei)} WETH` : `Approve a sale of ≈ $${(Number(a.requestedUsdCents ?? 0) / 100).toFixed(2)} of WETH`,
      detail: `This trade is bigger than the agent may do alone (${(a.reasons ?? []).map(humanize).join(", ") || "needs your signature"}). Prices are rechecked before you sign.` });
  if (d.policyAheadOfSession)
    t.push({ kind: "sign-policy", title: "Sign to apply your new limits", detail: `You saved policy v${d.policyVersion}. The agent keeps using the old limits until you sign a new on-chain permission.` });
  else if (!d.session || d.session.onChain !== "ACTIVE")
    t.push({ kind: "authorize", title: d.session ? "Re-authorize the agent" : "Authorize the agent", detail: d.session
      ? `The agent's permission is ${humanize(d.session.onChain)}. Sign a new one so it can keep your portfolio in range.`
      : "Give Guardian a limited, revocable permission to rebalance inside your limits." });
  if (!d.monitoring.enabled)
    t.push({ kind: "resume", title: "The agent is paused", detail: d.monitoring.pausedReason === "AI_UNAVAILABLE_OR_INVALID"
      ? "The AI failed several times in a row, so Guardian stopped acting on its own to be safe. Resume once the AI provider is working."
      : `Autonomous actions are off${d.monitoring.pausedReason ? ` (${humanize(d.monitoring.pausedReason)})` : ""}. Resume to let it rebalance again.` });
  return t;
}

/** One-sentence status the agent "says" in the hero. */
export const multiOf = (d: Dash) => (d.multi && !("error" in d.multi) ? d.multi : null);

export function headline(d: Dash): { title: string; body: string } {
  const p = portfolioOf(d), pol = d.policy, mode = agentMode(d), latest = d.actions[0];
  const m = multiOf(d);
  if (m && pol && mode !== "thinking" && mode !== "acting" && mode !== "needs-you") {
    const worst = [...m.weights].sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))[0];
    if (mode === "paused") return { title: "I'm paused", body: `Your ${m.weights.length}-asset portfolio is worth $${m.totalUsd}. I won't trade until you resume me.` };
    if (!m.drifted) return { title: "All good — nothing to do", body: `Your ${m.weights.length} assets ($${m.totalUsd}) are all within ±${m.driftPct} points of their targets. Largest drift: ${worst ? `${worst.symbol} ${worst.driftPct >= 0 ? "+" : ""}${worst.driftPct.toFixed(1)} pts` : "none"}.` };
    const next = m.legs[0];
    return { title: "Your portfolio is out of balance", body: `${worst!.symbol} is ${worst!.pct.toFixed(1)}% vs a ${worst!.targetPct}% target. Next step: ${next ? `${next.side.toLowerCase()} $${next.usd} of ${next.symbol}` : "none above the minimum trade"}, unless a cooldown is running.` };
  }
  if (!p || !pol) return { title: "I can't read your portfolio right now", body: "error" in d.portfolio ? d.portfolio.error : "No policy is set yet." };
  const pct = `${p.wethWeightPct.toFixed(1)}%`, band = `${pol.ethMinPct}–${pol.ethMaxPct}%`;
  if (mode === "paused") return { title: "I'm paused", body: `WETH is ${pct} of your portfolio (allowed ${band}). I won't trade until you resume me.` };
  if (mode === "thinking") return { title: "I'm deciding what to do", body: `WETH moved to ${pct}, outside your ${band} range. I'm checking prices, risk and your limits.` };
  if (mode === "acting") return { title: `I'm ${latest?.plan?.direction === "BUY_WETH" ? "buying WETH" : "selling WETH"} to rebalance`, body: `Bringing WETH from ${pct} back toward your ${pol.targetEthPct}% target. The swap is on its way to the chain.` };
  if (mode === "needs-you") return { title: "I need you for something", body: "See “Your tasks” below — one signature and I can continue." };
  if (mode === "offline") return { title: "I'm watching, but I can't act", body: `WETH is ${pct}. Authorize me so I can rebalance when it leaves ${band}.` };
  if (p.assessment === "WITHIN_BAND") return { title: "All good — nothing to do", body: `WETH is ${pct} of your $${Number(p.totalUsd).toFixed(2)} portfolio, inside your ${band} range. I check every new block.` };
  return { title: "Your portfolio is out of range", body: `WETH is ${pct}, outside ${band}. I'll ${p.assessment === "SELL_WETH" ? "sell" : "buy"} WETH on the next check, unless a cooldown is running.` };
}

/** Plain-language explanation of each audit event type. */
type Explain = { icon: string; title: string; why?: string; step?: Step };
export type Step = "noticed" | "measured" | "decided" | "planned" | "checked" | "executed" | "done";
export const STEPS: { id: Step; label: string }[] = [
  { id: "noticed", label: "Noticed" }, { id: "measured", label: "Measured" }, { id: "decided", label: "Decided" },
  { id: "planned", label: "Planned" }, { id: "checked", label: "Safety checks" }, { id: "executed", label: "Executed" }, { id: "done", label: "Done" },
];
export const EXPLAIN: Record<string, Explain> = {
  TRIGGER_DETECTED: { icon: "◉", title: "Noticed a change", why: "A transfer, price move or your request made the agent look again.", step: "noticed" },
  ALLOCATION: { icon: "◔", title: "Measured your portfolio", why: "Balances and Chainlink prices, read at the latest block.", step: "measured" },
  AI_DECISION: { icon: "✦", title: "AI decided", why: "The AI only picks what to do. Code computes every amount and address.", step: "decided" },
  AI_UNAVAILABLE: { icon: "⚠", title: "AI unavailable — using the safe rule", why: "Without a valid AI answer, Guardian rebalances to your own target, only for small low-risk trades.", step: "decided" },
  PARTIAL_STEP: { icon: "⇲", title: "Splitting a bigger move", why: "The move is above your per-trade cap, so the agent does one capped step now and the rest after a cooldown.", step: "planned" },
  PLAN: { icon: "▤", title: "Planned the trade", step: "planned" },
  QUOTE: { icon: "⇄", title: "Got a price quote", why: "From the Uniswap quoter, with your maximum slippage applied.", step: "planned" },
  RISK: { icon: "⛨", title: "Scored the risk", why: "Price divergence, size and history. High risk always goes to you.", step: "checked" },
  ROUTING: { icon: "⑂", title: "Chose who signs", why: "Small trades inside limits: the agent. Bigger ones: you.", step: "checked" },
  SIMULATION_PASSED: { icon: "✓", title: "Simulated the swap", why: "Dry run against the live chain before anything is sent.", step: "checked" },
  SESSION_VALIDATED: { icon: "⚿", title: "Permission check passed", why: "Your smart account confirmed the agent's limited key may do exactly this.", step: "checked" },
  SUBMITTED: { icon: "↗", title: "Sent to the network", step: "executed" },
  RECEIPT_PENDING: { icon: "⋯", title: "Waiting for the block", step: "executed" },
  SUBMISSION_UNKNOWN: { icon: "?", title: "Submission status unknown — reconciling", step: "executed" },
  CONFIRMED: { icon: "●", title: "Confirmed on-chain", step: "done" },
  EXECUTION_FAILED: { icon: "✕", title: "Swap reverted", why: "The permission was fine but the market moved; no funds were lost beyond gas (sponsored).", step: "done" },
  FAILED: { icon: "■", title: "Stopped", step: "done" },
  REJECTED: { icon: "⛔", title: "Blocked by your policy", step: "done" },
  NO_ACTION: { icon: "○", title: "Nothing to do", step: "done" },
  WAIT: { icon: "◷", title: "Agent chose to wait", step: "done" },
  PENDING_APPROVAL: { icon: "✋", title: "Waiting for your approval", step: "checked" },
  REVALIDATED: { icon: "↻", title: "Rechecked prices before your signature", step: "checked" },
  MASTER_SUBMITTED: { icon: "↗", title: "Your signed operation was sent", step: "executed" },
  DECLINED: { icon: "✕", title: "You declined", step: "done" },
  CANCELLED: { icon: "✕", title: "Cancelled", step: "done" },
  SESSION_REAUTH_REQUIRED: { icon: "⚿", title: "Agent needs a new permission" },
  AGENT_AUTHORIZED: { icon: "⚿", title: "Agent authorized" },
  AGENT_REVOKED: { icon: "⚿", title: "Agent revoked" },
  AUTHORIZATION_PREPARED: { icon: "✎", title: "Authorization ready to sign" },
  POLICY_UPDATED: { icon: "⚙", title: "Limits updated" },
  RESUMED: { icon: "▶", title: "Agent resumed" },
  DEMO_MOVE: { icon: "≋", title: "Simulated market move" },
  PLAN_LEGS: { icon: "▤", title: "Planned the rebalance", why: "Overweight assets are sold into USDC first; the USDC then buys underweight assets. One step per action.", step: "planned" },
  PAPER_FILL: { icon: "◇", title: "Simulated trade", why: "This asset has no usable pool on this network, so the step is recorded at the Chainlink price without an on-chain trade.", step: "executed" },
  SIMULATED_FILL: { icon: "◆", title: "Simulated step recorded", step: "done" },
  DEMO_RESET: { icon: "≋", title: "Demo portfolio reset" },
  ACCOUNT_REGISTERED: { icon: "★", title: "Account registered" },
};
export const explain = (type: string): Explain => EXPLAIN[type] ?? { icon: "•", title: humanize(type).replace(/^./, (c) => c.toUpperCase()) };
