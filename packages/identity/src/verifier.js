import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Token verification.
 *
 * A verifier answers exactly one question: "which identity does this token
 * assert?". It never decides what that identity may do — authorization is a
 * separate layer, and conflating them is how a token claim becomes a privilege
 * escalation.
 *
 * The returned identity carries the subject plus the auth-strength context that
 * step-up guards need (whether MFA was satisfied, and when the user last
 * authenticated).
 */

/**
 * Verifies an OIDC-issued JWT against a JWKS.
 *
 * Prefer `jwksUri` in deployment (the issuer publishes the key set) and inject
 * `jwks` in tests, so verification can be exercised without a network.
 */
export function createJwtVerifier({
  issuer,
  audience = undefined,
  jwksUri = null,
  jwks = null,
  clockToleranceSeconds = 5,
} = {}) {
  const keySet = jwks ?? (jwksUri ? createRemoteJWKSet(new URL(jwksUri)) : null);
  if (!keySet) throw new Error('createJwtVerifier requires a JWKS or a JWKS URI.');

  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keySet, {
        issuer,
        audience,
        clockTolerance: clockToleranceSeconds,
      });
      return toIdentity(payload);
    },
  };
}

/**
 * Verifies a symmetric token with a shared secret.
 *
 * Development and test only. A shared secret cannot be rotated per client and
 * cannot be published as a JWKS, so it must never authenticate production
 * traffic; constructing it in production throws unless explicitly forced.
 */
export function createHmacVerifier({ secret, issuer, audience = undefined, allowInProduction = false, env = process.env } = {}) {
  if (!secret) throw new Error('createHmacVerifier requires a secret.');
  if (env.NODE_ENV === 'production' && !allowInProduction) {
    throw new Error('The shared-secret verifier is not permitted in production. Configure OIDC instead.');
  }

  const key = new TextEncoder().encode(secret);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: ['HS256'] });
      return toIdentity(payload);
    },
  };
}

/** Builds a JWKS from an in-memory key set. Used by tests and by local stacks. */
export function localJwks(jwks) {
  return createLocalJWKSet(jwks);
}

export function toIdentity(payload) {
  const mfa = Array.isArray(payload.amr) ? payload.amr.includes('mfa') : false;
  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    displayName: typeof payload.name === 'string' ? payload.name : null,
    mfa,
    authenticatedAt: typeof payload.auth_time === 'number' ? payload.auth_time : null,
  };
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
