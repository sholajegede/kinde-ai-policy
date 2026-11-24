export type Scope = "org" | "user" | "agent";
export type Period = "day" | "week" | "month";
export type Unit = "usd" | "tokens";

/** A spending limit. `usd` and `tokens` can be set together, which creates two limits. */
export interface Budget {
  scope: Scope;
  period: Period;
  usd?: number;
  tokens?: number;
}

export interface PlanPolicy {
  /** Models this plan may call. The first one is the default. */
  models: string[];
  /** Models to try, in order, when the chosen model fails. Each must be in `models`. */
  fallbacks?: string[];
  maxOutputTokens: number;
  /** Organization and user budgets. Agent budgets go in `agents`. */
  budgets?: Budget[];
}

export type PlanSource = { flag: string } | { property: string } | { claim: string };

/** Extra access for callers with a permission, role or feature flag. */
export interface Grant {
  permission?: string;
  role?: string;
  flag?: string;
  addModels?: string[];
  maxOutputTokens?: number;
  /** User or agent budgets that replace the plan's budget with the same scope, period and unit. */
  budgets?: Budget[];
}

export interface AgentPolicy {
  /** Limits the agent to these models, within its organization's plan. */
  models?: string[];
  maxOutputTokens?: number;
  /** Agent budgets, counted per M2M client ID. */
  budgets?: Budget[];
}

export interface AiPolicy {
  plan: { from?: PlanSource[]; fallback?: string };
  plans: Record<string, PlanPolicy>;
  grants?: Grant[];
  /** Policy for M2M tokens. Without it, M2M tokens are refused. */
  agents?: { default?: AgentPolicy; clients?: Record<string, AgentPolicy> };
  /** Refuse tokens without `org_code`. Defaults to true. */
  requireOrganization?: boolean;
}

export interface Principal {
  type: "user" | "machine";
  /** The user ID (`sub`) or, for M2M tokens, the client ID (`azp`). */
  subject: string;
  orgCode: string | null;
  roles: string[];
  permissions: string[];
  scopes: string[];
  featureFlags: Record<string, unknown>;
  properties: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export interface BudgetLimit {
  /** The store key, for example `kinde-ai-policy:org:org_123:month:2026-11:usd`. */
  key: string;
  scope: Scope;
  /** The organization code, user ID or client ID the budget belongs to. */
  id: string;
  unit: Unit;
  period: Period;
  /** USD or tokens. */
  limit: number;
  /** What is left now, after spent and reserved amounts. */
  remaining: number;
  resetsAt: string;
}

export interface Attribution {
  plan: string;
  org?: string;
  user?: string;
  agent?: string;
}

export interface Allowed {
  allowed: true;
  principal: { type: "user" | "machine"; subject: string; orgCode: string | null };
  plan: string;
  model: string;
  models: string[];
  fallbacks: string[];
  maxOutputTokens: number;
  budgets: BudgetLimit[];
  attribution: Attribution;
}

export type DenialReason =
  | "unauthenticated"
  | "no_organization"
  | "agent_not_allowed"
  | "no_plan"
  | "model_not_allowed"
  | "budget_exhausted";

export interface Denied {
  allowed: false;
  reason: DenialReason;
  status: 401 | 402 | 403 | 429;
  detail: string;
  retryAt?: string;
}

export type Decision = Allowed | Denied;

/** Prices in USD per million tokens. */
export type Pricing = Record<string, { input: number; output: number }>;
