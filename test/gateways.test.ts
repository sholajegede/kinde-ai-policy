import { describe, expect, it } from "vitest";
import type { Allowed } from "../src/index.js";
import { readOpenAIUsage } from "../src/index.js";
import { openrouter } from "../src/openrouter.js";
import { vercelGateway } from "../src/vercel.js";
import { makePolicy, MINI, SONNET, testkit, userToken } from "./fixtures.js";

const ask = { messages: [{ role: "user", content: "Say hi" }], max_tokens: 50_000 };

async function proDecision() {
  const { ai, store } = makePolicy();
  return { ai, store, decision: (await ai.decide({ token: await userToken({ plan: "pro" }) })) as Allowed };
}

describe("openrouter adapter", () => {
  it("sends fallbacks in models, turns on usage accounting, and caps max_tokens", async () => {
    const { ai, decision } = await proDecision();
    const call = await ai.prepare(decision, ask, openrouter({ apiKey: "sk-or-test", app: { url: "https://acme.test", title: "Acme" } }));
    if (!call.allowed) throw new Error(call.detail);
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers).toMatchObject({ authorization: "Bearer sk-or-test", "HTTP-Referer": "https://acme.test", "X-Title": "Acme" });
    expect(call.body).toEqual({ messages: ask.messages, model: SONNET, models: [MINI], max_tokens: 8192, usage: { include: true }, user: "kp_alice" });
  });

  it("sends no models field when there is no fallback, and settles the cost OpenRouter reports", async () => {
    const { ai, decision, store } = await proDecision();
    const call = await ai.prepare(decision, { ...ask, model: MINI }, openrouter());
    if (!call.allowed) throw new Error(call.detail);
    expect(call.body).not.toHaveProperty("models");
    await call.settle({ model: MINI, usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.00001 } });
    const key = decision.budgets[0]!.key;
    expect((await store.usage([key]))[key]).toEqual({ used: 10, reserved: 0 });
  });
});

describe("vercelGateway adapter", () => {
  it("sends fallbacks, the user and tags in providerOptions.gateway and keeps the caller's own gateway options", async () => {
    const { ai, decision } = await proDecision();
    const call = await ai.prepare(decision, { ...ask, providerOptions: { gateway: { order: ["bedrock"], tags: ["feature:chat"] } } }, vercelGateway({ apiKey: "vck_test", sendUser: true, sendTags: true }));
    if (!call.allowed) throw new Error(call.detail);
    expect(call.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(call.body).toEqual({
      messages: ask.messages,
      model: SONNET,
      max_tokens: 8192,
      providerOptions: { gateway: { order: ["bedrock"], tags: ["feature:chat", "plan:pro", "org:org_acme"], models: [MINI], user: "kp_alice" } },
    });
  });

  it("sends no user or tags unless asked, because Vercel charges for them", async () => {
    const { ai, decision } = await proDecision();
    const call = await ai.prepare(decision, ask, vercelGateway());
    if (!call.allowed) throw new Error(call.detail);
    expect(call.body.providerOptions).toEqual({ gateway: { models: [MINI] } });
  });

  it("tags an M2M agent's calls with its client ID", async () => {
    const { ai } = makePolicy();
    const decision = (await ai.decide({ token: await testkit.m2mToken({ clientId: "triage_bot", organizationCode: "org_acme" }) })) as Allowed;
    const call = await ai.prepare(decision, ask, vercelGateway({ sendUser: true, sendTags: true }));
    if (!call.allowed) throw new Error(call.detail);
    expect(call.body.providerOptions).toEqual({ gateway: { user: "triage_bot", tags: ["plan:free", "org:org_acme", "agent:triage_bot"] } });
  });
});

describe("readOpenAIUsage", () => {
  it("reads a cost from usage.cost or from gateway provider metadata", () => {
    expect(readOpenAIUsage({ model: "m", usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.5 } })).toEqual({ model: "m", inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
    expect(readOpenAIUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 }, providerMetadata: { gateway: { cost: "0.25" } } })).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0.25 });
    expect(readOpenAIUsage({ choices: [] })).toBeNull();
  });

  it("reads Vercel's total debited cost and the model it routed to from the message metadata", () => {
    // Trimmed from a real Vercel AI Gateway response on 2026-11-25, after a fallback.
    const response = {
      model: "openai/gpt-4o-mini",
      choices: [{ message: { content: "OK", provider_metadata: { gateway: { routing: { canonicalSlug: "openai/gpt-4o-mini" }, cost: "0.0000033", gatewayCost: "0.0002283" } } } }],
      usage: { prompt_tokens: 14, completion_tokens: 2, cost: 0.0000033 },
    };
    expect(readOpenAIUsage(response)).toEqual({ model: "openai/gpt-4o-mini", inputTokens: 14, outputTokens: 2, costUsd: 0.0002283 });
  });
});

