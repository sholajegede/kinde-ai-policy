import { describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, memoryStore, periodWindow, type Allowed, type Prepared } from "../src/index.js";
import { openaiCompatible } from "../src/openai-compatible.js";
import { makePolicy, MINI, SONNET, userToken } from "./fixtures.js";

const adapter = openaiCompatible();
const ask = (text: string, extra: Record<string, unknown> = {}) => ({ messages: [{ role: "user", content: text }], ...extra });

describe("periods", () => {
  it("uses UTC calendar windows, with weeks starting on Monday", () => {
    const t = new Date("2026-11-26T23:30:00Z");
    expect(periodWindow("day", t)).toEqual({ id: "2026-11-26", end: new Date("2026-11-27T00:00:00Z") });
    expect(periodWindow("week", t)).toEqual({ id: "week-of-2026-11-23", end: new Date("2026-11-30T00:00:00Z") });
    expect(periodWindow("month", new Date("2026-12-31T12:00:00Z"))).toEqual({ id: "2026-12", end: new Date("2027-01-01T00:00:00Z") });
  });
});

describe("memoryStore", () => {
  it("reserves all keys or none", async () => {
    const store = memoryStore();
    expect(await store.reserve("a", [{ key: "x", amount: 6, limit: 10, expiresAt: Infinity }], 1000)).toEqual({ ok: true });
    const r = await store.reserve("b", [
      { key: "y", amount: 1, limit: 10, expiresAt: Infinity },
      { key: "x", amount: 5, limit: 10, expiresAt: Infinity },
    ], 1000);
    expect(r).toEqual({ ok: false, key: "x", available: 4 });
    expect(await store.usage(["x", "y"])).toEqual({ x: { used: 0, reserved: 6 }, y: { used: 0, reserved: 0 } });
  });

  it("settles to what was spent and releases the rest", async () => {
    const store = memoryStore();
    await store.reserve("a", [{ key: "x", amount: 6, limit: 10, expiresAt: Infinity }], 1000);
    await store.settle("a", { x: 2 });
    await store.settle("a", { x: 2 });
    expect(await store.usage(["x"])).toEqual({ x: { used: 2, reserved: 0 } });
  });

  it("frees a reservation that is never settled after its time runs out", async () => {
    let t = 0;
    const store = memoryStore({ now: () => t });
    await store.reserve("a", [{ key: "x", amount: 10, limit: 10, expiresAt: Infinity }], 1000);
    expect((await store.reserve("b", [{ key: "x", amount: 1, limit: 10, expiresAt: Infinity }], 1000)).ok).toBe(false);
    t = 1001;
    expect((await store.reserve("b", [{ key: "x", amount: 1, limit: 10, expiresAt: Infinity }], 1000)).ok).toBe(true);
  });
});

