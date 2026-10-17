import { erc20Abi, type Address } from "viem";
import { assessRebalance, type RebalanceAssessment } from "@guardian/portfolio";
import { readReferencePrices, type ReferencePrices } from "@guardian/oracle";
import type { HumanPolicy } from "@guardian/policy";
import type { EngineContext } from "./context.js";

export interface PortfolioSnapshot {
  blockNumber: bigint;
  wethWei: bigint;
  usdcRaw: bigint;
  prices: ReferencePrices;
  assessment: RebalanceAssessment;
}

/** Balances and reference prices at one block; fails closed if any input is unavailable or stale. */
export async function readPortfolio(ctx: EngineContext, account: Address, policy: HumanPolicy, opts: { atLeastBlock?: bigint } = {}): Promise<PortfolioSnapshot> {
  const n = ctx.network, c = ctx.publicClient;
  // Load-balanced RPCs can lag a just-included receipt; never value an older block than the caller has seen.
  const head = await c.getBlockNumber();
  const blockNumber = opts.atLeastBlock !== undefined && head < opts.atLeastBlock ? opts.atLeastBlock : head;
  const [wethWei, usdcRaw, prices] = await Promise.all([
    c.readContract({ address: n.weth, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber }),
    c.readContract({ address: n.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber }),
    readReferencePrices(c, n),
  ]);
  const assessment = assessRebalance({ wethWei, usdcRaw, wethUsd: prices.wethUsd, usdcUsd: prices.usdcUsd }, policy);
  return { blockNumber, wethWei, usdcRaw, prices, assessment };
}

/** Rounds UP, so cap/budget comparisons are conservative. */
export const usd18ToCents = (v: bigint) => (v + 10n ** 16n - 1n) / 10n ** 16n;
export const fmtUsd18 = (v: bigint) => (Number(v / 10n ** 12n) / 1e6).toFixed(4);
export const fmtBps = (v: bigint) => (Number(v) / 100).toFixed(2);
