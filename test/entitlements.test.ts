import { startKindeTestkit, type RunningKindeTestkit } from "kinde-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, kindeAccountApi, type Allowed, type EntitlementsSource } from "../src/index.js";
import { AUDIENCE, MINI, pricing, SONNET } from "./fixtures.js";

// Entitlements come from kinde-testkit's Account API over HTTP, seeded the way Kinde billing reports them.
let issuer: RunningKindeTestkit;

beforeAll(async () => {
  issuer = await startKindeTestkit({
    port: 0,
    audience: [AUDIENCE],
    seed: {
      organizations: [{ code: "org_acme" }, { code: "org_globex" }, { code: "org_initech" }],
      users: [
        { id: "kp_alice", email: "alice@acme.test" },
        { id: "kp_bob", email: "bob@globex.test" },
        { id: "kp_carol", email: "carol@initech.test" },
      ],
      memberships: [
        { user: "kp_alice", organization: "org_acme" },
        { user: "kp_bob", organization: "org_globex" },
        { user: "kp_carol", organization: "org_initech" },
      ],
      plans: [
        {
          key: "pro",
          subscribers: ["org_acme"],
          entitlements: [
            { featureKey: "ai_monthly_usd", limitMax: 250 },
            { featureKey: "ai_max_output", limitMax: 16000 },
            { featureKey: "ai_daily_tokens", limitMax: 2147483647 },
            { featureKey: "ai_weekly_usd", limitMax: null },
            { featureKey: "seats", limitMax: 10 },
          ],
        },
        { key: "enterprise", subscribers: ["org_globex"], entitlements: [{ featureKey: "ai_monthly_usd", limitMax: 5000 }] },
      ],
    },
  });
});
afterAll(async () => {
  await issuer.close();
});

const policy = definePolicy({
  plan: { from: [{ billing: true }], fallback: "free" },
  plans: {
    free: { models: [MINI], maxOutputTokens: 1024, budgets: [{ scope: "org", usd: 2, period: "month" }] },
    pro: {
      models: [SONNET, MINI],
      fallbacks: [MINI],
      maxOutputTokens: 4096,
      budgets: [
        { scope: "org", usd: 100, period: "month" },
        { scope: "user", tokens: 500_000, period: "day" },
      ],
    },
  },
  entitlements: {
    ai_monthly_usd: "budgets.org.usd.month",
    ai_max_output: "maxOutputTokens",
    ai_daily_tokens: "budgets.user.tokens.day",
    ai_weekly_usd: "budgets.org.usd.week",
  },
  properties: { ai_monthly_usd_override: "budgets.org.usd.month" },
  agents: { default: { budgets: [{ scope: "agent", usd: 1, period: "day" }] } },
});

function counting() {
  const calls: string[] = [];
  const f: typeof fetch = (input, init) => {
    calls.push(String(input));
    return fetch(input, init);
  };
  return { calls, fetch: f };
}

const make = (extra: Partial<Parameters<typeof createAiPolicy>[0]> = {}) =>
  createAiPolicy({ policy, issuer: issuer.issuer, audience: AUDIENCE, pricing, entitlements: kindeAccountApi({ issuer: issuer.issuer }), ...extra });
const tokenFor = (sub: string, org: string, claims: Record<string, unknown> = {}) => issuer.testkit.token({ subject: sub, organizationCode: org, claims });

