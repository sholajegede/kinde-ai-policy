import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAiPolicy, definePolicy, kindeManagementApi, principalFromClaims, type Allowed } from "../src/index.js";
import { MINI, SONNET } from "./fixtures.js";

// A local stand-in for Kinde's Management API. The organization and entitlement bodies are the ones a real
// Kinde business returned on 2026-11-24 for an organization on a plan with three features (test/contract).
const REAL_ORG_BILLING = {
  agreements: [{ plan_code: "siteward_pro", agreement_id: "agreement_01a1c880f3b5a20cdfa71f3f171a125c" }],
  billing_customer_id: "customer_01a18502fa8af570663ecfd91b2f9113",
};
const REAL_ENTITLEMENTS = [
  { id: "entitlement_01a1c880f411d8132fea905c3d597980", price_name: null, unit_amount: 0.0, feature_code: "alert_channels", feature_name: "Alert channels", fixed_charge: 0.0, entitlement_limit_max: 3, entitlement_limit_min: 0 },
  { id: "entitlement_01a1c880f411619e13b92fd05ca6d5bb", price_name: null, unit_amount: 0.0, feature_code: "monitors", feature_name: "Monitors", fixed_charge: 0.0, entitlement_limit_max: 25, entitlement_limit_min: 0 },
  { id: "entitlement_01a1c880f41102a481aae4fe788e08e7", price_name: null, unit_amount: 0.0, feature_code: "protected_sites", feature_name: "Protected sites", fixed_charge: 0.0, entitlement_limit_max: 10, entitlement_limit_min: 0 },
];

let server: Server;
let issuer: string;
const log: string[] = [];
const valid = new Set<string>();
let tokenCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      log.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/oauth2/token") {
        const form = new URLSearchParams(raw);
        if (form.get("client_id") !== "billing_reader" || form.get("client_secret") !== "s3cret" || form.get("audience") !== `${issuer}/api`)
          return send(401, { error: "invalid_client" });
        const token = `mgmt_${++tokenCount}`;
        valid.add(token);
        return send(200, { access_token: token, expires_in: 86400, scope: "", token_type: "bearer" });
      }
      if (!valid.has(req.headers.authorization?.slice(7) ?? "")) return send(401, { errors: [{ code: "TOKEN_INVALID" }] });
      if (url.pathname === "/api/v1/organization") {
        const code = url.searchParams.get("code");
        if (url.searchParams.get("expand") !== "billing") return send(400, {});
        if (code === "org_11028f68ef58") return send(200, { code, name: "Dabbit Pro", billing: REAL_ORG_BILLING });
        if (code === "org_unbilled") return send(200, { code, name: "Unbilled" });
        if (code === "org_forbidden") return send(403, { errors: [{ code: "SCOPE_MISSING" }] });
        return send(404, {});
      }
      if (url.pathname === "/api/v1/billing/entitlements") {
        if (url.searchParams.get("customer_id") !== REAL_ORG_BILLING.billing_customer_id) return send(404, {});
        const size = Number(url.searchParams.get("page_size"));
        const after = url.searchParams.get("starting_after");
        const start = after ? REAL_ENTITLEMENTS.findIndex((e) => e.id === after) + 1 : 0;
        const page = REAL_ENTITLEMENTS.slice(start, start + size);
        return send(200, { code: "OK", message: "Success", has_more: start + size < REAL_ENTITLEMENTS.length, entitlements: page });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  log.length = 0;
});

const source = (extra: { pageSize?: number; clientSecret?: string } = {}) =>
  kindeManagementApi({ issuer, clientId: "billing_reader", clientSecret: extra.clientSecret ?? "s3cret", ...(extra.pageSize ? { pageSize: extra.pageSize } : {}) });
const user = (org: string | null) => principalFromClaims({ sub: "kp_49400a5655424983b2505b51120c5546", ...(org ? { org_code: org } : {}) });

