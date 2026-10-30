import { PLATFORM_KEYS } from '@ai-infra/rbac';
import { createProjectAccessService } from '../services/project-access.js';

export function registerProjectAccessRoutes(router, { pool, evaluator }) {
  const service = createProjectAccessService({ pool });
  const options = { permission: PLATFORM_KEYS.PROJECT_MEMBER_MANAGE, projectParam: 'projectId' };
  const base = '/api/v1/projects/:projectId';
  router.get(`${base}/members`, async ctx => ({ data: await service.list({
    projectId: ctx.params.projectId, actorId: ctx.user.userId, query: ctx.query,
  }) }), options);
  router.get(`${base}/member-candidates`, async ctx => ({ data: await service.candidates({
    projectId: ctx.params.projectId, actorId: ctx.user.userId, query: ctx.query,
  }) }), options);
  router.put(`${base}/members/:userId`, async ctx => {
    const data = await service.set({ projectId: ctx.params.projectId, userId: ctx.params.userId,
      actorId: ctx.user.userId, body: ctx.body, correlationId: ctx.correlationId });
    // Use the canonical DB UUID, not its possibly upper-case path spelling.
    evaluator.invalidate({ userId: data.member.userId, projectId: ctx.params.projectId });
    return { data };
  }, options);
}
