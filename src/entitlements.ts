import type { Principal } from "./types.js";

/** Kinde reports an unmetered or unlimited feature as this value. */
export const KINDE_UNLIMITED = 2147483647;

export interface Entitlements {
  orgCode: string | null;
  /** Plan keys the caller subscribes to, in the order Kinde returns them. */
  plans: string[];
  /** `entitlement_limit_max` by feature key. `null` means Kinde sent no limit. */
  limits: Record<string, number | null>;
}

export interface EntitlementsContext {
  principal: Principal;
  /** The caller's access token, when one was passed to decide(). */
  token?: string;
}

/** Looks up a caller's Kinde billing plan and limits. Returns null when it cannot look them up for this caller. */
export type EntitlementsSource = (context: EntitlementsContext) => Promise<Entitlements | null>;

export class EntitlementsError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EntitlementsError";
    this.status = status;
  }
}

interface AccountPage {
  data?: {
    org_code?: string | null;
    plans?: Array<{ key?: unknown }>;
    entitlements?: Array<{ feature_key?: unknown; entitlement_limit_max?: unknown }>;
  };
  metadata?: { has_more?: boolean; next_page_starting_after?: string | null };
}

export interface KindeAccountApiOptions {
  /** Your Kinde domain, for example `https://yourbusiness.kinde.com`. */
  issuer: string;
  fetch?: typeof fetch;
  pageSize?: number;
  /** Stops after this many pages, so a broken cursor cannot loop forever. Defaults to 20. */
  maxPages?: number;
}

/**
 * Reads entitlements from Kinde's Account API with the user's own access token.
 * Use it for plans billed to individual users. For plans billed to an organization, Kinde's Account API
 * returned an empty plan in testing, so use kindeManagementApi() instead. M2M tokens cannot use it.
 */
export function kindeAccountApi(options: KindeAccountApiOptions): EntitlementsSource {
  const base = `${options.issuer.replace(/\/+$/, "")}/account_api/v1/entitlements`;
  const doFetch = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 20;

  return async ({ principal, token }) => {
    if (principal.type === "machine" || !token) return null;
    const result: Entitlements = { orgCode: principal.orgCode, plans: [], limits: {} };
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(base);
      url.searchParams.set("page_size", String(pageSize));
      if (after) url.searchParams.set("starting_after", after);
      const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (!res.ok) throw new EntitlementsError(`Kinde's Account API answered ${res.status} for entitlements.`, res.status);
      const body = (await res.json()) as AccountPage;
      if (!body.data) throw new EntitlementsError("Kinde's Account API sent entitlements without a data field.");
      if (page === 0) {
        if (typeof body.data.org_code === "string") result.orgCode = body.data.org_code;
        result.plans = (body.data.plans ?? []).map((p) => p.key).filter((k): k is string => typeof k === "string");
      }
      for (const e of body.data.entitlements ?? []) {
        if (typeof e.feature_key !== "string") continue;
        result.limits[e.feature_key] = typeof e.entitlement_limit_max === "number" ? e.entitlement_limit_max : null;
      }
      after = body.metadata?.has_more ? (body.metadata.next_page_starting_after ?? null) : null;
      if (!after) return result;
    }
    throw new EntitlementsError(`Kinde's Account API returned more than ${maxPages} pages of entitlements.`);
  };
}

export interface KindeManagementApiOptions {
  /** Your Kinde domain, for example `https://yourbusiness.kinde.com`. */
  issuer: string;
  /** An M2M app authorized for the Kinde Management API with `read:organizations` and `read:billing_entitlements`. */
  clientId: string;
  clientSecret: string;
  /** Defaults to `<issuer>/api`. */
  audience?: string;
  fetch?: typeof fetch;
  pageSize?: number;
  /** Stops after this many pages, so a broken cursor cannot loop forever. Defaults to 20. */
  maxPages?: number;
}

interface OrganizationWithBilling {
  billing?: { billing_customer_id?: unknown; agreements?: Array<{ plan_code?: unknown }> } | null;
}

interface EntitlementsPage {
  has_more?: boolean;
  entitlements?: Array<{ id?: unknown; feature_code?: unknown; entitlement_limit_max?: unknown }>;
}

