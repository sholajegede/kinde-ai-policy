import { describe, expect, it } from "vitest";
import { kindeAccountApi, kindeManagementApi, principalFromClaims } from "../../src/index.js";

// Read-only checks of Kinde billing against a real Kinde business.
// Account API: KINDE_CONTRACT_ISSUER and KINDE_CONTRACT_TOKEN (a user access token). node test/contract/sign-in.mjs sets both.
// Management API: also KINDE_CONTRACT_M2M_CLIENT_ID, KINDE_CONTRACT_M2M_CLIENT_SECRET, KINDE_CONTRACT_ORG and KINDE_CONTRACT_CUSTOMER_ID.
const issuer = process.env.KINDE_CONTRACT_ISSUER?.replace(/\/+$/, "");
const token = process.env.KINDE_CONTRACT_TOKEN;
const m2mId = process.env.KINDE_CONTRACT_M2M_CLIENT_ID;
const m2mSecret = process.env.KINDE_CONTRACT_M2M_CLIENT_SECRET;
const org = process.env.KINDE_CONTRACT_ORG;
const customer = process.env.KINDE_CONTRACT_CUSTOMER_ID;

describe.skipIf(!issuer || !token)("Kinde Account API entitlements (live)", () => {
  it("returns the shape the package reads", async () => {
    const res = await fetch(`${issuer}/account_api/v1/entitlements`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>; metadata: Record<string, unknown> };
    console.log("Account API answered:", JSON.stringify(body, null, 2));
    expect(body.data).toHaveProperty("org_code");
    expect(Array.isArray(body.data.plans)).toBe(true);
    expect(Array.isArray(body.data.entitlements)).toBe(true);
    // Kinde sends a plan with a null key when the caller has no plan it can report.
    for (const plan of body.data.plans as Array<Record<string, unknown>>) expect(plan.key === null || typeof plan.key === "string").toBe(true);
    for (const e of body.data.entitlements as Array<Record<string, unknown>>) {
      expect(typeof e.feature_key).toBe("string");
      expect(e.entitlement_limit_max === null || typeof e.entitlement_limit_max === "number").toBe(true);
    }
    expect(body.metadata).toHaveProperty("has_more");
  });

  it("reads them through kindeAccountApi", async () => {
    const payload = JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    const result = await kindeAccountApi({ issuer: issuer! })({ principal: principalFromClaims(payload), token: token! });
    expect(result).not.toBeNull();
    console.log("kindeAccountApi read:", JSON.stringify(result, null, 2));
  });
});

describe.skipIf(!issuer || !m2mId || !m2mSecret || !org)("Kinde Management API billing (live)", () => {
  async function m2mToken() {
    const res = await fetch(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: m2mId!, client_secret: m2mSecret!, audience: `${issuer}/api` }),
    });
    const body = (await res.json()) as { access_token?: string; scope?: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    console.log("M2M token scopes:", body.scope);
    return body.access_token!;
  }

  async function get(path: string, bearer: string) {
    const res = await fetch(`${issuer}${path}`, { headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
    const text = await res.text();
    console.log(`GET ${path} answered ${res.status}:`, text.slice(0, 4000));
    return res.status;
  }

  it("prints the organization and its billing", async () => {
    const bearer = await m2mToken();
    const res = await fetch(`${issuer}/api/v1/organization?code=${encodeURIComponent(org!)}&expand=billing`, { headers: { authorization: `Bearer ${bearer}` } });
    const orgBody = (await res.json()) as { billing?: { billing_customer_id?: string } };
    console.log(`GET organization with expand=billing answered ${res.status}:`, JSON.stringify(orgBody.billing ?? orgBody));
    const customerId = orgBody.billing?.billing_customer_id ?? customer;
    if (customerId) {
      await get(`/api/v1/billing/agreements?customer_id=${encodeURIComponent(customerId)}`, bearer);
      await get(`/api/v1/billing/entitlements?customer_id=${encodeURIComponent(customerId)}`, bearer);
    }
  });

  it("reads the plan and limits through kindeManagementApi", async () => {
    const read = kindeManagementApi({ issuer: issuer!, clientId: m2mId!, clientSecret: m2mSecret! });
    const result = await read({ principal: principalFromClaims({ sub: "kp_contract", org_code: org! }) });
    console.log("kindeManagementApi read:", JSON.stringify(result, null, 2));
    expect(result).not.toBeNull();
    expect(result!.orgCode).toBe(org);
    expect(Array.isArray(result!.plans)).toBe(true);
    for (const limit of Object.values(result!.limits)) expect(limit === null || typeof limit === "number").toBe(true);
  });
});
