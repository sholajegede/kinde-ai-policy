import { generateText, streamText, wrapLanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { aiPolicyMiddleware, PolicyDeniedError } from "../src/ai-sdk.js";
import type { Allowed } from "../src/index.js";
import { makePolicy, MINI, OPUS, SONNET, userToken } from "./fixtures.js";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

function generating(modelId: string, opts: { input?: number; output?: number; cost?: string; fail?: boolean } = {}) {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => {
      if (opts.fail) throw new Error("upstream failed");
      return {
        content: [{ type: "text", text: "hi" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(opts.input ?? 12, opts.output ?? 40),
        warnings: [],
        response: { modelId },
        ...(opts.cost ? { providerMetadata: { gateway: { cost: opts.cost } } } : {}),
      };
    },
  });
}

async function setup(plan = "pro") {
  const { ai, store } = makePolicy();
  const decision = (await ai.decide({ token: await userToken({ plan }) })) as Allowed;
  const used = async () => {
    const key = decision.budgets.find((b) => b.scope === "user" && b.unit === "usd")?.key ?? decision.budgets[0]!.key;
    return (await store.usage([key]))[key]!;
  };
  return { ai, decision, used };
}

describe("aiPolicyMiddleware with generateText", () => {
  it("caps output tokens, sends gateway options, and settles from the usage the call reports", async () => {
    const { ai, decision, used } = await setup();
    const model = generating(SONNET);
    await generateText({
      model: wrapLanguageModel({ model, middleware: aiPolicyMiddleware(ai, decision, { gateway: "vercel", user: true, tags: true }) }),
      prompt: "Say hi",
      maxOutputTokens: 50_000,
      providerOptions: { gateway: { order: ["anthropic"] } },
    });
    const call = model.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(8192);
    expect(call.providerOptions).toEqual({
      gateway: { order: ["anthropic"], models: [MINI], user: "kp_alice", tags: ["plan:pro", "org:org_acme"] },
    });
    expect(await used()).toEqual({ used: 12 * 3 + 40 * 15, reserved: 0 });
  });

  it("leaves the user and tags out unless asked, and prices the model the gateway routed to", async () => {
    const { ai, decision, used } = await setup();
    const model = new MockLanguageModelV4({
      modelId: SONNET,
      doGenerate: async () => ({
        content: [{ type: "text", text: "hi" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(10, 20),
        warnings: [],
        response: { modelId: SONNET },
        providerMetadata: { gateway: { routing: { canonicalSlug: MINI } } },
      }),
    });
    await generateText({ model: wrapLanguageModel({ model, middleware: aiPolicyMiddleware(ai, decision, { gateway: "vercel" }) }), prompt: "x" });
    expect(model.doGenerateCalls[0]!.providerOptions).toEqual({ gateway: { models: [MINI] } });
    expect((await used()).used).toBe(Math.ceil(10 * 0.25 + 20 * 2));
  });

  it("charges the cost the gateway reports", async () => {
    const { ai, decision, used } = await setup();
    await generateText({ model: wrapLanguageModel({ model: generating(SONNET, { cost: "0.0021" }), middleware: aiPolicyMiddleware(ai, decision) }), prompt: "x" });
    expect((await used()).used).toBe(2100);
  });

  it("refuses a model the decision does not allow, before calling it", async () => {
    const { ai, decision } = await setup();
    const model = generating(OPUS);
    const error = await generateText({ model: wrapLanguageModel({ model, middleware: aiPolicyMiddleware(ai, decision) }), prompt: "x", maxRetries: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).denied).toMatchObject({ reason: "model_not_allowed", status: 403 });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("returns the reservation when the call fails", async () => {
    const { ai, decision, used } = await setup();
    await expect(
      generateText({ model: wrapLanguageModel({ model: generating(SONNET, { fail: true }), middleware: aiPolicyMiddleware(ai, decision) }), prompt: "x", maxRetries: 0 }),
    ).rejects.toThrow(/upstream failed/);
    expect(await used()).toEqual({ used: 0, reserved: 0 });
  });

  it("throws at once for a denied decision", async () => {
    const { ai } = makePolicy();
    const denied = await ai.decide({ token: null });
    expect(() => aiPolicyMiddleware(ai, denied)).toThrow(PolicyDeniedError);
  });
});

describe("aiPolicyMiddleware with streamText", () => {
  it("settles when the stream finishes, from the model that answered", async () => {
    const { ai, decision, used } = await setup();
    const model = new MockLanguageModelV4({
      modelId: SONNET,
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "r1", modelId: MINI, timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "hello" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(10, 20) },
        ]),
      }),
    });
    const result = streamText({ model: wrapLanguageModel({ model, middleware: aiPolicyMiddleware(ai, decision) }), prompt: "x" });
    expect(await result.text).toBe("hello");
    // The fallback model answered, so it is priced as gpt-5-mini.
    expect(await used()).toEqual({ used: Math.ceil(10 * 0.25 + 20 * 2), reserved: 0 });
  });
});
