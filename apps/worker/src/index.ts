// Guardian persistent worker: watch → precheck → (LLM + deterministic pipeline) → reconcile.
import { and, eq } from "drizzle-orm";
import { createPublicClient, erc20Abi, webSocket, type Address } from "viem";
import pino from "pino";
import { appendAudit, inCooldown, policies, smartAccounts, watcherCheckpoints } from "@guardian/db";
import { createEngineContext, describeAllocation, housekeeping, loadAccountState, multiPortfolio, readPortfolio, reconcile, runRebalance, fmtBps } from "@guardian/engine";
import { portfolioTargets } from "@guardian/policy";
import { notifyOwner, telegramEnabled } from "./notify.js";

const log = pino({ name: "guardian-worker", redact: ["*.apiKey", "*.privateKey", "*.encryptedKey"] });
const ctx = createEngineContext();
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 15_000);
const TRIGGER_WINDOW_SEC = 300; // one allocation trigger per account per 5-minute window (idempotency key)
let stopping = false;
const inflight = new Set<string>();
const emptyNoted = new Set<string>();

async function monitoredAccounts() {
  return ctx.db.select({ id: smartAccounts.id, address: smartAccounts.address }).from(smartAccounts)
    .innerJoin(policies, and(eq(policies.accountId, smartAccounts.id), eq(policies.active, true)))
    .where(and(eq(smartAccounts.chainId, ctx.chain.id), eq(smartAccounts.monitoringEnabled, true)));
}

type CheckState = "checking" | "in_band" | "out_of_band" | "evaluating" | "cooldown" | "error";
type Check = { at: string; block: string | null; state: CheckState; summary: string; nextCheckAt: string };
const recent = new Map<string, Check[]>();

/** Live status for the dashboard: the latest precheck plus a short history, written on every check. */
async function recordCheck(accountId: string, block: bigint | null, state: CheckState, summary: string) {
  const c: Check = { at: new Date().toISOString(), block: block?.toString() ?? null, state, summary, nextCheckAt: new Date(Date.now() + TICK_MS).toISOString() };
  const list = [c, ...(recent.get(accountId) ?? []).filter((x) => x.state !== "checking")].slice(0, 10);
  recent.set(accountId, list);
  const lastCheck = { ...c, recent: list };
  await ctx.db.insert(watcherCheckpoints).values({ accountId, lastBlock: block ?? 0n, heartbeatAt: new Date(), lastCheck })
    .onConflictDoUpdate({ target: watcherCheckpoints.accountId, set: { ...(block !== null ? { lastBlock: block } : {}), heartbeatAt: new Date(), lastCheck } })
    .catch((e) => log.warn({ err: (e as Error).message }, "could not record check"));
}

async function evaluate(accountId: string, trigger: { key: string; kind: string; detail?: string }) {
  if (inflight.has(accountId)) return;
  inflight.add(accountId);
  try {
    const st = await loadAccountState(ctx, accountId);
    if (!st.policy) return;
    const [w, u] = await Promise.all([ctx.network.weth, ctx.network.usdc].map((token) =>
      ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [st.account.address as Address] })));
    if (w === 0n && u === 0n) { // unfunded account: nothing to value or rebalance
      if (!emptyNoted.has(accountId)) { emptyNoted.add(accountId); log.info({ accountId }, "portfolio is empty; waiting for funds"); }
      return;
    }
    emptyNoted.delete(accountId);
    // Cheap deterministic precheck; the LLM is only woken for a meaningful change (band crossed).
    // Multi-asset policies check every asset's drift; legacy policies check the WETH band.
    const account = st.account.address as Address;
    let block: bigint, inBand: boolean, summary: string, detail: string;
    if (portfolioTargets(st.policy).multi) {
      const [mp, b] = await Promise.all([multiPortfolio(ctx, accountId, account, st.policy), ctx.publicClient.getBlockNumber()]);
      block = b; inBand = !mp.assessment.drifted;
      summary = `${describeAllocation(mp)}${inBand ? " — all within range" : ""}`;
      const worst = [...mp.assessment.weights].sort((x, y) => Math.abs(y.driftPct) - Math.abs(x.driftPct))[0]!;
      detail = trigger.detail ?? `${worst.symbol} at ${worst.pct.toFixed(1)}% vs target ${worst.targetPct}% (outside ±${mp.driftPct} pts)`;
    } else {
      const snap = await readPortfolio(ctx, account, st.policy);
      const weight = fmtBps(snap.assessment.valuation.wethWeightBps);
      block = snap.blockNumber; inBand = snap.assessment.kind === "WITHIN_BAND";
      summary = `WETH ${weight}% (range ${st.policy.ethMinPct}–${st.policy.ethMaxPct}%)${inBand ? " — within range" : ""}`;
      detail = trigger.detail ?? (snap.assessment.kind === "SELL_WETH"
        ? `WETH weight ${weight}% above maximum ${st.policy.ethMaxPct}%` : `WETH weight ${weight}% below minimum ${st.policy.ethMinPct}%`);
    }
    if (inBand) { await recordCheck(accountId, block, "in_band", summary); return; }
    if (await inCooldown(ctx.db, accountId)) { await recordCheck(accountId, block, "cooldown", `${summary} — waiting for the cooldown after the last trade`); return; }
    await recordCheck(accountId, block, "evaluating", `${summary} — out of band, deciding now`);
    const res = await runRebalance(ctx, accountId, { key: trigger.key, kind: trigger.kind, detail, block });
    await recordCheck(accountId, block, "out_of_band", `${summary} — ${"state" in res ? `action ${String(res.state).toLowerCase().replaceAll("_", " ")}` : `skipped (${String(res.skipped).toLowerCase().replaceAll("_", " ")})`}`);
    log.info({ accountId, trigger: trigger.key, res }, "rebalance evaluated");
    if ("state" in res && res.state === "PENDING_APPROVAL")
      await notifyOwner(`Guardian needs your OK: ${detail}. This trade is bigger than the agent may make alone. Approve or decline within 30 minutes.`)
        .catch((e) => log.warn({ err: (e as Error).message }, "owner notification failed"));
  } catch (e) {
    // Drizzle wraps driver errors ("Failed query: …"); the cause holds the real reason (e.g. connection limit).
    const err = e as Error & { cause?: { message?: string } };
    const why = err.cause?.message ?? err.message.split(String.fromCharCode(10))[0]!;
    await recordCheck(accountId, null, "error", `Check failed safely, nothing was traded: ${why.slice(0, 200)}`);
    log.error({ accountId, err: err.message.split(String.fromCharCode(10))[0], cause: err.cause?.message }, "evaluation failed (fail closed)");
  } finally {
    inflight.delete(accountId);
  }
}

