import type { JSONWebKeySet } from "jose";
import type { ChatRequest, GatewayAdapter, Rendered, Usage } from "./adapter.js";
import { PolicyConfigError } from "./errors.js";
import { periodWindow } from "./periods.js";
import { cachedEntitlements, KINDE_UNLIMITED, type Entitlements, type EntitlementsSource } from "./entitlements.js";
import { definePolicy, policyModels, policyNeedsPricing, policyUsesEntitlements, validatePricing } from "./policy.js";
import { costMicros, estimateInputTokens, worstCaseMicros } from "./pricing.js";
import { principalFromClaims } from "./principal.js";
import { memoryStore, type BudgetStore } from "./store.js";
import type { AgentPolicy, AiPolicy, Allowed, Budget, BudgetLimit, Decision, Denied, DenialReason, LimitTarget, Period, Pricing, Principal, Scope, Unit } from "./types.js";
import { createVerifier, type TokenVerifier } from "./verify.js";

export interface AiPolicyOptions {
  policy: AiPolicy;
  /** Your Kinde domain. With `audience`, tokens are verified against its JWKS. */
  issuer?: string;
  audience?: string | string[] | false;
  /** Keys to use instead of fetching them from the issuer. */
  jwks?: JSONWebKeySet;
  /** Your own token check, used instead of `issuer` and `audience`. */
  verify?: TokenVerifier;
  /** Where budget counters live. Defaults to this process's memory. */
  store?: BudgetStore;
  /** USD per million tokens, for every model the policy allows. Needed for USD budgets. */
  pricing?: Pricing;
  /** How long an unsettled reservation holds budget. Defaults to 10 minutes. */
  reservationTtlMs?: number;
  /** Reads the caller's Kinde billing plan and limits: kindeManagementApi() or kindeAccountApi(). Required when the policy reads billing. */
  entitlements?: EntitlementsSource;
  /** How long a billing lookup is reused. Defaults to 60 seconds. */
  entitlementsCacheMs?: number;
  /** How long the last lookup is still used while Kinde cannot be reached. Defaults to 1 hour. */
  entitlementsMaxStaleMs?: number;
  estimateInputTokens?: (request: ChatRequest) => number;
  now?: () => Date;
}

export interface DecideInput {
  /** A Kinde access token. It is verified before use. */
  token?: string | null;
  /** Claims your framework already verified. Pass the token too when the policy reads Kinde billing. */
  claims?: Record<string, unknown>;
}

export interface DecideRequest {
  model?: string;
  maxOutputTokens?: number;
}

export interface Explanation {
  decision: Decision;
  steps: string[];
}

export interface Settlement {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** `actual` when usage was read, `reserved` when it was not and the reservation was charged in full. */
  charged: "actual" | "reserved";
}

export interface ReserveCall {
  /** Defaults to the decision's model. It must be one the decision allows. */
  model?: string;
  inputTokens: number;
  /** Capped at the decision's limit. Defaults to it. */
  maxOutputTokens?: number;
}

export interface Reservation {
  allowed: true;
  reservationId: string;
  model: string;
  fallbacks: string[];
  maxOutputTokens: number;
  /** Charges what the call used. Without usage, the whole reservation is charged. */
  settle(usage?: Usage | null): Promise<Settlement>;
  /** Returns the whole reservation, for a call that failed or was never sent. */
  release(): Promise<void>;
}

export interface Prepared extends Rendered, Omit<Reservation, "settle"> {
  /** Charges what the call used. Pass the gateway's response, its last streamed chunk, or a Usage object. */
  settle(result?: unknown): Promise<Settlement>;
}

export interface AiPolicyEngine {
  readonly policy: AiPolicy;
  decide(input: DecideInput, request?: DecideRequest): Promise<Decision>;
  explain(input: DecideInput, request?: DecideRequest): Promise<Explanation>;
  /** Reserves budget for one model call you make yourself. prepare() and the AI SDK middleware use it. */
  reserve(decision: Decision, call: ReserveCall): Promise<Reservation | Denied>;
  prepare(decision: Decision, request: ChatRequest, adapter: GatewayAdapter): Promise<Prepared | Denied>;
  toResponse(denied: Denied): Response;
}

