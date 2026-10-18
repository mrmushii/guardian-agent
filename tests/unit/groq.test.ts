// Groq adapter: strict JSON-schema request, JSON-mode retry, null-field handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqModel, validateDecision, type AgentContext } from "@guardian/agent";

const ctx = { portfolio: {} } as unknown as AgentContext;
const reply = (content: unknown, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: JSON.stringify(content) } }] } : { error: { message: "bad" } }), { status });

afterEach(() => vi.unstubAllGlobals());

describe("GroqModel", () => {
  it("sends a strict json_schema request to Groq and drops null optional fields", async () => {
    const calls: { url: string; body: any; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization! });
      return reply({ decision: "REBALANCE", targetWethWeight: 0.53, recheckMinutes: null, reason: "Above band" });
    });
    const m = new GroqModel("gsk_test", "openai/gpt-oss-120b");
    const raw = await m.decide(ctx);
    expect(m.name).toBe("groq:openai/gpt-oss-120b");
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer gsk_test");
    expect(calls[0]!.body.response_format.type).toBe("json_schema");
    expect(calls[0]!.body.response_format.json_schema.strict).toBe(true);
    expect(raw).toEqual({ decision: "REBALANCE", targetWethWeight: 0.53, reason: "Above band" });
    expect(validateDecision(raw, { ethMinPct: 45, ethMaxPct: 55, maxWaitMinutes: 60 }).ok).toBe(true);
  });

  it("retries in JSON mode when the model rejects json_schema", async () => {
    const formats: string[] = [];
    vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
      const f = JSON.parse(String(init.body)).response_format.type as string;
      formats.push(f);
      return f === "json_schema" ? reply(null, 400) : reply({ decision: "NO_ACTION", reason: "In band" });
    });
    expect(await new GroqModel("k", "llama-3.3-70b-versatile").decide(ctx)).toEqual({ decision: "NO_ACTION", reason: "In band" });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("surfaces HTTP errors with the provider label", async () => {
    vi.stubGlobal("fetch", async () => reply(null, 401));
    await expect(new GroqModel("bad", "openai/gpt-oss-120b").decide(ctx)).rejects.toThrow("Groq HTTP 401");
  });
});
