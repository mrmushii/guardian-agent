# Demo Script (≈5 minutes)

This script follows the plan's demo outline. Everything runs on Base Sepolia.

## Before recording

1. Check the starting state and reset it if needed:
   ```bash
   corepack pnpm guardian status          # want: wethWeightPct ≈ 50, session ACTIVE with 2 swaps
   corepack pnpm guardian reset-demo 10   # if needed: $10 WETH + $10 USDC (surplus goes to Wallet B)
   corepack pnpm guardian authorize       # if the session is not ACTIVE or has fewer than 2 swaps left
   ```
   Wallet B needs at least $41.25 of WETH. If it's short, run `corepack pnpm guardian b-buy-weth <usdc>`.
2. Start the worker and the dashboard:
   ```bash
   corepack pnpm worker
   corepack pnpm --filter @guardian/web start          # after a build
   ```
3. Open http://localhost:3000, sign in with the owner wallet, and keep a terminal next to the browser.
4. Note: after a confirmed rebalance the agent waits 10 minutes (cooldown) before acting again. Record Scenario 2 after the cooldown, or cut the wait out of the video.

## Recording

| Time | Show | Say (suggested) |
| --- | --- | --- |
| 0:00–0:30 | Dashboard hero at 50% | "An AI agent that manages money is usually given a key. If the AI is tricked, the key goes with it. Guardian gives the agent authority it cannot expand." |
| 0:30–1:00 | **Who signs what** panel | "There are two authorities. I keep the master key. The agent gets a session key that the smart account itself restricts." |
| 1:00–1:30 | **Agent authority** panel (per swap, swaps left, expiry, reauthorize at) | "My policy is in dollars: $10 per trade, $25 a day. The EVM can't read dollars, so Guardian compiles them into token units. That's the WETH amount shown under Per swap (about 0.0036 WETH, including a 15% price buffer), 2 swaps, 24 hours, Uniswap only, back to this account." |
| 1:30–2:30 | Terminal: `corepack pnpm guardian send-weth 11.25`, then watch **Activity** | "Wallet B sends $11.25 of WETH. The portfolio jumps to 68%. The agent decides to rebalance and deterministic code plans the sale, about $4.69. It gets a quote, scores the risk, and routes to Tier 1. The session key signs. Confirmed." Click the transaction link, then point at the separate UserOperation hash. |
| 2:30–3:15 | Terminal: `node --env-file=.env --import tsx scripts/security/malicious-userop.ts` | "Now assume the AI and the backend are compromised. I take the real session key and sign a transfer of everything to an attacker, plus an unlimited approval. The bundler rejects every one. There's no transaction hash, because the account's own permission refused them." |
| 3:15–3:40 | `docs/evidence/defense-c-onchain-validation-failure.json` explorer link (once E4 has run) | "Forced straight to the EntryPoint, the same operation fails on-chain." *(If E4 hasn't run yet, show the simulated rejection table in docs/gate0-decision.md instead.)* |
| 3:40–4:10 | Terminal: `corepack pnpm guardian send-weth 30`, then **Waiting for your approval** → **Review and sign** | "A bigger move needs about $14 of selling. That's above the agent's limit, so it can't sign. It asks me. Guardian rechecks the prices, I sign in my wallet, and it executes with master authority." |
| 4:10–4:30 | **Outcomes** panel and **Revoke agent** | "One done by the agent, one done with my approval. And I can revoke the agent at any time: after that, even trades it was allowed to make are refused. The AI can act, but only inside authority it cannot redefine." |

## Fallbacks during recording

- **Activity doesn't move after `send-weth`:** check the worker terminal. Messages like `COOLDOWN` or `paused` explain it. `corepack pnpm guardian evaluate` forces a check.
- **Gemini returns 503 or 429:** the agent pauses, which is the intended fail-closed behavior. Switch `LLM_MODEL` to a model that is up, then run `corepack pnpm guardian resume`.
- **Testnet pricing:** after a swap, the allocation lands below 53% because Sepolia pools pay about 2× market. Say so on camera: "testnet pools aren't market-priced; on mainnet this lands at 53%."
