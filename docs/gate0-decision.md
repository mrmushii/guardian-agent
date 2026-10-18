# Gate 0 — Integration Spike Result

**Date:** 2026-10-14 · **Network:** Base Sepolia (84532) · **Method:** read-only RPC and `eth_simulateV1` → `EntryPoint.handleOps`. No transaction has been broadcast.

## Decision

**Direct path: Kernel smart account → SwapRouter02 `exactInputSingle`.** `GuardianSwapExecutor` is not needed.

Call policy v0.0.5 can constrain every required field of the nested `ExactInputSingleParams` tuple. All seven fields are static, so each is an inline 32-byte word at argument offset `i × 32`. These rules were proven with positive and negative cases (below):

| Offset | Field | Rule |
| --- | --- | --- |
| 0 | `tokenIn` | `== WETH` |
| 32 | `tokenOut` | `== USDC` |
| 64 | `fee` | `== selected tier` |
| 96 | `recipient` | `== smart account` |
| 128 | `amountIn` | `<= compiled maxAmountInWei` |
| 160 | `amountOutMinimum` | **unconstrained** (off-chain, plan §9) |
| 192 | `sqrtPriceLimitX96` | `== 0` |

## Pinned versions

| Component | Version |
| --- | --- |
| EntryPoint | v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Kernel | **v3.3** (`KERNEL_V3_3`). v3.1 was tested first, but it has no `grantAccess`, so a permission the master installs cannot be allowed to call `execute()` (`InvalidValidator`). The full suite was rerun on v3.3: 20/20 pass |
| `@zerodev/sdk` / `ecdsa-validator` / `permissions` | 5.5.10 / 5.4.9 / 5.6.3 |
| `viem` / `permissionless` | 2.57.5 / 0.4.1 |
| Call policy | v0.0.5 `0x85770b902D1e503D5f5141d9eaC16d0d08eEaDd2` |
| Timestamp policy | `0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F` |
| Rate-limit policy | `0xf63d4139B25c836334edD76641356c6b74C86873` (`interval = 0`) |
| Gas policy | `0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23` |
| Bundler / paymaster | Pimlico; verifying paymaster `0x777777777777AeC03fd955926DbF81597e66834C` |

Addresses for both networks are in [`packages/chain/src/index.ts`](../packages/chain/src/index.ts). They were verified by `scripts/gate0/verify-addresses.ts`.

## Deployed testnet account

