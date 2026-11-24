import { startKindeTestkit, type RunningKindeTestkit } from "kinde-testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAiPolicy } from "../src/index.js";
import { AUDIENCE, policy, pricing } from "./fixtures.js";

// These tests fetch keys from a running issuer over HTTP, the same way the package does with Kinde.
let issuer: RunningKindeTestkit;

beforeAll(async () => {
  issuer = await startKindeTestkit({ port: 0, audience: [AUDIENCE] });
});
afterAll(async () => {
  await issuer.close();
});

const make = () => createAiPolicy({ policy, issuer: issuer.issuer, audience: AUDIENCE, pricing });

describe("token verification against the issuer's JWKS", () => {
  it("accepts a valid token", async () => {
    const token = await issuer.testkit.token({ subject: "kp_alice", organizationCode: "org_acme" });
    const decision = await make().decide({ token });
    expect(decision.allowed).toBe(true);
  });

  it.each(["expired", "wrong-issuer", "wrong-audience"] as const)("refuses a token that is %s", async (invalid) => {
    const token = await issuer.testkit.token({ subject: "kp_alice", organizationCode: "org_acme", invalid });
    const decision = await make().decide({ token });
    expect(decision).toMatchObject({ allowed: false, reason: "unauthenticated", status: 401 });
  });

  it("refuses a token signed by another key", async () => {
    const { KindeTestkit } = await import("kinde-testkit");
    const other = await KindeTestkit.create({ issuer: issuer.issuer, audience: [AUDIENCE] });
    const decision = await make().decide({ token: await other.token({ subject: "kp_alice", organizationCode: "org_acme" }) });
    expect(decision).toMatchObject({ allowed: false, reason: "unauthenticated" });
  });

  it("refuses a request with no token", async () => {
    expect(await make().decide({ token: null })).toMatchObject({ allowed: false, reason: "unauthenticated" });
  });

  it("requires an audience when an issuer is set", () => {
    expect(() => createAiPolicy({ policy, issuer: issuer.issuer, pricing })).toThrow(/audience is required/);
  });
});
