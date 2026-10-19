import { and, eq, gt } from "drizzle-orm";
import type { Address } from "viem";
import { agentActions } from "@guardian/db";
import { simulateMove } from "@guardian/engine";
import { HttpError, json, requireAccount, route } from "@/lib/server";
/** Testnet demo: the demo wallet moves funds into this account so the owner can watch the agent react. */
export const POST = route(async (req: Request) => {
  const { account, ctx } = await requireAccount();
  if (!ctx.network.isTestnet) throw new HttpError(403, "Simulation is disabled on mainnet");
  const { direction, usd, resetCooldownOnly } = (await req.json().catch(() => ({}))) as { direction?: string; usd?: number; resetCooldownOnly?: boolean };
  // Testnet only: lift the post-trade cooldown so back-to-back demo moves get an immediate reaction. Mainnet keeps the full cooldown.
  const cleared = await ctx.db.update(agentActions).set({ cooldownUntil: null })
    .where(and(eq(agentActions.accountId, account.id), gt(agentActions.cooldownUntil, new Date()))).returning({ id: agentActions.id });
  if (resetCooldownOnly) return json({ cooldownCleared: cleared.length });
  if (direction !== "up" && direction !== "down") throw new HttpError(400, "direction must be up or down");
  if (typeof usd !== "number" || usd < 1 || usd > 30) throw new HttpError(400, "Amount must be between $1 and $30");
  return json({ ...(await simulateMove(ctx, account.id, account.address as Address, direction, usd)), cooldownCleared: cleared.length });
});
