import { parseAbi, type PublicClient } from "viem";
import type { NetworkConfig } from "@guardian/chain";

/** minOutRaw = floor(quoteOutRaw × (10000 − slippageBps) / 10000). The quote must come from the configured Quoter. */
export function minOutFromQuote(quoteOutRaw: bigint, slippageBps: number): bigint {
  if (quoteOutRaw <= 0n) throw new Error("Quote output must be positive");
  assertSlippage(slippageBps);
  return (quoteOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** maxInRaw = ceil(quoteInRaw × (10000 + slippageBps) / 10000): the most the exact-output buy may spend. */
export function maxInFromQuote(quoteInRaw: bigint, slippageBps: number): bigint {
  if (quoteInRaw <= 0n) throw new Error("Quote input must be positive");
  assertSlippage(slippageBps);
  return (quoteInRaw * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

function assertSlippage(bps: number) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("Invalid slippageBps");
}

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface SwapQuote {
  direction: "SELL_WETH" | "BUY_WETH";
  /** WETH leg (wei): sold for a sell, bought for a buy. */
  wethWei: bigint;
  /** USDC leg (raw, 6 dp): quoted output for a sell, quoted input for a buy. */
  usdcRaw: bigint;
  /** Pool reserves at quote time (liquidity risk input). */
  poolWethReserve: bigint;
  poolUsdcReserve: bigint;
  pool: `0x${string}`;
  feeTier: number;
  blockNumber: bigint;
  quotedAt: number;
}

async function reserves(client: PublicClient, n: NetworkConfig, blockNumber: bigint) {
  return Promise.all([n.weth, n.usdc].map((t) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [n.pool], blockNumber })));
}

/** Sell quote for the configured WETH→USDC pool only; callers cannot choose tokens, pool, or router. */
export async function quoteWethToUsdc(client: PublicClient, n: NetworkConfig, amountInWei: bigint): Promise<SwapQuote> {
  if (amountInWei <= 0n) throw new Error("amountIn must be positive");
  const blockNumber = await client.getBlockNumber();
  const [{ result }, [poolWethReserve, poolUsdcReserve]] = await Promise.all([
    client.simulateContract({ address: n.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle", blockNumber,
      args: [{ tokenIn: n.weth, tokenOut: n.usdc, amountIn: amountInWei, fee: n.feeTier, sqrtPriceLimitX96: 0n }] }),
    reserves(client, n, blockNumber),
  ]);
  return { direction: "SELL_WETH", wethWei: amountInWei, usdcRaw: result[0], poolWethReserve: poolWethReserve!, poolUsdcReserve: poolUsdcReserve!,
    pool: n.pool, feeTier: n.feeTier, blockNumber, quotedAt: Math.floor(Date.now() / 1000) };
}

/** Buy quote (exact WETH output) for the configured USDC→WETH pool only. */
export async function quoteUsdcToWeth(client: PublicClient, n: NetworkConfig, wethOutWei: bigint): Promise<SwapQuote> {
  if (wethOutWei <= 0n) throw new Error("amountOut must be positive");
  const blockNumber = await client.getBlockNumber();
  const [{ result }, [poolWethReserve, poolUsdcReserve]] = await Promise.all([
    client.simulateContract({ address: n.quoterV2, abi: quoterAbi, functionName: "quoteExactOutputSingle", blockNumber,
      args: [{ tokenIn: n.usdc, tokenOut: n.weth, amount: wethOutWei, fee: n.feeTier, sqrtPriceLimitX96: 0n }] }),
    reserves(client, n, blockNumber),
  ]);
  return { direction: "BUY_WETH", wethWei: wethOutWei, usdcRaw: result[0], poolWethReserve: poolWethReserve!, poolUsdcReserve: poolUsdcReserve!,
    pool: n.pool, feeTier: n.feeTier, blockNumber, quotedAt: Math.floor(Date.now() / 1000) };
}