async function tick() {
  try { await reconcile(ctx); await housekeeping(ctx); } catch (e) { log.error({ err: (e as Error).message }, "reconcile failed"); }
  const window = Math.floor(Date.now() / 1000 / TRIGGER_WINDOW_SEC);
  for (const a of await monitoredAccounts()) await evaluate(a.id, { key: `alloc:${window}`, kind: "ALLOCATION_POLL" });
}

/** WebSocket hint: incoming WETH or USDC transfers trigger immediately. Polling remains the source of truth. */
function watchTransfers(accounts: { id: string; address: string }[]) {
  const wsUrl = ctx.chain.id === 8453 ? process.env.BASE_MAINNET_WS_URL : process.env.BASE_SEPOLIA_WS_URL;
  if (!wsUrl || !accounts.length) return () => {};
  const ws = createPublicClient({ chain: ctx.chain, transport: webSocket(wsUrl, { reconnect: { attempts: 1_000, delay: 2_000 } }) });
  const byAddr = new Map(accounts.map((a) => [a.address.toLowerCase(), a.id]));
  const watch = (token: Address, symbol: "WETH" | "USDC", fmt: (v: bigint) => string) => ws.watchContractEvent({
    address: token, abi: erc20Abi, eventName: "Transfer", args: { to: accounts.map((a) => a.address as Address) },
    onLogs: (logs) => { for (const l of logs) {
      const id = byAddr.get(l.args.to!.toLowerCase());
      if (!id) continue;
      void appendAudit(ctx.db, { accountId: id, type: `${symbol}_TRANSFER_DETECTED`, level: "INFO", message: `${symbol} transfer detected: ${fmt(l.args.value!)} from ${l.args.from}`, data: { tx: l.transactionHash, block: l.blockNumber } });
      void evaluate(id, { key: `transfer:${l.transactionHash}:${l.logIndex}`, kind: `${symbol}_TRANSFER`, detail: `${symbol} transfer detected (${fmt(l.args.value!)})` });
    } },
    onError: (e) => log.warn({ err: e.message }, "websocket watcher error (polling continues)"),
  });
  const stops = [watch(ctx.network.weth, "WETH", (v) => `${v} wei`), watch(ctx.network.usdc, "USDC", (v) => `${Number(v) / 1e6} USDC`)];
  return () => { for (const s of stops) s(); };
}

async function main() {
  log.info({ chainId: ctx.chain.id, models: ctx.models.map((m) => m.name), telegram: telegramEnabled }, "worker starting");
  await reconcile(ctx); // recover in-flight operations before accepting new work
  let unwatch = watchTransfers(await monitoredAccounts());
  let lastAccounts = "";
  while (!stopping) {
    const accounts = await monitoredAccounts();
    const sig = accounts.map((a) => a.id).sort().join(",");
    if (sig !== lastAccounts) { unwatch(); unwatch = watchTransfers(accounts); lastAccounts = sig; }
    await tick();
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  unwatch();
  await ctx.close();
  log.info("worker stopped");
  process.exit(0); // WebSocket/RPC handles would otherwise keep the process alive
}

let signals = 0;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {
  stopping = true;
  if (++signals > 1) { log.warn("forced exit"); process.exit(1); }
  log.info("stopping after current tick");
});
main().catch((e) => { log.fatal({ err: (e as Error).message }, "worker crashed"); process.exit(1); });
