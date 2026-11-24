# Changelog

## 0.1.0

- First release. `createAiPolicy()` decides which models, fallbacks, output limit and budgets a Kinde caller gets, and `prepare()` turns the decision into a gateway request.
- Verifies Kinde access tokens against the issuer's JWKS, with RS256, issuer and audience checks. `decide({ claims })` accepts claims your framework already verified.
- `principalFromClaims()` reads Kinde user tokens and M2M tokens, including roles, permissions, feature flags and organization, user and application properties.
- `definePolicy()` checks a JSON policy and lists every problem at once: plans from feature flags, properties or claims with a fallback plan, grants by permission, role or feature flag, and agent policies for M2M clients.
- Budgets per organization, user and agent, in USD, tokens or both, by UTC day, week or month. `prepare()` reserves the worst case across the fallback chain on every budget at once, `settle()` charges the real usage or the gateway's reported cost, and `release()` returns the reservation.
- `memoryStore()` keeps budgets in the process. Unsettled reservations free themselves after `reservationTtlMs`.
- `explain()` lists each step of a decision. `toResponse()` turns a denial into a JSON response with its status and a `Retry-After` header.
- `kinde-ai-policy/openai-compatible` sends the decision to any OpenAI-compatible endpoint, including streams, and reads usage back.
