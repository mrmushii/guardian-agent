import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { paperPositions } from "@guardian/db";
import { assessMulti, type Leg } from "@guardian/portfolio";
import { portfolioTargets, type HumanPolicy } from "@guardian/policy";
import type { EngineContext } from "./context.js";
import { holdings, type ResolvedAsset } from "./assets.js";

const HUB = "USDC";
const toCents = (raw: bigint, decimals: number, priceUsd: number) => BigInt(Math.floor((Number(raw) / 10 ** decimals) * priceUsd * 100));
const fromCents = (cents: bigint, decimals: number, priceUsd: number) => BigInt(Math.floor((Number(cents) / 100 / priceUsd) * 10 ** decimals));

/** Simulated positions (raw units). The USDC entry is real USDC notionally committed to them. */
export async function paperBook(ctx: EngineContext, accountId: string) {
  const rows = await ctx.db.select().from(paperPositions).where(and(eq(paperPositions.accountId, accountId), eq(paperPositions.chainId, ctx.chain.id)));
  return new Map(rows.map((r) => [r.symbol, BigInt(r.qtyRaw)]));
}

async function setPaper(ctx: EngineContext, accountId: string, symbol: string, qtyRaw: bigint) {
  await ctx.db.insert(paperPositions).values({ accountId, chainId: ctx.chain.id, symbol, qtyRaw: `${qtyRaw}` })
    .onConflictDoUpdate({ target: [paperPositions.accountId, paperPositions.chainId, paperPositions.symbol], set: { qtyRaw: `${qtyRaw}`, updatedAt: new Date() } });
}

export type MultiRow = ResolvedAsset & { realRaw: bigint; paperRaw: bigint; usdCents: bigint; targetPct: number };

/**
 * The whole portfolio for a v3 policy: real balances of every listed asset plus simulated positions, with the USDC
 * committed to simulated buys removed from the real USDC. Missing prices fail closed (the asset cannot be valued).
 */
export async function multiPortfolio(ctx: EngineContext, accountId: string, account: Address, policy: HumanPolicy) {
  const t = portfolioTargets(policy);
  const [h, book] = await Promise.all([holdings(ctx, accountId, account), paperBook(ctx, accountId)]);
  const rows: MultiRow[] = [];
  for (const a of h.assets) {
    const targetPct = t.assets.find((x) => x.symbol === a.symbol)?.targetPct;
    const realRaw = BigInt(a.balanceRaw), paperRaw = a.symbol === HUB ? -(book.get(HUB) ?? 0n) : (book.get(a.symbol) ?? 0n);
    if (targetPct === undefined && realRaw === 0n && paperRaw === 0n) continue;
    if (a.priceUsd == null) throw new Error(`No price for ${a.symbol}: cannot value the portfolio`);
    rows.push({ ...a, realRaw, paperRaw, targetPct: targetPct ?? 0, usdCents: toCents(realRaw + paperRaw, a.decimals, a.priceUsd) });
  }
  for (const x of t.assets) if (!rows.some((r) => r.symbol === x.symbol)) throw new Error(`${x.symbol} is not available on this network`);
  const assessment = assessMulti(rows.map((r) => ({ symbol: r.symbol, usdCents: r.usdCents > 0n ? r.usdCents : 0n })), t.assets, t.driftPct, { hub: HUB });
  return { rows, assessment, driftPct: t.driftPct };
}

export const describeAllocation = (a: Awaited<ReturnType<typeof multiPortfolio>>) =>
  a.assessment.weights.map((w) => `${w.symbol} ${w.pct.toFixed(1)}% (target ${w.targetPct}%)`).join(", ") + `; drift band ±${a.driftPct} pts`;

/**
 * Simulated fill at the oracle price for an asset that cannot trade on this network. Buys are funded from real USDC
 * not yet committed; sells are limited to the simulated quantity held. Returns the filled amount (possibly smaller).
 */
export async function paperFill(ctx: EngineContext, accountId: string, rows: MultiRow[], leg: Leg, capCents: bigint) {
  const a = rows.find((r) => r.symbol === leg.symbol)!, usdc = rows.find((r) => r.symbol === HUB)!;
  const book = await paperBook(ctx, accountId);
  const committed = book.get(HUB) ?? 0n, held = book.get(a.symbol) ?? 0n;
  let cents = leg.usdCents < capCents ? leg.usdCents : capCents;
  if (leg.side === "BUY") {
    const free = toCents(usdc.realRaw - committed, usdc.decimals, usdc.priceUsd!);
    if (free < cents) cents = free;
    if (cents <= 0n) return { filledCents: 0n, qtyRaw: 0n, reason: "No uncommitted USDC to fund the simulated buy" };
    const qty = fromCents(cents, a.decimals, a.priceUsd!), usdcRaw = fromCents(cents, usdc.decimals, usdc.priceUsd!);
    await setPaper(ctx, accountId, a.symbol, held + qty);
    await setPaper(ctx, accountId, HUB, committed + usdcRaw);
    return { filledCents: cents, qtyRaw: qty, reason: null };
  }
  const heldCents = toCents(held, a.decimals, a.priceUsd!);
  if (heldCents < cents) cents = heldCents;
  if (cents <= 0n) return { filledCents: 0n, qtyRaw: 0n, reason: `No simulated ${a.symbol} to sell (real ${a.symbol} cannot trade on this network)` };
  const qty = cents === heldCents ? held : fromCents(cents, a.decimals, a.priceUsd!), usdcRaw = fromCents(cents, usdc.decimals, usdc.priceUsd!);
  await setPaper(ctx, accountId, a.symbol, held - qty);
  await setPaper(ctx, accountId, HUB, committed - usdcRaw);
  return { filledCents: cents, qtyRaw: qty, reason: null };
}
