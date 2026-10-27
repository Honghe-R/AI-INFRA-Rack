import { ApiError } from '@ai-infra/core';
import { withOrganisation, withTenant } from '@ai-infra/db';
import { FACILITY_KEYS, PLATFORM_KEYS } from '@ai-infra/rbac';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project listing for the shell's entry screen.
 *
 * A project list is a workspace-level read that spans one organisation, so it
 * cannot be scoped to a single project. The request therefore names its
 * organisation, and the read runs with the organisation GUC set: migration 002's
 * additive policy on `projects` exposes exactly that organisation's rows, and the
 * membership filter narrows them to projects the caller can actually reach.
 *
 * A caller with no membership in the requested organisation gets an empty list
 * rather than an error, so the endpoint does not confirm whether an organisation
 * exists.
 */
export function registerProjectRoutes(router, { pool }) {
  router.get(
    '/api/v1/projects',
    async ({ query, user }) => {
      const organisationId = query.organisation_id ?? null;
      if (!organisationId) {
        throw new ApiError('VALIDATION_FAILED', 'organisation_id is required to list projects.', { status: 400 });
      }
      if (!UUID.test(organisationId)) {
        throw new ApiError('NOT_FOUND', 'The requested resource was not found.', { status: 404 });
      }

      const { rows } = await withOrganisation(
        pool,
        organisationId,
        (client) =>
          client.query(
            `SELECT p.project_id,
                    p.organization_id,
                    p.name,
                    p.showcase,
                    (SELECT count(*) FROM organization_memberships m
                      WHERE m.organization_id = p.organization_id AND m.user_id = $1 AND m.status = 'ACTIVE')::int
                      AS organisation_membership_count,
                    (SELECT count(*) FROM project_memberships m
                      WHERE m.project_id = p.project_id AND m.user_id = $1 AND m.status = 'ACTIVE')::int
                      AS project_membership_count
             FROM projects p
             ORDER BY p.name`,
            [user.userId],
          ),
        { readOnly: true },
      );

      return {
        data: rows
          .filter((row) => row.organisation_membership_count > 0 || row.project_membership_count > 0)
          .map((row) => ({
            projectId: row.project_id,
            organisationId: row.organization_id,
            name: row.name,
            showcase: row.showcase,
            // Lifecycle and validation live on a revision, not a project, so the
            // list does not invent them; the shell renders "not validated".
            accessState: row.project_membership_count > 0 ? 'Member' : 'Organisation',
          })),
      };
    },
    // The guard resolves scope from the request using the parameter names it is
    // told about. A mismatch here is the blueprint's "silent null scope" bug: the
    // check would run unscoped and deny a caller who legitimately holds the key.
    { permission: PLATFORM_KEYS.PROJECT_READ, organisationParam: 'organisation_id' },
  );

  /**
   * Scenario summaries for one project, each carrying its active revision.
   *
   * Opening a project means entering a workspace context, and a context is a
   * project *and* a scenario *and* a revision (ui-pattern.md, "Information
   * Architecture"). The project list cannot supply those identifiers, so the
   * shell reads them here instead of inventing a scenario id it was never given.
   *
   * "Active revision" is the newest DRAFT, falling back to the newest revision
   * when a scenario has no draft left: a draft is the only revision a user can
   * continue authoring, and a scenario whose drafts are all validated or
   * published is still openable for reading.
   */
  router.get(
    '/api/v1/projects/:projectId/scenarios',
    async ({ params }) => {
      const { projectId } = params;

      const { rows } = await withTenant(
        pool,
        projectId,
        (client) =>
          client.query(
            `SELECT s.scenario_id,
                    s.name,
                    s.description,
                    r.revision_id,
                    r.lifecycle_state,
                    r.revision_name,
                    r.updated_at
               FROM scenarios s
               LEFT JOIN LATERAL (
                 SELECT r.revision_id, r.lifecycle_state, r.name AS revision_name, r.updated_at
                   FROM revisions r
                  WHERE r.scenario_id = s.scenario_id
                  ORDER BY (r.lifecycle_state = 'DRAFT') DESC, r.created_at DESC, r.revision_id
                  LIMIT 1
               ) r ON TRUE
              -- The tenant policy filters on the same column; the explicit
              -- predicate keeps the read correct where the caller is the table
              -- owner and row-level security does not apply.
              WHERE s.project_id = $1
              ORDER BY s.created_at, s.name, s.scenario_id`,
            [projectId],
          ),
        { readOnly: true },
      );

      return {
        data: rows.map((row) => ({
          scenarioId: row.scenario_id,
          name: row.name,
          description: row.description,
          activeRevision: row.revision_id
            ? {
                revisionId: row.revision_id,
                lifecycleState: row.lifecycle_state,
                name: row.revision_name,
                updatedAt: row.updated_at,
              }
            : null,
        })),
      };
    },
    // The identifier arrives in the path, so the guard must look there. A
    // malformed or unreachable project is a 404 from the guard, never a null
    // scope: `facility.read` covers the facility graph this route exposes.
    { permission: FACILITY_KEYS.READ, projectParam: 'projectId' },
  );
}
