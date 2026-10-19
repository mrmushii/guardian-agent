# Execution Evidence — Base Sepolia

**Network:** Base Sepolia (chain ID 84532). **Date:** 2026-10-14. All amounts are test tokens; no mainnet transaction has been made.

| Identity | Address |
| --- | --- |
| Master owner (EOA) | `0x1FeE37df0111D22616fBA6d51bF64038CF05d290` |
| Smart account (Kernel v3.3) | `0x11Bc46A51a49d1424c6474fb318C904E451654b7` |
| Agent session signer (revoked) | `0xeDba8d10aF5750547327840ccc386066e69998E1` |
| Agent permission ID | `0xb4a1c62d` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Wallet B (demo sender, sponsored smart account) | `0x1e467AA153422A1c3A2DFCA3545bb952ac2DdcCb` |

On the explorer, the transaction sender is the bundler. Transaction hashes link to [Base Sepolia BaseScan](https://sepolia.basescan.org/); UserOperation hashes are not transactions, so look them up on a 4337 explorer (e.g. JiffyScan, chain 84532).

The authority behind each action is the UserOperation signature, recorded below as "Signed by".

## Lifecycle

| # | Step | Signed by | UserOperation | Transaction | Block | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Deploy smart account | Master | `0x1a170a5a…0777d39` | [`0x861c12f8…d61053f3`](https://sepolia.basescan.org/tx/0x861c12f87e05cb5d375e24e7f8a02ec162726a518b27d035d979cdb0d61053f3) | 48110394 | Success |
| 2 | Authorize Guardian: bounded WETH approve, install permission, grant `execute` access | Master | `0x27141df7…f5c45d5b` | [`0x26f1c62e…10aba351`](https://sepolia.basescan.org/tx/0x26f1c62e290641c102af0b2631ada08b9d18b262ed3943f2ae14781310aba351) | 48110998 | Success |
| 3 | Setup: swap 8.92 USDC to WETH (portfolio to 50.02% WETH) | Master | `0x41d9f5da…fd841f7` | [`0x17f1b59d…fe7e3ed`](https://sepolia.basescan.org/tx/0x17f1b59de8bf6b9b44944e049575a08d8418e58468b652fff2f3ebf93fe7e3ed) | — | Success |
| 4 | Scenario 1 trigger: Wallet B sends $11.25 of WETH | Wallet B | `0x3fa9118e…74e98c` | [`0x32da55f9…84b1991`](https://sepolia.basescan.org/tx/0x32da55f97824f19b5647b26a5873e9b459dedc7fbecdc8404954f913384b1991) | — | Success |
| 5 | **Scenario 1: autonomous rebalance (Tier 1)** | **Agent session** | `0x971f98ca…050f606c` | [`0xbe79fd85…04ced84a`](https://sepolia.basescan.org/tx/0xbe79fd85d2e7d9ad404cd704242ec8b5dbb81939c92a5f8492b4d81004ced84a) | 48112653 | Success |
| 6 | Scenario 2 trigger: Wallet B sends $30 of WETH | Wallet B | — | [`0xe430bbf8…ec66395db`](https://sepolia.basescan.org/tx/0xe430bbf8d40d628616e63422d37f9a410a1627dab52760b43dc9dcdec66395db) | — | Success |
| 7 | **Scenario 2: master-approved rebalance (Tier 2)** | **Master** | `0x95d73407…a4f3485` | [`0x11847b74…157e5835f`](https://sepolia.basescan.org/tx/0x11847b74c4ae2aa164c1d729c01e09dbddb074a06a75f3a1642a0a8157e5835f) | 48113495 | Success |
| 8 | **Revoke agent:** remove access, uninstall the permission, clear the allowance | Master | `0x03a66ecc…7b3dbeb9` | [`0xda42aec3…2df99ac45`](https://sepolia.basescan.org/tx/0xda42aec3d54688638a393491e59d86ea000a79a21c884b3574492b72df99ac45) | 48113527 | Success |
| 9 | Re-authorize: new permission `0x32588915`, signer `0x0E41E69c…6607` | Master | — | [`0x7ca4960c…2f6bb88c`](https://sepolia.basescan.org/tx/0x7ca4960c1fe945ea692bcef7b491f93560a3f013b7cac61c1b3f57aa2f6bb88c) | — | Success |
| 10 | **E8: permitted swap with impossible `amountOutMinimum`** | Agent session | `0x509287ed…94fcfb227` | [`0x84e27e2a…9096eae6e4`](https://sepolia.basescan.org/tx/0x84e27e2a5e9552620bec2b9658373524bdb0464a4854ce64b3e12c9096eae6e4) | 48113696 | Outer tx **success**; UserOperation **failed** ("Too little received") |

Later housekeeping (not scenario evidence): the session was revoked and re-authorized as permission `0x5064ff44` ([`0x344b8c25…99e3e9f`](https://sepolia.basescan.org/tx/0x344b8c259b002021144f83e4195ad4cd5449df5aa6c283b88c07eae9c99e3e9f)), and the demo portfolio was reset to $10 WETH + $10 USDC with the surplus moved to Wallet B ([`0xaf1fdf38…3331e21f`](https://sepolia.basescan.org/tx/0xaf1fdf38e7e5ede317974026ef02c6546f8c5ce5a7741ce6e5a60c523331e21f)).

## v2 — two-way permission (2026-10-17/18)

The v1 sell-only permission was replaced by a two-way permission: sell via `exactInputSingle`, buy via `exactOutputSingle` with an on-chain `amountInMaximum` ceiling, 6 swaps per resetting 24 h window. Permission `0x15314af3`, signer `0x44664dDC…E13665C`.

| # | Step | Signed by | UserOperation | Transaction | Block | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 11 | Revoke v1 permission | Master | `0x503401bd…2cd5d9cc5` | [`0x4063e41c…9f71f1a88d`](https://sepolia.basescan.org/tx/0x4063e41c07febaff4a7a9d2952813ba03982b843ad1da780758eea9f71f1a88d) | 48247088 | Success |
| 12 | Authorize v2: permission `0x15314af3` | Master | `0x8f177280…7ad6409dbe` | [`0x0930d3fa…e3ff84fea74`](https://sepolia.basescan.org/tx/0x0930d3fa6133fda7e173271cbeaa842b76fc5dfcaf66c883144b2e3ff84fea74) | 48247098 | Success |
| 13 | **Scenario 1 (v2): autonomous sale, Tier 1** (67.88% after the Wallet B transfer) | **Agent session** | `0xa0a35241…a0fb760e1` | [`0xc5640ea9…c1c7dde32230`](https://sepolia.basescan.org/tx/0xc5640ea95991899d4005a01ef3245c9ad73b37eff85520c8e9a6c1c7dde32230) | 48247125 | Success |
| 14 | **Buy side: autonomous purchase, Tier 1.** 42.68% → buy 0.001652 WETH via `exactOutputSingle` for 7.03 USDC (max 7.07), risk 19 LOW | **Agent session** | `0xac92806f…bbbd8beeb4840ea93c20a2d9d40a3b4f` | [`0x94fee704…71db047fa9eaecfbb26f7a`](https://sepolia.basescan.org/tx/0x94fee7044adb495548058301dc23f1a9850e6657af71db047fa9eaecfbb26f7a) | 48279774 | Success; post-trade allocation 57.54% read at the receipt block |
| 15 | AI fallback #1 (`LLM_MODEL=does-not-exist`): `AI_UNAVAILABLE` (Gemini 404), `provider: deterministic-fallback`, routed `RULE_BASED_FALLBACK`, sell $1.63, risk 14 LOW | **Agent session** | `0x569bc554…5d61e682e4` | [`0xc4fc53ed…e0fe78f6ddfdb5df77e32854ee5bf`](https://sepolia.basescan.org/tx/0xc4fc53edd93a689499370ea6649c054348be0fe78f6ddfdb5df77e32854ee5bf) | 48280107 | Success; 57.58% → 51.22% |
| 16 | AI fallback #2 ("2 in a row"), same routing | **Agent session** | `0x49e736ae…7f31e6cc4f` | [`0x232edb4a…f618d1ad7fdd4f7b91b284672438a585698`](https://sepolia.basescan.org/tx/0x232edb4a6dfb14a576cd10269fb30f618d1ad7fdd4f7b91b284672438a585698) | 48280429 | Success |
| 17 | AI fallback #3 ("3 in a row"): **fail closed**, no trade, account paused `AI_UNAVAILABLE_OR_INVALID`; then owner `resume` | — | — | — | — | Action `f8a6d60b…` FAILED as designed |
| 18 | **Partial step:** Wallet B sends $22 of WETH (70.30%); full move $11.70 > cap, `PARTIAL_STEP`, one capped sale of 0.0036 WETH, routed `PARTIAL_STEP_WITHIN_CAP`, risk 21 LOW | **Agent session** | `0xa521c2a8…19d70dd205` | [`0x832f0cd1…02d2ea53a35baf2e4ae2835d5b38`](https://sepolia.basescan.org/tx/0x832f0cd1b8b22757bdb6103785a028f8afca02d2ea53a35baf2e4ae2835d5b38) | 48280787 | Success; 52.39% after the step (testnet pool overpays ≈1.75×), so no remainder trade was needed; the evaluation after the cooldown returned `NO_ACTION` (action `608e1a81…`) |

Defense B against the v2 session key: **8/8 forbidden operations rejected by the bundler** ([`evidence/defense-b-bundler-rejections-v2.json`](evidence/defense-b-bundler-rejections-v2.json)).

## Scenario 1 — autonomous (E1, testnet)

The worker detected the WETH transfer. It then:

1. Measured the allocation at **66.85% WETH**, above the 55% maximum.
2. Received AI decision `REBALANCE` (target 0.53).
3. Planned a sale of **$4.63** (0.001906 WETH).
4. Got a quote of 9.47 USDC and set the minimum output at 9.42 USDC (50 bps).
5. Scored risk at **22 (LOW)**.
6. Routed to **Tier 1**.
7. Passed simulation, signed with the restricted session key, and submitted.
8. Confirmed 12 s after detection.

The final allocation was 46.29%. The Sepolia pool paid about 2× the Chainlink price (104.6% divergence, labeled `TESTNET_PRICING`). The amount sold was correct at the reference price.

## Scenario 2 — master approval (E2)

The transfer arrived during the 10-minute cooldown, so it was deferred. After the cooldown:

1. The allocation was **69.93%**.
2. The AI decision was `REBALANCE`.
3. The required sale was **$11.57**.
4. Routing chose **Tier 2**, for two reasons: `ABOVE_AUTONOMOUS_USD_CAP` and `ABOVE_COMPILED_TOKEN_CAP`. The agent did not sign.
5. On approval, the engine revalidated with fresh balances and quote: sell $11.55, minimum 23.46 USDC, risk 28.
6. The owner signed the userOpHash. The engine verified that the signature recovers the master owner, then submitted.

The master batch raised the router allowance by exactly `amountIn` and restored it. The allowance afterwards was 0.005252 WETH, which is the compiled 0.007158 minus the 0.001906 that Scenario 1 used. Master execution did not widen agent authority.

## Security evidence

| ID | Test | Result | Record |
| --- | --- | --- | --- |
| E3/E6/E7 | Real session key with application checks bypassed. Forbidden operations sent via `eth_sendUserOperation`: WETH transfer to an attacker (the prompt-injection payload), unlimited approve to an attacker, swap with the attacker as recipient, swap at cap + 1 wei | **All rejected by the Pimlico bundler (AA23). No transaction hash** | [`evidence/defense-b-bundler-rejections.json`](evidence/defense-b-bundler-rejections.json) |
| E7 (revocation) | Same session key after revocation: a previously **allowed** swap, and a transfer | **Both rejected (AA23)**. On-chain checks: allowance `0`; `isAllowedSelector(permission, execute)` is `false` | [`evidence/revocation-rejections.json`](evidence/revocation-rejections.json) |
| E5 | Expiry, operation count, gas/paymaster abuse, delegatecall, batch smuggling | Rejected by validation, with each cause attributed by control cases | [`evidence/gate0-permissions.json`](evidence/gate0-permissions.json) (simulation against deployed contracts) |
| E8 | Execution failure vs. authorization failure | Validation passed (minimum output is not an on-chain restriction); router reverted. Classified `EXECUTION_FAILED`, not a permission result | [`evidence/e8-execution-revert.json`](evidence/e8-execution-revert.json) |
| E4 | Forced on-chain validation failure (`handleOps` from a test EOA) | **Not yet run.** The harness wallet needs Base Sepolia ETH | [`scripts/security/direct-handleops.ts`](../scripts/security/direct-handleops.ts) |
| E6 (app layer) | Prompt injection through the agent | Agent answered `ESCALATE` ("attempted prompt injection to redirect funds") | Live test of the decision contract |

## Notes

- `amountOutMinimum` is not constrained on-chain. Market quality is checked off-chain, which is the plan's stated limitation.
- Post-trade allocation is read at a block no older than the receipt. Run #16 showed a lagging RPC node answering "block not found" for the receipt block, so the `CONFIRMED` line lost its allocation. The read now waits (bounded, 15 s) for the node to reach that block, and a failed valuation is shown in the `CONFIRMED` line instead of dropped silently. Row 18 is the first trade on the fixed code.
- Testnet allocations after a swap differ from the 53% target because Sepolia pools are not market-priced. Mainnet proof (E1) is pending owner approval.

## Multi-asset: on-chain asset verification (2026-10-18)

`node --env-file=.env --import tsx scripts/verify-asset.ts` checks each registry asset on Base Sepolia: ERC-20 metadata, fresh Chainlink USD feed, USDC pool with liquidity, and a $1 USDC → asset → USDC quote that must keep ≥ 90% and buy within 10× of the oracle value.

| Asset | Feed | Token / pool | Status |
| --- | --- | --- | --- |
| USDC | USDC/USD `0xd30e…5165` | hub | VERIFIED |
| WETH | ETH/USD `0x4aDC…c7cb1` | 0.3% pool, $1 round trip $0.99 | **VERIFIED (tradable)** |
| cbBTC | BTC/USD `0x0FB9…4298` | 0.05% pool loses 99% on $1 | PAPER |
| LINK | LINK/USD `0xb113…5A61` | 1% pool priced 4.7e-12× the oracle | PAPER |
| DAI | DAI/USD `0xD109…945e` | no token on Base Sepolia | PAPER |
| USDT | USDT/USD `0x3ec8…934f` | no token on Base Sepolia | PAPER |
| AERO | none on testnet | none | UNAVAILABLE |

On testnet only WETH/USDC can trade for real; other assets run in clearly labelled simulated mode, priced by their Chainlink feeds.

### Live multi-asset run (2026-10-18, policy v4 → v5: WETH 50% / cbBTC 10% / USDC 40%, drift ±5)

| Step | Outcome |
| --- | --- |
| Allocation WETH 50.7%, cbBTC 0%, USDC 49.3% → plan "buy $8.93 cbBTC" | **Simulated** fill: 0.000110090 cbBTC at the Chainlink price (cbBTC pool unusable on Sepolia); allocation WETH 50.7 / cbBTC 10.0 / USDC 39.3 |
| Wallet B sends $10 WETH → WETH 55.7% → plan "sell $5.63 WETH, buy $1.01 cbBTC", sells first | **On-chain** Tier 1 sale with the WETH agent key: 0.00237402 WETH for 10.02 USDC, risk 16 LOW, block 48287918, [`0x40ee426e…caf5`](https://sepolia.basescan.org/tx/0x40ee426ecbf3dee1d5bfc556294e8d9deddd18f35f8d6975b92ad33b1612caf5); allocation WETH 47.9 / cbBTC 8.6 / USDC 43.5 |