describe("kindeManagementApi", () => {
  it("reads the plan from the organization's agreements and the limits from its entitlements", async () => {
    expect(await source()({ principal: user("org_11028f68ef58") })).toEqual({
      orgCode: "org_11028f68ef58",
      plans: ["siteward_pro"],
      limits: { alert_channels: 3, monitors: 25, protected_sites: 10 },
    });
    expect(log).toEqual([
      "POST /oauth2/token",
      "GET /api/v1/organization?code=org_11028f68ef58&expand=billing",
      "GET /api/v1/billing/entitlements?customer_id=customer_01a18502fa8af570663ecfd91b2f9113&page_size=100",
    ]);
  });

  it("follows every page of entitlements", async () => {
    const result = await source({ pageSize: 2 })({ principal: user("org_11028f68ef58") });
    expect(Object.keys(result!.limits)).toHaveLength(3);
    expect(log.filter((l) => l.includes("billing/entitlements"))).toHaveLength(2);
    expect(log.at(-1)).toContain("starting_after=entitlement_01a1c880f411619e13b92fd05ca6d5bb");
  });

  it("reuses its M2M token, and gets a new one when Kinde rejects it", async () => {
    const read = source();
    await read({ principal: user("org_11028f68ef58") });
    await read({ principal: user("org_11028f68ef58") });
    expect(log.filter((l) => l.includes("oauth2/token"))).toHaveLength(1);
    valid.clear();
    await read({ principal: user("org_11028f68ef58") });
    expect(log.filter((l) => l.includes("oauth2/token"))).toHaveLength(2);
  });

  it("returns no plan for an organization without billing, and nothing for a caller without an organization", async () => {
    expect(await source()({ principal: user("org_unbilled") })).toEqual({ orgCode: "org_unbilled", plans: [], limits: {} });
    expect(await source()({ principal: user(null) })).toBeNull();
  });

  it("names the missing scope when Kinde answers 403, and refuses a bad client secret", async () => {
    await expect(source()({ principal: user("org_forbidden") })).rejects.toThrow(/answered 403 for \/api\/v1\/organization\. Check that the M2M app has the read:organizations/);
    await expect(source({ clientSecret: "wrong" })({ principal: user("org_11028f68ef58") })).rejects.toThrow(/refused the M2M token for the Management API \(401\)/);
  });
});

describe("a policy on Kinde billing through the Management API", () => {
  const policy = definePolicy({
    plan: { from: [{ billing: true }], fallback: "free" },
    plans: {
      free: { models: [MINI], maxOutputTokens: 1024, budgets: [{ scope: "org", usd: 1, period: "month" }] },
      siteward_pro: { models: [SONNET, MINI], maxOutputTokens: 4096, budgets: [{ scope: "org", usd: 5, period: "month" }] },
    },
    entitlements: { monitors: "budgets.org.usd.month" },
    agents: { default: { models: [MINI] } },
  });
  const pricing = { [MINI]: { input: 0.25, output: 2 }, [SONNET]: { input: 3, output: 15 } };

  it("gives a user the organization's plan and limit", async () => {
    const ai = createAiPolicy({ policy, pricing, entitlements: source() });
    const d = (await ai.decide({ claims: { sub: "kp_49400a5655424983b2505b51120c5546", org_code: "org_11028f68ef58" } })) as Allowed;
    expect(d).toMatchObject({ plan: "siteward_pro", model: SONNET, budgets: [{ scope: "org", limit: 25 }] });
  });

  it("gives an M2M agent in the organization the same plan and limit, within its agent policy", async () => {
    const ai = createAiPolicy({ policy, pricing, entitlements: source() });
    const d = (await ai.decide({ claims: { gty: ["client_credentials"], azp: "siteward_agent", org_code: "org_11028f68ef58" } })) as Allowed;
    expect(d).toMatchObject({ plan: "siteward_pro", model: MINI, models: [MINI], budgets: [{ scope: "org", limit: 25 }] });
  });

  it("uses the fallback plan for an organization without billing", async () => {
    const ai = createAiPolicy({ policy, pricing, entitlements: source() });
    expect(await ai.decide({ claims: { sub: "kp_x", org_code: "org_unbilled" } })).toMatchObject({ plan: "free", budgets: [{ limit: 1 }] });
  });
});
