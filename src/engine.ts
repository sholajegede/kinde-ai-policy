import type { JSONWebKeySet } from "jose";
import type { ChatRequest, GatewayAdapter, Rendered, Usage } from "./adapter.js";
import { PolicyConfigError } from "./errors.js";
import { periodWindow } from "./periods.js";
import { definePolicy, policyModels, policyNeedsPricing, validatePricing } from "./policy.js";
import { costMicros, estimateInputTokens, worstCaseMicros } from "./pricing.js";
import { principalFromClaims } from "./principal.js";
import { memoryStore, type BudgetStore } from "./store.js";
import type { AgentPolicy, AiPolicy, Allowed, Budget, BudgetLimit, Decision, Denied, DenialReason, Period, Pricing, Principal, Scope, Unit } from "./types.js";
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
  estimateInputTokens?: (request: ChatRequest) => number;
  now?: () => Date;
}

export interface DecideInput {
  /** A Kinde access token. It is verified before use. */
  token?: string | null;
  /** Claims your framework already verified. */
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

export interface Prepared extends Rendered {
  allowed: true;
  reservationId: string;
  model: string;
  fallbacks: string[];
  maxOutputTokens: number;
  /** Charges what the call used. Pass the gateway's response, its last streamed chunk, or a Usage object. */
  settle(result?: unknown): Promise<Settlement>;
  /** Returns the whole reservation, for a call that failed or was never sent. */
  release(): Promise<void>;
}

export interface AiPolicyEngine {
  readonly policy: AiPolicy;
  decide(input: DecideInput, request?: DecideRequest): Promise<Decision>;
  explain(input: DecideInput, request?: DecideRequest): Promise<Explanation>;
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

  function pickPlan(principal: Principal, steps: string[]): string | undefined {
    for (const source of policy.plan.from ?? []) {
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

    const plan = pickPlan(principal, steps);
    if (!plan) return done(deny("no_plan", "No plan applies to this caller."));
    const planPolicy = policy.plans[plan]!;

    const models = [...planPolicy.models];
    let maxOutputTokens = planPolicy.maxOutputTokens;
    let budgets = flatten(planPolicy.budgets);

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

  async function prepare(decision: Decision, request: ChatRequest, adapter: GatewayAdapter): Promise<Prepared | Denied> {
    if (!decision.allowed) return decision;
    const model = request.model ?? decision.model;
    if (!decision.models.includes(model))
      return deny("model_not_allowed", `${model} is not allowed on plan "${decision.plan}". Allowed: ${decision.models.join(", ")}.`);
    const usableFallbacks = decision.fallbacks.filter((f) => f !== model);
    const asked = request.max_tokens ?? request.max_completion_tokens;
    const maxOutputTokens = typeof asked === "number" && asked > 0 ? Math.min(asked, decision.maxOutputTokens) : decision.maxOutputTokens;
    const inputTokens = estimate(request);
    const chain = [model, ...usableFallbacks];
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

    const rendered = adapter.render({ decision, request, model, fallbacks: usableFallbacks, maxOutputTokens });
    let finished: Promise<Settlement> | undefined;
    let released = false;

    const settle = (result?: unknown): Promise<Settlement> => {
      if (finished) return finished;
      if (released) return Promise.reject(new Error("This reservation was released, so it cannot be settled."));
      finished = (async () => {
        const usage = isUsage(result) ? result : result === undefined ? null : adapter.readUsage(result);
        if (!usage) {
          await store.settle(reservationId, {});
          return { model, inputTokens: null, outputTokens: null, costUsd: decision.budgets.some((b) => b.unit === "usd") ? usdMicros / 1e6 : null, charged: "reserved" };
        }
        const used = usage.model ?? model;
        const price = pricing[used];
        const micros =
          usage.costUsd !== undefined
            ? Math.round(usage.costUsd * 1_000_000)
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
      fallbacks: usableFallbacks,
      maxOutputTokens,
      ...rendered,
      settle,
      async release() {
        if (finished || released) return;
        released = true;
        await store.release(reservationId);
      },
    };
  }

  return {
    policy,
    async decide(input, request) {
      return (await resolve(input, request)).decision;
    },
    explain: resolve,
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
