import { desc, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { agentActions, dailyUsedCents, transactions, userOperations, utcDay } from "@guardian/db";
import { GUARDIAN_CONFIG } from "@guardian/policy";
import { loadAccountState, pendingSignatures, readPortfolio, sessionStatus, fmtBps, fmtUsd18, explorerTx } from "@guardian/engine";
import { json, requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
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

  const onChain = await sessionStatus(ctx, st.account, st.session, st.compilation).catch(() => "UNKNOWN");
  const actions = await ctx.db.select().from(agentActions).where(eq(agentActions.accountId, account.id)).orderBy(desc(agentActions.createdAt)).limit(30);
  const outcomes = await ctx.db.select({ state: agentActions.state, n: sql<number>`count(*)::int` }).from(agentActions).where(eq(agentActions.accountId, account.id)).groupBy(agentActions.state);
  const ops = await ctx.db.select({ op: userOperations, tx: transactions }).from(userOperations)
    .leftJoin(transactions, eq(transactions.userOperationId, userOperations.id)).where(eq(userOperations.accountId, account.id)).orderBy(desc(userOperations.createdAt)).limit(20);
  const agentOpsUsed = ops.filter((o) => o.op.authority === "AGENT_SESSION" && o.op.sessionId === st.session?.id && o.tx?.userOpSuccess !== undefined && o.op.state === "INCLUDED").length;

  return json({
    network: { chainId: ctx.chain.id, name: ctx.chain.name, isTestnet: ctx.network.isTestnet },
    identities: { masterOwner: account.ownerAddress, smartAccount: account.address, entryPoint: account.entryPoint, kernelVersion: account.kernelVersion,
      sessionSigner: st.session?.signerAddress ?? null },
    monitoring: { enabled: account.monitoringEnabled, pausedReason: account.pausedReason },
    policy: st.policy,
    session: st.session && { id: st.session.id, status: st.session.status, onChain, permissionId: st.session.permissionId, validUntil: st.session.validUntil,
      authorizeUserOpHash: st.session.authorizeUserOpHash },
    compiled: st.compilation && { maxAmountInWei: st.compilation.maxAmountInWei, maxOps: st.compilation.maxOps, opsUsed: agentOpsUsed,
      allowanceWei: st.compilation.allowanceWei, authPrice: Number(st.compilation.authPriceAnswer) / 10 ** st.compilation.authPriceDecimals,
      bufferBps: st.compilation.bufferBps, reauthAtPrice: (Number(st.compilation.authPriceAnswer) / 10 ** st.compilation.authPriceDecimals) * (1 + GUARDIAN_CONFIG.reauthPriceRiseBps / 10_000) },
    budget: { day: utcDay(), usedCents: await dailyUsedCents(ctx.db, account.id), budgetCents: st.policy ? Math.round(st.policy.dailyBudgetUsd * 100) : 0 },
    portfolio,
    actions: actions.map((a) => ({ id: a.id, state: a.state, tier: a.tier, reasons: a.reasons, decision: a.decision, plan: a.plan, requestedUsdCents: a.requestedUsdCents,
      createdAt: a.createdAt, updatedAt: a.updatedAt, error: a.error, trigger: a.trigger })),
    outcomes: Object.fromEntries(outcomes.map((o) => [o.state, o.n])),
    operations: ops.map(({ op, tx }) => ({ id: op.id, actionId: op.actionId, authority: op.authority, purpose: op.purpose, state: op.state, userOpHash: op.userOpHash,
      createdAt: op.createdAt, transactionHash: tx?.transactionHash ?? null, block: tx?.blockNumber ?? null, outerSuccess: tx?.outerSuccess ?? null,
      userOpSuccess: tx?.userOpSuccess ?? null, explorer: tx ? explorerTx(ctx, tx.transactionHash) : null, bundlerResult: op.bundlerResult })),
    pendingSignatures: await pendingSignatures(ctx, account.id),
  });
});
