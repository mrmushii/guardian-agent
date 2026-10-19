# Guardian Agent — Technical Documentation

Guardian is a policy-bound autonomous wallet. An LLM agent proposes rebalancing actions for a WETH/USDC portfolio. Deterministic code plans, prices, risk-checks and routes each proposal. A ZeroDev Kernel v3.3 smart account (ERC-4337, EntryPoint v0.7) independently enforces the authority delegated to the agent. Version 2 rebalances in both directions (sell WETH via `exactInputSingle`, buy WETH via `exactOutputSingle`) and supports multi-asset portfolios through a USDC hub, with one isolated session key per tradable asset.

> **Partial-Step Autonomy (E7).** When a drift needs a $22 rebalance but the autonomous cap is $10, the agent neither fails nor pages the owner: it executes one capped $10 step at Tier 1 (`PARTIAL_STEP`), then re-evaluates after the cooldown. Moves above 3× the cap go to the owner. Evidence: [execution-evidence.md](execution-evidence.md) row 18.
>
> **3-Strike Fail-Safe AI Fallback (E8).** If no model returns a valid decision, the owner's own target becomes a deterministic rule (`deterministic-fallback`, routed `RULE_BASED_FALLBACK`) for small, low-risk Tier 1 trades, so the portfolio is not left unguarded. The 3rd consecutive failure fails closed (`AI_UNAVAILABLE_OR_INVALID`). Evidence: rows 15–17.

Everything described here runs on Base Sepolia. Each claim about enforcement is backed by a test or by a testnet transaction listed in [execution-evidence.md](execution-evidence.md).

## 1. Architecture

```text
Owner wallet (master key) ──signs──► master UserOperations (authorize, revoke, Tier 2 swaps)
                                          │
Worker (Node) ── watch blocks / WETH transfers ── portfolio precheck
   │  meaningful change only
   ▼
 LLM agent (Groq gpt-oss-120b; Gemini/OpenAI fallback; rule fallback) → decision ∈ {REBALANCE, WAIT, ESCALATE, NO_ACTION}  (strict schema)
   ▼
 Deterministic planner → QuoterV2 quote → min output → risk engine → authority router
   ├─ Tier 1: restricted session key signs → simulate → bundler → EntryPoint → Kernel permission validation → SwapRouter02
   ├─ Tier 2: PENDING_APPROVAL → revalidate → owner signs userOpHash in wallet → bundler
   └─ Tier 3: reject + security event
   ▼
 Receipt + balance verification → audit trail (PostgreSQL) → dashboard
```

| Component | Location | Responsibility |
| --- | --- | --- |
| Policy | `packages/policy` | Human policy schema; USD-to-token compiler; authority router; parameters |
| Portfolio | `packages/portfolio` | Integer valuation; closed-form rebalance |
| Oracle | `packages/oracle` | Chainlink ETH/USD and USDC/USD; staleness; L2 sequencer check |
| DEX | `packages/dex` | QuoterV2 quote for the configured pool only; min output |
| Risk | `packages/risk` | Weighted score plus hard gates |
| Agent | `packages/agent` | Provider adapters; strict Zod decision contract |
| Account | `packages/account` | Kernel accounts; permission policies; authorize/revoke batches; AES-GCM key store |
| Simulation | `packages/simulation` | `EntryPoint.handleOps` executed inside `eth_simulateV1` |
| DB | `packages/db` | Schema, migrations (RLS on), durable claims, budget reservations |
| Engine | `packages/engine` | Pipeline, master-operation flow, reconciliation |
| Worker | `apps/worker` | Polling plus WebSocket transfer watcher; restart recovery |
| Web | `apps/web` | Sign-In with Ethereum + testnet Judge Sandbox; SSE timeline (`/api/stream`); agent chat; `/api/whatif` counterfactuals; compiled-permission inspector; adversarial defense lab; approvals; authorize/revoke |