describe("plans and limits from Kinde's Account API", () => {
  it("takes the plan and limits from the Account API", async () => {
    const { decision, steps } = await make().explain({ token: await tokenFor("kp_alice", "org_acme") });
    const d = decision as Allowed;
    expect(d).toMatchObject({ allowed: true, plan: "pro", model: SONNET, maxOutputTokens: 16000 });
    expect(d.budgets.map((b) => `${b.scope}:${b.unit}:${b.period}:${b.limit}`)).toEqual(["org:usd:month:250"]);
    expect(steps).toEqual([
      "Verified the access token.",
      "Caller is user kp_alice in org_acme.",
      "Read Kinde billing: plan pro, 5 entitlements.",
      'Plan "pro" comes from Kinde billing.',
      'Kinde entitlement "ai_monthly_usd" sets the monthly org budget to $250.00.',
      'Kinde entitlement "ai_max_output" sets maxOutputTokens to 16000.',
      'Kinde entitlement "ai_daily_tokens" is unlimited, so the daily user tokens budget is removed.',
      'Kinde entitlement "ai_weekly_usd" has no limit, so the plan\'s value stays.',
      "Checked 1 budget.",
      `Allowed ${SONNET} on plan "pro".`,
    ]);
  });

  it("skips a billing plan the policy does not have and uses the fallback plan", async () => {
    const { decision, steps } = await make().explain({ token: await tokenFor("kp_bob", "org_globex") });
    expect(decision).toMatchObject({ allowed: true, plan: "free", budgets: [{ limit: 5000 }] });
    expect(steps).toContain('Skipped Kinde billing: "enterprise" is not a plan in the policy.');
  });

  it("uses the fallback plan for an organization with no subscription", async () => {
    const d = (await make().decide({ token: await tokenFor("kp_carol", "org_initech") })) as Allowed;
    expect(d).toMatchObject({ plan: "free", maxOutputTokens: 1024, budgets: [{ limit: 2 }] });
  });

  it("lets an organization property override a limit", async () => {
    const token = await tokenFor("kp_alice", "org_acme", { organization_properties: { ai_monthly_usd_override: { v: "400" } } });
    expect(await make().decide({ token })).toMatchObject({ budgets: [{ scope: "org", limit: 400 }] });
  });

  it("reads every page", async () => {
    const counter = counting();
    const ai = make({ entitlements: kindeAccountApi({ issuer: issuer.issuer, fetch: counter.fetch, pageSize: 2 }) });
    expect(await ai.decide({ token: await tokenFor("kp_alice", "org_acme") })).toMatchObject({ maxOutputTokens: 16000, budgets: [{ limit: 250 }] });
    expect(counter.calls).toHaveLength(3);
    expect(counter.calls[1]).toContain("starting_after=");
  });

  it("reuses a lookup until it expires, and shares one request between parallel calls", async () => {
    let now = new Date("2026-11-24T12:00:00Z");
    const counter = counting();
    const ai = make({ now: () => now, entitlements: kindeAccountApi({ issuer: issuer.issuer, fetch: counter.fetch }) });
    const token = await tokenFor("kp_alice", "org_acme");
    await Promise.all(Array.from({ length: 10 }, () => ai.decide({ token })));
    expect(counter.calls).toHaveLength(1);
    now = new Date("2026-11-24T12:00:59Z");
    await ai.decide({ token });
    expect(counter.calls).toHaveLength(1);
    now = new Date("2026-11-24T12:01:01Z");
    await ai.decide({ token });
    expect(counter.calls).toHaveLength(2);
  });

  it("keeps the last answer while Kinde is unreachable, then denies with 503", async () => {
    let now = new Date("2026-11-24T12:00:00Z");
    let down = false;
    const real = kindeAccountApi({ issuer: issuer.issuer });
    const source: EntitlementsSource = async (ctx) => {
      if (down) throw new Error("connect ECONNREFUSED");
      return real(ctx);
    };
    const ai = make({ now: () => now, entitlements: source });
    const token = await tokenFor("kp_alice", "org_acme");
    expect(await ai.decide({ token })).toMatchObject({ plan: "pro" });

    down = true;
    now = new Date("2026-11-24T12:30:00Z");
    const { decision, steps } = await ai.explain({ token });
    expect(decision).toMatchObject({ allowed: true, plan: "pro" });
    expect(steps).toContain("Kinde billing could not be reached (connect ECONNREFUSED), so its last answer applies.");

    now = new Date("2026-11-24T13:01:00Z");
    const denied = await ai.decide({ token });
    expect(denied).toMatchObject({ allowed: false, reason: "entitlements_unavailable", status: 503 });
  });

  it("denies with 503 when the Account API refuses the token", async () => {
    const ai = make();
    const { KindeTestkit } = await import("kinde-testkit");
    const stranger = await KindeTestkit.create({ issuer: issuer.issuer, audience: [AUDIENCE] });
    const token = await stranger.token({ subject: "kp_alice", organizationCode: "org_acme" });
    const d = await ai.decide({ claims: await stranger.verify(token), token });
    expect(d).toMatchObject({ allowed: false, reason: "entitlements_unavailable", detail: "Kinde billing could not be reached: Kinde's Account API answered 403 for entitlements." });
  });

  it("does not call the Account API for an M2M agent or without a token", async () => {
    const counter = counting();
    const ai = make({ entitlements: kindeAccountApi({ issuer: issuer.issuer, fetch: counter.fetch }) });
    const agent = await issuer.testkit.m2mToken({ clientId: "triage_bot", organizationCode: "org_acme" });
    const { decision, steps } = await ai.explain({ token: agent });
    expect(decision).toMatchObject({ allowed: true, plan: "free" });
    expect(steps).toContain("Kinde billing was not read for this caller.");
    expect(await ai.decide({ claims: { sub: "kp_alice", org_code: "org_acme" } })).toMatchObject({ plan: "free" });
    expect(counter.calls).toHaveLength(0);
    // The empty answer without a token is not cached, so the next call with a token reads billing.
    expect(await ai.decide({ token: await tokenFor("kp_alice", "org_acme") })).toMatchObject({ plan: "pro" });
    expect(counter.calls).toHaveLength(1);
  });

  it("needs a way to read billing", () => {
    expect(() => createAiPolicy({ policy, pricing, issuer: issuer.issuer, audience: AUDIENCE })).toThrow(/pass entitlements: kindeManagementApi/);
    expect(() => definePolicy({ ...structuredClone(policy), entitlements: { x: "budgets.agent.usd.month" as never } })).toThrow(/entitlements\.x must be/);
  });
});
