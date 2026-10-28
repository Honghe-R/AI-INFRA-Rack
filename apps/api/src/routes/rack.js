import { ApiError } from '@ai-infra/core';
import { RackInputError } from '@ai-infra/rack';
import { RACK_KEYS, FACILITY_KEYS } from '@ai-infra/rbac';
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

export function registerRackRoutes(router, { pool, guard }) {
  const service = createRackPlanService({ pool });
  const base = '/api/v1/projects/:projectId/rack/plans';
  router.get(`${base}/:planId/room-view`, ctx => adapt(async () => {
    if (!guard) throw new ApiError('SERVICE_UNAVAILABLE', 'Facility authorization is not configured.', { status: 503 });
    await guard.check(FACILITY_KEYS.READ, ctx, { projectParam: 'projectId' });
    return { data: await service.roomView({ projectId: ctx.params.projectId, planId: ctx.params.planId }) };
  }), { permission: RACK_KEYS.READ, projectParam: 'projectId' });
  router.get(base, ctx => adapt(async () => ({
    data: await service.list({ projectId: ctx.params.projectId, query: ctx.query }),
  })), { permission: RACK_KEYS.READ, projectParam: 'projectId' });
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
