import { parseAbi, type PublicClient } from "viem";
import type { NetworkConfig } from "@guardian/chain";

/** minOutRaw = floor(quoteOutRaw × (10000 − slippageBps) / 10000). The quote must come from the configured Quoter. */
export function minOutFromQuote(quoteOutRaw: bigint, slippageBps: number): bigint {
  if (quoteOutRaw <= 0n) throw new Error("Quote output must be positive");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error("Invalid slippageBps");
  return (quoteOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
}

const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface SwapQuote {
  amountInWei: bigint;
  amountOutRaw: bigint;
  /** Pool WETH reserve at quote time (liquidity risk input). */
  poolWethReserve: bigint;
  pool: `0x${string}`;
  feeTier: number;
  blockNumber: bigint;
  quotedAt: number;
}

/** Quote for the configured WETH→USDC pool only; callers cannot choose tokens, pool, or router. */
export async function quoteWethToUsdc(client: PublicClient, n: NetworkConfig, amountInWei: bigint): Promise<SwapQuote> {
  if (amountInWei <= 0n) throw new Error("amountIn must be positive");
  const blockNumber = await client.getBlockNumber();
  const [{ result }, poolWethReserve] = await Promise.all([
    client.simulateContract({ address: n.quoterV2, abi: quoterAbi, functionName: "quoteExactInputSingle", blockNumber,
      args: [{ tokenIn: n.weth, tokenOut: n.usdc, amountIn: amountInWei, fee: n.feeTier, sqrtPriceLimitX96: 0n }] }),
    client.readContract({ address: n.weth, abi: erc20Abi, functionName: "balanceOf", args: [n.pool], blockNumber }),
  ]);
  return { amountInWei, amountOutRaw: result[0], poolWethReserve, pool: n.pool, feeTier: n.feeTier, blockNumber, quotedAt: Math.floor(Date.now() / 1000) };
}
