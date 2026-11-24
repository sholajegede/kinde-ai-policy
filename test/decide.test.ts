import { describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, type Allowed } from "../src/index.js";
import { makePolicy, MINI, OPUS, policy, pricing, SONNET, testkit, userToken } from "./fixtures.js";

const allowed = (d: unknown) => {
  expect(d).toMatchObject({ allowed: true });
  return d as Allowed;
};

describe("decide", () => {
  it("falls back to the free plan when no source names a plan", async () => {
    const { ai } = makePolicy();
    const d = allowed(await ai.decide({ token: await userToken() }));
    expect(d).toMatchObject({ plan: "free", model: MINI, models: [MINI], fallbacks: [], maxOutputTokens: 1024 });
    expect(d.budgets.map((b) => [b.scope, b.unit, b.limit, b.remaining])).toEqual([["org", "usd", 2, 2]]);
    expect(d.attribution).toEqual({ plan: "free", org: "org_acme", user: "kp_alice" });
  });

  it("takes the plan from a Kinde feature flag", async () => {
    const { ai } = makePolicy();
    const d = allowed(await ai.decide({ token: await userToken({ plan: "pro" }) }));
    expect(d).toMatchObject({ plan: "pro", model: SONNET, fallbacks: [MINI], maxOutputTokens: 8192 });
    expect(d.budgets.map((b) => `${b.scope}:${b.unit}:${b.limit}`)).toEqual(["org:usd:100", "user:usd:20", "user:tokens:2000000"]);
  });

  it("takes the plan from an organization property when the flag is missing", async () => {
    const { ai } = makePolicy();
    const token = await userToken({ claims: { organization_properties: { kp_org_plan: { v: "pro" } } } });
    expect(await ai.decide({ token })).toMatchObject({ plan: "pro" });
  });

  it("skips a plan name the policy does not have", async () => {
    const { ai } = makePolicy();
    const { decision, steps } = await ai.explain({ token: await userToken({ plan: "enterprise" }) });
    expect(decision).toMatchObject({ plan: "free" });
    expect(steps).toContain('Skipped feature flag "plan": "enterprise" is not a plan in the policy.');
  });

  it("adds models and output tokens through a permission grant", async () => {
    const { ai } = makePolicy();
    const d = allowed(await ai.decide({ token: await userToken({ plan: "pro", permissions: ["ai:premium-models"] }) }, { model: OPUS }));
    expect(d).toMatchObject({ model: OPUS, models: [SONNET, MINI, OPUS], fallbacks: [MINI], maxOutputTokens: 16384 });
  });

  it("replaces only the matching user budget through a role grant", async () => {
    const { ai } = makePolicy();
    const d = allowed(await ai.decide({ token: await userToken({ plan: "pro", roles: ["ai-admin"] }) }));
    expect(d.budgets.map((b) => `${b.scope}:${b.unit}:${b.limit}`)).toEqual(["org:usd:100", "user:tokens:2000000", "user:usd:50"]);
  });

  it("refuses a model the plan does not allow", async () => {
    const { ai } = makePolicy();
    const d = await ai.decide({ token: await userToken() }, { model: SONNET });
    expect(d).toMatchObject({ allowed: false, reason: "model_not_allowed", status: 403 });
  });

  it("lowers max output tokens to what the request asks for, never above the plan", async () => {
    const { ai } = makePolicy();
    const token = await userToken();
    expect(await ai.decide({ token }, { maxOutputTokens: 100 })).toMatchObject({ maxOutputTokens: 100 });
    expect(await ai.decide({ token }, { maxOutputTokens: 999_999 })).toMatchObject({ maxOutputTokens: 1024 });
  });

  it("refuses a token without an organization", async () => {
    const { ai } = makePolicy();
    expect(await ai.decide({ token: await userToken({ org: null }) })).toMatchObject({ allowed: false, reason: "no_organization" });
  });

  it("allows a token without an organization when the policy says so, without organization budgets", async () => {
    const ai = createAiPolicy({ policy: definePolicy({ ...structuredClone(policy), requireOrganization: false }), pricing });
    const d = allowed(await ai.decide({ claims: { sub: "kp_solo" } }));
    expect(d.budgets).toEqual([]);
    expect(d.attribution).toEqual({ plan: "free", user: "kp_solo" });
  });

  it("refuses M2M tokens when the policy has no agents section", async () => {
    const noAgents = definePolicy({ plan: { fallback: "p" }, plans: { p: { models: [MINI], maxOutputTokens: 10 } } });
    const ai = createAiPolicy({ policy: noAgents });
    const claims = await testkit.verify(await testkit.m2mToken({ clientId: "worker", organizationCode: "org_acme" }));
    expect(await ai.decide({ claims })).toMatchObject({ allowed: false, reason: "agent_not_allowed", status: 403 });
  });

  it("gives an M2M agent its own caps inside its organization's plan", async () => {
    const { ai } = makePolicy();
    const token = await testkit.m2mToken({ clientId: "triage_bot", organizationCode: "org_acme", claims: { feature_flags: { plan: { t: "s", v: "pro" } } } });
    const d = allowed(await ai.decide({ token }));
    expect(d).toMatchObject({ plan: "pro", model: MINI, models: [MINI], fallbacks: [], maxOutputTokens: 2048 });
    expect(d.budgets.map((b) => `${b.scope}:${b.id}:${b.unit}:${b.limit}`)).toEqual(["org:org_acme:usd:100", "agent:triage_bot:usd:5"]);
    expect(d.attribution).toEqual({ plan: "pro", org: "org_acme", agent: "triage_bot" });
  });

  it("applies a per-client agent policy over the default", async () => {
    const { ai } = makePolicy();
    const token = await testkit.m2mToken({ clientId: "support_agent", organizationCode: "org_acme", claims: { feature_flags: { plan: { t: "s", v: "pro" } } } });
    expect(await ai.decide({ token })).toMatchObject({ model: SONNET, models: [SONNET, MINI], fallbacks: [MINI], maxOutputTokens: 2048 });
  });

  it("explains each step", async () => {
    const { ai } = makePolicy();
    const { steps } = await ai.explain({ token: await userToken({ plan: "pro", permissions: ["ai:premium-models"] }) });
    expect(steps).toEqual([
      "Verified the access token.",
      "Caller is user kp_alice in org_acme.",
      'Plan "pro" comes from feature flag "plan".',
      'Grant 0 applies through permission "ai:premium-models".',
      "Checked 3 budgets.",
      `Allowed ${SONNET} on plan "pro".`,
    ]);
  });

  it("turns a denial into a JSON response", async () => {
    const { ai } = makePolicy();
    const d = await ai.decide({ token: null });
    if (d.allowed) throw new Error("expected a denial");
    const res = ai.toResponse(d);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { type: "unauthenticated", message: "No access token was sent." } });
  });
});
