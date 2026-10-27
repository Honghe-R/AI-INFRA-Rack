import { FACILITY_KEYS } from '@ai-infra/rbac';

/**
 * Governance reads (backend-api-contracts.md): approval attestations and impact
 * notices.
 *
 * Both go through the tool surface, like every other facility route. The write
 * side of governance — publish and record-attestation — lands with T5 and is
 * registered here beside its reads so the surface has one governance route
 * family rather than one per verb.
 */
export function registerFacilityGovernanceRoutes(router, { toolSurface }) {
  if (!toolSurface) throw new Error('registerFacilityGovernanceRoutes requires the facility tool surface.');

  const contextFor = ({ params, user, correlationId }) => ({
    projectId: params.projectId ?? null,
    revisionId: params.revisionId ?? null,
    userId: user?.userId ?? null,
    correlationId: correlationId ?? null,
    readOnly: true,
  });

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/approval-attestations',
    async ({ params, query, user, correlationId }) => {
      const page = await toolSurface.execute({
        name: 'list_attestations',
        args: {
          revision_id: params.revisionId,
          attestation_id: query.attestation_id ?? null,
          decision: query.decision ?? null,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 50,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: { approval_attestations: page.items ?? [], total: page.total ?? 0 }, meta: { next_cursor: page.next_cursor ?? null } };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/impact-notices',
    async ({ params, query, user, correlationId }) => {
      const page = await toolSurface.execute({
        name: 'list_impact_notices',
        args: {
          revision_id: params.revisionId,
          since: query.since ?? null,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 50,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: { impact_notices: page.items ?? [], total: page.total ?? 0 }, meta: { next_cursor: page.next_cursor ?? null } };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );
}
