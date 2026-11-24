import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export interface VerifierOptions {
  /** Your Kinde domain, for example `https://yourbusiness.kinde.com`. */
  issuer: string;
  /** The API audience registered in Kinde. Pass `false` only if your tokens have no audience. */
  audience: string | string[] | false;
  /** Keys to use instead of fetching `<issuer>/.well-known/jwks.json`. */
  jwks?: JSONWebKeySet;
  clockToleranceSeconds?: number;
}

export type TokenVerifier = (token: string) => Promise<Record<string, unknown>>;

/** Verifies Kinde access tokens with RS256 against the issuer's JWKS. */
export function createVerifier(options: VerifierOptions): TokenVerifier {
  const issuer = options.issuer.replace(/\/+$/, "");
  const keys = options.jwks ? createLocalJWKSet(options.jwks) : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      algorithms: ["RS256"],
      ...(options.audience === false ? {} : { audience: options.audience }),
      ...(options.clockToleranceSeconds ? { clockTolerance: options.clockToleranceSeconds } : {}),
    });
    return payload as Record<string, unknown>;
  };
}
