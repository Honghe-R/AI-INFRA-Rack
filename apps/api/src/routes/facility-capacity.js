import { FACILITY_KEYS } from '@ai-infra/rbac';

/**
 * The capacity routes (backend-api-contracts.md, under `facility.capacity.*`).
 *
 * Thin adapters over the facility tool surface, exactly as the verification and
 * import routes are: the route translates HTTP into a tool call and back, and
 * nothing here reads a store or decides a permission. The demand request and the
 * allocation decision are draft mutations, so both write routes carry `If-Match`
 * and the tool advances the draft token — the same concurrency rule the
 * conventions section applies to every draft-mutating request.
 */
export function registerFacilityCapacityRoutes(router, { toolSurface }) {
  if (!toolSurface) throw new Error('registerFacilityCapacityRoutes requires the facility tool surface.');

  const contextFor = ({ params, user, correlationId }) => ({
    projectId: params.projectId ?? null,
    revisionId: params.revisionId ?? null,
    userId: user?.userId ?? null,
    correlationId: correlationId ?? null,
    readOnly: false,
    confirmed: true,
  });

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/capacity',
    async ({ params, query, user, correlationId }) => {
      const budgets = await toolSurface.execute({
        name: 'get_capacity_budget',
        args: {
          revision_id: params.revisionId,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 50,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: budgets, meta: { truncated: budgets?.truncated === true, next_cursor: budgets?.next_cursor ?? null } };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/capacity-requests',
    async ({ params, body, headers, user, correlationId }) => {
      const decision = await toolSurface.execute({
        name: 'request_capacity_allocation',
        args: {
          revision_id: params.revisionId,
          base_revision_id: body?.base_revision_id ?? null,
          etag: ifMatch(headers) ?? body?.if_match ?? null,
          consumer_type: body?.consumer_type ?? null,
          consumer_id: body?.consumer_id ?? null,
          phase_id: body?.phase_id ?? null,
          resource_kind: body?.resource_kind ?? null,
          requested_capacity: body?.requested_capacity ?? null,
          required_from: body?.required_from ?? null,
          priority: body?.priority ?? 'NORMAL',
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: decision, status: 201 };
    },
    { permission: FACILITY_KEYS.CAPACITY_REQUEST, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/allocations/:allocationId',
    async ({ params, body, headers, user, correlationId }) => {
      const decision = await toolSurface.execute({
        name: 'decide_allocation',
        args: {
          revision_id: params.revisionId,
          base_revision_id: body?.base_revision_id ?? null,
          etag: ifMatch(headers) ?? body?.if_match ?? null,
          allocation_id: params.allocationId,
          state: body?.state ?? null,
          comment: body?.comment ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: decision };
    },
    { permission: FACILITY_KEYS.CAPACITY_ALLOCATE, projectParam: 'projectId' },
  );
}

/** `If-Match` is a protocol header, not a body field, so the route reads both. */
function ifMatch(headers = {}) {
  const raw = headers['if-match'];
  if (typeof raw !== 'string') return null;
  // A client may send the weak or quoted form; the tool compares the opaque value.
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}