/**
 * Reads an organization's Kinde billing through the Management API: the plan from the organization's
 * billing agreements, and the limits from the billing customer's entitlements. It works for user and M2M
 * tokens alike, because it only needs the organization code.
 */
export function kindeManagementApi(options: KindeManagementApiOptions): EntitlementsSource {
  const issuer = options.issuer.replace(/\/+$/, "");
  const audience = options.audience ?? `${issuer}/api`;
  const doFetch = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 20;
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const res = await doFetch(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: options.clientId, client_secret: options.clientSecret, audience }),
    });
    if (!res.ok) throw new EntitlementsError(`Kinde refused the M2M token for the Management API (${res.status}).`, res.status);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new EntitlementsError("Kinde sent no access token for the Management API.");
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
    cached = { token: body.access_token, expiresAt: Date.now() + Math.max(0, lifetime - 60) * 1000 };
    return body.access_token;
  }

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    pending ??= fetchToken().finally(() => (pending = null));
    return pending;
  }

  async function get<T>(path: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await doFetch(`${issuer}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: "application/json" } });
      if (res.status === 401 && attempt === 0) {
        cached = null;
        continue;
      }
      if (!res.ok) {
        const detail = res.status === 403 ? " Check that the M2M app has the read:organizations and read:billing_entitlements scopes." : "";
        throw new EntitlementsError(`Kinde's Management API answered ${res.status} for ${path.split("?")[0]}.${detail}`, res.status);
      }
      return (await res.json()) as T;
    }
    throw new EntitlementsError("Kinde's Management API refused a fresh M2M token.", 401);
  }

  return async ({ principal }) => {
    const orgCode = principal.orgCode;
    if (!orgCode) return null;
    const org = await get<OrganizationWithBilling>(`/api/v1/organization?code=${encodeURIComponent(orgCode)}&expand=billing`);
    const billing = org.billing ?? null;
    const plans = (billing?.agreements ?? []).map((a) => a.plan_code).filter((c): c is string => typeof c === "string");
    const result: Entitlements = { orgCode, plans, limits: {} };
    const customerId = billing?.billing_customer_id;
    if (typeof customerId !== "string" || customerId === "") return result;

    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ customer_id: customerId, page_size: String(pageSize) });
      if (after) query.set("starting_after", after);
      const body = await get<EntitlementsPage>(`/api/v1/billing/entitlements?${query}`);
      const items = body.entitlements ?? [];
      for (const e of items) {
        if (typeof e.feature_code !== "string") continue;
        result.limits[e.feature_code] = typeof e.entitlement_limit_max === "number" ? e.entitlement_limit_max : null;
      }
      const last = items.at(-1)?.id;
      if (!body.has_more || typeof last !== "string") return result;
      after = last;
    }
    throw new EntitlementsError(`Kinde's Management API returned more than ${maxPages} pages of entitlements.`);
  };
}

interface CacheEntry {
  value: Entitlements | null;
  fetchedAt: number;
}

/** Caches lookups per caller, shares one request between parallel calls, and keeps the last answer for outages. */
export function cachedEntitlements(source: EntitlementsSource, options: { ttlMs: number; maxStaleMs: number; maxEntries?: number; now: () => number }) {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<Entitlements | null>>();
  const maxEntries = options.maxEntries ?? 10_000;

  return async (context: EntitlementsContext): Promise<{ value: Entitlements | null; stale: boolean; error?: Error }> => {
    const { principal } = context;
    const key = `${principal.type}:${principal.orgCode ?? ""}:${principal.subject}`;
    const now = options.now();
    const hit = cache.get(key);
    if (hit && now - hit.fetchedAt < options.ttlMs) return { value: hit.value, stale: false };

    let request = pending.get(key);
    if (!request) {
      request = source(context).finally(() => pending.delete(key));
      pending.set(key, request);
    }
    try {
      const value = await request;
      // A null answer means no lookup happened, often for want of a token, so it is not kept.
      if (value !== null) {
        cache.delete(key);
        cache.set(key, { value, fetchedAt: options.now() });
        if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      }
      return { value, stale: false };
    } catch (error) {
      if (hit && now - hit.fetchedAt < options.maxStaleMs) return { value: hit.value, stale: true, error: error as Error };
      throw error;
    }
  };
}
