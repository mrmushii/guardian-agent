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
  session: { maxOps: 2, bufferBps: 1_500, gasAllowanceWei: 10n ** 16n }, // E6
} as const;