describe("reserve and settle", () => {
  it("reserves the worst case across the fallback chain, then settles to real usage", async () => {
    const { ai, store } = makePolicy();
    const d = (await ai.decide({ token: await userToken({ plan: "pro" }) })) as Allowed;
    const call = (await ai.prepare(d, ask("hello there", { max_tokens: 1000 }), adapter)) as Prepared;
    expect(call.allowed).toBe(true);
    // 11 characters: ceil(11 / 3) + 4 = 8 input tokens. Sonnet is the most expensive model in the chain.
    const reservedMicros = Math.ceil(8 * 3 + 1000 * 15);
    const userUsd = d.budgets.find((b) => b.scope === "user" && b.unit === "usd")!;
    const userTokens = d.budgets.find((b) => b.unit === "tokens")!;
    expect(await store.usage([userUsd.key, userTokens.key])).toEqual({
      [userUsd.key]: { used: 0, reserved: reservedMicros },
      [userTokens.key]: { used: 0, reserved: 1008 },
    });

    const settled = await call.settle({ model: MINI, usage: { prompt_tokens: 12, completion_tokens: 40 } });
    expect(settled).toEqual({ model: MINI, inputTokens: 12, outputTokens: 40, costUsd: (12 * 0.25 + 40 * 2) / 1e6, charged: "actual" });
    expect(await store.usage([userUsd.key, userTokens.key])).toEqual({
      [userUsd.key]: { used: 83, reserved: 0 },
      [userTokens.key]: { used: 52, reserved: 0 },
    });
  });

  it("charges the gateway's reported cost when it has one", async () => {
    const { ai, store } = makePolicy();
    const d = (await ai.decide({ token: await userToken() })) as Allowed;
    const call = (await ai.prepare(d, ask("hi"), adapter)) as Prepared;
    await call.settle({ model: MINI, usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0123 } });
    expect((await store.usage([d.budgets[0]!.key]))[d.budgets[0]!.key]).toEqual({ used: 12_300, reserved: 0 });
  });

  it("charges the full reservation when usage is unknown, and nothing after release", async () => {
    const { ai, store } = makePolicy();
    const d = (await ai.decide({ token: await userToken() })) as Allowed;
    const key = d.budgets[0]!.key;
    const a = (await ai.prepare(d, ask("hi", { max_tokens: 100 }), adapter)) as Prepared;
    expect(await a.settle({ choices: [] })).toMatchObject({ charged: "reserved" });
    expect((await store.usage([key]))[key]!.used).toBe(Math.ceil(5 * 0.25 + 100 * 2));
    const b = (await ai.prepare(d, ask("hi", { max_tokens: 100 }), adapter)) as Prepared;
    await b.release();
    await expect(b.settle()).rejects.toThrow(/released/);
    expect((await store.usage([key]))[key]).toEqual({ used: 202, reserved: 0 });
  });

  it("refuses a call whose worst case does not fit, and says what is left", async () => {
    const tiny = definePolicy({ plan: { fallback: "p" }, plans: { p: { models: [MINI], maxOutputTokens: 1000, budgets: [{ scope: "org", tokens: 500, period: "day" }] } } });
    const ai = createAiPolicy({ policy: tiny });
    const d = (await ai.decide({ claims: { sub: "kp_a", org_code: "org_a" } })) as Allowed;
    const denied = await ai.prepare(d, ask("hi"), adapter);
    expect(denied).toMatchObject({ allowed: false, reason: "budget_exhausted", status: 429 });
    expect(denied.allowed === false && denied.detail).toContain("could use up to 1005 tokens");
    expect(await ai.prepare(d, ask("hi", { max_tokens: 400 }), adapter)).toMatchObject({ allowed: true });
  });

  it("never lets parallel calls past the limit", async () => {
    const policy = definePolicy({ plan: { fallback: "p" }, plans: { p: { models: [MINI], maxOutputTokens: 100, budgets: [{ scope: "org", tokens: 1000, period: "day" }] } } });
    const ai = createAiPolicy({ policy });
    const d = (await ai.decide({ claims: { sub: "kp_a", org_code: "org_a" } })) as Allowed;
    const results = await Promise.all(Array.from({ length: 50 }, () => ai.prepare(d, ask("hi"), adapter)));
    const ok = results.filter((r): r is Prepared => r.allowed);
    expect(ok).toHaveLength(9);
    await Promise.all(ok.map((c) => c.settle({ usage: { prompt_tokens: 50, completion_tokens: 60 } })));
    expect(await ai.decide({ claims: { sub: "kp_a", org_code: "org_a" } })).toMatchObject({ allowed: true, budgets: [{ remaining: 10 }] });
  });

  it("denies at decide once a budget is used up, until the period resets", async () => {
    let now = new Date("2026-11-30T23:59:00Z");
    const policy = definePolicy({ plan: { fallback: "p" }, plans: { p: { models: [MINI], maxOutputTokens: 100, budgets: [{ scope: "user", tokens: 150, period: "month" }] } } });
    const ai = createAiPolicy({ policy, now: () => now });
    const claims = { sub: "kp_a", org_code: "org_a" };
    const call = (await ai.prepare(await ai.decide({ claims }), ask("hi"), adapter)) as Prepared;
    await call.settle({ usage: { prompt_tokens: 100, completion_tokens: 50 } });
    const denied = await ai.decide({ claims });
    expect(denied).toMatchObject({ allowed: false, reason: "budget_exhausted", retryAt: "2026-12-01T00:00:00.000Z" });
    if (denied.allowed) return;
    expect(ai.toResponse(denied).headers.get("retry-after")).toBe("60");
    now = new Date("2026-12-01T00:00:01Z");
    expect(await ai.decide({ claims })).toMatchObject({ allowed: true });
  });

  it("keeps organizations and users apart", async () => {
    const { ai } = makePolicy();
    const alice = (await ai.decide({ token: await userToken({ plan: "pro" }) })) as Allowed;
    const bob = (await ai.decide({ token: await userToken({ plan: "pro", sub: "kp_bob", org: "org_globex" }) })) as Allowed;
    const keys = new Set([...alice.budgets, ...bob.budgets].map((b) => b.key));
    expect(keys.size).toBe(6);
  });

  it("refuses a request model outside the decision", async () => {
    const { ai } = makePolicy();
    const d = (await ai.decide({ token: await userToken() })) as Allowed;
    expect(await ai.prepare(d, ask("hi", { model: SONNET }), adapter)).toMatchObject({ allowed: false, reason: "model_not_allowed" });
  });
});
