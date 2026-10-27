import { randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { executeRun, RUN_REASON, RUN_STATUS } from './engine.js';
import { defaultPolicyRegistry } from './policies.js';
import { grantWaiver as grantWaiverRow, revokeWaiver as revokeWaiverRow } from './waivers.js';

/**
 * Validation service.
 *
 * A local `AFFECTED_SUBGRAPH` run is synchronous when the affected subgraph is
 * small, because the editor needs the answer while the user is still editing. A
 * `FULL` batch is a job: it must not hold an HTTP request open
 * (non-functional-requirements.md, "Jobification"). Both paths converge on the
 * same engine, which is what makes the acceptance criterion "a local run and a
 * full run reach identical conclusions" structural rather than aspirational.
 */
export function createFacilityValidationService({
  pool,
  logger = null,
  policies = defaultPolicyRegistry,
  maxDiagnostics = 100_000,
  syncEntityLimit = 2000,
} = {}) {
  if (!pool) throw new Error('createFacilityValidationService requires a database pool.');

  /** Validating a revision requires it to exist, have an envelope, and be a draft. */
  async function resolveTarget(projectId, revisionId) {
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const { rows } = await client.query(
          `SELECT r.revision_id, r.scenario_id, r.lifecycle_state,
                  (SELECT count(*) FROM entity_registry e
                    WHERE e.project_id = r.project_id AND e.revision_id = r.revision_id)::int AS entity_count,
                  (SELECT envelope_id FROM facility_envelopes f
                    WHERE f.project_id = r.project_id AND f.revision_id = r.revision_id) AS envelope_id
             FROM revisions r
            WHERE r.project_id = $1 AND r.revision_id = $2`,
          [projectId, revisionId],
        );
        return rows[0] ?? null;
      },
      { readOnly: true },
    );
  }

  async function requestValidation({
    projectId,
    revisionId,
    scope = 'FULL',
    baseEtag = null,
    requestedCapabilities = null,
    actorId = null,
    correlationId = null,
  }) {
    if (!['FULL', 'AFFECTED_SUBGRAPH'].includes(scope)) {
      throw new ApiError('VALIDATION_FAILED', 'scope must be FULL or AFFECTED_SUBGRAPH.', {
        status: 400,
        details: [{ field: 'scope' }],
      });
    }

    const target = await resolveTarget(projectId, revisionId);
    if (!target) throw errors.notFound('The requested resource was not found.');
    if (!target.envelope_id) {
      throw new ApiError('FACILITY_ENVELOPE_NOT_FOUND', 'The revision has no facility envelope to validate.', { status: 409 });
    }
    if (target.lifecycle_state !== 'DRAFT') {
      throw new ApiError('REVISION_IMMUTABLE', 'A validated or published revision cannot be revalidated; branch a draft.', { status: 409 });
    }

    const runId = randomUUID();
    const sync = scope === 'AFFECTED_SUBGRAPH' && target.entity_count <= syncEntityLimit;

    if (sync) {
      const result = await withTenant(pool, projectId, async (client) => {
        const currentDraft = await isCurrentDraft(client, projectId, target.scenario_id, revisionId);
        return executeRun({
          client,
          projectId,
          scenarioId: target.scenario_id,
          revisionId,
          scope,
          reason: RUN_REASON.VALIDATION,
          requestedCapabilities,
          baseEtag,
          actorId,
          policies,
          maxDiagnostics,
          isCurrentDraft: currentDraft,
          runId,
        });
      });
      return { mode: 'sync', ...result };
    }

    const jobId = randomUUID();
    await withTenant(pool, projectId, (client) =>
      client.query(
        `INSERT INTO jobs
           (job_id, project_id, scenario_id, revision_id, job_type, state, requested_by, payload, created_by)
         VALUES ($1, $2, $3, $4, 'VALIDATION', 'QUEUED', $5, $6::jsonb, $5)`,
        [
          jobId, projectId, target.scenario_id, revisionId, actorId,
          JSON.stringify({
            validation_run_id: runId,
            scope,
            base_etag: baseEtag,
            requested_capabilities: requestedCapabilities,
            actor_id: actorId,
            correlation_id: correlationId,
          }),
        ],
      ),
    );

    return { mode: 'job', jobId, runId, scope, status: RUN_STATUS.QUEUED };
  }

  async function getRun({ projectId, revisionId, runId }) {
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const run = (
          await client.query(
            `SELECT validation_run_id, revision_id, scope, status, base_etag, requested_capabilities::text[] AS requested_capabilities,
                    checked_capabilities::text[] AS checked_capabilities,
                    not_checked_capabilities::text[] AS not_checked_capabilities,
                    error_count, warning_count, started_at, completed_at, created_at
               FROM validation_runs
              WHERE project_id = $1 AND revision_id = $2 AND validation_run_id = $3`,
            [projectId, revisionId, runId],
          )
        ).rows[0];
        if (!run) return null;
        const diagnostics = await listDiagnosticRows(client, projectId, revisionId, { runId });
        const coverage = (
          await client.query(
            `SELECT capability, status, evidence_refs, reviewed_at
               FROM capability_coverage
              WHERE project_id = $1 AND revision_id = $2
              ORDER BY capability`,
            [projectId, revisionId],
          )
        ).rows.map(mapCoverage);
        return { run: mapRun(run), diagnostics, coverage };
      },
      { readOnly: true },
    );
  }

  async function listDiagnostics({ projectId, revisionId, filters = {} }) {
    return withTenant(
      pool,
      projectId,
      (client) => listDiagnosticRows(client, projectId, revisionId, filters),
      { readOnly: true },
    );
  }

  async function listCoverage({ projectId, revisionId }) {
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const { rows } = await client.query(
          `SELECT capability, status, evidence_refs, reviewed_at
             FROM capability_coverage WHERE project_id = $1 AND revision_id = $2 ORDER BY capability`,
          [projectId, revisionId],
        );
        return rows.map(mapCoverage);
      },
      { readOnly: true },
    );
  }

  async function listWaivers({ projectId, revisionId }) {
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const { rows } = await client.query(
          `SELECT waiver_id, revision_id, diagnostic_ids, scope, policy_id, reason, granted_at, expires_at, status
             FROM waivers WHERE project_id = $1 AND revision_id = $2 ORDER BY granted_at DESC`,
          [projectId, revisionId],
        );
        return rows.map(mapWaiver);
      },
      { readOnly: true },
    );
  }

  async function getJob({ projectId, jobId }) {
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const { rows } = await client.query(
          `SELECT job_id, revision_id, job_type, state, progress_pct, payload, result, error_message,
                  started_at, completed_at, created_at
             FROM jobs WHERE project_id = $1 AND job_id = $2`,
          [projectId, jobId],
        );
        return rows[0] ? mapJob(rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  return {
    requestValidation,
    getRun,
    listDiagnostics,
    listCoverage,
    listWaivers,
    getJob,
    grantWaiver: (input) => grantWaiverRow({ pool, ...input }),
    revokeWaiver: (input) => revokeWaiverRow({ pool, ...input }),
  };
}

/** The newest DRAFT revision of the scenario, which is what "current draft" means. */
export async function isCurrentDraft(client, projectId, scenarioId, revisionId) {
  const { rows } = await client.query(
    `SELECT revision_id FROM revisions
      WHERE project_id = $1 AND scenario_id = $2 AND lifecycle_state = 'DRAFT'
      ORDER BY created_at DESC, revision_id LIMIT 1`,
    [projectId, scenarioId],
  );
  if (rows.length === 0) return true;
  return rows[0].revision_id === revisionId;
}

async function listDiagnosticRows(client, projectId, revisionId, { runId = null, severity = null, status = null, constraintId = null, capability = null, limit = 500 } = {}) {
  const { rows } = await client.query(
    `SELECT diagnostic_id, validation_run_id, constraint_id, severity, status, entity_refs, geometry_refs,
            source_values, computed, remediation_category, remediation_hint, policy_ref,
            supersedes_diagnostic_id, created_at
       FROM facility_diagnostics
      WHERE project_id = $1 AND revision_id = $2
        AND ($3::uuid IS NULL OR validation_run_id = $3)
        AND ($4::severity IS NULL OR severity = $4)
        AND ($5::diagnostic_status IS NULL OR status = $5)
        AND ($6::text IS NULL OR constraint_id = $6)
        AND ($7::text IS NULL OR constraint_id LIKE $7 || '%')
      ORDER BY severity, constraint_id, created_at
      LIMIT $8`,
    [projectId, revisionId, runId, severity, status, constraintId, capability ? `facility.${String(capability).toLowerCase()}` : null, Math.min(Math.max(limit, 1), 1000)],
  );
  return rows.map(mapDiagnostic);
}

function mapRun(row) {
  return {
    validationRunId: row.validation_run_id,
    revisionId: row.revision_id,
    scope: row.scope,
    status: row.status,
    baseEtag: row.base_etag,
    requestedCapabilities: row.requested_capabilities ?? [],
    checkedCapabilities: row.checked_capabilities ?? [],
    notCheckedCapabilities: row.not_checked_capabilities ?? [],
    errorCount: row.error_count,
    warningCount: row.warning_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function mapDiagnostic(row) {
  // `evidence_key` is the engine's supersession identity, not evidence a reader can
  // use, so it is dropped here rather than shown on every finding.
  const { evidence_key: _evidenceKey, ...computed } = row.computed ?? {};
  return {
    diagnosticId: row.diagnostic_id,
    validationRunId: row.validation_run_id,
    constraintId: row.constraint_id,
    severity: row.severity,
    status: row.status,
    entityRefs: row.entity_refs ?? [],
    geometryRefs: row.geometry_refs ?? [],
    sourceValues: row.source_values ?? [],
    computed,
    remediationCategory: row.remediation_category,
    remediationHint: row.remediation_hint,
    policyRef: row.policy_ref,
    supersedesDiagnosticId: row.supersedes_diagnostic_id,
    createdAt: row.created_at,
  };
}

function mapCoverage(row) {
  return {
    capability: row.capability,
    status: row.status,
    reasons: row.evidence_refs?.reasons ?? [],
    validationRunId: row.evidence_refs?.validation_run_id ?? null,
    reviewedAt: row.reviewed_at,
  };
}

function mapWaiver(row) {
  return {
    waiverId: row.waiver_id,
    revisionId: row.revision_id,
    diagnosticIds: row.diagnostic_ids ?? [],
    scope: row.scope,
    policyId: row.policy_id,
    reason: row.reason,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function mapJob(row) {
  return {
    jobId: row.job_id,
    revisionId: row.revision_id,
    jobType: row.job_type,
    state: row.state,
    progressPct: row.progress_pct,
    result: row.result,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}