const STATUS: Record<DenialReason, Denied["status"]> = {
  unauthenticated: 401,
  no_organization: 403,
  agent_not_allowed: 403,
  model_not_allowed: 403,
  no_plan: 402,
  budget_exhausted: 429,
  entitlements_unavailable: 503,
};

const PERIOD_WORD: Record<Period, string> = { day: "daily", week: "weekly", month: "monthly" };

interface FlatBudget {
  scope: Scope;
  period: Period;
  unit: Unit;
  amount: number;
}

const flatten = (budgets: Budget[] = []): FlatBudget[] =>
  budgets.flatMap((b) => [
    ...(b.usd !== undefined ? [{ scope: b.scope, period: b.period, unit: "usd" as const, amount: b.usd }] : []),
    ...(b.tokens !== undefined ? [{ scope: b.scope, period: b.period, unit: "tokens" as const, amount: b.tokens }] : []),
  ]);

const replace = (current: FlatBudget[], next: FlatBudget[]) =>
  current.filter((c) => !next.some((n) => n.scope === c.scope && n.period === c.period && n.unit === c.unit)).concat(next);

const toStoreUnits = (unit: Unit, amount: number) => (unit === "usd" ? Math.round(amount * 1_000_000) : amount);
const fromStoreUnits = (unit: Unit, amount: number) => (unit === "usd" ? amount / 1_000_000 : amount);
const format = (unit: Unit, amount: number) => (unit === "usd" ? `$${amount.toFixed(amount < 1 ? 4 : 2)}` : `${amount} tokens`);

function isUsage(v: unknown): v is Usage {
  return typeof v === "object" && v !== null && typeof (v as Usage).inputTokens === "number" && typeof (v as Usage).outputTokens === "number";
}

