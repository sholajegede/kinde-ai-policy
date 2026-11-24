import { PolicyConfigError } from "./errors.js";
import type { AgentPolicy, AiPolicy, Budget, Grant, PlanPolicy, Pricing } from "./types.js";

const SCOPES = ["org", "user", "agent"];
const PERIODS = ["day", "week", "month"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function checkBudgets(budgets: unknown, where: string, scopes: string[], problems: string[]) {
  if (budgets === undefined) return;
  if (!Array.isArray(budgets)) return void problems.push(`${where}.budgets must be an array`);
  budgets.forEach((b, i) => {
    const at = `${where}.budgets[${i}]`;
    if (!isObject(b)) return void problems.push(`${at} must be an object`);
    if (!scopes.includes(b.scope as string)) problems.push(`${at}.scope must be ${scopes.map((s) => `"${s}"`).join(" or ")}`);
    if (!PERIODS.includes(b.period as string)) problems.push(`${at}.period must be "day", "week" or "month"`);
    if (b.usd === undefined && b.tokens === undefined) problems.push(`${at} needs usd, tokens or both`);
    if (b.usd !== undefined && !isPositive(b.usd)) problems.push(`${at}.usd must be a positive number`);
    if (b.tokens !== undefined && !isPositiveInt(b.tokens)) problems.push(`${at}.tokens must be a positive whole number`);
  });
}

function checkPlan(name: string, plan: unknown, problems: string[]) {
  const at = `plans.${name}`;
  if (!isObject(plan)) return void problems.push(`${at} must be an object`);
  if (!isStringArray(plan.models) || plan.models.length === 0) problems.push(`${at}.models must list at least one model`);
  if (plan.fallbacks !== undefined) {
    if (!isStringArray(plan.fallbacks)) problems.push(`${at}.fallbacks must be an array of model names`);
    else if (isStringArray(plan.models)) {
      for (const f of plan.fallbacks) if (!plan.models.includes(f)) problems.push(`${at}.fallbacks has "${f}", which is not in ${at}.models`);
    }
  }
  if (!isPositiveInt(plan.maxOutputTokens)) problems.push(`${at}.maxOutputTokens must be a positive whole number`);
  checkBudgets(plan.budgets, at, ["org", "user"], problems);
}

function checkGrant(grant: unknown, i: number, problems: string[]) {
  const at = `grants[${i}]`;
  if (!isObject(grant)) return void problems.push(`${at} must be an object`);
  const conditions = ["permission", "role", "flag"].filter((k) => grant[k] !== undefined);
  if (conditions.length !== 1) problems.push(`${at} needs exactly one of permission, role or flag`);
  for (const k of conditions) if (typeof grant[k] !== "string" || grant[k] === "") problems.push(`${at}.${k} must be a non-empty string`);
  if (grant.addModels !== undefined && !isStringArray(grant.addModels)) problems.push(`${at}.addModels must be an array of model names`);
  if (grant.maxOutputTokens !== undefined && !isPositiveInt(grant.maxOutputTokens)) problems.push(`${at}.maxOutputTokens must be a positive whole number`);
  checkBudgets(grant.budgets, at, ["user", "agent"], problems);
}

function checkAgent(agent: unknown, at: string, problems: string[]) {
  if (!isObject(agent)) return void problems.push(`${at} must be an object`);
  if (agent.models !== undefined && !isStringArray(agent.models)) problems.push(`${at}.models must be an array of model names`);
  if (agent.maxOutputTokens !== undefined && !isPositiveInt(agent.maxOutputTokens)) problems.push(`${at}.maxOutputTokens must be a positive whole number`);
  checkBudgets(agent.budgets, at, ["agent"], problems);
}

/** Returns every problem with a policy. An empty list means the policy is valid. */
export function validatePolicy(policy: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(policy)) return ["the policy must be an object"];
  const plans = policy.plans;
  if (!isObject(plans) || Object.keys(plans).length === 0) problems.push("plans must define at least one plan");
  else for (const [name, plan] of Object.entries(plans)) checkPlan(name, plan, problems);

  const planSection = policy.plan;
  if (!isObject(planSection)) problems.push("plan must be an object with from, fallback or both");
  else {
    const { from, fallback } = planSection;
    if (from === undefined && fallback === undefined) problems.push("plan needs from, fallback or both");
    if (from !== undefined) {
      if (!Array.isArray(from)) problems.push("plan.from must be an array");
      else
        from.forEach((source, i) => {
          const keys = isObject(source) ? Object.keys(source) : [];
          const key = keys[0];
          const ok = keys.length === 1 && key !== undefined && ["flag", "property", "claim"].includes(key) && typeof (source as Record<string, unknown>)[key] === "string";
          if (!ok) problems.push(`plan.from[${i}] must be { flag }, { property } or { claim } with a string name`);
        });
    }
    if (fallback !== undefined && (typeof fallback !== "string" || (isObject(plans) && !(fallback in plans))))
      problems.push(`plan.fallback must name a plan in plans`);
  }

  if (policy.grants !== undefined) {
    if (!Array.isArray(policy.grants)) problems.push("grants must be an array");
    else policy.grants.forEach((g, i) => checkGrant(g, i, problems));
  }

  if (policy.agents !== undefined) {
    const agents = policy.agents;
    if (!isObject(agents)) problems.push("agents must be an object");
    else {
      if (agents.default !== undefined) checkAgent(agents.default, "agents.default", problems);
      if (agents.clients !== undefined) {
        if (!isObject(agents.clients)) problems.push("agents.clients must be an object keyed by M2M client ID");
        else for (const [id, a] of Object.entries(agents.clients)) checkAgent(a, `agents.clients.${id}`, problems);
      }
    }
  }

  if (policy.requireOrganization !== undefined && typeof policy.requireOrganization !== "boolean") problems.push("requireOrganization must be true or false");
  return problems;
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Checks a policy and returns a frozen copy. Throws PolicyConfigError with every problem found. */
export function definePolicy(policy: AiPolicy): AiPolicy {
  const problems = validatePolicy(policy);
  if (problems.length > 0) throw new PolicyConfigError(problems);
  return freeze(structuredClone(policy));
}

/** Every model a policy can allow, from plans, grants and agents. */
export function policyModels(policy: AiPolicy): string[] {
  const models = new Set<string>();
  for (const plan of Object.values(policy.plans)) for (const m of plan.models) models.add(m);
  for (const g of policy.grants ?? []) for (const m of g.addModels ?? []) models.add(m);
  return [...models];
}

function hasUsd(budgets: Budget[] | undefined) {
  return (budgets ?? []).some((b) => b.usd !== undefined);
}

/** True when any budget in the policy is in USD, which needs prices. */
export function policyNeedsPricing(policy: AiPolicy): boolean {
  const agents: AgentPolicy[] = [policy.agents?.default, ...Object.values(policy.agents?.clients ?? {})].filter((a): a is AgentPolicy => a !== undefined);
  return (
    Object.values(policy.plans).some((p: PlanPolicy) => hasUsd(p.budgets)) ||
    (policy.grants ?? []).some((g: Grant) => hasUsd(g.budgets)) ||
    agents.some((a) => hasUsd(a.budgets))
  );
}

export function validatePricing(pricing: unknown, models: string[]): string[] {
  const problems: string[] = [];
  if (!isObject(pricing)) return ["pricing must be an object keyed by model name"];
  for (const [model, price] of Object.entries(pricing)) {
    if (!isObject(price) || typeof price.input !== "number" || typeof price.output !== "number" || price.input < 0 || price.output < 0)
      problems.push(`pricing.${model} must be { input, output } in USD per million tokens`);
  }
  for (const m of models) if (!(m in pricing)) problems.push(`pricing has no price for "${m}", which the policy allows and a USD budget needs`);
  return problems;
}

export type { Pricing };
