import { errors } from '@ai-infra/core';
import { readEtag } from '@ai-infra/facility';
import { withTenant } from '@ai-infra/db';
import { FACILITY_KEYS } from '@ai-infra/rbac';

/**
 * Facility graph reads.
 *
 * `GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}` is the
 * canonical normalized-envelope read (backend-api-contracts.md, under
 * `facility.read`). This is the design-context slice of it: the identity, the
 * design scope, its containers, the geometry records, the utility sources and
 * interfaces, and the spatial constraints.
 *
 * What is deliberately absent is as important as what is present. `T4` derives
 * `CapabilityCoverage` from validation evidence and never lets it be asserted
 * (D11), and a draft that has never been validated therefore has no coverage
 * rows. They are returned as an empty list rather than a fabricated
 * `NOT_PROVIDED`, so a consumer reports "not derived" instead of a verdict, and
 * a map stays readable. Validation summaries, diagnostics, and the frozen
 * protobuf belong to T4 and T5.
 *
 * Geometry is returned as WGS 84 GeoJSON, which the contract makes mandatory as
 * the interoperable representation and which is what a Web Mercator canvas can
 * draw. The projected representation stays server-side; it is authoritative for
 * measurement, not for rendering.
 */
export function registerFacilityRoutes(router, { pool }) {
  router.get(
    '/api/v1/projects/:projectId/facility/revisions/:revisionId',
    async ({ params }) => {
      const { projectId, revisionId } = params;

      const graph = await withTenant(
        pool,
        projectId,
        async (client) => {
          const envelope = (
            await client.query(
              `SELECT envelope_id, scenario_id, revision_id, lifecycle_state, approval_state,
                      content_checksum, published_at, created_at, updated_at
                 FROM facility_envelopes
                WHERE project_id = $1 AND revision_id = $2`,
              [projectId, revisionId],
            )
          ).rows[0];
          if (!envelope) return null;

          const [scopes, containers, geometry, sources, interfaces, constraints, coverage] = await Promise.all([
            client.query(
              `SELECT scope_id, entity_type, scope_kind, name, jurisdiction, parent_scope_id
                 FROM design_scopes
                WHERE project_id = $1 AND revision_id = $2
                ORDER BY name, scope_id`,
              [projectId, revisionId],
            ),
            client.query(
              `SELECT container_id, scope_id, parent_container_id, phase_id, kind, entity_type, name,
                      level_number, status, elevation_base_m, elevation_top_m
                 FROM facility_containers
                WHERE project_id = $1 AND revision_id = $2
                ORDER BY kind, name, container_id`,
              [projectId, revisionId],
            ),
            client.query(
              // GeoJSON is emitted by PostGIS, so no coordinate array is rebuilt in
              // JavaScript and no precision is lost in a round trip through text.
              `SELECT g.geometry_id, g.entity_id, g.entity_type, g.role, g.ordinal, g.geometry_type,
                      ST_AsGeoJSON(g.geojson_4326)::json AS geojson_4326,
                      g.projected_crs, g.vertical_crs,
                      g.elevation_base_m, g.elevation_top_m, g.height_m,
                      e.display_name, e.status
                 FROM geometry_records g
                 LEFT JOIN entity_registry e
                   ON e.entity_id = g.entity_id
                  AND e.revision_id = g.revision_id
                  AND e.project_id = g.project_id
                WHERE g.project_id = $1 AND g.revision_id = $2
                ORDER BY g.entity_type, g.role, g.ordinal, g.geometry_id`,
              [projectId, revisionId],
            ),
            client.query(
              `SELECT u.utility_source_id, u.kind, u.capacity_value, u.capacity_unit, u.capacity_basis,
                      u.capacity_state, u.failure_domain_id, u.phase_id, u.available_from, e.display_name
                 FROM utility_sources u
                 LEFT JOIN entity_registry e
                   ON e.entity_id = u.utility_source_id AND e.project_id = u.project_id
                WHERE u.project_id = $1 AND u.revision_id = $2
                ORDER BY u.kind, u.utility_source_id`,
              [projectId, revisionId],
            ),
            client.query(
              `SELECT i.interface_id, i.utility_source_id, i.capacity_value, i.capacity_unit, i.capacity_basis,
                      i.capacity_state, i.service_state, i.failure_domain_id, i.phase_id, e.display_name
                 FROM utility_interfaces i
                 LEFT JOIN entity_registry e
                   ON e.entity_id = i.interface_id AND e.project_id = i.project_id
                WHERE i.project_id = $1 AND i.revision_id = $2
                ORDER BY i.service_state, i.interface_id`,
              [projectId, revisionId],
            ),
            client.query(
              `SELECT c.constraint_id, c.scope_id, c.container_id, c.applies_to_geometry_id, c.kind,
                      c.severity, c.rule_kind, c.rule_value, c.rule_unit, e.display_name
                 FROM spatial_constraints c
                 LEFT JOIN entity_registry e
                   ON e.entity_id = c.constraint_id AND e.project_id = c.project_id
                WHERE c.project_id = $1 AND c.revision_id = $2
                ORDER BY c.kind, c.constraint_id`,
              [projectId, revisionId],
            ),
            client.query(
              `SELECT capability, status, reviewed_at
                 FROM capability_coverage
                WHERE project_id = $1 AND revision_id = $2
                ORDER BY capability`,
              [projectId, revisionId],
            ),
          ]);

          // The draft concurrency token, read through the same module the tool
          // surface uses, so the two cannot disagree about the current draft state.
          const etag = await readEtag({ client, projectId, revisionId });

          return {
            envelope,
            etag,
            scopes: scopes.rows,
            containers: containers.rows,
            geometry: geometry.rows,
            sources: sources.rows,
            interfaces: interfaces.rows,
            constraints: constraints.rows,
            coverage: coverage.rows,
          };
        },
        { readOnly: true },
      );

      if (!graph) throw errors.notFound('The requested resource was not found.');

      return {
        data: {
          envelopeId: graph.envelope.envelope_id,
          projectId,
          scenarioId: graph.envelope.scenario_id,
          revisionId: graph.envelope.revision_id,
          lifecycleState: graph.envelope.lifecycle_state,
          approvalState: graph.envelope.approval_state,
          // A draft has no content checksum — there is no immutable content to hash
          // yet — so the ETag is what a write must present and what a validation
          // result is pinned to. They are separate fields because they answer
          // separate questions.
          etag: graph.etag?.etag ?? null,
          etagVersion: graph.etag?.etagVersion ?? null,
          contentChecksum: graph.envelope.content_checksum,
          publishedAt: graph.envelope.published_at,
          createdAt: graph.envelope.created_at,
          updatedAt: graph.envelope.updated_at,
          designContext: {
            scopes: graph.scopes.map((row) => ({
              scopeId: row.scope_id,
              entityType: row.entity_type,
              scopeKind: row.scope_kind,
              name: row.name,
              jurisdiction: row.jurisdiction,
              parentScopeId: row.parent_scope_id,
            })),
            containers: graph.containers.map((row) => ({
              containerId: row.container_id,
              scopeId: row.scope_id,
              parentContainerId: row.parent_container_id,
              phaseId: row.phase_id,
              kind: row.kind,
              entityType: row.entity_type,
              name: row.name,
              levelNumber: row.level_number,
              status: row.status,
              elevationBaseM: num(row.elevation_base_m),
              elevationTopM: num(row.elevation_top_m),
            })),
          },
          geometryRecords: graph.geometry.map((row) => ({
            geometryId: row.geometry_id,
            entityId: row.entity_id,
            entityType: row.entity_type,
            role: row.role,
            ordinal: row.ordinal,
            geometryType: row.geometry_type,
            // A JSON object, never a string: the client should not have to parse
            // GeoJSON out of a text field.
            geojson4326: row.geojson_4326,
            projectedCrs: row.projected_crs,
            verticalCrs: row.vertical_crs,
            elevationBaseM: num(row.elevation_base_m),
            elevationTopM: num(row.elevation_top_m),
            heightM: num(row.height_m),
            displayName: row.display_name ?? null,
            entityStatus: row.status ?? null,
          })),
          utilitySources: graph.sources.map((row) => ({
            utilitySourceId: row.utility_source_id,
            kind: row.kind,
            capacityValue: num(row.capacity_value),
            capacityUnit: row.capacity_unit,
            capacityBasis: row.capacity_basis,
            capacityState: row.capacity_state,
            failureDomainId: row.failure_domain_id,
            phaseId: row.phase_id,
            availableFrom: row.available_from,
            displayName: row.display_name ?? null,
          })),
          utilityInterfaces: graph.interfaces.map((row) => ({
            interfaceId: row.interface_id,
            utilitySourceId: row.utility_source_id,
            capacityValue: num(row.capacity_value),
            capacityUnit: row.capacity_unit,
            capacityBasis: row.capacity_basis,
            capacityState: row.capacity_state,
            serviceState: row.service_state,
            failureDomainId: row.failure_domain_id,
            phaseId: row.phase_id,
            displayName: row.display_name ?? null,
          })),
          spatialConstraints: graph.constraints.map((row) => ({
            constraintId: row.constraint_id,
            scopeId: row.scope_id,
            containerId: row.container_id,
            appliesToGeometryId: row.applies_to_geometry_id,
            kind: row.kind,
            severity: row.severity,
            ruleKind: row.rule_kind,
            ruleValue: num(row.rule_value),
            ruleUnit: row.rule_unit,
            displayName: row.display_name ?? null,
          })),
          // Derived by T4 and, for an unvalidated draft, legitimately empty.
          capabilityCoverage: graph.coverage.map((row) => ({
            capability: row.capability,
            status: row.status,
            reviewedAt: row.reviewed_at,
          })),
        },
      };
    },
    // The project id arrives in the path, and `facility.read` is the key that
    // covers the facility graph. A malformed or unreachable project is a 404 from
    // the guard, never a widened or null scope.
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );
}

/** PostgreSQL `numeric` arrives as a string; the boundary carries a number. */
function num(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
