// Guardian persistent worker: watch → precheck → (LLM + deterministic pipeline) → reconcile.
import { and, eq } from "drizzle-orm";
import { createPublicClient, erc20Abi, webSocket, type Address } from "viem";
import pino from "pino";
import { appendAudit, policies, smartAccounts, watcherCheckpoints } from "@guardian/db";
import { createEngineContext, housekeeping, loadAccountState, readPortfolio, reconcile, runRebalance, fmtBps } from "@guardian/engine";

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
    const snap = await readPortfolio(ctx, st.account.address as Address, st.policy);
    await ctx.db.insert(watcherCheckpoints).values({ accountId, lastBlock: snap.blockNumber, heartbeatAt: new Date() })
      .onConflictDoUpdate({ target: watcherCheckpoints.accountId, set: { lastBlock: snap.blockNumber, heartbeatAt: new Date() } });
    if (snap.assessment.kind === "WITHIN_BAND") return;
    const weight = fmtBps(snap.assessment.valuation.wethWeightBps);
    const detail = trigger.detail ?? (snap.assessment.kind === "SELL_WETH"
      ? `WETH weight ${weight}% above maximum ${st.policy.ethMaxPct}%` : `WETH weight ${weight}% below minimum ${st.policy.ethMinPct}%`);
    const res = await runRebalance(ctx, accountId, { key: trigger.key, kind: trigger.kind, detail, block: snap.blockNumber });
    log.info({ accountId, trigger: trigger.key, res }, "rebalance evaluated");
  } catch (e) {
    log.error({ accountId, err: (e as Error).message }, "evaluation failed (fail closed)");
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
  log.info({ chainId: ctx.chain.id, models: ctx.models.map((m) => m.name) }, "worker starting");
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
