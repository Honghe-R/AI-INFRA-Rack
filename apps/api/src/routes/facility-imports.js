import { ApiError } from '@ai-infra/core';
import { FACILITY_KEYS } from '@ai-infra/rbac';

/**
 * The import path (backend-api-contracts.md, under `facility.import.*`).
 *
 * This is the first half of the flow in ui-pattern.md, "Import Flow": it lists the
 * asset versions a revision consumes and it pins one. Transform review, mapping,
 * the merge preview, and apply are later steps and have no route here, because
 * they have no command behind them yet — a route that invented one would be the
 * fabricated mutation path the tool surface exists to prevent
 * (tool-surface.md, "What is not here").
 *
 * Both handlers are adapters over the facility tool surface, exactly as the
 * verification routes are: the route translates HTTP into a tool call and back,
 * and nothing in this file reads a store or decides a permission.
 *
 * A binding does not advance the draft ETag. Applying an import is one typed
 * change set and that is what advances the token and emits
 * `facility.revision.changed.v1` (import-adapters.md); pinning a source is
 * provenance, not a change to the design graph. So there is no `If-Match` here,
 * and the response carries no new token to echo.
 */

export function registerFacilityImportRoutes(router, { toolSurface }) {
  if (!toolSurface) throw new Error('registerFacilityImportRoutes requires the facility tool surface.');

  const contextFor = ({ params, user, correlationId }) => ({
    projectId: params.projectId ?? null,
    revisionId: params.revisionId ?? null,
    userId: user?.userId ?? null,
    correlationId: correlationId ?? null,
    readOnly: false,
    // The caller asked for this operation explicitly; a model-driven caller has to
    // obtain that confirmation before the executor will run a write.
    confirmed: true,
  });

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings',
    async ({ params, query, user, correlationId }) => {
      const page = await toolSurface.execute({
        name: 'list_asset_bindings',
        args: {
          revision_id: params.revisionId,
          asset_version_id: query.asset_version_id ?? null,
          role: query.role ?? null,
          status: query.status ?? null,
          cursor: query.cursor ?? null,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 50,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return {
        data: { asset_bindings: page.items ?? [], total: page.total ?? 0 },
        meta: {
          truncated: page.truncated === true,
          next_cursor: page.next_cursor ?? null,
        },
      };
    },
    // Reading a binding is reading which asset version the revision consumes, so
    // the transport asks for the facility read key and the tool re-asserts
    // `asset.read` inside the handler.
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings',
    async ({ params, body, user, correlationId }) => {
      const binding = await toolSurface.execute({
        name: 'create_asset_binding',
        args: {
          revision_id: params.revisionId,
          asset_version_id: body?.asset_version_id ?? null,
          representation_id: body?.representation_id ?? null,
          role: body?.role ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: binding, status: 201 };
    },
    { permission: FACILITY_KEYS.IMPORT_INITIATE, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId',
    async ({ params, query, user, correlationId }) => {
      const binding = await toolSurface.execute({
        name: 'get_asset_binding',
        args: { revision_id: params.revisionId, binding_id: params.bindingId, include_mappings: query.include_mappings !== 'false' },
        context: contextFor({ params, user, correlationId }),
      });
      if (!binding) throw new ApiError('NOT_FOUND', 'The requested resource was not found.', { status: 404 });
      return { data: binding };
    },
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );

  // The mapping workflow. The revision is in the path on every route because every
  // facility tool is revision-scoped and a scope mismatch must be a refusal, not a
  // widened query.
  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId/transform',
    async ({ params, body, user, correlationId }) => {
      const transform = await toolSurface.execute({
        name: 'create_spatial_transform',
        args: {
          revision_id: params.revisionId,
          binding_id: params.bindingId,
          source_units: body?.source_units ?? null,
          target_units: body?.target_units ?? null,
          source_crs: body?.source_crs ?? null,
          target_crs: body?.target_crs ?? null,
          vertical_crs: body?.vertical_crs ?? null,
          method: body?.method ?? null,
          control_points: body?.control_points ?? [],
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: transform, status: 201 };
    },
    { permission: FACILITY_KEYS.IMPORT_MAP, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId/transforms/:transformId/review',
    async ({ params, body, user, correlationId }) => {
      const transform = await toolSurface.execute({
        name: 'review_spatial_transform',
        args: {
          revision_id: params.revisionId,
          transform_id: params.transformId,
          review_state: body?.review_state ?? null,
          comment: body?.comment ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: transform };
    },
    { permission: FACILITY_KEYS.IMPORT_MAP, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId/mappings',
    async ({ params, body, user, correlationId }) => {
      const mapping = await toolSurface.execute({
        name: 'create_import_mapping',
        args: {
          revision_id: params.revisionId,
          binding_id: params.bindingId,
          transform_id: body?.transform_id ?? null,
          source_selector: body?.source_selector ?? null,
          target_entity_type: body?.target_entity_type ?? null,
          target_geometry_role: body?.target_geometry_role ?? null,
          attribute_mapping: body?.attribute_mapping ?? {},
          cardinality: body?.cardinality ?? 'ONE_TO_ONE',
          required: body?.required === true,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: mapping, status: 201 };
    },
    { permission: FACILITY_KEYS.IMPORT_MAP, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId/mappings/:mappingId/review',
    async ({ params, body, user, correlationId }) => {
      const mapping = await toolSurface.execute({
        name: 'review_import_mapping',
        args: {
          revision_id: params.revisionId,
          mapping_id: params.mappingId,
          review_state: body?.review_state ?? null,
          comment: body?.comment ?? null,
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: mapping };
    },
    { permission: FACILITY_KEYS.IMPORT_MAP, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId/preview-merge',
    async ({ params, body, user, correlationId }) => {
      const preview = await toolSurface.execute({
        name: 'preview_import_merge',
        args: { revision_id: params.revisionId, binding_id: params.bindingId, mapping_ids: body?.mapping_ids ?? null },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: preview };
    },
    { permission: FACILITY_KEYS.IMPORT_APPLY, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId/asset-bindings/:bindingId/apply',
    async ({ params, body, user, correlationId }) => {
      const applied = await toolSurface.execute({
        name: 'apply_asset_binding',
        args: {
          revision_id: params.revisionId,
          base_revision_id: body?.base_revision_id ?? null,
          etag: body?.if_match ?? null,
          binding_id: params.bindingId,
          transform_id: body?.transform_id ?? null,
          mapping_ids: body?.mapping_ids ?? null,
          target_revision_id: body?.target_revision_id ?? params.revisionId,
          conflict_resolutions: body?.conflict_resolutions ?? [],
        },
        context: contextFor({ params, user, correlationId }),
      });
      return { data: applied, status: 201 };
    },
    { permission: FACILITY_KEYS.IMPORT_APPLY, projectParam: 'projectId' },
  );
}
