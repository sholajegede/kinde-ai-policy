import type { Principal } from "./types.js";

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** Kinde wraps flag and property values as `{ t, v }` or `{ v }`. */
function unwrap(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "v" in value) return (value as { v: unknown }).v;
  return value;
}

function unwrapAll(record: unknown): Record<string, unknown> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return {};
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, unwrap(v)]));
}

/**
 * Turns verified Kinde access token claims into a principal.
 * Only pass claims from a token you have verified.
 */
export function principalFromClaims(claims: Record<string, unknown>): Principal {
  const gty = claims.gty;
  const grants = Array.isArray(gty) ? gty : typeof gty === "string" ? [gty] : [];
  const machine = grants.includes("client_credentials");
  const subject = machine ? claims.azp : claims.sub;
  if (typeof subject !== "string" || subject === "") {
    throw new Error(machine ? "The M2M token has no azp claim." : "The token has no sub claim.");
  }

  const roles = Array.isArray(claims.roles)
    ? claims.roles
        .map((r) => (typeof r === "string" ? r : typeof r === "object" && r !== null ? (r as { key?: unknown }).key : undefined))
        .filter((r): r is string => typeof r === "string")
    : [];

  const scopeClaim = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  const scopes = machine && scopeClaim.length > 0 ? scopeClaim : [...new Set([...scopeClaim, ...asStrings(claims.scp)])];

  return {
    type: machine ? "machine" : "user",
    subject,
    orgCode: typeof claims.org_code === "string" && claims.org_code !== "" ? claims.org_code : null,
    roles,
    permissions: asStrings(claims.permissions),
    scopes,
    featureFlags: unwrapAll(claims.feature_flags),
    properties: {
      ...unwrapAll(claims.organization_properties),
      ...unwrapAll(claims.user_properties),
      ...unwrapAll(claims.application_properties),
    },
    claims,
  };
}
