# kinde-ai-policy

Decide which AI models, output limits and budgets each Kinde user, organization or agent gets, and hand that decision to the AI gateway you already use. kinde-ai-policy reads a verified Kinde access token, picks the caller's plan from Kinde billing or a feature flag, takes their limits from their Kinde entitlements, applies the grants for their permissions and roles, reserves budget before the model call and charges the real usage after it. It does not send the model call itself. Your code still calls OpenRouter, LiteLLM, Vercel AI Gateway, Portkey, Cloudflare AI Gateway or a provider directly, with the fields this package gives it.

![How kinde-ai-policy works: a Kinde access token and your policy go into decide(), which verifies the token, picks the plan, applies grants and agent caps, chooses the model and fallbacks, caps output tokens and checks every budget. prepare() reserves the worst-case cost in the budget store and renders the request for your gateway. settle() charges the real usage when the response comes back.](https://raw.githubusercontent.com/sholajegede/kinde-ai-policy/main/docs/how-it-works.png)

## Contents

- [Why it exists](#why-it-exists)
- [Install](#install)
- [Quick start](#quick-start)
- [The policy](#the-policy)
- [Plans and limits from Kinde billing](#plans-and-limits-from-kinde-billing)
- [How a decision is made](#how-a-decision-is-made)
- [Budgets](#budgets)
- [AI agents with M2M tokens](#ai-agents-with-m2m-tokens)
- [Denials](#denials)
- [Gateways](#gateways)
- [Test your policy with kinde-testkit](#test-your-policy-with-kinde-testkit)
- [API](#api)
- [What this release covers](#what-this-release-covers)

## Why it exists

An AI product sells access in tiers. The free plan gets a small model and a few dollars a month, the paid plan gets a better model with a fallback, and an admin can use the most expensive one. Kinde already knows who the caller is, which organization they are working in, what plan that organization pays for, and what roles and permissions they have. AI gateways know how to route a request, retry on another model and stop a key that has spent too much.

Nothing connects the two. Every gateway trusts whatever user ID you send it, and most of them only enforce budgets per API key or per team member, not per customer of your app. Vercel's AI Gateway documentation says this plainly: per-user quotas have to be enforced in your own code. So each team writes the same glue by hand. They read the plan from somewhere, keep a list of models per plan, count tokens in a table, and copy the result into the gateway's request fields. And because it is hand-written for one gateway, it has to be rewritten when they change gateways.

kinde-ai-policy is that glue, written once:

- It takes identity only from a verified Kinde access token, never from the request body.
- The plan, models, fallbacks, output limits and budgets live in one JSON policy that you can review, test and load from anywhere.
- Kinde billing stays the source of truth: the plan an organization pays for and the limits on that plan come from Kinde, so changing a price or a limit in Kinde changes what the caller gets.
- Budgets are counted per organization, per user and per agent, by day, week or month.
- Before the call it reserves the most the call could cost. After the call it charges what was actually used. Parallel requests cannot spend past a limit.
- AI agents that sign in with Kinde M2M tokens get their own budgets and model limits inside their organization's plan.
- A denial comes with a reason, an HTTP status and a retry time, so a person or an agent can see why.

## Install

```bash
npm install kinde-ai-policy
```

It needs Node.js 20 or later and runs on edge runtimes that have `fetch` and Web Crypto. Its only dependency is `jose`.

## Quick start

Define the policy:

```ts
// ai-policy.ts
import { definePolicy } from "kinde-ai-policy";

export const policy = definePolicy({
  plan: { from: [{ flag: "plan" }], fallback: "free" },
  plans: {
    free: {
      models: ["openai/gpt-5-mini"],
      maxOutputTokens: 1024,
      budgets: [{ scope: "org", usd: 2, period: "month" }],
    },
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
```

Then use it in any route that calls a model. This one sends the call to OpenRouter:

```ts
import { createAiPolicy } from "kinde-ai-policy";
import { openrouter } from "kinde-ai-policy/openrouter";
import { policy } from "./ai-policy";

const ai = createAiPolicy({
  policy,
  issuer: process.env.KINDE_ISSUER_URL!, // https://yourbusiness.kinde.com
  audience: process.env.KINDE_AUDIENCE!, // the API audience registered in Kinde
  pricing: {
    "openai/gpt-5-mini": { input: 0.25, output: 2 }, // USD per million tokens
    "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
    "anthropic/claude-opus-4.1": { input: 15, output: 75 },
  },
});

const gateway = openrouter({ apiKey: process.env.OPENROUTER_API_KEY });

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const decision = await ai.decide({ token });
  if (!decision.allowed) return ai.toResponse(decision);

  const call = await ai.prepare(decision, await req.json(), gateway);
  if (!call.allowed) return ai.toResponse(call);

  try {
    const res = await fetch(call.url!, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
    const json = await res.json();
    await (res.ok ? call.settle(json) : call.release());
    return Response.json(json, { status: res.status });
  } catch (error) {
    await call.release();
    throw error;
  }
}
```

If your framework has already verified the token, pass its claims instead with `ai.decide({ claims })`, and leave out `issuer` and `audience`.

## The policy

A policy is plain JSON, so it can live in your code, a file or a database. `definePolicy()` checks it and throws a `PolicyConfigError` that lists every problem at once.

| Field | What it does |
| --- | --- |
| `plan.from` | Where to read the plan name, tried in order: `{ billing: true }` for the plan the caller subscribes to in Kinde billing, `{ flag }` for a Kinde feature flag, `{ property }` for a Kinde property, `{ claim }` for any token claim. A name that is not in `plans` is skipped. |
| `plan.fallback` | The plan for callers with no plan from those sources. Without it they are denied with `no_plan`. |
| `plans.<name>.models` | The models this plan may use. The first one is the default. |
| `plans.<name>.fallbacks` | Models for the gateway to try, in order, if the chosen one fails. Each must be in `models`. |
| `plans.<name>.maxOutputTokens` | The most output tokens a single call may ask for. |
| `plans.<name>.budgets` | Organization and user budgets: `{ scope, period, usd, tokens }`. |
| `entitlements` | Kinde billing feature keys whose limit replaces a plan limit. See [Plans and limits from Kinde billing](#plans-and-limits-from-kinde-billing). |
| `properties` | Kinde organization, user or application property keys whose number replaces a plan limit, for a deal you set by hand on one organization. |
| `grants` | Extra access for one `permission`, `role` or `flag`: `addModels`, a higher `maxOutputTokens`, or user and agent `budgets` that replace the plan's budget with the same scope, period and unit. Grants cannot change organization budgets. |
| `agents` | The policy for M2M tokens. See [AI agents with M2M tokens](#ai-agents-with-m2m-tokens). |
| `requireOrganization` | Deny tokens without `org_code`. Defaults to `true`. |

If you sell plans with Kinde billing, read the plan from there. If you don't, a string feature flag named `plan` with a different value per organization works too, and Kinde puts it in the access token as `feature_flags.plan`.

## Plans and limits from Kinde billing

In Kinde billing, a plan has features, and each feature can have a limit. kinde-ai-policy reads the plan an organization subscribes to, and the limits on it, from Kinde's Management API, so your access tokens need no extra claims:

```ts
import { createAiPolicy, definePolicy, kindeManagementApi } from "kinde-ai-policy";

export const policy = definePolicy({
  plan: { from: [{ billing: true }], fallback: "free" },
  plans: {
    free: { models: ["openai/gpt-5-mini"], maxOutputTokens: 1024, budgets: [{ scope: "org", usd: 2, period: "month" }] },
    pro: { models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"], maxOutputTokens: 4096, budgets: [{ scope: "org", usd: 100, period: "month" }] },
  },
  entitlements: {
    ai_monthly_usd: "budgets.org.usd.month",
    ai_max_output: "maxOutputTokens",
  },
});

const ai = createAiPolicy({
  policy,
  issuer: process.env.KINDE_ISSUER_URL!,
  audience: process.env.KINDE_AUDIENCE!,
  pricing,
  entitlements: kindeManagementApi({
    issuer: process.env.KINDE_ISSUER_URL!,
    clientId: process.env.KINDE_M2M_CLIENT_ID!,
    clientSecret: process.env.KINDE_M2M_CLIENT_SECRET!,
  }),
});
```

The names under `plans` are Kinde plan codes, so an organization on the `pro` plan in Kinde gets the `pro` plan here. The `ai_monthly_usd` feature's limit on that plan in Kinde replaces the $100, so when you raise it in Kinde the organization can spend more from the next lookup. A mapping target is `maxOutputTokens` or a budget written as `budgets.<org|user>.<usd|tokens>.<day|week|month>`. If the plan has no budget with that scope, unit and period, the entitlement adds one.

Kinde reports an unlimited feature as `2147483647`. For a budget that removes the budget, and for `maxOutputTokens` it keeps the plan's limit. A feature with no limit in Kinde leaves the plan's value as it is.

How the lookup works:

- `kindeManagementApi()` needs an M2M app in Kinde that is authorized for the Kinde Management API with the `read:organizations` and `read:billing_entitlements` scopes. It gets its own token with the client credentials grant and reuses it until it expires.
- For each organization it makes two calls: `GET /api/v1/organization?expand=billing`, which gives the plan code and the billing customer ID, and `GET /api/v1/billing/entitlements` for that customer, which gives the limits.
- It only needs the organization code, so it works the same for user tokens and for AI agents with M2M tokens.
- A lookup is reused for 60 seconds per caller (`entitlementsCacheMs`), and parallel calls share one request.
- If Kinde cannot be reached, the last answer is used for up to an hour (`entitlementsMaxStaleMs`). After that, or with no earlier answer, the call is denied with `entitlements_unavailable` (503) rather than given a plan the organization may not pay for.

For plans billed to individual users rather than organizations, use `kindeAccountApi({ issuer })` instead. It reads Kinde's Account API with the user's own access token, so pass `token` to `decide()` even if you also pass `claims`. Kinde's Account API returned an empty plan for an organization's subscription when this package was tested, which is why organization billing goes through the Management API.

To read billing some other way, pass `entitlements: async ({ principal, token }) => ({ orgCode, plans: ["pro"], limits: { ai_monthly_usd: 250 } })`. Return `null` when you cannot answer for that caller.

## How a decision is made

`decide()` runs these steps in order and stops at the first denial. `explain()` returns the same decision with each step written out, which helps when a user asks why they got a smaller model.

1. Verify the access token against your Kinde issuer's keys at `/.well-known/jwks.json`. Only RS256 tokens with your issuer and audience pass.
2. Read the caller: a user (`sub`) or an M2M client (`azp`, when `gty` is `client_credentials`), with `org_code`, roles, permissions, feature flags and properties.
3. Deny M2M tokens if the policy has no `agents` section, and tokens without `org_code` if an organization is required.
4. Read Kinde billing, if the policy uses it.
5. Pick the plan.
6. Apply Kinde entitlements, then properties, to the plan's limits.
7. Apply every grant that matches.
8. For an M2M caller, apply its agent policy.
9. Choose the model: the one the request asks for if the plan allows it, otherwise the plan's default. Lower `maxOutputTokens` if the request asks for fewer.
10. Read every budget that applies and deny if any is used up.

```ts
const { decision, steps } = await ai.explain({ token });
// [
//   "Verified the access token.",
//   "Caller is user kp_alice in org_acme.",
//   'Plan "pro" comes from feature flag "plan".',
//   'Grant 0 applies through permission "ai:premium-models".',
//   "Checked 2 budgets.",
//   'Allowed anthropic/claude-sonnet-4.5 on plan "pro".'
// ]
```

## Budgets

A budget has a scope, a period and a limit in USD, tokens or both.

| Scope | Counted per | Set in |
| --- | --- | --- |
| `org` | Kinde organization code | plans |
| `user` | Kinde user ID | plans, grants |
| `agent` | M2M client ID | agents, grants |

Periods follow the UTC calendar: `day` resets at midnight, `week` on Monday at midnight, and `month` on the first of the month. A call must fit in every budget that applies to it, so a user on the pro plan above is held to both their own $20 and their organization's $100.

Each call goes through two steps:

1. `prepare()` reserves the most the call could cost on every budget at once, or on none. For tokens that is the estimated input plus the output limit. For USD it is that token count priced at the most expensive model in the fallback chain, because the gateway may fall back to any of them. The input estimate is deliberately high: one token per 3 characters plus 4 per message.
2. `settle()` replaces the reservation with what the call really used. Pass it the gateway's response or the last chunk of a stream. If the gateway reports a cost, as OpenRouter does in `usage.cost`, that cost is charged. Otherwise the reported tokens are priced with your `pricing`. If no usage can be read, the full reservation is charged. `release()` drops a reservation for a call that failed or was never sent. A reservation that is neither settled nor released frees itself after `reservationTtlMs` (10 minutes by default).

USD is counted in millionths of a dollar, so totals do not drift. Prices are in USD per million tokens, the unit gateways publish.

The budget state lives in a store. This release ships `memoryStore()`, the default, which keeps counters in the process. It is right for tests, scripts and a single server. If your app runs on more than one instance, each one would count separately, so wait for the Redis store in a later release or pass your own store that implements `BudgetStore`. A store must check and add every entry of a reservation in one atomic step.

## AI agents with M2M tokens

AI agents and background workers sign in to Kinde with the client credentials grant and get an M2M access token. Kinde puts the app's client ID in `azp`, `client_credentials` in `gty`, and `org_code` when the app belongs to an organization. kinde-ai-policy treats each such client as its own budget holder inside its organization's plan:

```ts
agents: {
  default: { models: ["openai/gpt-5-mini"], maxOutputTokens: 2048, budgets: [{ scope: "agent", usd: 5, period: "day" }] },
  clients: { support_agent: { models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"] } },
},
```

An agent gets the plan's models narrowed to its own `models`, the lower of the two output limits, its organization's budgets and its own agent budgets. User budgets do not apply to agents. A client listed in `clients` uses those fields over `default`.

## Denials

| `reason` | `status` | When |
| --- | --- | --- |
| `unauthenticated` | 401 | No token, or the token failed verification |
| `no_organization` | 403 | The token has no `org_code` and the policy requires one |
| `agent_not_allowed` | 403 | An M2M token, and the policy has no `agents` section |
| `model_not_allowed` | 403 | The request asks for a model the caller may not use |
| `no_plan` | 402 | No plan source matched and there is no fallback plan |
| `budget_exhausted` | 429 | A budget is used up, or the call's worst case does not fit in what is left |
| `entitlements_unavailable` | 503 | Kinde billing could not be reached and there is no recent answer to use |

`ai.toResponse(denied)` turns a denial into a JSON `Response` with that status, the reason and a readable message, plus a `Retry-After` header when the budget resets:

```json
{ "error": { "type": "budget_exhausted", "message": "The monthly user budget of $20.00 is used up. It resets at 2026-12-01T00:00:00.000Z.", "retry_at": "2026-12-01T00:00:00.000Z" } }
```

## Gateways

An adapter turns a decision into one gateway's request and reads usage and cost back from its response. Each one is its own import, so you only load the one you use.

### OpenRouter

```ts
import { openrouter } from "kinde-ai-policy/openrouter";

const call = await ai.prepare(decision, { messages }, openrouter({ apiKey: process.env.OPENROUTER_API_KEY }));
```

The adapter sends the decision's fallbacks in OpenRouter's `models` field, which OpenRouter tries in order after `model`. It caps `max_tokens`, sends the user or agent ID in `user`, and turns on usage accounting, so `settle()` charges the cost OpenRouter reports in `usage.cost`. Pass `app: { url, title }` to send the `HTTP-Referer` and `X-Title` headers OpenRouter uses for app attribution.

OpenRouter checks every model ID in the request before it routes, so a misspelled model in a plan or its fallbacks fails the whole request with a 400, not just that model. Use exact OpenRouter model IDs in your policy.

### Vercel AI Gateway

```ts
import { vercelGateway } from "kinde-ai-policy/vercel";

const call = await ai.prepare(decision, { messages }, vercelGateway({ apiKey: process.env.AI_GATEWAY_API_KEY }));
```

The adapter sends the fallbacks in `providerOptions.gateway`, and keeps any gateway options you already set there, such as `order`. When Vercel falls back, it still answers with a normal response, and `settle()` reads the model that answered and the total Vercel debited (`gatewayCost`, surcharges included) from the response's metadata.

`sendUser: true` sends the user or agent ID as Vercel's `user`, and `sendTags: true` adds `plan:`, `org:` and `agent:` reporting tags, so Vercel's spend reports can group by them. Both are off by default because Vercel charges for each reporting value it records. In testing, each value added $0.000075 to the request, more than 20 times the inference cost of a short call.

Vercel's own budgets cover API keys, projects and team members, not the customers of your app. The budgets in your policy are what limit each organization, user and agent.

### The AI SDK

```ts
import { generateText, gateway, wrapLanguageModel } from "ai";
import { aiPolicyMiddleware, PolicyDeniedError } from "kinde-ai-policy/ai-sdk";

const decision = await ai.decide({ token });
if (!decision.allowed) return ai.toResponse(decision);

try {
  const { text } = await generateText({
    model: wrapLanguageModel({ model: gateway(decision.model), middleware: aiPolicyMiddleware(ai, decision, { gateway: "vercel" }) }),
    prompt,
  });
  return Response.json({ text });
} catch (error) {
  if (error instanceof PolicyDeniedError) return ai.toResponse(error.denied);
  throw error;
}
```

The middleware works with `generateText` and `streamText`, and with any provider. Before the call it refuses a model the decision does not allow, caps `maxOutputTokens` and reserves budget. After the call, or when a stream finishes, it settles from the usage the call reports, and if the call fails it returns the reservation. With `gateway: "vercel"` it also sends the fallbacks in `providerOptions.gateway`, and `user: true` and `tags: true` add the paid reporting values described above. It defaults to AI SDK 7. Pass `specificationVersion: "v3"` for AI SDK 6.

### LiteLLM

```ts
import { litellm } from "kinde-ai-policy/litellm";

const call = await ai.prepare(decision, { messages }, litellm({ baseUrl: "http://localhost:4000", apiKey: process.env.LITELLM_MASTER_KEY }));
const res = await fetch(call.url!, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
await call.settle(await res.json(), res.headers);
```

The adapter sends the fallbacks in LiteLLM's `fallbacks` body field, which the proxy tries in order when a model fails. It sends the user or agent ID in `user`, which LiteLLM tracks as the end user, and adds `plan:`, `org:` and `agent:` to `metadata.tags` for LiteLLM's spend tracking (`sendTags: false` turns that off). Pass the response headers to `settle()`, as above, and it charges the cost LiteLLM reports in `x-litellm-response-cost`. The model names in your policy are the `model_name` values in your proxy's config.

This works with the open-source proxy. LiteLLM's own JWT authentication is an Enterprise feature, and this package checks the Kinde token in front of the proxy instead.

### Portkey

```ts
import { portkey } from "kinde-ai-policy/portkey";

const adapter = portkey({
  apiKey: process.env.PORTKEY_API_KEY,
  target: (model) => ({ provider: "@openai-prod" }),
});
```

With `target`, the adapter sends the model and its fallbacks as a fallback config in the `x-portkey-config` header, one target per model, each with its own `override_params.model`. `target` returns how to reach a model, such as a Model Catalog provider slug, or `{ provider, api_key, custom_host }` for the open-source gateway. `onStatusCodes` limits which errors move to the next model. Portkey reports which target answered in the `x-portkey-last-used-option-index` response header.

The adapter also sends `_user`, `plan`, `org` and `agent` in `x-portkey-metadata`, which appear in Portkey's logs and can group Portkey's usage-limit policies (`sendMetadata: false` turns that off). Pass `baseUrl` for the open-source gateway, which needs no `apiKey`.

### Any OpenAI-compatible endpoint

`kinde-ai-policy/openai-compatible` works with any endpoint that speaks the OpenAI chat completions API, such as OpenAI itself. It sets `model`, caps `max_tokens` (or `max_completion_tokens` with `maxTokensField`), sends the user in `user`, and asks streams to include usage in their last chunk. That API has no fallback field, so this adapter sends no fallbacks.

### Your own calls

For a client or gateway with no adapter, reserve budget yourself and settle with the usage you get back:

```ts
const reservation = await ai.reserve(decision, { inputTokens: 1200, maxOutputTokens: 500 });
if (!reservation.allowed) return ai.toResponse(reservation);
try {
  const result = await callYourModel(reservation.model, reservation.maxOutputTokens);
  await reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
} catch (error) {
  await reservation.release();
  throw error;
}
```

To write an adapter, implement `GatewayAdapter`: a `render()` that returns `{ url, headers, body }` and a `readUsage()` that returns `{ inputTokens, outputTokens, model, costUsd }`. `chatCompletionsAdapter()` builds the OpenAI-style body for you.

## Test your policy with kinde-testkit

[kinde-testkit](https://www.npmjs.com/package/kinde-testkit) signs real Kinde-shaped tokens, so you can test a policy without a Kinde account or a network:

```ts
import { KindeTestkit } from "kinde-testkit";
import { createAiPolicy } from "kinde-ai-policy";
import { policy } from "./ai-policy";

const testkit = await KindeTestkit.create({ issuer: "https://acme.kinde.test", audience: ["https://api.acme.test"] });
const ai = createAiPolicy({ policy, issuer: "https://acme.kinde.test", audience: "https://api.acme.test", jwks: testkit.jwks(), pricing });

const token = await testkit.token({ subject: "kp_alice", organizationCode: "org_acme", featureFlags: { plan: { t: "s", v: "pro" } } });
expect(await ai.decide({ token })).toMatchObject({ allowed: true, plan: "pro" });

const outsider = await testkit.token({ subject: "kp_bob", organizationCode: "org_acme" });
expect(await ai.decide({ token: outsider }, { model: "anthropic/claude-sonnet-4.5" })).toMatchObject({ allowed: false, reason: "model_not_allowed" });
```

`testkit.m2mToken({ clientId, organizationCode })` signs an M2M token the same way, for testing agent policies.

## API

From `kinde-ai-policy`:

- `createAiPolicy({ policy, issuer, audience, jwks, verify, store, pricing, reservationTtlMs, entitlements, entitlementsCacheMs, entitlementsMaxStaleMs, estimateInputTokens, now })` returns the engine. `verify` replaces the built-in token check with your own, and `entitlements` is required when the policy reads Kinde billing.
- `ai.decide({ token, claims }, { model, maxOutputTokens })` returns an `Allowed` decision (`plan`, `model`, `models`, `fallbacks`, `maxOutputTokens`, `budgets` with `remaining` and `resetsAt`, `attribution`) or a `Denied` one (`reason`, `status`, `detail`, `retryAt`).
- `ai.explain(input, request)` returns `{ decision, steps }`.
- `ai.prepare(decision, request, adapter)` reserves budget and returns `{ url, headers, body, model, fallbacks, maxOutputTokens, reservationId, settle(), release() }`, or a `Denied` decision when the call does not fit.
- `ai.reserve(decision, { model, inputTokens, maxOutputTokens })` reserves budget for a call you make yourself and returns `{ model, fallbacks, maxOutputTokens, settle(usage), release() }`, or a `Denied` decision.
- `ai.toResponse(denied)` returns a `Response`.
- `definePolicy(policy)` checks and freezes a policy. `validatePolicy(policy)` returns the list of problems without throwing.
- `principalFromClaims(claims)` turns verified claims into `{ type, subject, orgCode, roles, permissions, scopes, featureFlags, properties }`.
- `createVerifier({ issuer, audience, jwks })` returns the token check on its own.
- `kindeManagementApi({ issuer, clientId, clientSecret, audience, fetch, pageSize })` and `kindeAccountApi({ issuer, fetch, pageSize })` read Kinde billing. `KINDE_UNLIMITED` is `2147483647`.
- `memoryStore()` and the `BudgetStore` interface.
- `estimateInputTokens(request)`, `costMicros(price, input, output)` and `periodWindow(period, date)`.
- `PolicyConfigError`, with `problems` listing each one.

From the gateway imports:

- `kinde-ai-policy/openrouter`: `openrouter({ apiKey, baseUrl, app, maxTokensField, sendUser, headers })`.
- `kinde-ai-policy/vercel`: `vercelGateway({ apiKey, baseUrl, sendTags, maxTokensField, sendUser, headers })`.
- `kinde-ai-policy/ai-sdk`: `aiPolicyMiddleware(ai, decision, { gateway, user, tags, specificationVersion })`, `PolicyDeniedError` and `usageFromAiSdk()`.
- `kinde-ai-policy/litellm`: `litellm({ baseUrl, apiKey, sendTags, maxTokensField, sendUser, headers })`.
- `kinde-ai-policy/portkey`: `portkey({ apiKey, baseUrl, target, onStatusCodes, sendMetadata, maxTokensField, headers })`.
- `kinde-ai-policy/openai-compatible`: `openaiCompatible({ baseUrl, apiKey, maxTokensField, sendUser, headers })` and `readOpenAIUsage(response)`.

## What this release covers

| Feature | Status |
| --- | --- |
| Kinde access token verification with JWKS, user and M2M tokens | Implemented, tested against kinde-testkit's issuer over HTTP |
| Plans from Kinde billing, feature flags, properties and claims, with a fallback plan | Implemented |
| Grants by permission, role and feature flag | Implemented |
| Agent policies for M2M clients | Implemented |
| Organization, user and agent budgets in USD and tokens, by day, week and month | Implemented |
| Reserve before the call, settle after, release on failure | Implemented, tested with 50 parallel calls against one limit |
| In-memory budget store | Implemented |
| OpenAI-compatible adapter, including streams | Implemented, tested against a local OpenAI-compatible server |
| `ai.reserve()` for calls you make yourself | Implemented |
| Plans and limits from Kinde billing for organizations, through the Management API | Implemented, checked against a real Kinde business and tested with the responses it returned |
| Plans and limits from Kinde billing for users, through the Account API | Implemented, tested against kinde-testkit's Account API over HTTP |
| Kinde billing for M2M agents | Implemented, through the Management API |
| Limits from Kinde properties | Implemented |
| OpenRouter adapter with native fallbacks and reported cost | Implemented, tested live against OpenRouter |
| Vercel AI Gateway adapter with native fallbacks and total debited cost | Implemented, tested live, including a fallback from a missing model |
| AI SDK middleware for `generateText` and `streamText` | Implemented, tested with AI SDK 7 and live through Vercel AI Gateway |
| LiteLLM adapter with native fallbacks and reported cost | Implemented, tested against a local LiteLLM proxy |
| Portkey adapter with fallback configs and metadata | Implemented, tested against Portkey's open-source gateway |
| Cloudflare AI Gateway adapter | Planned |
| Redis and Upstash budget stores | Planned |
| An agent acting for a user | Planned |
| Reporting usage to Kinde billing meters | Planned |

## License

MIT
