import { randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';

/**
 * Waivers.
 *
 * A waiver suppresses the gating effect of named diagnostics without altering
 * their evidence: the diagnostic moves to `WAIVED`, stays visible, and is never
 * deleted. Revocation restores the gate. Both are append-only governance facts —
 * the waiver row carries the grant, and revocation is recorded on it as a status
 * change with a reason, because a waiver that vanished would leave an audit gap.
 *
 * A re-run creates a new diagnostic for the same condition; the engine carries
 * the waiver forward through `supersedes_diagnostic_id`, so a waiver keeps
 * meaning what it meant until it expires or is revoked.
 */

export async function grantWaiver({
  pool,
  projectId,
  revisionId,
  diagnosticIds = [],
  policyId,
  reason,
  scope = 'REVISION',
  expiresAt = null,
  actorId = null,
  correlationId = null,
}) {
  if (!Array.isArray(diagnosticIds) || diagnosticIds.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'A waiver requires at least one diagnostic.', {
      status: 400,
      details: [{ field: 'diagnostic_ids' }],
    });
  }
  if (!policyId) {
    throw new ApiError('VALIDATION_FAILED', 'A waiver requires a policy reference.', {
      status: 400,
      details: [{ field: 'policy_id' }],
    });
  }

  return withTenant(pool, projectId, async (client) => {
    const { rows } = await client.query(
      `SELECT diagnostic_id FROM facility_diagnostics
        WHERE project_id = $1 AND revision_id = $2 AND diagnostic_id = ANY($3::uuid[])`,
      [projectId, revisionId, diagnosticIds],
    );
    if (rows.length !== diagnosticIds.length) {
      throw new ApiError('VALIDATION_FAILED', 'Every waived diagnostic must belong to the revision.', {
        status: 400,
        details: [{ field: 'diagnostic_ids' }],
      });
    }

    const waiverId = randomUUID();
    const waiver = (
      await client.query(
        `INSERT INTO waivers
           (waiver_id, project_id, scenario_id, revision_id, diagnostic_ids, scope, granted_by, policy_id,
            reason, expires_at, status, created_by)
         SELECT $1, $2, d.scenario_id, d.revision_id, $3::uuid[], $4, $5, $6, $7, $8, 'GRANTED', $5
           FROM facility_diagnostics d
          WHERE d.project_id = $2 AND d.revision_id = $9 AND d.diagnostic_id = ANY($3::uuid[])
          LIMIT 1
         RETURNING waiver_id, revision_id, diagnostic_ids, scope, policy_id, reason, granted_at, expires_at, status`,
        [waiverId, projectId, diagnosticIds, scope, actorId, policyId, reason, expiresAt, revisionId],
      )
    ).rows[0];

    await client.query(
      `UPDATE facility_diagnostics SET status = 'WAIVED'
        WHERE project_id = $1 AND diagnostic_id = ANY($2::uuid[]) AND status IN ('OPEN', 'ACKNOWLEDGED')`,
      [projectId, diagnosticIds],
    );

    await client.query(
      `INSERT INTO outbox_events
         (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload, correlation_id, created_by)
       SELECT $1, $2, d.scenario_id, d.revision_id, 'facility.waiver.recorded.v1', 'waiver', $3, $4::jsonb, $5, $6
         FROM facility_diagnostics d
        WHERE d.project_id = $2 AND d.revision_id = $7 LIMIT 1`,
      [
        randomUUID(), projectId, waiverId,
        JSON.stringify({ waiver_id: waiverId, diagnostic_ids: diagnosticIds, policy_id: policyId, expires_at: expiresAt }),
        correlationId, actorId, revisionId,
      ],
    );

    return mapWaiver(waiver);
  });
}

export async function revokeWaiver({
  pool,
  projectId,
  waiverId,
  reason,
  actorId = null,
  correlationId = null,
}) {
  return withTenant(pool, projectId, async (client) => {
    const waiver = (
      await client.query(
        `SELECT waiver_id, revision_id, diagnostic_ids, status FROM waivers
          WHERE waiver_id = $1 AND project_id = $2`,
        [waiverId, projectId],
      )
    ).rows[0];
    if (!waiver) throw errors.notFound('The requested resource was not found.');

    await client.query(
      `UPDATE waivers SET status = 'REVOKED' WHERE waiver_id = $1 AND project_id = $2`,
      [waiverId, projectId],
    );
    // Only diagnostics this waiver still holds are released; a diagnostic waived
    // by a different, live waiver keeps its status.
    await client.query(
      `UPDATE facility_diagnostics SET status = 'OPEN'
        WHERE project_id = $1 AND diagnostic_id = ANY($2::uuid[]) AND status = 'WAIVED'
          AND NOT EXISTS (
            SELECT 1 FROM waivers w
             WHERE w.project_id = $1 AND w.status = 'GRANTED' AND w.waiver_id <> $3
               AND facility_diagnostics.diagnostic_id = ANY(w.diagnostic_ids))`,
      [projectId, waiver.diagnostic_ids, waiverId],
    );

    await client.query(
      `INSERT INTO outbox_events
         (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload, correlation_id, created_by)
       SELECT $1, $2, d.scenario_id, d.revision_id, 'facility.waiver.revoked.v1', 'waiver', $3, $4::jsonb, $5, $6
         FROM facility_diagnostics d
        WHERE d.project_id = $2 AND d.revision_id = $7 LIMIT 1`,
      [
        randomUUID(), projectId, waiverId,
        JSON.stringify({ waiver_id: waiverId, reason: reason ?? null }),
        correlationId, actorId, waiver.revision_id,
      ],
    );

    return { waiverId, status: 'REVOKED' };
  });
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
