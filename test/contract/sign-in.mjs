// Gets a real user access token from Kinde with a front-end app's PKCE sign-in, then runs the contract tests with it.
// KINDE_CONTRACT_ISSUER=https://yourbusiness.kinde.com KINDE_CONTRACT_CLIENT_ID=<front-end app client ID> \
// KINDE_CONTRACT_REDIRECT=http://localhost:8976/callback KINDE_CONTRACT_ORG=org_123 node test/contract/sign-in.mjs
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const issuer = process.env.KINDE_CONTRACT_ISSUER?.replace(/\/+$/, "");
const clientId = process.env.KINDE_CONTRACT_CLIENT_ID;
const redirect = process.env.KINDE_CONTRACT_REDIRECT;
const org = process.env.KINDE_CONTRACT_ORG;
if (!issuer || !clientId || !redirect) {
  console.error("Set KINDE_CONTRACT_ISSUER, KINDE_CONTRACT_CLIENT_ID and KINDE_CONTRACT_REDIRECT. KINDE_CONTRACT_ORG is optional.");
  process.exit(1);
}

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(12).toString("hex");
const auth = new URL(`${issuer}/oauth2/auth`);
auth.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirect,
  scope: "openid profile email offline",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
  ...(org ? { org_code: org } : {}),
}).toString();

console.log("\nSign in at this URL. The browser then tries to open the redirect URL, which may fail to load. That is fine.\n");
console.log(auth.toString());
if (process.platform === "darwin") spawnSync("open", [auth.toString()]);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const landed = new URL((await rl.question("\nPaste the full URL from the address bar after sign-in: ")).trim());
rl.close();
if (landed.searchParams.get("state") !== state) throw new Error("The state in that URL does not match this sign-in.");
const code = landed.searchParams.get("code");
if (!code) throw new Error(`No code in that URL: ${landed.searchParams.get("error_description") ?? landed.searchParams.get("error") ?? "unknown"}`);

const res = await fetch(`${issuer}/oauth2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(redirect).origin },
  body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier }),
});
const body = await res.json();
if (!res.ok || typeof body.access_token !== "string") throw new Error(`Kinde did not return a token (${res.status}): ${JSON.stringify(body)}`);

const claims = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url").toString());
console.log(`\nSigned in as ${claims.sub} in ${claims.org_code ?? "no organization"}. Running the contract tests.\n`);
const run = spawnSync("npx", ["vitest", "run", "test/contract"], {
  stdio: "inherit",
  env: { ...process.env, KINDE_CONTRACT_ISSUER: issuer, KINDE_CONTRACT_TOKEN: body.access_token },
});
process.exit(run.status ?? 1);
