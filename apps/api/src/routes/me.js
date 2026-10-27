import { ApiError } from '@ai-infra/core';

/**
 * Self endpoints (blueprint §8).
 *
 * These answer questions *about the caller*, so they require authentication but
 * no permission key of their own.
 *
 * The check endpoint always answers 200 with a decision. A denial is not a
 * transport failure: a client caches it distinctly, and using the HTTP status
 * for the decision would make "denied" indistinguishable from "could not ask".
 * Non-200 is reserved for protocol errors — an unresolvable scope, a missing
 * token, an evaluator failure.
 */
export function registerSelfRoutes(router, { repository, guard }) {
  router.get('/api/v1/me/permissions', async ({ user, query }) => {
    const effective = await repository.effectiveKeys({
      userId: user.userId,
      projectId: query.project_id ?? null,
      organisationId: query.organisation_id ?? null,
    });
    return {
      data: {
        user_id: user.userId,
        keys: effective.keys,
        organisation_id: effective.organisationId ?? null,
      },
    };
  });

  router.get('/api/v1/me/permissions/check', async (ctx) => {
    const functionKey = ctx.query.function_key ?? null;
    try {
      const result = await guard.check(functionKey, ctx, {
        projectParam: 'project_id',
        organisationParam: 'organisation_id',
      });
      return { data: { ...result, determined: true } };
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'INSUFFICIENT_PERMISSION' || error.code === 'UNKNOWN_FUNCTION')) {
        return {
          data: {
            allowed: false,
            grant: null,
            functionId: null,
            functionKey,
            projectId: ctx.query.project_id ?? null,
            organisationId: ctx.query.organisation_id ?? null,
            reason: error.code,
            determined: true,
          },
        };
      }
      throw error;
    }
  });
}
