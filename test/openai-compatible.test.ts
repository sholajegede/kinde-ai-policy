import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Allowed, Prepared } from "../src/index.js";
import { openaiCompatible } from "../src/openai-compatible.js";
import { makePolicy, MINI, SONNET, userToken } from "./fixtures.js";

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

// A small OpenAI-compatible server. It records each request and answers with usage, streamed or not.
const received: Received[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ headers: req.headers, body });
      if (req.url !== "/v1/chat/completions") return void res.writeHead(404).end();
      const usage = { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "Hi" } }] })}\n\n`);
        const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage;
        if (includeUsage) res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage })}\n\n`);
        return void res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-1", model: body.model, choices: [{ message: { role: "assistant", content: "Hi" } }], usage }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function send(call: Prepared) {
  return fetch(call.url!, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
}

describe("openai-compatible adapter against a real HTTP server", () => {
  it("sends the decided model, the capped max tokens and the user, then settles from the response", async () => {
    const { ai, store } = makePolicy();
    const adapter = openaiCompatible({ baseUrl, apiKey: "sk-test" });
    const d = (await ai.decide({ token: await userToken({ plan: "pro" }) })) as Allowed;
    const call = (await ai.prepare(d, { messages: [{ role: "user", content: "Say hi" }], max_tokens: 50_000, temperature: 0.2 }, adapter)) as Prepared;
    const res = await send(call);
    const settled = await call.settle(await res.json());

    const last = received.at(-1)!;
    expect(last.headers.authorization).toBe("Bearer sk-test");
    expect(last.body).toEqual({ messages: [{ role: "user", content: "Say hi" }], model: SONNET, max_tokens: 8192, temperature: 0.2, user: "kp_alice" });
    expect(settled).toEqual({ model: SONNET, inputTokens: 21, outputTokens: 7, costUsd: (21 * 3 + 7 * 15) / 1e6, charged: "actual" });
    const tokens = d.budgets.find((b) => b.unit === "tokens")!;
    expect((await store.usage([tokens.key]))[tokens.key]).toEqual({ used: 28, reserved: 0 });
  });

  it("asks for usage on streams and settles from the last chunk", async () => {
    const { ai } = makePolicy();
    const adapter = openaiCompatible({ baseUrl, maxTokensField: "max_completion_tokens" });
    const d = (await ai.decide({ token: await userToken() })) as Allowed;
    const call = (await ai.prepare(d, { messages: [{ role: "user", content: "Say hi" }], stream: true, max_tokens: 64 }, adapter)) as Prepared;
    const text = await (await send(call)).text();
    const chunks = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)) as unknown);

    expect(received.at(-1)!.body).toMatchObject({ model: MINI, max_completion_tokens: 64, stream: true, stream_options: { include_usage: true } });
    expect(received.at(-1)!.body).not.toHaveProperty("max_tokens");
    expect(await call.settle(chunks.at(-1))).toMatchObject({ inputTokens: 21, outputTokens: 7, charged: "actual" });
  });

  it("sends the agent client ID as the user, with the lower of the plan and agent output caps", async () => {
    const { ai } = makePolicy();
    const d = (await ai.decide({ claims: { gty: ["client_credentials"], azp: "triage_bot", org_code: "org_acme" } })) as Allowed;
    const call = (await ai.prepare(d, { messages: [{ role: "user", content: "x" }] }, openaiCompatible({ baseUrl }))) as Prepared;
    await call.settle(await (await send(call)).json());
    expect(received.at(-1)!.body).toMatchObject({ model: MINI, max_tokens: 1024, user: "triage_bot" });
  });
});
