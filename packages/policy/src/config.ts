/** Engineering and owner parameters. See docs/decisions.md for each value's source and rationale. */
export interface NetworkRiskConfig {
  /** D2: max |quotePrice − oraclePrice| / oraclePrice, in bps. */
  maxDivergenceBps: number;
}

export const NETWORK_RISK: Record<number, NetworkRiskConfig> = {
  8453: { maxDivergenceBps: 200 },     // mainnet 2%
  84532: { maxDivergenceBps: 20_000 }, // Sepolia 200% (pools not market-priced; labeled TESTNET_PRICING)
};

export const GUARDIAN_CONFIG = {
  reauthPriceRiseBps: 1_000,          // D3
  riskWeights: { liquidity: 0.3, slippage: 0.3, size: 0.2, protocol: 0.1, token: 0.1 }, // D4
  liquidityFullScoreShareBps: 200,    // E1: 2% of pool WETH reserve = score 100
  usdcDepegBps: 200,                  // E1/E2
  staticProtocolScore: 10,
  staticTokenScore: 10,
  oracleMaxAgeSec: { ethUsd: 3_600, usdcUsd: 90_000 }, // E3
  sequencerGracePeriodSec: 3_600,
  quoteMaxAgeSec: 30,                 // E4
  cooldownSec: 600,                   // E5
  // E6 (v2): per-window op count that resets (RateLimitPolicyWithReset, Gate 0 addendum), not a session total.
  session: { maxOpsPerWindow: 6, windowSec: 86_400, bufferBps: 1_500, usdcBufferBps: 200, gasAllowanceWei: 10n ** 16n },
  /** E7: with partial autonomy, a cap-exceeding move up to this multiple of the cap is stepped at Tier 1. */
  partialAutonomyMaxMultiple: 3,
  /** E8: consecutive AI failures before new autonomous actions pause (deterministic fallback before then). */
  aiFailurePauseThreshold: 3,
  /** E9: longest WAIT the agent may request before the next evaluation. */
  maxWaitMinutes: 60,
} as const;
