# Guardian Agent — Security Self-Assessment

> Guardian assumes the LLM, agent software, and backend may fail. Security therefore does not depend solely on their correct behavior. Critical authority boundaries are independently enforced by the smart account's delegated permission system.

**Limitation, stated up front:** the on-chain permission bounds asset access, the token-unit transaction size, the call target, the selector, the recipient, the session duration, the operation count and the gas authority. All of these are verified by tests and testnet transactions. Live USD valuation, the daily USD budget, risk scoring and market quality (slippage, `amountOutMinimum`) are enforced **off-chain** in this MVP.

## Authority tiers

| Tier | Signer | When | On-chain bound |
| --- | --- | --- | --- |
| 1 — Agent | Restricted session key | Every check passes and risk is LOW | Permission policies (below) |
| 2 — Master | Owner wallet (Kernel root) | Valid, but beyond agent authority or needing review | Full account authority, used only after revalidation and the owner's signature |
| 3 — Prohibited | None | Violations, hard gates, HIGH risk | Rejected and audited; never escalated to master automatically |

## What the session key can do (permission v2)

Exactly two functions are allowed, both on `SwapRouter02`, both with the recipient equal to the smart account, the configured pool fee, no price limit and no ETH value:

- **Sell:** `exactInputSingle`, WETH → USDC, `amountIn ≤ ` the compiled WETH cap (about $10 at the authorization price, with a 15% buffer).
- **Buy:** `exactOutputSingle`, USDC → WETH, `amountInMaximum ≤ ` the compiled USDC cap ($10 with a 2% buffer). The most a buy can spend is bound on-chain.

The session lasts 7 days and allows 6 operations per 24 h window (the count resets: `RateLimitPolicyWithReset`). It requires the approved paymaster and has a cumulative gas allowance of 0.01 ETH. Router allowances are bounded at cap × 42 per token and are cleared on revocation.

**Maximum loss if the session key and backend are fully compromised:** up to 6 capped swaps a day between WETH and USDC at a poor price, with every output still landing in the owner's account. Nothing can be transferred out or approved to anyone else. Buys cannot overspend their cap even at a bad price. Sells can accept a bad price (risk 1 below). Revocation stops everything immediately.

## What the AI can and cannot decide

| The agent chooses | Deterministic code / the account decides |
| --- | --- |
| REBALANCE, WAIT (1–60 min), ESCALATE or NO_ACTION | Whether the portfolio is out of band at all |
| A whole-percent target inside the owner's band | The trade size, tokens, pool, recipient, calldata, gas and signature |
| — | The tier: the agent can only *narrow* it (ESCALATE turns Tier 1 into Tier 2), never widen it |

If no provider returns a valid decision, a rule-based rebalance to the owner's target runs, but only when it is Tier 1 and LOW risk. Otherwise it goes to the master. Three AI failures in a row pause new autonomous actions.

## Verified evidence

| Claim | Method | Result |
| --- | --- | --- |
| Forbidden target, selector, token, fee, recipient, amount, batch, delegatecall | `eth_simulateV1` against deployed contracts; each negative differs from a passing positive by one field | All rejected; causes decoded (`CallViolatesParamRule`, no-permission) |
| Expiry, operation count (session-wide), gas, paymaster | Same; control cases isolate the gas policy | Rejected with `AA22` / `PolicyFailed(2)` / `PolicyFailed(3)` |
| Real bundler rejects forbidden ops signed by the real session key | `eth_sendUserOperation` to Pimlico, application bypassed | v1: 4/4 rejected. v2 (two-way): 8/8 rejected, including buy-side recipient swap, USDC cap + 1, USDC transfer and USDC approve to an attacker. No transaction hash (`evidence/defense-b-bundler-rejections-v2.json`) |
| Two-way permission and resetting window | `eth_simulateV1` against deployed contracts (`scripts/gate0/two-way-harness.ts`) | 19/19 cases as expected (`evidence/gate0-two-way-permissions.json`) |
| Revocation | Master uninstall plus `grantAccess(false)`, then the same key retried | A previously allowed swap is rejected; allowance 0 |
| Execution failure is not authorization failure | Permitted swap with impossible minimum output | Outer transaction success; UserOperation `success=false` ("Too little received") |
| Autonomous Tier 1 swap | Real WETH transfer trigger | Confirmed, block 48112653 |
| Tier 2 needs the master | Sale of $11.57 > $10 | Routed to approval; master-signed, block 48113495 |
| No duplicate execution | 8 concurrent claims; parallel budget reservations | Exactly one claim; budget never exceeded |

All hashes are listed in [execution-evidence.md](execution-evidence.md).

## Known risks and gaps

1. **Sell-side `amountOutMinimum` is unconstrained on-chain.** A compromised backend could execute up to 6 capped sells a day at a bad price. (Buys are bounded by `amountInMaximum` on-chain.) Mitigations: short sessions, a small cap, revocation. A future fix is an oracle-aware execution guard.
2. **USD cap drift.** The token cap is worth more dollars if ETH rises. Reauthorization at +10% (below the 15% buffer) limits this, but between checks it relies on the worker being live.
3. **Testnet pricing.** Base Sepolia pools quote about 2× Chainlink. The testnet divergence threshold (200%) is deliberately relaxed and labeled `TESTNET_PRICING`. Mainnet uses 2%.
4. **Forced on-chain validation failure (E4) not yet produced.** It needs Sepolia ETH for the harness EOA. Bundler-level and simulated on-chain rejections are proven.
5. **Mainnet proof not yet run.** Held until the owner approves real-value testing.
6. **Single LLM provider configured.** The OpenAI fallback is implemented, but no OpenAI key is set. A provider outage falls back to the rule-based Tier 1 rebalance; three in a row pause autonomy. Neither path can widen authority.
9. **Longer exposure window.** A 7-day session with 6 ops/day is more exposure than v1's 2 ops in 24 h. This is the price of unattended operation. The bound is still fixed on-chain and revocable at any time.
10. **Window count shown from the database.** The dashboard's "swaps left this window" comes from recorded operations. The chain enforces the real count, so a mismatch can only cause a bundler rejection (fail closed), never an extra operation.
7. **Key custody.** The session key is decrypted in the worker process. A KMS/HSM signer is future hardening. The master key never reaches the server.
8. **Audit-log integrity.** Database records are not tamper-proof. Chain evidence (UserOperation and transaction hashes) is the authority.

## Claim

AI compromise does not automatically imply unrestricted account compromise. Guardian does not claim the system cannot lose money. It claims that losses are bounded by an authority the agent cannot expand, which only the master can grant or revoke.