Pinned stack: viem 2.57.5, @zerodev/sdk 5.5.10, @zerodev/permissions 5.6.3, Kernel v3.3, EntryPoint v0.7, call policy v0.0.5, Pimlico bundler and verifying paymaster, Next.js 16.4 with custom CSS modules, PostgreSQL, Drizzle 0.45.

## 2. Policy Compilation: Translating Human Financial Intent into Cryptographic Authority

The owner states intent in dollars and percentages:

```json
{ "ethMinPct": 45, "ethMaxPct": 55, "targetEthPct": 53, "maxAutoTxUsd": 10,
  "dailyBudgetUsd": 25, "maxSlippageBps": 50, "sessionDurationHours": 24 }
```

The EVM cannot read dollars, so the policy is compiled into restrictions the smart account can check. Each step is persisted in `policy_compilations` for audit.

**Step 1 — Authorization price.** Read Chainlink ETH/USD (`P_auth`, 8 decimals) and reject it if stale.

**Step 2 — Buffered conversion.** With autonomous cap `C` and appreciation buffer `b = 15%`, everything is computed in integers:

```text
maxAmountInWei = floor( C_cents · 10^(18+dec) · 10000  /  (100 · P_auth · (10000 + b_bps)) )
```

Example: `C = $10` and `P_auth = $2,429.68` give `maxAmountInWei = 3,578,928,984,027,955` (about 0.00358 WETH, worth $8.70 at authorization).

**Step 3 — Bounded allowance.** `allowance = maxAmountInWei × maxOps` (maxOps = 2). It is never unlimited.

**Step 4 — Session permission.** The ceiling becomes four on-chain policies. The policy order fixes the `PolicyFailed(i)` index:

| # | Policy | Restriction |
| --- | --- | --- |
| 0 | Call policy v0.0.5 | Only `SwapRouter02.exactInputSingle`, with `value = 0`, `callType = CALL`. Field rules on the static tuple (offset `i × 32`): `tokenIn = WETH`, `tokenOut = USDC`, `fee = pool tier`, `recipient = smart account`, `amountIn ≤ maxAmountInWei`, `sqrtPriceLimitX96 = 0` |
| 1 | Timestamp | `validAfter`, `validUntil = authorization + 24 h` |
| 2 | Rate limit | `count = 2`, `interval = 0` (session-wide, never resets; proven) |
| 3 | Gas | Cumulative gas allowance 0.01 ETH; paymaster required and must be the approved Pimlico paymaster |

**v2 (two-way, as deployed).** The table above is the v1 permission that produced the first evidence set. Permission v2 adds a second call-policy entry, `exactOutputSingle` with `tokenIn = USDC`, `tokenOut = WETH`, the same fee/recipient/price-limit pins and `amountInMaximum ≤ maxUsdcInRaw` (the USDC cap, 2% buffer). The rate limit becomes `RateLimitPolicyWithReset`, 6 ops per resetting 24 h window over a 7-day session. Allowances are bounded per token at cap × 42. Multi-asset accounts get one such permission (one session key) per asset, because one call policy cannot hold two same-selector entries (`duplicate permissionHash`). The live values for the current account are visible in the console under **Guardrails → Inspect compiled on-chain permission spec**.

**Step 5 — Installation by the master.** A single master-signed batch performs `WETH.approve(router, allowance)`, `Kernel.installValidations(permission)` and `Kernel.grantAccess(permission, execute, true)`. Kernel v3.3 was chosen because v3.1 has no `grantAccess`, so a permission the master installed could not call `execute`.

**What stays off-chain, by design.** The token ceiling is not a permanent USD ceiling. If WETH appreciates, the same amount is worth more dollars. Guardian therefore enforces the live USD cap and the daily budget off-chain, and sets `SESSION_REAUTH_REQUIRED` when the price rises 10% above `P_auth`. That is below the 15% buffer, so the on-chain cap is still worth at most $10 when reauthorization triggers. An exact on-chain USD cap would need an oracle-aware validator, which is out of MVP scope.

## 3. Core algorithms

**Rebalance (integer, 18-decimal USD).** WETH and USDC are valued with Chainlink prices. A rebalance triggers only outside the band (`V_W · 100 > ethMaxPct · V_T` or `< ethMinPct · V_T`). Then, for target weight T:

```text
overweight:  saleUsd = V_W − T · V_T     amountIn  = floor(saleUsd / P_WETH)       → exactInputSingle
underweight: buyUsd  = T · V_T − V_W     amountOut = floor(buyUsd / P_WETH)        → exactOutputSingle (amountInMaximum ≤ USDC cap)
```

Rounding is down, so slightly less is traded. USD amounts compared with caps round up (conservative). Multi-asset portfolios compute one leg per asset against USDC and execute sells before buys.

**Execution protection.** `minOut = floor(quoteOut · (10000 − slippageBps) / 10000)`, where `quoteOut` comes from QuoterV2 for the exact pool and amount.

**Risk.** `R = 0.30·liquidity + 0.30·divergence + 0.20·size + 0.10·protocol + 0.10·token`, each scored 0–100 (formulas in [decisions.md](decisions.md)). LOW ≤ 30, MEDIUM ≤ 60, HIGH > 60. Hard gates reject regardless of score: divergence above the network threshold, USDC depeg above 2%, no liquidity, stale oracle, or L2 sequencer down.

**Authority routing.** Tier 3 is checked first (violations, hard gates, HIGH). Next, Tier 2: above the USD cap, above the daily budget, above the compiled token cap, session not active, MEDIUM risk, or AI `ESCALATE`. Otherwise Tier 1. The same amount is routed in every tier. Authority never changes the size of the rebalance.

**Daily budget.** UTC calendar day. Reservations are made atomically under a row lock on the account, so concurrent reservations cannot exceed the budget (tested with 4 parallel × $10 against $25: exactly 2 succeed). Reservations are released on a definitive failure.

## 4. Lifecycle and recovery

```text
TRIGGERED → PLANNING → SIMULATING → SUBMITTING → PENDING → CONFIRMED (cooldown 10 min)
                 ├→ PENDING_APPROVAL → REVALIDATING → MASTER_SIGNING → SUBMITTING → PENDING
                 ├→ REJECTED | NO_ACTION | WAIT | FAILED | EXECUTION_FAILED | CANCELLED
```

- **One active action per account.** A partial unique index enforces it, and so do idempotent trigger keys. Both were tested under 8 concurrent claims.
- **Submission intent first.** The UserOperation is written to `user_operations` before it is sent. A bundler validation error is a definitive rejection. A timeout is `UNKNOWN`, and the account stays locked until it is reconciled from chain evidence.
- **Restart.** The worker reconciles pending operations before taking new work.
- **Fail closed.** If the LLM is unavailable or returns invalid output, the rule-based fallback may run a small LOW-risk Tier 1 trade; the 3rd consecutive failure pauses new autonomous actions. Stale oracles, a failed quote or a failed simulation all stop the action.

## 5. Deployment and reproduction

Prerequisites are Node 24 and pnpm (via corepack), plus credentials for Base RPC/WS, Pimlico, PostgreSQL and an LLM provider (Groq, Gemini or OpenAI), all listed in `.env.example`.

```bash
corepack pnpm install && corepack pnpm db:migrate && corepack pnpm test
node --env-file=.env --import tsx scripts/gate0/verify-addresses.ts      # on-chain address verification
node --env-file=.env --import tsx scripts/gate0/permission-harness.ts    # 20 permission cases (simulation)
node --env-file=.env --import tsx scripts/setup-account.ts               # deploy Kernel account (sponsored)
corepack pnpm guardian register && corepack pnpm guardian authorize
corepack pnpm worker                                                     # autonomous monitoring
corepack pnpm --filter @guardian/web build && corepack pnpm --filter @guardian/web start
```

The full scenario runbook is in the [README](../README.md). Hosting targets: web on Vercel, the worker as a persistent process (e.g. Railway), and any managed PostgreSQL. On testnet, the sign-in card offers a no-wallet **Judge Sandbox** whose sessions cannot change owner settings. Mainnet is refused unless `GUARDIAN_ALLOW_MAINNET=true`.
