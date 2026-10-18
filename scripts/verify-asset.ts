// Verify assets on the configured network: `verify-asset` (whole registry) or `verify-asset <token> [feed]`.
import type { Address } from "viem";
import { ASSETS } from "@guardian/chain";
import { createEngineContext, verifyAsset } from "@guardian/engine";

const ctx = createEngineContext();
const [token, feed] = process.argv.slice(2);
const targets = token ? [{ token: token as Address, feed: feed as Address | undefined }]
  : ASSETS.map((a) => ({ symbol: a.symbol, hub: a.hub, decimals: a.decimals, ...a.deployments[ctx.chain.id] }));
for (const t of targets) {
  const v = await verifyAsset(ctx, t);
  console.log(`\n${v.symbol.padEnd(6)} ${v.status}`);
  for (const c of v.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.id.padEnd(5)} ${c.detail}`);
}
await ctx.close();
