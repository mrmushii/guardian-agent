# Guardian Agent — Security Self-Assessment

> Guardian assumes the LLM, agent software, and backend may fail. Security therefore does not depend solely on their correct behavior. Critical authority boundaries are independently enforced by the smart account's delegated permission system.

**Limitation, stated up front:** the on-chain permission bounds asset access, the token-unit transaction size, the call target, the selector, the recipient, the session duration, the operation count and the gas authority. All of these are verified by tests and testnet transactions. Live USD valuation, the daily USD budget, risk scoring and market quality (slippage, `amountOutMinimum`) are enforced **off-chain** in this MVP.

## Authority tiers

| Tier | Signer | When | On-chain bound |
| --- | --- | --- | --- |
| 1 — Agent | Restricted session key | Every check passes and risk is LOW | Permission policies (below) |
| 2 — Master | Owner wallet (Kernel root) | Valid, but beyond agent authority or needing review | Full account authority, used only after revalidation and the owner's signature |
| 3 — Prohibited | None | Violations, hard gates, HIGH risk | Rejected and audited; never escalated to master automatically |

## What the session key can do

Exactly one function is allowed: `SwapRouter02.exactInputSingle`. The arguments must be WETH → USDC in the configured pool, with the recipient equal to the smart account, `amountIn ≤ 0.00358 WETH`, no price limit and no ETH value. It is valid for 24 hours, allows at most 2 operations in total, requires the approved paymaster, and has a cumulative gas allowance of 0.01 ETH.

**Maximum loss if the session key and backend are fully compromised:** at most 2 × 0.00358 WETH can be sold for USDC at a poor price, with the proceeds still landing in the owner's account. Nothing can be transferred out. This is bounded further by the WETH allowance (cap × 2), which drops to 0 on revocation.

## Verified evidence

| Claim | Method | Result |
| --- | --- | --- |
| Forbidden target, selector, token, fee, recipient, amount, batch, delegatecall | `eth_simulateV1` against deployed contracts; each negative differs from a passing positive by one field | All rejected; causes decoded (`CallViolatesParamRule`, no-permission) |
| Expiry, operation count (session-wide), gas, paymaster | Same; control cases isolate the gas policy | Rejected with `AA22` / `PolicyFailed(2)` / `PolicyFailed(3)` |
| Real bundler rejects forbidden ops signed by the real session key | `eth_sendUserOperation` to Pimlico, application bypassed | 4/4 rejected, no transaction hash |
| Revocation | Master uninstall plus `grantAccess(false)`, then the same key retried | A previously allowed swap is rejected; allowance 0 |
| Execution failure is not authorization failure | Permitted swap with impossible minimum output | Outer transaction success; UserOperation `success=false` ("Too little received") |
| Autonomous Tier 1 swap | Real WETH transfer trigger | Confirmed, block 48112653 |
| Tier 2 needs the master | Sale of $11.57 > $10 | Routed to approval; master-signed, block 48113495 |
| No duplicate execution | 8 concurrent claims; parallel budget reservations | Exactly one claim; budget never exceeded |

All hashes are listed in [execution-evidence.md](execution-evidence.md).

## Known risks and gaps

1. **`amountOutMinimum` is unconstrained on-chain.** A compromised backend could execute up to 2 capped swaps at a bad price. Mitigations: short sessions, a small cap, revocation. A future fix is an oracle-aware execution guard.
2. **USD cap drift.** The token cap is worth more dollars if ETH rises. Reauthorization at +10% (below the 15% buffer) limits this, but between checks it relies on the worker being live.
3. **Testnet pricing.** Base Sepolia pools quote about 2× Chainlink. The testnet divergence threshold (200%) is deliberately relaxed and labeled `TESTNET_PRICING`. Mainnet uses 2%.
4. **Forced on-chain validation failure (E4) not yet produced.** It needs Sepolia ETH for the harness EOA. Bundler-level and simulated on-chain rejections are proven.
5. **Mainnet proof not yet run.** Held until the owner approves real-value testing.
6. **Single LLM provider configured.** The fallback is implemented, but no OpenAI key is set. Provider outages pause autonomy; they do not trigger unsafe behavior.
7. **Key custody.** The session key is decrypted in the worker process. A KMS/HSM signer is future hardening. The master key never reaches the server.
8. **Audit-log integrity.** Database records are not tamper-proof. Chain evidence (UserOperation and transaction hashes) is the authority.

## Claim

AI compromise does not automatically imply unrestricted account compromise. Guardian does not claim the system cannot lose money. It claims that losses are bounded by an authority the agent cannot expand, which only the master can grant or revoke.
