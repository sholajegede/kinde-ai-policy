import { describe, expect, it } from "vitest";
import { principalFromClaims } from "../src/index.js";
import { testkit, userToken } from "./fixtures.js";

describe("principalFromClaims", () => {
  it("reads a Kinde user token", async () => {
    const claims = await testkit.verify(await userToken({ permissions: ["ai:premium-models"], roles: ["ai-admin"], plan: "pro" }));
    const p = principalFromClaims(claims);
    expect(p).toMatchObject({
      type: "user",
      subject: "kp_alice",
      orgCode: "org_acme",
      permissions: ["ai:premium-models"],
      roles: ["ai-admin"],
      featureFlags: { plan: "pro" },
    });
  });

  it("reads a Kinde M2M token as a machine, with its client ID as the subject", async () => {
    const token = await testkit.m2mToken({ clientId: "support_agent", organizationCode: "org_acme", scopes: ["read:tickets"] });
    const p = principalFromClaims(await testkit.verify(token));
    expect(p).toMatchObject({ type: "machine", subject: "support_agent", orgCode: "org_acme", scopes: ["read:tickets"] });
  });

  it("merges organization, user and application properties and unwraps Kinde values", () => {
    const p = principalFromClaims({
      sub: "kp_bob",
      organization_properties: { kp_org_plan: { v: "pro" }, shared: { v: "org" } },
      user_properties: { shared: { v: "user" } },
      feature_flags: { beta: { t: "b", v: true } },
    });
    expect(p.properties).toEqual({ kp_org_plan: "pro", shared: "user" });
    expect(p.featureFlags).toEqual({ beta: true });
    expect(p.orgCode).toBeNull();
  });

  it("refuses claims without a subject", async () => {
    const claims = await testkit.verify(await testkit.token({ invalid: "missing-subject" }));
    expect(() => principalFromClaims(claims)).toThrow(/no sub claim/);
  });
});
