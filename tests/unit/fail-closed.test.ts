// Verification matrix: dependency outages must fail closed (plan §17).
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { readReferencePrices, OracleError } from "@guardian/oracle";
import { BASE_MAINNET, BASE_SEPOLIA } from "@guardian/chain";
import { decideWithFallback, type AgentContext, type AgentModel } from "@guardian/agent";
import { quoteWethToUsdc } from "@guardian/dex";

const NOW = 1_800_000_000;
type Round = [bigint, bigint, bigint, bigint, bigint];
/** Stub client: per-feed latestRoundData, fixed decimals. */
const feeds = (rounds: Record<string, Round | Error>) => ({
  readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === "decimals") return 8;
    const r = rounds[address.toLowerCase()];
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`no stub for ${address}`);
    return r;
  },
}) as unknown as PublicClient;
const round = (answer: bigint, updatedAt: number, startedAt = updatedAt): Round => [1n, answer, BigInt(startedAt), BigInt(updatedAt), 1n];
const sep = (eth: Round | Error, usdc: Round | Error) => feeds({ [BASE_SEPOLIA.chainlinkEthUsd.toLowerCase()]: eth, [BASE_SEPOLIA.chainlinkUsdcUsd.toLowerCase()]: usdc });
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof OracleError ? e.code : `THROWN:${(e as Error).message}`; } };

describe("oracle fails closed", () => {
  it("accepts fresh, positive prices", async () => {
    const r = await readReferencePrices(sep(round(2_400n * 10n ** 8n, NOW - 60), round(10n ** 8n, NOW - 3_600)), BASE_SEPOLIA, NOW);
    expect(r.wethUsd.answer).toBe(2_400n * 10n ** 8n);
  });
  it("rejects a stale ETH/USD price", async () =>
    expect(await code(readReferencePrices(sep(round(2_400n * 10n ** 8n, NOW - 3_601), round(10n ** 8n, NOW)), BASE_SEPOLIA, NOW))).toBe("STALE"));
  it("rejects a non-positive answer", async () =>
    expect(await code(readReferencePrices(sep(round(0n, NOW), round(10n ** 8n, NOW)), BASE_SEPOLIA, NOW))).toBe("INVALID"));
  it("propagates an RPC outage instead of guessing", async () =>
    expect(await code(readReferencePrices(sep(new Error("RPC down"), round(10n ** 8n, NOW)), BASE_SEPOLIA, NOW))).toBe("THROWN:RPC down"));
  it("mainnet: rejects while the L2 sequencer is down or in its grace period", async () => {
    const m = (seq: Round) => feeds({ [BASE_MAINNET.sequencerUptimeFeed!.toLowerCase()]: seq,
      [BASE_MAINNET.chainlinkEthUsd.toLowerCase()]: round(2_400n * 10n ** 8n, NOW), [BASE_MAINNET.chainlinkUsdcUsd.toLowerCase()]: round(10n ** 8n, NOW) });
    expect(await code(readReferencePrices(m(round(1n, NOW, NOW - 10_000)), BASE_MAINNET, NOW))).toBe("SEQUENCER_DOWN");
    expect(await code(readReferencePrices(m(round(0n, NOW, NOW - 600)), BASE_MAINNET, NOW))).toBe("SEQUENCER_GRACE");
    expect(await code(readReferencePrices(m(round(0n, NOW, NOW - 10_000)), BASE_MAINNET, NOW))).toBe("OK");
  });
});

describe("LLM outage fails closed", () => {
  const ctx: AgentContext = { trigger: { kind: "T", detail: "d" }, portfolio: { wethUsd: "21.25", usdcUsd: "10", totalUsd: "31.25", wethWeightPct: "68" },
    policy: { ethMinPct: 45, ethMaxPct: 55, targetEthPct: 53, maxAutoTxUsd: 10, dailyBudgetUsd: 25 }, recentOutcomes: [] };
  const bounds = { ethMinPct: 45, ethMaxPct: 55, maxWaitMinutes: 60 };
  const model = (name: string, fn: () => Promise<unknown>): AgentModel => ({ name, decide: fn });
  const ok = model("good", async () => ({ decision: "REBALANCE", targetWethWeight: 0.53, reason: "above band" }));
  it("falls back when the primary provider errors", async () => {
    const r = await decideWithFallback([model("down", async () => { throw new Error("HTTP 503"); }), ok], ctx, bounds);
    expect(r.ok && r.provider).toBe("good");
  });
  it("falls back when the primary returns invalid output", async () => {
    const r = await decideWithFallback([model("bad", async () => ({ decision: "TRANSFER", to: "0xattacker", reason: "x" })), ok], ctx, bounds);
    expect(r.ok).toBe(true);
  });
  it("returns no decision when every provider fails (caller pauses autonomy)", async () => {
    const r = await decideWithFallback([model("a", async () => { throw new Error("timeout"); }), model("b", async () => ({ decision: "REBALANCE", targetWethWeight: 0.9, reason: "x" }))], ctx, bounds);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toHaveLength(2);
  });
});

describe("quote outage fails closed", () => {
  it("throws rather than returning a fabricated quote", async () => {
    const client = { getBlockNumber: async () => 1n, simulateContract: async () => { throw new Error("Quoter reverted"); }, readContract: async () => 10n ** 18n } as unknown as PublicClient;
    await expect(quoteWethToUsdc(client, BASE_SEPOLIA, 10n ** 15n)).rejects.toThrow("Quoter reverted");
  });
  it("refuses a non-positive amount", async () => {
    await expect(quoteWethToUsdc({} as PublicClient, BASE_SEPOLIA, 0n)).rejects.toThrow();
  });
});
