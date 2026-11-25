import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, type Allowed, type Prepared } from "../../src/index.js";
import { portkey } from "../../src/portkey.js";
import { freePort, startProcess, startUpstream } from "./upstream.js";

// Portkey's open-source gateway, from the @portkey-ai/gateway dev dependency, in front of a local provider.
const require = createRequire(import.meta.url);
const server = require.resolve("@portkey-ai/gateway/build/start-server.js");

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gateway: Awaited<ReturnType<typeof startProcess>>;
let gatewayUrl: string;

beforeAll(async () => {
  upstream = await startUpstream();
  const port = await freePort();
  gateway = await startProcess(process.execPath, [server, `--port=${port}`], `http://127.0.0.1:${port}/`);
  gatewayUrl = `http://127.0.0.1:${port}/v1`;
}, 120_000);

afterAll(async () => {
  gateway?.stop();
  await upstream?.close();
});

const target = () => ({ provider: "openai", api_key: "sk-local", custom_host: upstream.url });

async function send(models: string[]) {
  const policy = definePolicy({
    plan: { fallback: "local" },
    plans: { local: { models, fallbacks: models.slice(1), maxOutputTokens: 64 } },
  });
  const ai = createAiPolicy({ policy, pricing: Object.fromEntries(models.map((m) => [m, { input: 1, output: 2 }])) });
  const decision = (await ai.decide({ claims: { sub: "kp_local", org_code: "org_local" } })) as Allowed;
  const call = (await ai.prepare(decision, { messages: [{ role: "user", content: "hi" }], max_tokens: 5000 }, portkey({ baseUrl: gatewayUrl, target }))) as Prepared;
  const res = await fetch(call.url!, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { call, res, body, settled: await call.settle(body, res.headers) };
}

describe("Portkey open-source gateway (local)", () => {
  it("routes through the target config with the capped max_tokens, and settles from the usage", async () => {
    const before = upstream.requests.length;
    const { call, settled } = await send(["backup-model"]);
    expect(JSON.parse(call.headers["x-portkey-metadata"]!)).toEqual({ _user: "kp_local", plan: "local", org: "org_local" });
    const sent = upstream.requests.slice(before);
    expect(sent.map((r) => r.body.model)).toEqual(["backup-model"]);
    expect(sent[0]!.body.max_tokens).toBe(64);
    expect(settled).toMatchObject({ model: "backup-model", inputTokens: 20, outputTokens: 5, charged: "actual" });
  });

  it("falls back to the next target when the first model fails", async () => {
    const before = upstream.requests.length;
    const { res, settled } = await send(["broken-primary", "backup-model"]);
    expect(upstream.requests.slice(before).map((r) => r.body.model)).toEqual(["broken-primary", "backup-model"]);
    expect(res.headers.get("x-portkey-last-used-option-index")).toBe("config.targets[1]");
    expect(settled.model).toBe("backup-model");
  });
});
