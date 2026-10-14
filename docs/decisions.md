# Parameter Decisions

Values the plan required to be defined before implementation. **Owner** entries were chosen by the project owner on 2026-10-14. **Engineering** entries were set during the build with the rationale given; all are configurable in `packages/policy/src/config.ts`.

| # | Parameter | Value | Source | Rationale |
| --- | --- | --- | --- | --- |
| D1 | Daily budget window | UTC calendar day (resets at 00:00 UTC) | Owner | Simple to audit and display |
| D2 | DEX vs. oracle price divergence | Per network. Mainnet: 2%. Base Sepolia: 200% | Owner (policy); Engineering (values) | Sepolia pools were observed at about +105% (fee 3000). Every testnet action is labeled `TESTNET_PRICING` |
| D3 | Session reauthorization | When the WETH reference price rises **10%** above the authorization price, the state becomes `SESSION_REAUTH_REQUIRED` | Owner | This is below the 15% compile buffer, so the on-chain cap is still worth ≤ $10 when reauthorization triggers |
| D4 | Risk weights | Liquidity 0.30, slippage/divergence 0.30, size 0.20, protocol 0.10, token 0.10 | Owner | Protocol and token risk are static for the allowlisted pair |
| E1 | Risk component scores (0–100, clamped) | Liquidity = 100 × (amountIn / pool WETH reserve) / 2%. Divergence = 100 × divergence / network threshold. Size = 100 × requestedUsd / dailyBudgetUsd. Protocol = 10 (verified Uniswap v3 router). Token = 10, or 100 if USDC/USD deviates from $1 by more than 2% | Engineering | Each component reaches 100 at the level where the action should not be autonomous |
| E2 | Hard gates (reject regardless of score) | Stale or invalid oracle data; divergence above the network threshold; USDC depeg above 2%; L2 sequencer down (mainnet) | Engineering | A weighted score must not average away a disqualifying condition |
| E3 | Oracle freshness (max age) | ETH/USD: 3,600 s. USDC/USD: 90,000 s | Engineering | Sepolia USDC/USD was observed about 21 h old (24 h heartbeat) |
| E4 | Quote freshness | 30 s, revalidated before signing | Engineering | About 15 Base blocks |
| E5 | Cooldown after a confirmed rebalance | 10 min | Engineering | Lets balances settle and prevents repeated triggers |
| E6 | Session limits | `maxOps` = 2, buffer 15%, gas allowance 0.01 ETH, duration 24 h | Plan / Engineering | Matches the plan's example values |
