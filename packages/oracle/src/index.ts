import { parseAbi, type Address, type PublicClient } from "viem";
import type { NetworkConfig } from "@guardian/chain";
import { GUARDIAN_CONFIG, type UsdPrice } from "@guardian/policy";

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

export interface FeedReading extends UsdPrice { feed: Address; updatedAt: number; ageSec: number }

export class OracleError extends Error {
  constructor(public code: "STALE" | "INVALID" | "SEQUENCER_DOWN" | "SEQUENCER_GRACE", message: string) { super(message); }
}

async function readFeed(client: PublicClient, feed: Address, maxAgeSec: number, now: number): Promise<FeedReading> {
  const [decimals, [, answer, , updatedAt]] = await Promise.all([
    client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
    client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
  ]);
  if (answer <= 0n) throw new OracleError("INVALID", `Feed ${feed} returned non-positive answer`);
  const ageSec = now - Number(updatedAt);
  if (updatedAt === 0n || ageSec > maxAgeSec) throw new OracleError("STALE", `Feed ${feed} is ${ageSec}s old (max ${maxAgeSec}s)`);
  return { feed, answer, decimals, updatedAt: Number(updatedAt), ageSec };
}

/** On L2 mainnet, prices are unusable while the sequencer is down or within the grace period after recovery. */
async function assertSequencerUp(client: PublicClient, feed: Address, now: number) {
  const [, answer, startedAt] = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
  if (answer !== 0n) throw new OracleError("SEQUENCER_DOWN", "L2 sequencer is down");
  if (now - Number(startedAt) < GUARDIAN_CONFIG.sequencerGracePeriodSec) throw new OracleError("SEQUENCER_GRACE", "L2 sequencer recently recovered");
}

export interface ReferencePrices { wethUsd: FeedReading; usdcUsd: FeedReading; readAt: number }

/** Reference prices for valuation. ETH/USD is the WETH proxy (WETH/ETH parity assumption). Fails closed. */
export async function readReferencePrices(client: PublicClient, n: NetworkConfig, now = Math.floor(Date.now() / 1000)): Promise<ReferencePrices> {
  if (n.sequencerUptimeFeed) await assertSequencerUp(client, n.sequencerUptimeFeed, now);
  const [wethUsd, usdcUsd] = await Promise.all([
    readFeed(client, n.chainlinkEthUsd, GUARDIAN_CONFIG.oracleMaxAgeSec.ethUsd, now),
    readFeed(client, n.chainlinkUsdcUsd, GUARDIAN_CONFIG.oracleMaxAgeSec.usdcUsd, now),
  ]);
  return { wethUsd, usdcUsd, readAt: now };
}
