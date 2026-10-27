import { ApiError } from '@ai-infra/core';
import { extractBearerToken } from './verifier.js';

/**
 * Authentication and step-up guards (blueprint §7).
 *
 * Authentication is not authorization, and the two stay in separate middleware:
 *
 *   missing token         401  UNAUTHENTICATED
 *   invalid or expired    403  INVALID_TOKEN
 *   suspended account     403  ACCOUNT_SUSPENDED
 *   unknown user record   401  UNAUTHENTICATED
 *
 * Invalid tokens are 403 rather than 401 on purpose: the caller presented
 * credentials, they were rejected, and re-prompting for a login would be wrong.
 * A missing token is 401 because the remedy is to authenticate.
 */
export function createAuthenticator({ verifier, directory, logger = null } = {}) {
  if (!verifier) throw new Error('createAuthenticator requires a verifier.');
  if (!directory) throw new Error('createAuthenticator requires a user directory.');

  return {
    async authenticate(ctx) {
      const token = extractBearerToken(ctx?.request?.headers?.authorization);
      if (!token) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.', { status: 401 });

      let identity;
      try {
        identity = await verifier.verify(token);
      } catch (cause) {
        logger?.warn('identity.token_rejected', { reason: cause?.code ?? cause?.name ?? 'INVALID' }, ctx?.correlationId ?? null);
        throw new ApiError('INVALID_TOKEN', 'The access token is invalid or expired.', {
          status: 403,
          details: [{ reason: cause?.code ?? 'INVALID' }],
        });
      }

      let resolved;
      try {
        resolved = await directory.resolveUser(identity);
      } catch (cause) {
        logger?.error('identity.directory_failed', { error: cause?.message }, ctx?.correlationId ?? null);
        throw new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.', { status: 500 });
      }

      if (!resolved) throw new ApiError('UNAUTHENTICATED', 'Authentication is required.', { status: 401 });
      if (resolved.suspended) throw new ApiError('ACCOUNT_SUSPENDED', 'This account is not active.', { status: 403 });

      ctx.user = resolved.user;
      ctx.authStrength = { mfa: identity.mfa === true, authenticatedAt: identity.authenticatedAt ?? null };
      return resolved.user;
    },
  };
}

/**
 * Step-up guard: requires a second factor. This is an identity check, not a
 * permission key, so it is never modelled as one.
 */
export function requireMfa() {
  return (ctx) => {
    if (ctx?.authStrength?.mfa !== true) {
      throw new ApiError('MFA_REQUIRED', 'This operation requires multi-factor authentication.', { status: 403 });
    }
    return true;
  };
}

/** Step-up guard: requires a recent authentication, in seconds. */
export function requireRecentAuth(maxAgeSeconds) {
  return (ctx) => {
    const authenticatedAt = ctx?.authStrength?.authenticatedAt;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof authenticatedAt !== 'number' || nowSeconds - authenticatedAt > maxAgeSeconds) {
      throw new ApiError('REAUTHENTICATION_REQUIRED', 'This operation requires a recent sign-in.', {
        status: 403,
        details: [{ max_age_seconds: maxAgeSeconds }],
      });
    }
    return true;
  };
}
