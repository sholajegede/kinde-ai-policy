import { KindeTestkit } from "kinde-testkit";
import { createAiPolicy, definePolicy, memoryStore, type AiPolicyOptions, type BudgetStore } from "../src/index.js";

export const ISSUER = "https://acme.kinde.test";
export const AUDIENCE = "https://api.acme.test";

export const testkit = await KindeTestkit.create({ issuer: ISSUER, audience: [AUDIENCE] });

export const MINI = "openai/gpt-5-mini";
export const SONNET = "anthropic/claude-sonnet-4.5";
export const OPUS = "anthropic/claude-opus-4.1";

export const pricing = {
  [MINI]: { input: 0.25, output: 2 },
  [SONNET]: { input: 3, output: 15 },
  [OPUS]: { input: 15, output: 75 },
};

export const policy = definePolicy({
  plan: { from: [{ flag: "plan" }, { property: "kp_org_plan" }], fallback: "free" },
  plans: {
    free: {
      models: [MINI],
      maxOutputTokens: 1024,
      budgets: [{ scope: "org", usd: 2, period: "month" }],
    },
    pro: {
      models: [SONNET, MINI],
      fallbacks: [MINI],
      maxOutputTokens: 8192,
      budgets: [
        { scope: "org", usd: 100, period: "month" },
        { scope: "user", usd: 20, period: "month", tokens: 2_000_000 },
      ],
    },
  },
  grants: [
    { permission: "ai:premium-models", addModels: [OPUS], maxOutputTokens: 16384 },
    { role: "ai-admin", budgets: [{ scope: "user", usd: 50, period: "month" }] },
  ],
  agents: {
    default: { models: [MINI], maxOutputTokens: 2048, budgets: [{ scope: "agent", usd: 5, period: "day" }] },
    clients: { support_agent: { models: [SONNET, MINI] } },
  },
});

/** A Kinde user token, signed by kinde-testkit. */
export function userToken(options: {
  sub?: string;
  org?: string | null;
  plan?: string;
  permissions?: string[];
  roles?: string[];
  claims?: Record<string, unknown>;
} = {}) {
  return testkit.token({
    subject: options.sub ?? "kp_alice",
    organizationCode: options.org === undefined ? "org_acme" : options.org,
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.plan ? { featureFlags: { plan: { t: "s", v: options.plan } } } : {}),
    ...(options.claims ? { claims: options.claims } : {}),
  });
}

export function makePolicy(overrides: Partial<AiPolicyOptions> = {}) {
  const store: BudgetStore = overrides.store ?? memoryStore();
  const ai = createAiPolicy({ policy, issuer: ISSUER, audience: AUDIENCE, jwks: testkit.jwks(), pricing, store, ...overrides });
  return { ai, store };
}
