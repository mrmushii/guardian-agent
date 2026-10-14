import { and, eq, gt, isNull } from "drizzle-orm";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { authNonces, users } from "@guardian/db";
import { engine, json, route, setSession, HttpError } from "@/lib/server";

/** Sign-In with Ethereum: the nonce is single-use, bound to the address, domain-checked, and expires in 10 minutes. */
export const POST = route(async (req: Request) => {
  const { message, signature } = (await req.json()) as { message: string; signature: `0x${string}` };
  const e = engine();
  const fields = parseSiweMessage(message);
  const host = new URL(req.url).host;
  if (!fields.address || !fields.nonce) throw new HttpError(400, "Malformed sign-in message");
  const ok = await verifySiweMessage(e.publicClient, { message, signature, domain: host, nonce: fields.nonce });
  if (!ok) throw new HttpError(401, "Signature check failed — sign the message with the wallet you connected");
  const wallet = fields.address.toLowerCase();
  const used = await e.db.update(authNonces).set({ usedAt: new Date() })
    .where(and(eq(authNonces.nonce, fields.nonce), eq(authNonces.walletAddress, wallet), isNull(authNonces.usedAt), gt(authNonces.expiresAt, new Date()))).returning();
  if (!used.length) throw new HttpError(401, "Sign-in request expired — start again");
  const [user] = await e.db.insert(users).values({ walletAddress: wallet }).onConflictDoUpdate({ target: users.walletAddress, set: { walletAddress: wallet } }).returning();
  await setSession({ userId: user!.id, wallet, exp: Date.now() + 8 * 3_600_000 });
  return json({ wallet });
});
