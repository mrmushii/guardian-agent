import type { Address } from "viem";
import { portfolioTargets } from "@guardian/policy";
import { addCustomAsset, holdings, loadAccountState, paperBook, removeCustomAsset } from "@guardian/engine";
import { HttpError, json, requireAccount, route } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Every supported asset with its on-chain verification, the account's real balance, its simulated position, and the
 * owner's target. `?fresh` re-verifies on-chain. Weights include simulated positions (net of committed USDC).
 */
export const GET = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const [h, st, book] = await Promise.all([holdings(ctx, account.id, account.address as Address, new URL(req.url).searchParams.has("fresh")),
    loadAccountState(ctx, account.id), paperBook(ctx, account.id)]);
  const t = st.policy ? portfolioTargets(st.policy) : null;
  const rows = h.assets.map((a) => {
    const paperRaw = a.symbol === "USDC" ? -(book.get("USDC") ?? 0n) : (book.get(a.symbol) ?? 0n);
    const paper = Number(paperRaw) / 10 ** a.decimals;
    const valueUsd = a.priceUsd == null ? null : (a.balance + paper) * a.priceUsd;
    return { ...a, paperBalance: paper, paperValueUsd: a.priceUsd == null ? null : paper * a.priceUsd, valueUsd, targetPct: t?.assets.find((x) => x.symbol === a.symbol)?.targetPct ?? null };
  });
  const total = rows.reduce((s, r) => s + (r.valueUsd ?? 0), 0);
  return json({ totalUsd: total, hub: h.hub, multi: !!t?.multi, driftPct: t?.driftPct ?? null,
    assets: rows.map((r) => ({ ...r, weightPct: total > 0 && r.valueUsd != null ? (r.valueUsd / total) * 100 : 0 })) });
});

/** Add a token by address (verified on-chain before it is saved), or remove a custom token. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  const body = (await req.json().catch(() => ({}))) as { token?: string; feed?: string; kind?: "stable" | "volatile"; remove?: string };
  if (body.remove) { await removeCustomAsset(ctx, account.id, body.remove); return json({ removed: body.remove }); }
  if (!body.token) throw new HttpError(400, "Enter the token address");
  try { return json(await addCustomAsset(ctx, account.id, { token: body.token, feed: body.feed || undefined, kind: body.kind })); }
  catch (e) { throw new HttpError(400, (e as Error).message.split("\n")[0]!); }
});
