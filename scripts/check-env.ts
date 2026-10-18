import { createPublicClient, http, webSocket, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pg from "pg";
const e = process.env;
const ok = (n: string, m: string) => console.log(`OK   ${n}: ${m}`);
const bad = (n: string, m: unknown) => console.log(`FAIL ${n}: ${String((m as Error)?.message ?? m).replace(/(apikey=|v2\/|:\/\/[^:]+:)[^@\s&"]+/g, "$1<redacted>").slice(0, 200)}`);
const t = async (n: string, f: () => Promise<string>) => { try { ok(n, await f()); } catch (x) { bad(n, x); } };
const rpc = async (url: string, method: string, params: unknown[] = []) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
};
await t("BASE_SEPOLIA_RPC_URL", async () => `chainId ${parseInt(await rpc(e.BASE_SEPOLIA_RPC_URL!, "eth_chainId"))} (want 84532)`);
await t("BASE_MAINNET_RPC_URL", async () => `chainId ${parseInt(await rpc(e.BASE_MAINNET_RPC_URL!, "eth_chainId"))} (want 8453)`);
for (const n of ["BASE_SEPOLIA_WS_URL", "BASE_MAINNET_WS_URL"]) await t(n, async () => {
  const c = createPublicClient({ transport: webSocket(e[n]!, { timeout: 10000 }) });
  const id = await c.getChainId(); await (await c.transport.getRpcClient()).close(); return `chainId ${id}`;
});
const pim = `https://api.pimlico.io/v2/84532/rpc?apikey=${e.PIMLICO_API_KEY}`;
await t("PIMLICO_API_KEY", async () => `bundler chainId ${parseInt(await rpc(pim, "eth_chainId"))}, entryPoints ${(await rpc(pim, "eth_supportedEntryPoints")).join(",")}`);
const sep = createPublicClient({ transport: http(e.BASE_SEPOLIA_RPC_URL) });
for (const n of ["TESTNET_OWNER_PRIVATE_KEY", "TESTNET_WALLET_B_PRIVATE_KEY", "TESTNET_HARNESS_PRIVATE_KEY"]) await t(n, async () => {
  const a = privateKeyToAccount(e[n] as `0x${string}`).address; return `${a} balance ${formatEther(await sep.getBalance({ address: a }))} ETH`;
});
await t("SESSION_KEY_ENCRYPTION_KEY", async () => { if (!/^[0-9a-f]{64}$/.test(e.SESSION_KEY_ENCRYPTION_KEY!)) throw "not 32-byte hex"; return "32-byte hex"; });
await t("DATABASE_URL", async () => {
  const c = new pg.Client({ connectionString: e.DATABASE_URL, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
  await c.connect(); const r = await c.query("select version()"); await c.end(); return r.rows[0].version.slice(0, 40);
});
await t("SUPABASE_URL + SERVICE_ROLE_KEY", async () => {
  const r = await fetch(`${e.SUPABASE_URL}/rest/v1/`, { headers: { apikey: e.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!r.ok) throw `HTTP ${r.status}`; return `HTTP ${r.status}`;
});
const llm = (provider?: string, model?: string) => async () => {
  if (provider === "groq") {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${e.GROQ_API_KEY}` } });
    const j: any = await r.json(); if (!r.ok) throw `HTTP ${r.status} ${j.error?.message}`;
    const ids: string[] = j.data.map((m: any) => m.id);
    if (!ids.includes(model!)) throw `key works, but model "${model}" not available. Models: ${ids.join(", ")}`;
    return `key works, model available`;
  }
  if (provider === "gemini") {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": e.GEMINI_API_KEY! } });
    const j: any = await r.json(); if (!r.ok) throw `HTTP ${r.status} ${j.error?.message}`;
    const names = j.models.map((m: any) => m.name.replace("models/", ""));
    if (!names.includes(model)) throw `key works, but model "${model}" not available. Flash models: ${names.filter((n: string) => n.includes("flash")).join(", ")}`;
    return `key works, model available`;
  }
  throw `no check for provider "${provider}"`;
};
await t(`LLM primary (${e.LLM_PROVIDER}:${e.LLM_MODEL})`, llm(e.LLM_PROVIDER, e.LLM_MODEL));
if (e.LLM_FALLBACK_PROVIDER && e.LLM_FALLBACK_MODEL) await t(`LLM fallback (${e.LLM_FALLBACK_PROVIDER}:${e.LLM_FALLBACK_MODEL})`, llm(e.LLM_FALLBACK_PROVIDER, e.LLM_FALLBACK_MODEL));
process.exit(0);
