import { ApiError } from '@ai-infra/core';
import { RackInputError } from '@ai-infra/rack';
import { RACK_KEYS } from '@ai-infra/rbac';
import { createRackPlanService } from '../services/rack-plans.js';

async function adapt(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RackInputError) {
      throw new ApiError(error.code, error.message, { status: 400, details: error.details });
    }
    throw error;
  }
}

export function registerRackRoutes(router, { pool }) {
  const service = createRackPlanService({ pool });
  const base = '/api/v1/projects/:projectId/rack/plans';
  router.post(base, ctx => adapt(async () => {
    const result = await service.create({
      projectId: ctx.params.projectId, actorId: ctx.user.userId, body: ctx.body,
      creationKey: ctx.headers['idempotency-key'],
    });
    return {
      status: result.replayed ? 200 : 201, data: result.plan,
      meta: { replayed: result.replayed },
      headers: { location: `/api/v1/projects/${result.plan.projectId}/rack/plans/${result.plan.planId}` },
    };
  }), { permission: RACK_KEYS.WRITE, projectParam: 'projectId' });
  router.get(`${base}/:planId`, ctx => adapt(async () => ({
    data: await service.get({ projectId: ctx.params.projectId, planId: ctx.params.planId }),
  })), { permission: RACK_KEYS.READ, projectParam: 'projectId' });
}