describe("litellm adapter", () => {
  it("sends fallbacks, the user and tags, and reads the cost header", async () => {
    const { litellm } = await import("../src/litellm.js");
    const { ai, decision } = await proDecision();
    const adapter = litellm({ baseUrl: "http://localhost:4000/", apiKey: "sk-master" });
    const call = await ai.prepare(decision, ask, adapter);
    if (!call.allowed) throw new Error(call.detail);
    expect(call.url).toBe("http://localhost:4000/chat/completions");
    expect(call.body).toEqual({ messages: ask.messages, model: SONNET, max_tokens: 8192, fallbacks: [MINI], user: "kp_alice", metadata: { tags: ["plan:pro", "org:org_acme"] } });
    const usage = adapter.readUsage({ model: SONNET, usage: { prompt_tokens: 3, completion_tokens: 4 } }, new Headers({ "x-litellm-response-cost": "0.0042" }));
    expect(usage).toEqual({ model: SONNET, inputTokens: 3, outputTokens: 4, costUsd: 0.0042 });
  });
});

describe("portkey adapter", () => {
  it("sends the model and its fallbacks as a fallback config, one target per model, with metadata", async () => {
    const { portkey } = await import("../src/portkey.js");
    const { ai, decision } = await proDecision();
    const call = await ai.prepare(decision, ask, portkey({ apiKey: "pk-test", target: () => ({ provider: "@openrouter-prod", override_params: { temperature: 0 } }), onStatusCodes: [429, 500] }));
    if (!call.allowed) throw new Error(call.detail);
    expect(call.url).toBe("https://api.portkey.ai/v1/chat/completions");
    expect(call.headers["x-portkey-api-key"]).toBe("pk-test");
    expect(JSON.parse(call.headers["x-portkey-config"]!)).toEqual({
      strategy: { mode: "fallback", on_status_codes: [429, 500] },
      targets: [
        { provider: "@openrouter-prod", override_params: { temperature: 0, model: SONNET } },
        { provider: "@openrouter-prod", override_params: { temperature: 0, model: MINI } },
      ],
    });
    expect(JSON.parse(call.headers["x-portkey-metadata"]!)).toEqual({ _user: "kp_alice", plan: "pro", org: "org_acme" });
  });

  it("sends a single target without a strategy, and no config without a target function", async () => {
    const { portkey } = await import("../src/portkey.js");
    const { ai, decision } = await proDecision();
    const single = await ai.prepare(decision, { ...ask, model: MINI }, portkey({ target: () => ({ provider: "openai" }) }));
    if (!single.allowed) throw new Error(single.detail);
    expect(JSON.parse(single.headers["x-portkey-config"]!)).toEqual({ provider: "openai", override_params: { model: MINI } });
    const bare = await ai.prepare(decision, ask, portkey({ sendMetadata: false }));
    if (!bare.allowed) throw new Error(bare.detail);
    expect(bare.headers).not.toHaveProperty("x-portkey-config");
    expect(bare.headers).not.toHaveProperty("x-portkey-metadata");
  });
});