export function createAiPolicy(options: AiPolicyOptions): AiPolicyEngine {
  const policy = definePolicy(options.policy);
  const problems: string[] = [];
  if (options.issuer !== undefined && options.audience === undefined)
    problems.push("audience is required with issuer. Pass false only if your Kinde tokens carry no audience");
  if (options.issuer !== undefined && options.verify) problems.push("pass issuer and audience, or verify, not both");
  if (policyNeedsPricing(policy)) {
    if (!options.pricing) problems.push("pricing is required because the policy has USD budgets");
    else problems.push(...validatePricing(options.pricing, policyModels(policy)));
  } else if (options.pricing) problems.push(...validatePricing(options.pricing, []));
  if (options.reservationTtlMs !== undefined && !(options.reservationTtlMs > 0)) problems.push("reservationTtlMs must be positive");
  const usesEntitlements = policyUsesEntitlements(policy);
  if (usesEntitlements && !options.entitlements)
    problems.push("the policy reads Kinde billing, so pass entitlements: kindeManagementApi({ issuer, clientId, clientSecret }) for organization plans, or kindeAccountApi({ issuer }) for user plans");
  if (problems.length > 0) throw new PolicyConfigError(problems);

  const verify =
    options.verify ??
    (options.issuer !== undefined
      ? createVerifier({ issuer: options.issuer, audience: options.audience ?? false, ...(options.jwks ? { jwks: options.jwks } : {}) })
      : undefined);
  const store = options.store ?? memoryStore();
  const pricing = options.pricing ?? {};
  const now = options.now ?? (() => new Date());
  const ttl = options.reservationTtlMs ?? 600_000;
  const estimate = options.estimateInputTokens ?? estimateInputTokens;
  const entitlementSource = options.entitlements;
  const lookup = entitlementSource
    ? cachedEntitlements(entitlementSource, {
        ttlMs: options.entitlementsCacheMs ?? 60_000,
        maxStaleMs: options.entitlementsMaxStaleMs ?? 3_600_000,
        now: () => now().getTime(),
      })
    : undefined;

  const deny = (reason: DenialReason, detail: string, retryAt?: string): Denied => ({
    allowed: false,
    reason,
    status: STATUS[reason],
    detail,
    ...(retryAt ? { retryAt } : {}),
  });

  async function principalOf(input: DecideInput, steps: string[]): Promise<Principal | Denied> {
    let claims = input.claims;
    if (!claims) {
      if (!input.token) return deny("unauthenticated", "No access token was sent.");
      if (!verify) throw new PolicyConfigError(["pass issuer and audience, or verify, to check tokens"]);
      try {
        claims = await verify(input.token);
      } catch (error) {
        return deny("unauthenticated", `The access token is not valid: ${(error as Error).message}`);
      }
      steps.push("Verified the access token.");
    } else steps.push("Used claims that the caller verified.");
    try {
      return principalFromClaims(claims);
    } catch (error) {
      return deny("unauthenticated", (error as Error).message);
    }
  }

  function pickPlan(principal: Principal, billing: Entitlements | null, steps: string[]): string | undefined {
    for (const source of policy.plan.from ?? []) {
      if ("billing" in source) {
        const plan = billing?.plans.find((k) => Object.hasOwn(policy.plans, k));
        if (plan) {
          steps.push(`Plan "${plan}" comes from Kinde billing.`);
          return plan;
        }
        if (billing && billing.plans.length > 0) steps.push(`Skipped Kinde billing: ${billing.plans.map((p) => `"${p}"`).join(", ")} is not a plan in the policy.`);
        continue;
      }
      const [label, value] =
        "flag" in source
          ? [`feature flag "${source.flag}"`, principal.featureFlags[source.flag]]
          : "property" in source
            ? [`property "${source.property}"`, principal.properties[source.property]]
            : [`claim "${source.claim}"`, principal.claims[source.claim]];
      if (typeof value === "string" && Object.hasOwn(policy.plans, value)) {
        steps.push(`Plan "${value}" comes from ${label}.`);
        return value;
      }
      if (value !== undefined) steps.push(`Skipped ${label}: ${JSON.stringify(value)} is not a plan in the policy.`);
    }
    if (policy.plan.fallback) steps.push(`No plan source matched, so the fallback plan "${policy.plan.fallback}" applies.`);
    return policy.plan.fallback;
  }

  async function resolve(input: DecideInput, request: DecideRequest = {}): Promise<Explanation> {
    const steps: string[] = [];
    const done = (decision: Decision): Explanation => {
      steps.push(decision.allowed ? `Allowed ${decision.model} on plan "${decision.plan}".` : `Denied (${decision.reason}): ${decision.detail}`);
      return { decision, steps };
    };

    const principal = await principalOf(input, steps);
    if ("allowed" in principal) return done(principal);
    steps.push(`Caller is ${principal.type === "machine" ? "M2M client" : "user"} ${principal.subject}${principal.orgCode ? ` in ${principal.orgCode}` : ""}.`);

    if (principal.type === "machine" && !policy.agents) return done(deny("agent_not_allowed", "This policy does not allow M2M tokens. Add an agents section to allow them."));
    if (!principal.orgCode && policy.requireOrganization !== false) return done(deny("no_organization", "The token has no org_code, and the policy requires an organization."));

    let billing: Entitlements | null = null;
    if (lookup) {
      try {
        const result = await lookup({ principal, ...(input.token ? { token: input.token } : {}) });
        billing = result.value;
        if (result.stale) steps.push(`Kinde billing could not be reached (${result.error?.message}), so its last answer applies.`);
        else if (billing) steps.push(`Read Kinde billing: ${billing.plans.length > 0 ? `plan ${billing.plans.join(", ")}` : "no plan"}, ${Object.keys(billing.limits).length} entitlements.`);
        else steps.push("Kinde billing was not read for this caller.");
      } catch (error) {
        return done(deny("entitlements_unavailable", `Kinde billing could not be reached: ${(error as Error).message}`));
      }
    }

    const plan = pickPlan(principal, billing, steps);
    if (!plan) return done(deny("no_plan", "No plan applies to this caller."));
    const planPolicy = policy.plans[plan]!;

    const models = [...planPolicy.models];
    let maxOutputTokens = planPolicy.maxOutputTokens;
    let budgets = flatten(planPolicy.budgets);

    const setLimit = (target: LimitTarget, value: number, label: string) => {
      if (target === "maxOutputTokens") {
        if (value === KINDE_UNLIMITED) return void steps.push(`${label} is unlimited, so the plan's output limit stays.`);
        if (!Number.isInteger(value) || value <= 0) return void steps.push(`Skipped ${label}: ${value} is not a valid output limit.`);
        maxOutputTokens = value;
        return void steps.push(`${label} sets maxOutputTokens to ${value}.`);
      }
      const [, scope, unit, period] = target.split(".") as [string, Scope, Unit, Period];
      const same = (b: FlatBudget) => b.scope === scope && b.unit === unit && b.period === period;
      if (value === KINDE_UNLIMITED) {
        budgets = budgets.filter((b) => !same(b));
        return void steps.push(`${label} is unlimited, so the ${PERIOD_WORD[period]} ${scope} ${unit} budget is removed.`);
      }
      if (!Number.isFinite(value) || value < 0) return void steps.push(`Skipped ${label}: ${value} is not a valid budget.`);
      budgets = replace(budgets, [{ scope, unit, period, amount: unit === "tokens" ? Math.floor(value) : value }]);
      steps.push(`${label} sets the ${PERIOD_WORD[period]} ${scope} budget to ${format(unit, value)}.`);
    };

    for (const [feature, target] of Object.entries(policy.entitlements ?? {})) {
      if (!billing || !Object.hasOwn(billing.limits, feature)) continue;
      const max = billing.limits[feature];
      if (max === null || max === undefined) steps.push(`Kinde entitlement "${feature}" has no limit, so the plan's value stays.`);
      else setLimit(target, max, `Kinde entitlement "${feature}"`);
    }
    for (const [key, target] of Object.entries(policy.properties ?? {})) {
      const raw = principal.properties[key];
      if (raw === undefined || raw === null || raw === "") continue;
      setLimit(target, typeof raw === "number" ? raw : Number(raw), `Property "${key}"`);
    }

    (policy.grants ?? []).forEach((grant, i) => {
      const [label, applies] = grant.permission
        ? [`permission "${grant.permission}"`, principal.permissions.includes(grant.permission)]
        : grant.role
          ? [`role "${grant.role}"`, principal.roles.includes(grant.role)]
          : [`feature flag "${grant.flag}"`, principal.featureFlags[grant.flag!] === true];
      if (!applies) return;
      for (const m of grant.addModels ?? []) if (!models.includes(m)) models.push(m);
      if (grant.maxOutputTokens) maxOutputTokens = Math.max(maxOutputTokens, grant.maxOutputTokens);
      budgets = replace(budgets, flatten(grant.budgets));
      steps.push(`Grant ${i} applies through ${label}.`);
    });

    let allowedModels = models;
    if (principal.type === "machine") {
      const agent: AgentPolicy = { ...policy.agents?.default, ...policy.agents?.clients?.[principal.subject] };
      if (agent.models) {
        allowedModels = models.filter((m) => agent.models!.includes(m));
        if (allowedModels.length === 0) return done(deny("model_not_allowed", `Agent ${principal.subject} is allowed no model in plan "${plan}".`));
      }
      if (agent.maxOutputTokens) maxOutputTokens = Math.min(maxOutputTokens, agent.maxOutputTokens);
      budgets = replace(budgets.filter((b) => b.scope !== "user"), flatten(agent.budgets));
      steps.push(`Applied the agent policy for ${principal.subject}.`);
    } else budgets = budgets.filter((b) => b.scope !== "agent");

    if (!principal.orgCode && budgets.some((b) => b.scope === "org")) {
      budgets = budgets.filter((b) => b.scope !== "org");
      steps.push("Skipped organization budgets: the token has no org_code.");
    }

    const model = request.model ?? allowedModels[0]!;
    if (!allowedModels.includes(model))
      return done(deny("model_not_allowed", `${model} is not allowed on plan "${plan}". Allowed: ${allowedModels.join(", ")}.`));
    if (request.maxOutputTokens !== undefined && request.maxOutputTokens > 0) maxOutputTokens = Math.min(maxOutputTokens, request.maxOutputTokens);
    const fallbacks = (planPolicy.fallbacks ?? []).filter((f) => f !== model && allowedModels.includes(f));

    const at = now();
    const limits: BudgetLimit[] = budgets.map((b) => {
      const id = b.scope === "org" ? principal.orgCode! : principal.subject;
      const window = periodWindow(b.period, at);
      return {
        key: `kinde-ai-policy:${b.scope}:${id}:${b.period}:${window.id}:${b.unit}`,
        scope: b.scope,
        id,
        unit: b.unit,
        period: b.period,
        limit: b.amount,
        remaining: b.amount,
        resetsAt: window.end.toISOString(),
      };
    });
    const usage = await store.usage(limits.map((l) => l.key));
    const exhausted: BudgetLimit[] = [];
    for (const l of limits) {
      const u = usage[l.key] ?? { used: 0, reserved: 0 };
      const left = toStoreUnits(l.unit, l.limit) - u.used - u.reserved;
      l.remaining = Math.max(0, fromStoreUnits(l.unit, left));
      if (left <= 0) exhausted.push(l);
    }
    if (exhausted.length > 0) {
      const first = exhausted[0]!;
      const retryAt = exhausted.map((l) => l.resetsAt).sort().at(-1)!;
      return done(
        deny("budget_exhausted", `The ${PERIOD_WORD[first.period]} ${first.scope} budget of ${format(first.unit, first.limit)} is used up. It resets at ${first.resetsAt}.`, retryAt),
      );
    }
    if (limits.length > 0) steps.push(`Checked ${limits.length} budget${limits.length === 1 ? "" : "s"}.`);

    const attribution = {
      plan,
      ...(principal.orgCode ? { org: principal.orgCode } : {}),
      ...(principal.type === "user" ? { user: principal.subject } : { agent: principal.subject }),
    };
    return done({
      allowed: true,
      principal: { type: principal.type, subject: principal.subject, orgCode: principal.orgCode },
      plan,
      model,
      models: allowedModels,
      fallbacks,
      maxOutputTokens,
      budgets: limits,
      attribution,
    });
  }

  async function reserve(decision: Decision, call: ReserveCall): Promise<Reservation | Denied> {
    if (!decision.allowed) return decision;
    const model = call.model ?? decision.model;
    if (!decision.models.includes(model))
      return deny("model_not_allowed", `${model} is not allowed on plan "${decision.plan}". Allowed: ${decision.models.join(", ")}.`);
    const fallbacks = decision.fallbacks.filter((f) => f !== model);
    const asked = call.maxOutputTokens;
    const maxOutputTokens = typeof asked === "number" && asked > 0 ? Math.min(asked, decision.maxOutputTokens) : decision.maxOutputTokens;
    const inputTokens = Math.max(0, Math.ceil(call.inputTokens));
    const chain = [model, ...fallbacks];
    const usdMicros = worstCaseMicros(pricing, chain, inputTokens, maxOutputTokens);

    const amounts = new Map<string, number>();
    const entries = decision.budgets.map((b) => {
      const amount = b.unit === "usd" ? usdMicros : inputTokens + maxOutputTokens;
      amounts.set(b.key, amount);
      return { key: b.key, amount, limit: toStoreUnits(b.unit, b.limit), expiresAt: Date.parse(b.resetsAt) };
    });
    const reservationId = globalThis.crypto.randomUUID();
    const reserved = await store.reserve(reservationId, entries, ttl);
    if (!reserved.ok) {
      const b = decision.budgets.find((x) => x.key === reserved.key)!;
      const need = fromStoreUnits(b.unit, amounts.get(b.key) ?? 0);
      const left = fromStoreUnits(b.unit, reserved.available);
      return deny(
        "budget_exhausted",
        `This request could use up to ${format(b.unit, need)}, and the ${PERIOD_WORD[b.period]} ${b.scope} budget has ${format(b.unit, left)} left. Ask for fewer output tokens, or wait until ${b.resetsAt}.`,
        b.resetsAt,
      );
    }

    let finished: Promise<Settlement> | undefined;
    let released = false;
    const settle = (usage?: Usage | null): Promise<Settlement> => {
      if (finished) return finished;
      if (released) return Promise.reject(new Error("This reservation was released, so it cannot be settled."));
      finished = (async () => {
        if (!usage) {
          await store.settle(reservationId, {});
          return { model, inputTokens: null, outputTokens: null, costUsd: decision.budgets.some((b) => b.unit === "usd") ? usdMicros / 1e6 : null, charged: "reserved" };
        }
        const used = usage.model ?? model;
        const price = pricing[used];
        const micros =
          usage.costUsd !== undefined
            ? Math.ceil(usage.costUsd * 1_000_000 - 1e-6)
            : price
              ? costMicros(price, usage.inputTokens, usage.outputTokens)
              : worstCaseMicros(pricing, chain, usage.inputTokens, usage.outputTokens);
        const spent: Record<string, number> = {};
        for (const b of decision.budgets) spent[b.key] = b.unit === "usd" ? micros : usage.inputTokens + usage.outputTokens;
        await store.settle(reservationId, spent);
        const priced = usage.costUsd !== undefined || Object.keys(pricing).length > 0;
        return { model: used, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: priced ? micros / 1e6 : null, charged: "actual" };
      })();
      return finished;
    };

    return {
      allowed: true,
      reservationId,
      model,
      fallbacks,
      maxOutputTokens,
      settle,
      async release() {
        if (finished || released) return;
        released = true;
        await store.release(reservationId);
      },
    };
  }

  async function prepare(decision: Decision, request: ChatRequest, adapter: GatewayAdapter): Promise<Prepared | Denied> {
    if (!decision.allowed) return decision;
    const reservation = await reserve(decision, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      inputTokens: estimate(request),
      ...(typeof (request.max_tokens ?? request.max_completion_tokens) === "number" ? { maxOutputTokens: (request.max_tokens ?? request.max_completion_tokens)! } : {}),
    });
    if (!reservation.allowed) return reservation;
    const rendered = adapter.render({ decision, request, model: reservation.model, fallbacks: reservation.fallbacks, maxOutputTokens: reservation.maxOutputTokens });
    return {
      ...reservation,
      ...rendered,
      settle: (result?: unknown) => reservation.settle(isUsage(result) ? result : result === undefined ? null : adapter.readUsage(result)),
    };
  }

  return {
    policy,
    async decide(input, request) {
      return (await resolve(input, request)).decision;
    },
    explain: resolve,
    reserve,
    prepare,
    toResponse(denied) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (denied.retryAt) headers["retry-after"] = String(Math.max(1, Math.ceil((Date.parse(denied.retryAt) - now().getTime()) / 1000)));
      return new Response(JSON.stringify({ error: { type: denied.reason, message: denied.detail, ...(denied.retryAt ? { retry_at: denied.retryAt } : {}) } }), {
        status: denied.status,
        headers,
      });
    },
  };
}
