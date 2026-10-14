import { clearSession, json, route } from "@/lib/server";
export const POST = route(async () => { await clearSession(); return json({ ok: true }); });
