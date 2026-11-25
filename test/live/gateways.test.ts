import { gateway, generateText, wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { aiPolicyMiddleware } from "../../src/ai-sdk.js";
import { createAiPolicy, definePolicy, memoryStore, type Allowed, type GatewayAdapter, type Prepared } from "../../src/index.js";
import { openrouter } from "../../src/openrouter.js";
import { vercelGateway } from "../../src/vercel.js";

// Real calls to real gateways, with a cheap model and a 16-token cap. Keys come from .env.local.
// The fallback tests put a model that does not exist first, so an answer proves the gateway fell back.
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const VERCEL_KEY = process.env.AI_GATEWAY_API_KEY;
const REAL = process.env.LIVE_MODEL ?? "openai/gpt-4o-mini";
const MISSING = "kinde-ai-policy/model-that-does-not-exist";
const PROMPT = [{ role: "user", content: "Reply with the single word OK." }];

function engine(models: string[]) {
  const store = memoryStore();
  const policy = definePolicy({
    plan: { fallback: "live" },
    plans: { live: { models, fallbacks: models.slice(1), maxOutputTokens: 16, budgets: [{ scope: "org", usd: 0.05, period: "day" }] } },
  });
  const pricing = Object.fromEntries(models.map((m) => [m, { input: 1, output: 4 }]));
  return { ai: createAiPolicy({ policy, pricing, store }), store };
}

async function call(models: string[], adapter: GatewayAdapter) {
  const { ai, store } = engine(models);
  const decision = (await ai.decide({ claims: { sub: "kp_live", org_code: "org_live" } })) as Allowed;
  const prepared = (await ai.prepare(decision, { messages: PROMPT }, adapter)) as Prepared;
  const res = await fetch(prepared.url!, { method: "POST", headers: prepared.headers, body: JSON.stringify(prepared.body) });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(`${adapter.name} ${res.status}:`, JSON.stringify(body).slice(0, 1500));
  expect(res.status, JSON.stringify(body)).toBe(200);
  const settled = await prepared.settle(body);
  console.log(`${adapter.name} settled:`, JSON.stringify(settled));
  const key = decision.budgets[0]!.key;
  return { body, settled, usage: (await store.usage([key]))[key]! };
}

describe.skipIf(!OPENROUTER_KEY)("OpenRouter (live)", () => {
  it("answers within the cap and settles the reported cost", async () => {
    const { body, settled, usage } = await call([REAL], openrouter({ apiKey: OPENROUTER_KEY! }));
    expect(String(body.model)).toContain(REAL.split("/")[1]!);
    expect(settled.charged).toBe("actual");
    expect(settled.outputTokens).toBeLessThanOrEqual(16);
    expect(usage.reserved).toBe(0);
  });

  // OpenRouter checks every model ID before routing, so a missing model cannot test a fallback: the request fails with 400.
  // A missing model in the fallback list gets the same 400 naming it, which proves OpenRouter reads the models field.
  it("reads the fallback list the adapter sends", async () => {
    const { ai } = engine([REAL, MISSING]);
    const decision = (await ai.decide({ claims: { sub: "kp_live", org_code: "org_live" } })) as Allowed;
    const prepared = (await ai.prepare(decision, { messages: PROMPT }, openrouter({ apiKey: OPENROUTER_KEY! }))) as Prepared;
    expect(prepared.body.models).toEqual([MISSING]);
    const res = await fetch(prepared.url!, { method: "POST", headers: prepared.headers, body: JSON.stringify(prepared.body) });
    const body = await res.text();
    console.log(`openrouter ${res.status}:`, body);
    await prepared.release();
    expect(res.status).toBe(400);
    expect(body).toContain(MISSING);
  });
});

describe.skipIf(!VERCEL_KEY)("Vercel AI Gateway (live)", () => {
  it("answers within the cap and settles", async () => {
    const { body, settled, usage } = await call([REAL], vercelGateway({ apiKey: VERCEL_KEY! }));
    expect(String(body.model)).toContain(REAL.split("/")[1]!);
    expect(settled.charged).toBe("actual");
    expect(settled.outputTokens).toBeLessThanOrEqual(16);
    expect(usage.reserved).toBe(0);
  });

  it("falls back when the first model does not exist, and settles the total Vercel debited", async () => {
    const { body, settled } = await call([MISSING, REAL], vercelGateway({ apiKey: VERCEL_KEY! }));
    expect(String(body.model)).toContain(REAL.split("/")[1]!);
    const gateway = (body.choices as Array<{ message: { provider_metadata: { gateway: { gatewayCost: string } } } }>)[0]!.message.provider_metadata.gateway;
    // Reported costs are rounded up to the next millionth of a dollar.
    expect(settled.costUsd).toBeGreaterThanOrEqual(Number(gateway.gatewayCost));
    expect(settled.costUsd! - Number(gateway.gatewayCost)).toBeLessThan(0.000001);
  });

  it("works through the AI SDK middleware, with fallbacks sent in providerOptions", async () => {
    const { ai, store } = engine([MISSING, REAL]);
    const decision = (await ai.decide({ claims: { sub: "kp_live", org_code: "org_live" } })) as Allowed;
    const result = await generateText({
      model: wrapLanguageModel({ model: gateway(MISSING), middleware: aiPolicyMiddleware(ai, decision, { gateway: "vercel" }) }),
      prompt: "Reply with the single word OK.",
      maxRetries: 0,
    });
    const meta = result.providerMetadata?.gateway as { routing?: { canonicalSlug?: string }; gatewayCost?: string } | undefined;
    console.log("ai-sdk:", JSON.stringify({ text: result.text, served: meta?.routing?.canonicalSlug, gatewayCost: meta?.gatewayCost }));
    expect(meta?.routing?.canonicalSlug).toBe(REAL);
    expect(result.text.length).toBeGreaterThan(0);
    const key = decision.budgets[0]!.key;
    expect((await store.usage([key]))[key]).toMatchObject({ reserved: 0 });
    expect((await store.usage([key]))[key]!.used).toBeGreaterThan(0);
  });
});
