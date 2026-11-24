import { describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, PolicyConfigError, validatePolicy, type AiPolicy } from "../src/index.js";
import { MINI, policy } from "./fixtures.js";

describe("policy validation", () => {
  it("accepts the fixture policy and freezes it", () => {
    expect(validatePolicy(policy)).toEqual([]);
    expect(Object.isFrozen(policy.plans.free!.models)).toBe(true);
  });

  it("lists every problem at once", () => {
    const bad = {
      plan: { fallback: "missing" },
      plans: {
        free: { models: [], maxOutputTokens: 0, fallbacks: ["x"], budgets: [{ scope: "agent", period: "year" }] },
      },
      grants: [{ permission: "a", role: "b", budgets: [{ scope: "org", usd: 1, period: "day" }] }],
      agents: { default: { budgets: [{ scope: "user", tokens: 1.5, period: "day" }] } },
    } as unknown as AiPolicy;
    const problems = validatePolicy(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        "plans.free.models must list at least one model",
        'plans.free.fallbacks has "x", which is not in plans.free.models',
        "plans.free.maxOutputTokens must be a positive whole number",
        'plans.free.budgets[0].scope must be "org" or "user"',
        'plans.free.budgets[0].period must be "day", "week" or "month"',
        "plans.free.budgets[0] needs usd, tokens or both",
        "plan.fallback must name a plan in plans",
        "grants[0] needs exactly one of permission, role or flag",
        'grants[0].budgets[0].scope must be "user" or "agent"',
        'agents.default.budgets[0].scope must be "agent"',
        "agents.default.budgets[0].tokens must be a positive whole number",
      ]),
    );
    expect(() => definePolicy(bad)).toThrow(PolicyConfigError);
  });

  it("survives a JSON round trip", () => {
    expect(definePolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
  });

  it("needs a price for every model when the policy has USD budgets", () => {
    expect(() => createAiPolicy({ policy, pricing: { [MINI]: { input: 1, output: 1 } } })).toThrow(/no price for "anthropic\/claude-sonnet-4.5"/);
    expect(() => createAiPolicy({ policy })).toThrow(/pricing is required/);
  });

  it("needs no prices for token budgets", () => {
    const tokensOnly = definePolicy({ plan: { fallback: "p" }, plans: { p: { models: [MINI], maxOutputTokens: 10, budgets: [{ scope: "org", tokens: 100, period: "day" }] } } });
    expect(() => createAiPolicy({ policy: tokensOnly })).not.toThrow();
  });
});
