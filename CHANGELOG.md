# Changelog

## 0.2.0

- Read the caller's plan and limits from Kinde billing. `plan.from` accepts `{ billing: true }`, and the new `entitlements` section maps a Kinde feature code to `maxOutputTokens` or a budget, such as `budgets.org.usd.month`.
- Add `kindeManagementApi()`, which reads an organization's plan from its billing agreements and its limits from the billing customer's entitlements, through Kinde's Management API with an M2M app. It works for user tokens and M2M agents, follows every page, and reuses its M2M token.
- Add `kindeAccountApi()`, which reads plans billed to individual users from Kinde's Account API with the user's access token.
- `createAiPolicy()` takes the source in `entitlements`, and refuses a policy that reads billing without one.
- Kinde's unlimited value, `2147483647`, removes a budget or keeps the plan's output limit. A feature with no limit keeps the plan's value.
- Lookups are cached per caller for `entitlementsCacheMs` (60 seconds), and parallel calls share one request. While Kinde cannot be reached, the last answer is used for `entitlementsMaxStaleMs` (1 hour). After that the call is denied with the new `entitlements_unavailable` reason and status 503.
- The new `properties` section maps a Kinde organization, user or application property to a limit in the same way.
- `decide({ claims, token })` uses the verified claims for identity and the token for the Account API.
- Add `npm run test:contract`, read-only checks of both billing APIs against a real Kinde business, and `test/contract/sign-in.mjs`, which signs in a user to get the token they need.

## 0.1.0

- First release. `createAiPolicy()` decides which models, fallbacks, output limit and budgets a Kinde caller gets, and `prepare()` turns the decision into a gateway request.
- Verifies Kinde access tokens against the issuer's JWKS, with RS256, issuer and audience checks. `decide({ claims })` accepts claims your framework already verified.
- `principalFromClaims()` reads Kinde user tokens and M2M tokens, including roles, permissions, feature flags and organization, user and application properties.
- `definePolicy()` checks a JSON policy and lists every problem at once: plans from feature flags, properties or claims with a fallback plan, grants by permission, role or feature flag, and agent policies for M2M clients.
- Budgets per organization, user and agent, in USD, tokens or both, by UTC day, week or month. `prepare()` reserves the worst case across the fallback chain on every budget at once, `settle()` charges the real usage or the gateway's reported cost, and `release()` returns the reservation.
- `memoryStore()` keeps budgets in the process. Unsettled reservations free themselves after `reservationTtlMs`.
- `explain()` lists each step of a decision. `toResponse()` turns a denial into a JSON response with its status and a `Retry-After` header.
- `kinde-ai-policy/openai-compatible` sends the decision to any OpenAI-compatible endpoint, including streams, and reads usage back.
