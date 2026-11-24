import { KindeTestkit } from "kinde-testkit";
import { describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy } from "../src/index.js";

// The policy and calls from the README, so the documented example keeps working.
const policy = definePolicy({
  plan: { from: [{ flag: "plan" }], fallback: "free" },
  plans: {
    free: { models: ["openai/gpt-5-mini"], maxOutputTokens: 1024, budgets: [{ scope: "org", usd: 2, period: "month" }] },
    pro: {
      models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"],
      fallbacks: ["openai/gpt-5-mini"],
      maxOutputTokens: 8192,
      budgets: [
        { scope: "org", usd: 100, period: "month" },
        { scope: "user", usd: 20, period: "month" },
      ],
    },
  },
  grants: [{ permission: "ai:premium-models", addModels: ["anthropic/claude-opus-4.1"] }],
});

const pricing = {
  "openai/gpt-5-mini": { input: 0.25, output: 2 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-opus-4.1": { input: 15, output: 75 },
};

describe("README example", () => {
  it("runs as documented", async () => {
    const testkit = await KindeTestkit.create({ issuer: "https://acme.kinde.test", audience: ["https://api.acme.test"] });
    const ai = createAiPolicy({ policy, issuer: "https://acme.kinde.test", audience: "https://api.acme.test", jwks: testkit.jwks(), pricing });

    const token = await testkit.token({ subject: "kp_alice", organizationCode: "org_acme", featureFlags: { plan: { t: "s", v: "pro" } }, permissions: ["ai:premium-models"] });
    expect(await ai.decide({ token })).toMatchObject({ allowed: true, plan: "pro" });
    const { steps } = await ai.explain({ token });
    expect(steps).toEqual([
      "Verified the access token.",
      "Caller is user kp_alice in org_acme.",
      'Plan "pro" comes from feature flag "plan".',
      'Grant 0 applies through permission "ai:premium-models".',
      "Checked 2 budgets.",
      'Allowed anthropic/claude-sonnet-4.5 on plan "pro".',
    ]);

    const outsider = await testkit.token({ subject: "kp_bob", organizationCode: "org_acme" });
    expect(await ai.decide({ token: outsider }, { model: "anthropic/claude-sonnet-4.5" })).toMatchObject({ allowed: false, reason: "model_not_allowed" });
  });
});
