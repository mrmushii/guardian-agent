import { and, eq } from "drizzle-orm";
import { erc20Abi, getAddress, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { ASSETS, HUB_SYMBOL, type AssetDef } from "@guardian/chain";
import { customAssets } from "@guardian/db";
import { readFeed } from "@guardian/oracle";
import type { EngineContext } from "./context.js";

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)"]);
const feedAbi = parseAbi(["function description() view returns (string)"]);
const FEE_TIERS = [100, 500, 3000, 10000];

/** VERIFIED: tradable on-chain. PAPER: priced by a fresh feed, simulated only. REJECTED/UNAVAILABLE: not usable here. */
export type AssetStatus = "VERIFIED" | "PAPER" | "REJECTED" | "UNAVAILABLE";
export type Check = { id: "token" | "feed" | "pool" | "quote"; ok: boolean; detail: string };
export interface ResolvedAsset {
  symbol: string; name: string; decimals: number; kind: "stable" | "volatile"; hub: boolean; custom: boolean;
  token: Address | null; feed: Address | null; feeTier: number | null; pool: Address | null; maxFeedAgeSec: number;
  status: AssetStatus; checks: Check[]; priceUsd: number | null; verifiedAt: string;
}

/**
 * On-chain verification of one asset on the engine's network: ERC-20 metadata, a fresh Chainlink USD feed,
 * a USDC pool with liquidity, and a $1 USDC → asset → USDC quote round trip. Read-only.
 */
export async function verifyAsset(ctx: EngineContext, a: { symbol?: string; token?: Address | null; feed?: Address | null; feeTier?: number | null; maxFeedAgeSec?: number; decimals?: number; hub?: boolean }) {
  const c = ctx.publicClient, n = ctx.network;
  const checks: Check[] = [];
  let symbol = a.symbol ?? "?", name = symbol, decimals = a.decimals ?? 18, priceUsd: number | null = null, feeTier = a.feeTier ?? null, usablePool: Address | null = null;

  if (a.token) {
    try {
      const [s, d, nm] = await Promise.all([
        c.readContract({ address: a.token, abi: erc20Abi, functionName: "symbol" }),
        c.readContract({ address: a.token, abi: erc20Abi, functionName: "decimals" }),
        c.readContract({ address: a.token, abi: erc20Abi, functionName: "name" }).catch(() => ""),
      ]);
      symbol = s; decimals = d; name = nm || s;
      checks.push({ id: "token", ok: true, detail: `${s}, ${d} decimals` });
    } catch { checks.push({ id: "token", ok: false, detail: "Not an ERC-20 token on this network" }); }
  } else checks.push({ id: "token", ok: false, detail: "No token deployed on this network" });

  if (a.feed) {
    try {
      const [r, desc] = await Promise.all([readFeed(c, a.feed, a.maxFeedAgeSec ?? 3600), c.readContract({ address: a.feed, abi: feedAbi, functionName: "description" })]);
      priceUsd = Number(r.answer) / 10 ** r.decimals;
      const usdPair = /\/\s*USD$/i.test(desc);
      checks.push({ id: "feed", ok: usdPair, detail: usdPair ? `${desc} = $${priceUsd.toLocaleString(undefined, { maximumFractionDigits: 4 })}, ${r.ageSec}s old` : `${desc} is not a USD feed` });
      if (!usdPair) priceUsd = null;
    } catch (e) { checks.push({ id: "feed", ok: false, detail: (e as Error).message.split("\n")[0]!.slice(0, 160) }); }
  } else checks.push({ id: "feed", ok: false, detail: "No Chainlink USD feed on this network" });

  if (a.hub) checks.push({ id: "pool", ok: true, detail: "USDC is the hub asset" }, { id: "quote", ok: true, detail: "Not traded against itself" });
  else if (a.token && checks[0]!.ok) {
    let pool: Address = zeroAddress, liq = 0n;
    for (const fee of feeTier ? [feeTier] : FEE_TIERS) {
      const p = await c.readContract({ address: n.uniswapV3Factory, abi: factoryAbi, functionName: "getPool", args: [a.token, n.usdc, fee] });
      if (p === zeroAddress) continue;
      const l = await c.readContract({ address: p, abi: poolAbi, functionName: "liquidity" });
      if (l > liq) { pool = p; liq = l; feeTier = fee; }
    }
    if (liq > 0n) usablePool = pool;
    checks.push({ id: "pool", ok: liq > 0n, detail: pool === zeroAddress ? "No USDC pool" : liq > 0n ? `USDC pool ${feeTier! / 10_000}% fee` : "USDC pool has no liquidity" });
    if (liq > 0n) {
      try {
        const q = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => c.simulateContract({ address: n.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee: feeTier!, sqrtPriceLimitX96: 0n }] }).then((r) => r.result[0]);
        const got = await q(n.usdc, a.token, 1_000_000n);
        const back = got > 0n ? await q(a.token, n.usdc, got) : 0n;
        // Usable pool: a $1 round trip keeps ≥ 90%, and the $1 buys within 10× of the oracle value (testnet pools are off-market, not broken).
        const roundTrip = Number(back) / 1e6;
        const vsOracle = priceUsd ? (Number(got) / 10 ** decimals) * priceUsd : null;
        const ok = got > 0n && roundTrip >= 0.9 && (vsOracle === null || (vsOracle >= 0.1 && vsOracle <= 10));
        const trip = `$1 → ${(Number(got) / 10 ** decimals).toPrecision(4)} ${symbol} → $${roundTrip.toFixed(2)}`;
        checks.push({ id: "quote", ok, detail: got === 0n ? "Pool cannot fill a $1 swap"
          : roundTrip < 0.9 ? `${trip}: pool too thin (loses ${((1 - roundTrip) * 100).toFixed(0)}% on $1)`
          : !ok ? `${trip}: pool price is ${vsOracle!.toExponential(1)}× the oracle — unusable`
          : `${trip}${n.isTestnet ? " (testnet pool, not market-priced)" : ""}` });
      } catch { checks.push({ id: "quote", ok: false, detail: "Pool cannot fill a $1 swap" }); }
    } else checks.push({ id: "quote", ok: false, detail: "Skipped (no liquidity)" });
  } else checks.push({ id: "pool", ok: false, detail: "Skipped (no token)" }, { id: "quote", ok: false, detail: "Skipped (no token)" });

  const ok = (id: Check["id"]) => checks.find((x) => x.id === id)?.ok;
  const status: AssetStatus = ok("token") && ok("feed") && ok("pool") && ok("quote") ? "VERIFIED" : ok("feed") ? "PAPER" : a.token || a.feed ? "REJECTED" : "UNAVAILABLE";
  return { symbol, name, decimals, feeTier, pool: usablePool, priceUsd, status, checks };
}

