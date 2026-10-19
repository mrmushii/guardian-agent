import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { smartAccounts, users } from "@guardian/db";
import { engine, HttpError, json, route, setSession } from "@/lib/server";

/** Judge Sandbox (testnet only): a read-and-demo session on the pre-deployed Base Sepolia account. Owner-only actions stay closed (see requireOwner). */
export const POST = route(async () => {
  const e = engine();
  if (!e.network.isTestnet) throw new HttpError(403, "Judge Sandbox is only available on testnet");
  const pinned = process.env.GUARDIAN_SANDBOX_ACCOUNT?.toLowerCase();
  const [account] = await e.db.select().from(smartAccounts)
    .where(and(eq(smartAccounts.chainId, e.chain.id), isNotNull(smartAccounts.userId), ...(pinned ? [sql`lower(${smartAccounts.address}) = ${pinned}`] : [])))
    .orderBy(asc(smartAccounts.createdAt)).limit(1);
  if (!account?.userId) throw new HttpError(404, "No demo smart account is registered on this network");
  const [user] = await e.db.select().from(users).where(eq(users.id, account.userId));
  if (!user) throw new HttpError(404, "Demo owner not found");
  await setSession({ userId: user.id, wallet: user.walletAddress, exp: Date.now() + 4 * 3_600_000, sandbox: true });
  return json({ wallet: user.walletAddress, smartAccount: account.address, sandbox: true });
});
