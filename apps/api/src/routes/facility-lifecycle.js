import { FACILITY_KEYS } from '@ai-infra/rbac';
import { createRevision } from '@ai-infra/facility';

/**
 * The lifecycle routes (backend-api-contracts.md): create and branch a draft, publish,
 * and record an approval attestation.
 *
 * Publish and approval go through the facility tool surface, like every other write,
 * so they are authorized, confirmed, bounded, audited, and tenant-scoped once. Create
 * and branch are the one pair with no tool of their own — the tool surface declares no
 * draft-creation operation — so they call the command directly under the route's
 * permission; the command carries its own tenant transaction and validation.
 */
export function registerFacilityLifecycleRoutes(router, { toolSurface, pool }) {
  if (!toolSurface) throw new Error('registerFacilityLifecycleRoutes requires the facility tool surface.');

  const contextFor = ({ params, user, correlationId }) => ({
    projectId: params.projectId ?? null,
    revisionId: params.revisionId ?? null,
    userId: user?.userId ?? null,
    correlationId: correlationId ?? null,
    readOnly: false,
    confirmed: true,
  });

  router.post(
    '/api/v1/projects/:projectId/facility/revisions',
    async ({ params, body, user, correlationId }) => {
      const created = await createRevision({
        pool,
        projectId: params.projectId,
        scenarioId: body?.scenario_id ?? null,
        name: body?.name ?? null,
        baseRevisionId: body?.base_revision_id ?? null,
        actorId: user?.userId ?? null,
      });
      void correlationId;
      return { data: created, status: 201 };
    },
    { permission: FACILITY_KEYS.DRAFT_CREATE, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/branches',
    async ({ params, body, user }) => {
      const created = await createRevision({
        pool,
        projectId: params.projectId,
        scenarioId: body?.scenario_id ?? null,
        name: body?.name ?? null,
        // A branch's base is the revision in the path unless the caller names the one
        // it actually read; D2 makes a mismatched base a refusal, not a widening.
        baseRevisionId: body?.base_revision_id ?? params.revisionId,
        actorId: user?.userId ?? null,
      });
      return { data: created, status: 201 };
    },
    { permission: FACILITY_KEYS.DRAFT_CREATE, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/publish',
    async ({ params, body, user, correlationId }) => {
      const published = await toolSurface.execute({
        name: 'publish_revision',
        args: {
          revision_id: params.revisionId,
          validation_run_id: body?.validation_run_id ?? null,
          base_revision_id: body?.base_revision_id ?? null,
          if_match: body?.if_match ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: published };
    },
    { permission: FACILITY_KEYS.PUBLISH, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/approval-attestations',
    async ({ params, body, user, correlationId }) => {
      const attestation = await toolSurface.execute({
        name: 'request_approval',
        args: {
          revision_id: params.revisionId,
          policy_id: body?.policy_id ?? null,
          decision: body?.decision ?? null,
          comment: body?.comment ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: attestation, status: 201 };
    },
    { permission: FACILITY_KEYS.APPROVE, projectParam: 'projectId' },
  );
}
