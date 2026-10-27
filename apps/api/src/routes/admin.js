import { ApiError } from '@ai-infra/core';
import { PLATFORM_KEYS } from '@ai-infra/rbac';

const SYSTEM = { permission: PLATFORM_KEYS.SYSTEM_ADMIN };
const ORG_ADMIN = { permission: PLATFORM_KEYS.ORG_ADMIN, organisationParam: 'organisation_id' };

/**
 * Administration (blueprint §8).
 *
 * Two scopes, deliberately separated:
 *  * **System** administration needs the scope-nulled `system.admin` key, so no
 *    scoped role can ever reach it.
 *  * **Organisation** administration needs `org.admin` at an organisation the
 *    caller belongs to; the guard resolves and validates that scope before the
 *    handler runs, so the handler never has to re-derive tenancy from the body.
 *
 * Every mutation clears the matching decision cache. A grant or a revocation
 * without a matching invalidation leaves a user holding stale permissions —
 * which is the failure this whole layer exists to prevent.
 */
export function registerAdminRoutes(router, { repository, evaluator }) {
  function invalidateFor({ userId, scopeKind, scopeId }) {
    evaluator.invalidate({
      userId,
      projectId: scopeKind === 'project' ? scopeId : null,
      organisationId: scopeKind === 'organisation' ? scopeId : null,
    });
  }

  router.get('/api/v1/admin/catalog', async () => ({ data: await repository.listCatalog() }), SYSTEM);

  router.post('/api/v1/admin/roles/permissions', async (ctx) => {
    const body = await ctx.json();
    if (!body?.role_key || !Array.isArray(body.keys)) {
      throw new ApiError('VALIDATION_FAILED', 'role_key and keys are required.', { status: 400 });
    }
    const result = await repository.replaceRolePermissions({ roleKey: body.role_key, keys: body.keys });
    // A role mapping change affects every holder, so the whole decision cache goes.
    evaluator.invalidateCatalog();
    return { data: result };
  }, SYSTEM);

  router.post('/api/v1/admin/assignments', async (ctx) => {
    const body = await ctx.json();
    const scopeKind = body?.scope_kind;
    if (!body?.user_id || !body?.role_key || !['global', 'organisation', 'project'].includes(scopeKind)) {
      throw new ApiError('VALIDATION_FAILED', 'user_id, role_key, and a valid scope_kind are required.', { status: 400 });
    }
    if (scopeKind !== 'global' && !body.scope_id) {
      throw new ApiError('VALIDATION_FAILED', 'scope_id is required for a scoped assignment.', { status: 400 });
    }

    const result = await repository.assignRole({
      userId: body.user_id,
      roleKey: body.role_key,
      scopeKind,
      scopeId: body.scope_id ?? null,
      actorUserId: ctx.user.userId,
    });
    invalidateFor({ userId: body.user_id, scopeKind, scopeId: body.scope_id ?? null });
    return { status: 201, data: result };
  }, SYSTEM);

  router.get('/api/v1/admin/assignments', async ({ query }) => {
    if (!query.user_id) throw new ApiError('VALIDATION_FAILED', 'user_id is required.', { status: 400 });
    return { data: await repository.listUserAssignments(query.user_id) };
  }, SYSTEM);

  router.post('/api/v1/admin/assignments/revoke', async (ctx) => {
    const body = await ctx.json();
    const scopeKind = body?.scope_kind;
    if (!body?.user_id || !['global', 'organisation', 'project'].includes(scopeKind)) {
      throw new ApiError('VALIDATION_FAILED', 'user_id and a valid scope_kind are required.', { status: 400 });
    }
    const result = await repository.revokeAssignment({
      userId: body.user_id,
      scopeKind,
      scopeId: body.scope_id ?? null,
    });
    invalidateFor({ userId: body.user_id, scopeKind, scopeId: body.scope_id ?? null });
    return { data: result };
  }, SYSTEM);

  router.get('/api/v1/admin/memberships', async ({ query }) => {
    if (!query.scope_kind || !query.scope_id) {
      throw new ApiError('VALIDATION_FAILED', 'scope_kind and scope_id are required.', { status: 400 });
    }
    return { data: await repository.listMemberships({ scopeKind: query.scope_kind, scopeId: query.scope_id }) };
  }, SYSTEM);

  /**
   * Organisation administration: assign a role inside the caller's own
   * organisation. The guard has already validated that the organisation exists;
   * the handler only has to pin the scope so a body cannot retarget the write.
   */
  router.post('/api/v1/organisations/members/role', async (ctx) => {
    const body = await ctx.json();
    const organisationId = ctx.body?.organisation_id ?? ctx.query.organisation_id;
    if (!body?.user_id || !body?.role_key) {
      throw new ApiError('VALIDATION_FAILED', 'user_id and role_key are required.', { status: 400 });
    }

    const result = await repository.assignRole({
      userId: body.user_id,
      roleKey: body.role_key,
      scopeKind: 'organisation',
      scopeId: organisationId,
      actorUserId: ctx.user.userId,
    });
    invalidateFor({ userId: body.user_id, scopeKind: 'organisation', scopeId: organisationId });
    return { status: 201, data: result };
  }, ORG_ADMIN);

  /** Onboarding: bootstrap the caller's first organisation. */
  router.post('/api/v1/organisations', async (ctx) => {
    const body = await ctx.json();
    if (!body?.name) throw new ApiError('VALIDATION_FAILED', 'name is required.', { status: 400 });

    const result = await repository.createOrganization({ name: body.name, ownerUserId: ctx.user.userId });
    evaluator.invalidate({ userId: ctx.user.userId, organisationId: result.organizationId });
    return { status: 201, data: result };
  }, { permission: PLATFORM_KEYS.ORGANISATION_CREATE });
}
