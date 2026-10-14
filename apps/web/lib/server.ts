import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { smartAccounts } from "@guardian/db";
import { createEngineContext, type EngineContext } from "@guardian/engine";

let ctx: EngineContext | undefined;
export const engine = () => (ctx ??= createEngineContext());

const COOKIE = "guardian_session";
const secret = () => { const s = process.env.AUTH_SECRET; if (!s || s.length < 32) throw new Error("AUTH_SECRET missing"); return s; };
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export interface Session { userId: string; wallet: string; exp: number }

export async function setSession(s: Session) {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", expires: new Date(s.exp) });
}
export async function clearSession() { (await cookies()).delete(COOKIE); }

export async function getSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const a = Buffer.from(mac), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
  return s.exp > Date.now() ? s : null;
}

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Every account-scoped route goes through this ownership check. */
export async function requireAccount() {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Sign in with the owner wallet");
  const e = engine();
  const [account] = await e.db.select().from(smartAccounts).where(and(eq(smartAccounts.userId, s.userId), eq(smartAccounts.chainId, e.chain.id)));
  if (!account) throw new HttpError(404, "No smart account registered for this wallet");
  return { session: s, account, ctx: e };
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? `${v}` : v)), { status, headers: { "content-type": "application/json" } });

export function route<T extends unknown[]>(fn: (...a: T) => Promise<Response>) {
  return async (...a: T) => {
    try { return await fn(...a); }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: status === 500 ? `Request failed: ${(e as Error).message.split("\n")[0]}` : (e as Error).message }, status);
    }
  };
}
