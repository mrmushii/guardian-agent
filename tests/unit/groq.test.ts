// Groq adapter: strict JSON-schema request, JSON-mode retry, null-field handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiModel, GroqModel, decideWithFallback, validateDecision, type AgentContext } from "@guardian/agent";

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
    // json_schema with reasoning → json_schema without the reasoning flag → JSON mode.
    expect(formats).toEqual(["json_schema", "json_schema", "json_object"]);
  });

  it("surfaces HTTP errors with the provider label", async () => {
    vi.stubGlobal("fetch", async () => reply(null, 401));
    await expect(new GroqModel("bad", "openai/gpt-oss-120b").decide(ctx)).rejects.toThrow("Groq HTTP 401");
  });

  it("returns the model reasoning alongside the validated decision", async () => {
    vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).include_reasoning).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "NO_ACTION", targetWethWeight: null, recheckMinutes: null, reason: "In band" }),
        reasoning: "Weight is 52%, inside 45-55, so nothing to do." } }] }), { status: 200 });
    });
    const r = await decideWithFallback([new GroqModel("k", "openai/gpt-oss-120b")], ctx, { ethMinPct: 45, ethMaxPct: 55, maxWaitMinutes: 60 });
    expect(r.ok && r.reasoning).toBe("Weight is 52%, inside 45-55, so nothing to do.");
  });
});

describe("GeminiModel reasoning", () => {
  it("separates thought parts from the JSON answer", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [
      { text: "Checking the band first.", thought: true }, { text: JSON.stringify({ decision: "NO_ACTION", reason: "In band" }) }] } }] }), { status: 200 }));
    const r = await new GeminiModel("k", "gemini-x").decideDetailed(ctx);
    expect(r.value).toEqual({ decision: "NO_ACTION", reason: "In band" });
    expect(r.reasoning).toBe("Checking the band first.");
  });
});