const cache = new Map<string, { at: number; value: ResolvedAsset }>();
const TTL = 10 * 60_000;

async function resolve(ctx: EngineContext, key: string, def: Parameters<typeof verifyAsset>[1] & { name: string; kind: "stable" | "volatile"; custom: boolean }, fresh: boolean) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;
  const v = await verifyAsset(ctx, def);
  const value: ResolvedAsset = {
    symbol: def.symbol ?? v.symbol, name: def.custom ? v.name : def.name, decimals: v.decimals, kind: def.kind, hub: !!def.hub, custom: def.custom,
    token: def.token ?? null, feed: def.feed ?? null, feeTier: v.feeTier, pool: v.pool, maxFeedAgeSec: def.maxFeedAgeSec ?? 3600,
    status: v.status, checks: v.checks, priceUsd: v.priceUsd, verifiedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Built-in registry plus the owner's custom tokens, each verified on this network (cached 10 min). */
export async function listAssets(ctx: EngineContext, accountId: string, fresh = false): Promise<ResolvedAsset[]> {
  const chainId = ctx.chain.id;
  const builtIn = ASSETS.map((d: AssetDef) => {
    const dep = d.deployments[chainId] ?? {};
    return resolve(ctx, `${chainId}:${d.symbol}`, { symbol: d.symbol, name: d.name, decimals: d.decimals, kind: d.kind, hub: d.hub, custom: false,
      token: dep.token, feed: dep.feed, feeTier: dep.feeTier, maxFeedAgeSec: dep.maxFeedAgeSec }, fresh);
  });
  const rows = await ctx.db.select().from(customAssets).where(and(eq(customAssets.accountId, accountId), eq(customAssets.chainId, chainId)));
  const custom = rows.map((r) => resolve(ctx, `${chainId}:custom:${r.token}`, { symbol: r.symbol, name: r.name, decimals: r.decimals, kind: r.kind as "stable" | "volatile",
    custom: true, token: r.token as Address, feed: r.feed as Address | null, feeTier: r.feeTier, maxFeedAgeSec: r.kind === "stable" ? 25 * 3600 : 3600 }, fresh));
  return Promise.all([...builtIn, ...custom]);
}

/** Owner adds a token by address (and optionally its USD feed). Verified before it is stored; rejected tokens are not saved. */
export async function addCustomAsset(ctx: EngineContext, accountId: string, input: { token: string; feed?: string; kind?: "stable" | "volatile" }) {
  if (!isAddress(input.token)) throw new Error("Enter a valid token address (0x…)");
  if (input.feed && !isAddress(input.feed)) throw new Error("The price feed must be an address (0x…)");
  const token = getAddress(input.token), feed = input.feed ? getAddress(input.feed) : null;
  if (ASSETS.some((a) => a.deployments[ctx.chain.id]?.token?.toLowerCase() === token.toLowerCase())) throw new Error("This token is already in the built-in list");
  const kind = input.kind ?? "volatile";
  const v = await verifyAsset(ctx, { token, feed, maxFeedAgeSec: kind === "stable" ? 25 * 3600 : 3600 });
  if (v.status === "REJECTED" || v.status === "UNAVAILABLE") return { saved: false as const, ...v };
  await ctx.db.insert(customAssets).values({ accountId, chainId: ctx.chain.id, symbol: v.symbol, name: v.name, token, decimals: v.decimals, feed, feeTier: v.feeTier,
    kind, status: v.status, evidence: v.checks }).onConflictDoUpdate({ target: [customAssets.accountId, customAssets.chainId, customAssets.token],
    set: { feed, feeTier: v.feeTier, status: v.status, evidence: v.checks, verifiedAt: new Date() } });
  cache.delete(`${ctx.chain.id}:custom:${token}`);
  return { saved: true as const, ...v };
}

export async function removeCustomAsset(ctx: EngineContext, accountId: string, token: string) {
  await ctx.db.delete(customAssets).where(and(eq(customAssets.accountId, accountId), eq(customAssets.chainId, ctx.chain.id), eq(customAssets.token, getAddress(token))));
  cache.delete(`${ctx.chain.id}:custom:${getAddress(token)}`);
}

/** Every asset's balance in the account, valued at its feed. Simulated (PAPER) assets show zero on-chain balance. */
export async function holdings(ctx: EngineContext, accountId: string, account: Address, fresh = false) {
  const assets = await listAssets(ctx, accountId, fresh);
  const rows = await Promise.all(assets.map(async (a) => {
    const raw = a.token ? await ctx.publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [account] }).catch(() => 0n) : 0n;
    const balance = Number(raw) / 10 ** a.decimals;
    return { ...a, balanceRaw: `${raw}`, balance, valueUsd: a.priceUsd == null ? null : balance * a.priceUsd };
  }));
  const total = rows.reduce((s, r) => s + (r.valueUsd ?? 0), 0);
  return { totalUsd: total, hub: HUB_SYMBOL, assets: rows.map((r) => ({ ...r, weightPct: total > 0 && r.valueUsd != null ? (r.valueUsd / total) * 100 : 0 })) };
}

/**
 * The engine as seen by one asset/USDC market: the network config with the asset in the "weth" slot, its pool,
 * fee tier and USD feed. Quotes, portfolio reads, swap calls and permission builders then target that asset unchanged.
 */
export function marketFor(ctx: EngineContext, a: Pick<ResolvedAsset, "symbol" | "token" | "feed" | "feeTier" | "pool" | "status">): EngineContext {
  if (a.symbol === "WETH") return ctx;
  if (a.status !== "VERIFIED" || !a.token || !a.feed || !a.feeTier || !a.pool) throw new Error(`${a.symbol} is not tradable on this network`);
  return { ...ctx, network: { ...ctx.network, weth: a.token, feeTier: a.feeTier, pool: a.pool, chainlinkEthUsd: a.feed } };
}

/** Resolved asset by symbol (built-in or the owner's custom tokens). */
export async function assetBySymbolFor(ctx: EngineContext, accountId: string, symbol: string) {
  const a = (await listAssets(ctx, accountId)).find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!a) throw new Error(`Unknown asset ${symbol}`);
  return a;
}
