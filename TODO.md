# TODO — v2 follow-ups (Base Sepolia)

All items done 2026-10-18; evidence in `docs/execution-evidence.md` rows 11–18.

- [x] **Buy-side trade result:** `BUY_WETH` → `exactOutputSingle` → Tier 1 → confirmed (block 48279774).
- [x] **Partial-step run:** Wallet B `send-weth 22` (no USDC needed) → `PARTIAL_STEP`, capped Tier 1 sale (block 48280787). The step landed in band on testnet pricing, so the post-cooldown check was `NO_ACTION`.
- [x] **AI-fallback run:** 2 fallback trades (`provider: deterministic-fallback`, `RULE_BASED_FALLBACK`, LOW risk), the 3rd failed closed and paused; resumed.
- [x] **Execution evidence:** v2 section added.
- [x] **Dashboard build and browser tests:** build passes; 4/4 e2e pass, with assertions for "Per purchase" and the window count. The buy-approval card is untested (needs a pending buy approval).
- [x] **Stale balance read after a trade:** a lagging RPC still dropped the allocation (`block not found`); `readPortfolio` now waits for the node to reach the receipt block. Verified on the partial-step trade.

## Open

- [ ] E2E coverage for the buy-approval card (needs a fixture or a Tier 2 buy).
- [ ] esbuild build scripts are allowed via `onlyBuiltDependencies` (pnpm 10); revisit if moving back to pnpm ≥ 11 (`allowBuilds`).