| Item | Value |
| --- | --- |
| Smart account (Kernel v3.3) | `0x11Bc46A51a49d1424c6474fb318C904E451654b7` |
| Master owner | `0x1FeE37df0111D22616fBA6d51bF64038CF05d290` |
| Deployment UserOperation | `0x1a170a5a1d83b7dbd8d337d02a09bf8faade3c86fce9912d811c5fcf50777d39` (sponsored, success) |
| Deployment transaction | [`0x861c…53f3`](https://sepolia.basescan.org/tx/0x861c12f87e05cb5d375e24e7f8a02ec162726a518b27d035d979cdb0d61053f3), block 48110394 |

An earlier v3.1 account (`0x35dA…fF4C`, tx `0xd3fa…03a9`) was deployed before the version change. It is no longer used.

## Permission evidence

Full record: [`evidence/gate0-permissions.json`](evidence/gate0-permissions.json). Reproduce with `node --env-file=.env --import tsx scripts/gate0/permission-harness.ts`.

Each negative case differs from the passing allowed swap in exactly one respect.

| Case | Result | Cause |
| --- | --- | --- |
| Allowed swap at compiled cap | Executed, USDC received | — |
| Wrong target / wrong selector / batch with forbidden call / delegatecall | AA23 `0x007e472e` | No permission matches the call type, target, and selector. The selector has no public name; the cause is attributed by differential comparison |
| Wrong tokenIn, tokenOut, fee, recipient, nonzero price limit; `amountIn = cap + 1` | AA23 `CallViolatesParamRule()` | Call policy |
| No paymaster | AA23 | Gas policy. The control without the gas policy succeeds |
| Unapproved paymaster | AA23 `PolicyFailed(3)` | Gas policy. The control fails only later, at the paymaster stage (AA31) |
| 1000× gas price with the approved paymaster | AA23 `PolicyFailed(3)` | Gas policy's cumulative allowance |
| Block time after `validUntil` | AA22 expired | Timestamp policy |
| Operations 1 and 2, then operation 3 about 24 h later | Success, success, then AA23 `PolicyFailed(2)` | Rate limit. `interval = 0` makes the count session-wide, with no reset |

## Findings that affect later gates

1. **`amountOutMinimum` is not bound on-chain.** A compromised backend can set it to 0 within the token cap. This matches plan §9. State it in the security report.
2. **Base Sepolia pools are not market-priced.** The fee-3000 pool quotes about 2× Chainlink, and the fee-500 pool about −20%. A price-divergence risk rule would block testnet swaps. That threshold must be network-specific, or the testnet run must be labeled as an exception.
3. **Feed freshness must follow each feed's heartbeat.** The Base Sepolia USDC/USD feed was about 21 h old while ETH/USD was about 2 min old.
4. **Enable-mode verification gas exceeds 1.5M.** The first session operation deploys the account and installs four policies. The bundler estimate must be used, not a fixed limit.
5. **Alchemy free tier limits `eth_getLogs` to a 10-block range.** Watcher backfill must page in 10-block windows or use a different provider tier.
6. **Installing the permission needs more than 800k call gas.** It installs four policies, so the authorize batch must use bundler-estimated gas.
7. The `tslib` peer dependency is missing from `@zerodev/ecdsa-validator`, so it is installed explicitly.

## Not yet done

- [x] One valid UserOperation actually sent through the bundler (account deployment, above).
- [ ] "Not yet valid" (`validAfter`). Simulated block time cannot move backwards. Test it with a future `validAfter` in Gate A.
- [x] Revocation, proven in simulation (`docs/evidence/gate-a-simulation.json`). A real testnet run is pending.
- [ ] Mainnet paymaster sponsorship. Verify before the mainnet proof.

## Addendum (2026-10-18): two-way permission and resetting rate limit

**Method:** `scripts/gate0/two-way-harness.ts`, simulation only (`eth_simulateV1` → `EntryPoint.handleOps`). Record: [`evidence/gate0-two-way-permissions.json`](evidence/gate0-two-way-permissions.json). All 19 cases pass.

**Buy side.** A second call-policy permission on the same router, selector `exactOutputSingle` (USDC → WETH). Its tuple is also all-static. A different selector means the sell rule and the buy rule cannot collide.

| Offset | Field | Rule |
| --- | --- | --- |
| 0 | `tokenIn` | `== USDC` |
| 32 | `tokenOut` | `== WETH` |
| 64 | `fee` | `== selected tier` |
| 96 | `recipient` | `== smart account` |
| 128 | `amountOut` | unconstrained (the size comes from the planner) |
| 160 | `amountInMaximum` | `<= compiled USDC cap` |
| 192 | `sqrtPriceLimitX96` | `== 0` |

The buy side is stricter than the sell side. `amountInMaximum` bounds the most USDC the swap can spend **on-chain**, so a poor price cannot make the account overspend. On the sell side, `amountOutMinimum` is still checked only off-chain.

Negative cases rejected with `CallViolatesParamRule`: cap + 1, attacker recipient, reversed tokens, attacker token, wrong fee, non-zero price limit, USDC through the sell selector, and `USDC.transfer`.

**Rate limit.** The default `RateLimitPolicy` (`0xf63d…6873`) **never resets**, even with `interval > 0`: after the interval passes it still returns `PolicyFailed(2)`. `RateLimitPolicyWithReset` (`0x6a06…ca9b`, an SDK constant) restores the count once `interval` has elapsed. Agent permissions from v2 use the with-reset contract: 6 operations per 24 h window, over a 7-day session.

The window test uses 120 s, not 24 h, because Pimlico paymaster signatures are only valid for minutes. With an hour of simulated time, the result is `AA32 paymaster expired`, not a policy result.

**Versioning.** `policy_compilations.permission_version` records which layout was installed: 1 is sell-only with a session-total count, 2 is two-way with a resetting window. The engine rebuilds the exact permission for that version, so older sessions can still be revoked.

## Addendum 2: multi-asset authority (2026-10-18)

Evidence: `docs/evidence/gate0-multi-asset-shared-policy-rejected.json`, `docs/evidence/gate0-multi-asset-permissions.json` (script `scripts/gate0/multi-asset-harness.ts`, simulation only).

**Shared call policy: rejected.** One `CallPolicy` V0_0_5 cannot hold two entries with the same target and selector. Installing sell rules for WETH and a second asset on `exactInputSingle` reverts with `duplicate permissionHash`, so per-asset caps cannot live in one policy. (`ONE_OF` on the token field exists, but then a single amount cap would apply to tokens with different decimals and prices, which is unsafe.)

**Decision: one permission per asset, USDC hub.** Each managed asset gets its own permission validator (its own session key) with today's two-way layout: sell `asset → USDC` via `exactInputSingle` with `amountIn ≤ asset cap`, buy `USDC → asset` via `exactOutputSingle` with `amountInMaximum ≤ USDC cap`, recipient = the account, fixed fee tier, zero price limit.

Proven in sequential simulated blocks on one account: installing a second asset's permission keeps the first working; each key is confined to its own pair and caps (a cap 10× larger on asset B never applies to WETH); a key cannot trade another key's asset, bypass USDC (B → WETH), pay a foreign recipient, or batch a transfer. All 13 cases match.

Consequences: an asset-to-asset rebalance runs as two operations (sell leg with the overweight asset's key, then buy leg with the underweight asset's key); rate limits and gas allowances are tracked per asset; authorization installs every asset's permission in one owner signature, and revocation uninstalls them all.

**Batch install / revoke** (`scripts/gate0/multi-asset-install.ts`, `docs/evidence/gate0-multi-asset-install.json`): the owner installs several per-asset permissions in one master UserOperation (`authorizeAgentCallsMulti`: bounded approve per asset, one USDC approve, one `installValidations` with every permission at the **same** validation nonce — `nonce + 1` reverts `InvalidNonce` — and `grantAccess(execute)` per key), each key then trades within its own caps, and `revokeAgentCallsMulti` removes them all in one operation, after which every key is rejected. Each permission install deploys several policy configs: a two-asset install needs ~2× the call gas of one (bundler estimation covers this in production; a fixed 3M limit in the harness ran out).
