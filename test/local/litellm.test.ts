import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, type Allowed, type Prepared } from "../../src/index.js";
import { litellm } from "../../src/litellm.js";
import { freePort, startProcess, startUpstream } from "./upstream.js";

// A real LiteLLM proxy, run from the `litellm` command (pip install 'litellm[proxy]'), in front of a local provider.
// Set LITELLM_BIN to the command's path if it is not on PATH. The tests skip without it.
const bin = process.env.LITELLM_BIN ?? "litellm";
const available = spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;

let upstream: Awaited<ReturnType<typeof startUpstream>>;
let proxy: Awaited<ReturnType<typeof startProcess>>;
let proxyUrl: string;
// LiteLLM refuses to start without a master key, so the proxy gets a local one and the adapter sends it.
const MASTER_KEY = "sk-kinde-ai-policy-local";

beforeAll(async () => {
  if (!available) return;
  upstream = await startUpstream();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "kap-litellm-"));
  const config = join(dir, "config.yaml");
  const deployment = (name: string, model: string) => `  - model_name: ${name}
    litellm_params:
      model: openai/${model}
      api_base: ${upstream.url}
      api_key: sk-local
      input_cost_per_token: 0.000001
      output_cost_per_token: 0.000002
`;
  writeFileSync(config, `model_list:\n${deployment("primary", "broken-primary")}${deployment("backup", "backup-model")}litellm_settings:\n  num_retries: 0\ngeneral_settings:\n  master_key: ${MASTER_KEY}\n`);
  proxy = await startProcess(bin, ["--config", config, "--host", "127.0.0.1", "--port", String(port)], `http://127.0.0.1:${port}/health/liveliness`);
  proxyUrl = `http://127.0.0.1:${port}`;
}, 180_000);

afterAll(async () => {
  proxy?.stop();
  await upstream?.close();
});

function engine(models: string[]) {
  const policy = definePolicy({
    plan: { fallback: "local" },
    plans: { local: { models, fallbacks: models.slice(1), maxOutputTokens: 64, budgets: [{ scope: "org", usd: 1, period: "day" }] } },
  });
  return createAiPolicy({ policy, pricing: Object.fromEntries(models.map((m) => [m, { input: 1, output: 2 }])) });
}

async function send(models: string[], request: Record<string, unknown> = {}) {
  const ai = engine(models);
  const decision = (await ai.decide({ claims: { sub: "kp_local", org_code: "org_local" } })) as Allowed;
  const call = (await ai.prepare(decision, { messages: [{ role: "user", content: "hi" }], max_tokens: 5000, ...request }, litellm({ baseUrl: proxyUrl, apiKey: MASTER_KEY }))) as Prepared;
  const res = await fetch(call.url!, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { call, res, body, settled: await call.settle(body, res.headers) };
}

describe.skipIf(!available)("LiteLLM proxy (local)", () => {
  it("passes the capped max_tokens to the provider, and settles LiteLLM's reported cost", async () => {
    const before = upstream.requests.length;
    const { call, res, settled } = await send(["backup"]);
    // LiteLLM keeps the user for its own end-user tracking and does not pass it to the provider.
    expect(call.body).toMatchObject({ model: "backup", max_tokens: 64, user: "kp_local" });
    const sent = upstream.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ model: "backup-model", max_tokens: 64 });
    // 20 input tokens at $0.000001 and 5 output tokens at $0.000002, as configured in the proxy.
    expect(res.headers.get("x-litellm-response-cost")).not.toBeNull();
    expect(settled).toMatchObject({ inputTokens: 20, outputTokens: 5, costUsd: 0.00003, charged: "actual" });
  });

  it("falls back to the next model when the first one fails", async () => {
    const before = upstream.requests.length;
    const { body } = await send(["primary", "backup"]);
    const sent = upstream.requests.slice(before).map((r) => r.body.model);
    expect(sent).toEqual(["broken-primary", "backup-model"]);
    expect((body as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("OK");
  });

  it("accepts the plan and organization tags in metadata", async () => {
    const { call } = await send(["backup"], { metadata: { tags: ["feature:chat"] } });
    expect(call.body.metadata).toEqual({ tags: ["feature:chat", "plan:local", "org:org_local"] });
  });
});
