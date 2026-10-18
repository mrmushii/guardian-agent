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

export async function readFeed(client: PublicClient, feed: Address, maxAgeSec: number, now = Math.floor(Date.now() / 1000)): Promise<FeedReading> {
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

const roundAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

export interface RecentMove { rounds: number; spanSec: number; changeBps: number; rangeBps: number }

/**
 * Net change and high–low range of a feed over its last `rounds` rounds (agent context, never a gate).
 * Rounds are walked back within the current phase; missing rounds end the walk. Throws on RPC failure.
 */
export async function recentMove(client: PublicClient, feed: Address, rounds = 24): Promise<RecentMove> {
  const [latestId, latest, , latestAt] = await client.readContract({ address: feed, abi: roundAbi, functionName: "latestRoundData" });
  const ids = Array.from({ length: rounds - 1 }, (_, i) => latestId - BigInt(i + 1));
  const prior = await Promise.all(ids.map((id) => client.readContract({ address: feed, abi: roundAbi, functionName: "getRoundData", args: [id] }).catch(() => null)));
  const points: { answer: bigint; at: bigint }[] = [{ answer: latest, at: latestAt }];
  for (const r of prior) { if (!r || r[1] <= 0n || r[3] === 0n) break; points.push({ answer: r[1], at: r[3] }); }
  const oldest = points[points.length - 1]!;
  const answers = points.map((p) => p.answer);
  const hi = answers.reduce((a, b) => (b > a ? b : a)), lo = answers.reduce((a, b) => (b < a ? b : a));
  return {
    rounds: points.length,
    spanSec: Number(latestAt - oldest.at),
    changeBps: Number(((latest - oldest.answer) * 10_000n) / oldest.answer),
    rangeBps: Number(((hi - lo) * 10_000n) / lo),
  };
}
