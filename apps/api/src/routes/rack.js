import { ApiError } from '@ai-infra/core';
import { RackInputError, getRackCatalog, getCatalogExamples } from '@ai-infra/rack';
import { RACK_KEYS, FACILITY_KEYS } from '@ai-infra/rbac';
import { createRackPlanService } from '../services/rack-plans.js';
import { createRackLayoutService } from '../services/rack-layout.js';

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
  router.get('/api/v1/projects/:projectId/rack/catalog', ctx => ({
    data: { ...getRackCatalog(), projectId: ctx.params.projectId, examples: getCatalogExamples() },
  }), { permission: RACK_KEYS.READ, projectParam: 'projectId' });
  const service = createRackPlanService({ pool });
  const layouts = createRackLayoutService({ pool });
  const base = '/api/v1/projects/:projectId/rack/plans';
  async function facilityRead(ctx) {
    if (!guard) throw new ApiError('SERVICE_UNAVAILABLE', 'Facility authorization is not configured.', { status: 503 });
    await guard.check(FACILITY_KEYS.READ, ctx, { projectParam: 'projectId' });
  }
  router.get(`${base}/:planId/layout`, ctx => adapt(async () => {
    await facilityRead(ctx);
    const data = await layouts.get({projectId:ctx.params.projectId,planId:ctx.params.planId});
    return {data,headers:{etag:`"${data.version}"`}};
  }), {permission:RACK_KEYS.READ,projectParam:'projectId'});
  router.post(`${base}/:planId/layout/check`, ctx => adapt(async () => {
    await facilityRead(ctx);
    return {data:await layouts.check({projectId:ctx.params.projectId,planId:ctx.params.planId,body:ctx.body})};
  }), {permission:RACK_KEYS.READ,projectParam:'projectId'});
  router.post(`${base}/:planId/layout/options`, ctx => adapt(async () => {
    await facilityRead(ctx);
    return { data: await layouts.options({ projectId:ctx.params.projectId, planId:ctx.params.planId, body:ctx.body }) };
  }), {permission:RACK_KEYS.READ,projectParam:'projectId'});
  router.post(`${base}/:planId/layout/equipment-options`, ctx => adapt(async () => {
    await facilityRead(ctx);
    return { data: await layouts.equipmentOptions({ projectId:ctx.params.projectId, planId:ctx.params.planId, body:ctx.body }) };
  }), {permission:RACK_KEYS.READ,projectParam:'projectId'});
  router.post(`${base}/:planId/layout/design-options`, ctx => adapt(async () => {
    await facilityRead(ctx);
    return {data:await layouts.designOptions({projectId:ctx.params.projectId,planId:ctx.params.planId,body:ctx.body})};
  }), {permission:RACK_KEYS.READ,projectParam:'projectId'});
  for (const [method,suffix,operation] of [['post','/room-snapshot','capture'],['put','/layout','save']]) {
    router[method](`${base}/:planId${suffix}`, ctx=>adapt(async()=>{
      await facilityRead(ctx);
      const result=await layouts.mutate({projectId:ctx.params.projectId,planId:ctx.params.planId,actorId:ctx.user.userId,
        body:ctx.body,key:ctx.headers['idempotency-key'],ifMatch:ctx.headers['if-match'],operation});
      return {data:result.layout,meta:{replayed:result.replayed,applied_version:result.appliedVersion},headers:{etag:`"${result.layout.version}"`}};
    }),{permission:RACK_KEYS.WRITE,projectParam:'projectId'});
  }
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
  for(const [method,suffix,operation] of [['patch','','rename'],['delete','','delete'],['post','/restore','restore']]) {
    router[method](`${base}/:planId${suffix}`,ctx=>adapt(async()=>{
      const result=await service.manage({projectId:ctx.params.projectId,planId:ctx.params.planId,
        actorId:ctx.user.userId,operation,body:ctx.body,key:ctx.headers['idempotency-key'],ifMatch:ctx.headers['if-match']});
      return {data:result.plan,meta:{replayed:result.replayed,applied_version:result.appliedVersion},headers:{etag:`"${result.plan.version}"`}};
    }),{permission:operation === 'delete' ? RACK_KEYS.DELETE : operation === 'restore' ? RACK_KEYS.RESTORE : RACK_KEYS.WRITE,projectParam:'projectId'});
  }
}
