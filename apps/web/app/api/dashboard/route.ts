import { desc, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { agentActions, dailyUsedCents, transactions, userOperations, utcDay } from "@guardian/db";
import { GUARDIAN_CONFIG, portfolioTargets } from "@guardian/policy";
import { agentOpsInWindow, agentOpsUsed, isTwoWay, loadAccountState, pendingSignatures, readPortfolio, sessionStatus, fmtBps, fmtUsd18, explorerTx, walletBBalances, multiPortfolio, loadSessions } from "@guardian/engine";
import { json, requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Demo wallet balances change only when a simulation runs; cache briefly so the 4 s poll stays cheap. */
let demoCache: { at: number; value: Awaited<ReturnType<typeof walletBBalances>> } | null = null;
async function demoBalances(ctx: Parameters<typeof walletBBalances>[0], fresh = false) {
  if (!fresh && demoCache && Date.now() - demoCache.at < 30_000) return demoCache.value;
  const value = await walletBBalances(ctx).catch(() => null);
  demoCache = { at: Date.now(), value };
  return value;
}

export const GET = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const st = await loadAccountState(ctx, account.id);
  let portfolio: Record<string, unknown> | { error: string };
  try {
    const s = await readPortfolio(ctx, account.address as Address, st.policy!);
    const v = s.assessment.valuation;
    portfolio = { block: s.blockNumber, wethWei: s.wethWei, usdcRaw: s.usdcRaw, wethUsd: fmtUsd18(v.wethUsd18), usdcUsd: fmtUsd18(v.usdcUsd18),
      totalUsd: fmtUsd18(v.totalUsd18), wethWeightPct: Number(fmtBps(v.wethWeightBps)), assessment: s.assessment.kind,
      ethUsd: Number(s.prices.wethUsd.answer) / 10 ** s.prices.wethUsd.decimals, ethUsdAgeSec: s.prices.wethUsd.ageSec };
  } catch (e) { portfolio = { error: (e as Error).message.split("\n")[0]! }; }

  let multi: Record<string, unknown> | null = null;
  if (st.policy && portfolioTargets(st.policy).multi) {
    try {
      const mp = await multiPortfolio(ctx, account.id, account.address as Address, st.policy);
      multi = { totalUsd: (Number(mp.assessment.totalCents) / 100).toFixed(2), drifted: mp.assessment.drifted, driftPct: mp.driftPct,
        weights: mp.assessment.weights.map((w) => ({ ...w, status: mp.rows.find((r) => r.symbol === w.symbol)?.status ?? null })),
        legs: mp.assessment.legs.map((l) => ({ symbol: l.symbol, side: l.side, usd: (Number(l.usdCents) / 100).toFixed(2) })) };
    } catch (e) { multi = { error: (e as Error).message.split(String.fromCharCode(10))[0] }; }
  }
  const sessions = (await loadSessions(ctx, account.id)).map((x) => ({ asset: x.session.asset, status: x.session.status, permissionId: x.session.permissionId, validUntil: x.session.validUntil }));
  const onChain = await sessionStatus(ctx, st.account, st.session, st.compilation).catch(() => "UNKNOWN");
  const actions = await ctx.db.select().from(agentActions).where(eq(agentActions.accountId, account.id)).orderBy(desc(agentActions.createdAt)).limit(30);
  const outcomes = await ctx.db.select({ state: agentActions.state, tier: agentActions.tier, n: sql<number>`count(*)::int` }).from(agentActions)
    .where(eq(agentActions.accountId, account.id)).groupBy(agentActions.state, agentActions.tier);
  const ops = await ctx.db.select({ op: userOperations, tx: transactions }).from(userOperations)
    .leftJoin(transactions, eq(transactions.userOperationId, userOperations.id)).where(eq(userOperations.accountId, account.id)).orderBy(desc(userOperations.createdAt)).limit(20);
  const opsUsed = st.session ? await agentOpsUsed(ctx, account.address as Address, st.session.permissionId).catch(() => null) : null;
  const twoWay = isTwoWay(st.compilation);
  const opsInWindow = st.session && twoWay && st.compilation?.windowSec ? await agentOpsInWindow(ctx, st.session.id, st.compilation.windowSec).catch(() => null) : null;
  const count = (states: string[], tier?: string) => outcomes.filter((o) => states.includes(o.state) && (!tier || o.tier === tier)).reduce((n, o) => n + o.n, 0);

  return json({
    network: { chainId: ctx.chain.id, name: ctx.chain.name, isTestnet: ctx.network.isTestnet },
    identities: { masterOwner: account.ownerAddress, smartAccount: account.address, entryPoint: account.entryPoint, kernelVersion: account.kernelVersion,
      sessionSigner: st.session?.signerAddress ?? null },
    monitoring: { enabled: account.monitoringEnabled, pausedReason: account.pausedReason },
    policy: st.policy,
    policyVersion: st.policyRow?.version ?? null,
    multi,
    sessions,
    // The owner saved limits that the on-chain permission does not have yet: they must sign a new authorization.
    policyAheadOfSession: !!(st.session && st.policyRow && st.session.policyId !== st.policyRow.id),
    agent: { models: ctx.models.map((m) => m.name) },
    demo: ctx.network.isTestnet ? { enabled: !!process.env.TESTNET_WALLET_B_PRIVATE_KEY, walletB: await demoBalances(ctx, new URL(req.url).searchParams.has("fresh")) } : { enabled: false, walletB: null },
    session: st.session && { id: st.session.id, status: st.session.status, onChain, permissionId: st.session.permissionId, validUntil: st.session.validUntil,
      authorizeUserOpHash: st.session.authorizeUserOpHash },
    compiled: st.compilation && { permissionVersion: st.compilation.permissionVersion, twoWay, maxAmountInWei: st.compilation.maxAmountInWei,
      maxUsdcInRaw: st.compilation.maxUsdcInRaw, windowSec: st.compilation.windowSec, opsInWindow, maxOps: st.compilation.maxOps, opsUsed,
      allowanceWei: st.compilation.allowanceWei, authPrice: Number(st.compilation.authPriceAnswer) / 10 ** st.compilation.authPriceDecimals,
      bufferBps: st.compilation.bufferBps, reauthAtPrice: (Number(st.compilation.authPriceAnswer) / 10 ** st.compilation.authPriceDecimals) * (1 + GUARDIAN_CONFIG.reauthPriceRiseBps / 10_000) },
    budget: { day: utcDay(), usedCents: await dailyUsedCents(ctx.db, account.id), budgetCents: st.policy ? Math.round(st.policy.dailyBudgetUsd * 100) : 0 },
    portfolio,
    actions: actions.map((a) => ({ id: a.id, state: a.state, tier: a.tier, reasons: a.reasons, decision: a.decision, plan: a.plan, requestedUsdCents: a.requestedUsdCents,
      createdAt: a.createdAt, updatedAt: a.updatedAt, error: a.error, trigger: a.trigger })),
    outcomes: {
      agentConfirmed: count(["CONFIRMED"], "TIER1_AGENT"),
      masterConfirmed: count(["CONFIRMED"], "TIER2_MASTER"),
      waiting: count(["PENDING_APPROVAL", "REVALIDATING", "MASTER_SIGNING"]),
      blocked: count(["REJECTED"]),
      stopped: count(["FAILED", "EXECUTION_FAILED", "CANCELLED"]),
      noAction: count(["NO_ACTION", "WAIT"]),
    },
    operations: ops.map(({ op, tx }) => ({ id: op.id, actionId: op.actionId, authority: op.authority, purpose: op.purpose, state: op.state, userOpHash: op.userOpHash,
      createdAt: op.createdAt, transactionHash: tx?.transactionHash ?? null, block: tx?.blockNumber ?? null, outerSuccess: tx?.outerSuccess ?? null,
      userOpSuccess: tx?.userOpSuccess ?? null, explorer: tx ? explorerTx(ctx, tx.transactionHash) : null, bundlerResult: op.bundlerResult })),
    pendingSignatures: await pendingSignatures(ctx, account.id),
  });
});
