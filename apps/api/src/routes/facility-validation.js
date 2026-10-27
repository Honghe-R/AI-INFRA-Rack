import { errors } from '@ai-infra/core';
import { FACILITY_KEYS } from '@ai-infra/rbac';

/**
 * Verification surface (verification-requirements.md, backend-api-contracts.md).
 *
 * Every handler here is a thin adapter over the facility tool surface: the route
 * translates HTTP into a tool call and the tool's result back into the documented
 * envelope. Nothing in this file reads a store, decides a permission, or shapes a
 * diagnostic — those live in the layer, once, so the API cannot answer differently
 * from the assistant or an integration client asking the same question.
 *
 * The routes keep their own `permission` option as well. That is deliberate
 * defence in depth: the router gates the transport and the tool re-asserts inside
 * the handler, which is what protects callers that are not HTTP.
 *
 * `readOnly` is not passed as true here: a route is an authenticated user action,
 * and immutability is the domain's decision (`REVISION_IMMUTABLE` from the
 * validation service). `confirmed` is true because the caller asked for this
 * operation explicitly; a model-driven caller must obtain that confirmation first.
 */

export function registerFacilityValidationRoutes(router, { toolSurface, validationService }) {
  if (!toolSurface) throw new Error('registerFacilityValidationRoutes requires the facility tool surface.');

  const contextFor = ({ params, user, correlationId }) => ({
    projectId: params.projectId ?? null,
    revisionId: params.revisionId ?? null,
    userId: user?.userId ?? null,
    correlationId: correlationId ?? null,
    readOnly: false,
    confirmed: true,
  });

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/validate',
    async ({ params, body, user, correlationId }) => {
      const result = await toolSurface.execute({
        name: 'run_validation',
        args: {
          revision_id: params.revisionId,
          scope: body?.scope ?? 'AFFECTED_SUBGRAPH',
          base_etag: body?.base_etag ?? null,
          capabilities: body?.capabilities ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return {
        status: result.mode === 'job' ? 202 : 200,
        data: result,
        meta: {
          validation_run_id: result.runId ?? null,
          job_id: result.jobId ?? null,
          scope: result.scope,
        },
      };
    },
    { permission: FACILITY_KEYS.VALIDATE_RUN, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/validation-runs/:runId',
    async ({ params, user, correlationId }) => {
      const result = await toolSurface.execute({
        name: 'get_validation_run',
        args: { revision_id: params.revisionId, validation_run_id: params.runId },
        context: contextFor({ params, user, correlationId }),
      });
      if (!result) throw errors.notFound('The requested resource was not found.');
      return { data: result };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/diagnostics',
    async ({ params, query, user, correlationId }) => {
      const page = await toolSurface.execute({
        name: 'list_diagnostics',
        args: {
          revision_id: params.revisionId,
          validation_run_id: query.run_id ?? null,
          severity: query.severity ?? null,
          status: query.status ?? null,
          constraint_id: query.constraint_id ?? null,
          capability: query.capability ?? null,
          include_superseded: query.include_superseded === 'true',
          cursor: query.cursor ?? null,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 200,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return {
        data: {
          diagnostics: page.items ?? [],
          total: page.total ?? 0,
          truncated: page.truncated === true,
          next_cursor: page.next_cursor ?? null,
        },
      };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/coverage',
    async ({ params, user, correlationId }) => {
      const result = await toolSurface.execute({
        name: 'get_coverage',
        args: { revision_id: params.revisionId },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: { coverage: result.coverage } };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/waivers',
    async ({ params, user, correlationId }) => {
      const page = await toolSurface.execute({
        name: 'list_waivers',
        args: { revision_id: params.revisionId, status: null, limit: 200 },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: { waivers: page.items ?? [], total: page.total ?? 0 } };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/waivers',
    async ({ params, body, user, correlationId }) => {
      const waiver = await toolSurface.execute({
        name: 'grant_waiver',
        args: {
          revision_id: params.revisionId,
          diagnostic_ids: body?.diagnostic_ids ?? [],
          policy_id: body?.policy_id ?? null,
          reason: body?.reason ?? null,
          scope: body?.scope ?? 'REVISION',
          expires_at: body?.expires_at ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { status: 201, data: waiver };
    },
    { permission: FACILITY_KEYS.WAIVER_GRANT, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/waivers/:waiverId/revoke',
    async ({ params, body, user, correlationId }) => {
      const revoked = await toolSurface.execute({
        name: 'revoke_waiver',
        args: { waiver_id: params.waiverId, reason: body?.reason ?? null },
        context: {
          projectId: params.projectId ?? null,
          revisionId: params.revisionId ?? null,
          userId: user?.userId ?? null,
          correlationId: correlationId ?? null,
          readOnly: false,
          confirmed: true,
        },
      });
      return { data: revoked };
    },
    { permission: FACILITY_KEYS.WAIVER_GRANT, projectParam: 'projectId' },
  );

  /**
   * The phase plan.
   *
   * An inspector has to offer something to assign an entity to, and the envelope read
   * does not carry phases. The tool already answers this, so the route is a thin adapter
   * rather than a second query.
   */
  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/phases',
    async ({ params, user, correlationId }) => {
      const page = await toolSurface.execute({
        name: 'list_phases',
        args: { revision_id: params.revisionId, limit: 200 },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: { phases: page.items ?? [], total: page.total ?? 0 } };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  /**
   * The change-set commit (backend-api-contracts.md, "Draft and Change Sets").
   *
   * The transport gate is `facility.draft.create`; the tool re-asserts the union of
   * the change kinds' own keys, because a set that moves geometry needs
   * `facility.geometry.write` and a set that only renames a building does not. One
   * static key here cannot express that, and pretending otherwise would either
   * over-grant or make the command unusable.
   *
   * `Idempotency-Key` arrives as a header and is answered inside the tool's
   * transaction, before the ETag precondition: a replay of a commit that already
   * succeeded necessarily presents a stale token, and refusing it would defeat the
   * point of the key.
   */
  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/changes',
    async ({ params, body, user, correlationId, headers }) => {
      const result = await toolSurface.execute({
        name: 'apply_change_set',
        args: {
          revision_id: params.revisionId,
          base_revision_id: body?.base_revision_id ?? null,
          etag: body?.etag ?? null,
          changes: body?.changes ?? [],
          preview_diagnostics: body?.preview_diagnostics !== false,
          idempotency_key: headers?.['idempotency-key'] ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: result };
    },
    { permission: FACILITY_KEYS.DRAFT_CREATE, projectParam: 'projectId' },
  );

  /**
   * Job polling. A job is a transport-level concept the surface does not model, so
   * this route keeps reading the service directly rather than inventing a tool for
   * it. The job's project arrives as a query parameter, so the guard resolves a
   * real project scope instead of checking the key unscoped.
   */
  router.get(
    '/api/v1/jobs/:jobId',
    async ({ params, query }) => {
      const projectId = query.project_id;
      if (!projectId) throw errors.notFound('The requested resource was not found.');
      const job = await validationService.getJob({ projectId, jobId: params.jobId });
      if (!job) throw errors.notFound('The requested resource was not found.');
      return { data: job };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'project_id' },
  );
}
