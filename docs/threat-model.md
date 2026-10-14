# Guardian Agent — Threat Model

## Assets
- Funds in the smart account (WETH, USDC).
- Master authority: the owner's EOA, which is the Kernel root validator.
- Agent authority: the session key plus its installed permission.
- Integrity of the audit trail and of owner approvals.

## Trust boundaries

| Component | Trusted for | Not trusted for |
| --- | --- | --- |
| Smart account, EntryPoint, policy contracts | Enforcing delegated authority | — |
| Owner wallet | Master signatures | — |
| LLM provider and its output | Nothing | Amounts, addresses, calldata, gas, signatures, risk |
| Worker / backend | Liveness; off-chain USD, budget and risk checks | Anything beyond the on-chain permission |
| Database | Coordination and audit | Proof of on-chain authority (chain evidence is kept separately) |
| Bundler / paymaster | Submission, sponsorship | Authorization decisions |
| Owner-entered chat text | Nothing (treated as data) | Instructions |

## Threats and mitigations

| # | Threat | Mitigation | Evidence | Residual risk |
| --- | --- | --- | --- | --- |
| T1 | Prompt injection makes the agent move funds | The model chooses only among four decisions; deterministic code builds every transaction; strict schema with unknown fields rejected; target must equal the policy target | Live test: injection → `ESCALATE`; unit tests reject `TRANSFER` and extra fields | None for fund movement: the permission (T3) blocks it independently |
| T2 | Malformed or hallucinated model output | Zod discriminated union; 500-character limit; fallback provider; pause on failure | Unit tests; fail-closed pause | Liveness only |
| T3 | Stolen session key used directly | On-chain call, timestamp, rate-limit and gas policies | Defense B: 4 forbidden ops rejected by the bundler; Gate 0: 20 cases | Within the cap: up to 2 swaps of ≤ 0.00358 WETH each, back into the account, with attacker-chosen `amountOutMinimum` (T4) |
| T4 | Compromised backend accepts bad execution | Off-chain quote, slippage and divergence checks | E8 shows `amountOutMinimum` is not enforced on-chain | **Value can be lost to poor pricing within the token cap.** Bounded by cap × ops |
| T5 | Price rises, so the token cap is worth more than $10 | 15% buffer; reauthorization at +10%; 24 h expiry | Unit test; router `REAUTH_REQUIRED` | Between checks, the cap can be worth up to $10 × 1.10 |
| T6 | Duplicate or concurrent execution | Partial unique index; idempotent triggers; optimistic transitions; atomic budget | Integration tests (8 concurrent claims; parallel budget) | None observed |
| T7 | Lost submission outcome causes double spend | Intent persisted before send; `UNKNOWN` keeps the lock; reconciliation from receipts | Code path; reconciler finalized Scenario 2 | Manual resolution if an op is never seen again |
| T8 | Gas drain through the agent | Gas policy: approved paymaster required; cumulative allowance | Gate 0: no paymaster, foreign paymaster and 1000× gas all rejected | Within 0.01 ETH of sponsored gas |
| T9 | Unlimited approval abuse | Allowance = cap × ops; master-only approvals; cleared on revoke | On-chain allowance 0 after revoke | Allowance is usable only by the router, back into the account |
| T10 | Master swap widens agent authority | Master batch raises allowance by exactly `amountIn`, then restores it | Allowance after Scenario 2 = prior value | None |
| T11 | Unauthorized dashboard access | SIWE with single-use, expiring nonces; HMAC session cookie; ownership check on every route | Replay → 401; tampered cookie → 401 | Browser compromise of the owner |
| T12 | Database exposed via Supabase REST | RLS enabled with no policies on all tables | Unauthenticated REST → 401 | Service-role key leak |
| T13 | Session key stolen from the database | AES-256-GCM; key in worker env only; AAD binds account and permission | Unit tests (tamper and rebinding fail) | Worker compromise still yields a key bounded by T3 |
| T14 | Stale or manipulated oracle | Max age per feed; sequencer check (mainnet); divergence gate against the DEX quote | Unit tests; testnet run | Correlated oracle and DEX manipulation |
| T15 | Revoked or expired agent keeps acting | `uninstallValidation` + `grantAccess(false)`; timestamp policy | Revocation: previously-allowed swap rejected; `isAllowedSelector = false` | None |
