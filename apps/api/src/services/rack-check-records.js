import { createHash, randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { RackInputError, normalizeEditableLayout, normalizeEquipment, normalizeSpatialConstraints, checkEquipment } from '@ai-infra/rack';

export const RACK_CHECK_RULESET = 'rack-scoped-checks/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const rackCheckFingerprint = layout => hash({
  version: layout.version, facilityInput: layout.facilityInput, snapshot: layout.snapshot,
  placements: layout.placements, constraints: layout.constraints, equipment: layout.equipment, models: layout.models,
});
const scope = (projectId, planId) => {
  if (!UUID.test(projectId ?? '') || !UUID.test(planId ?? '')) throw errors.notFound('Rack plan not found.');
};
const conflict = (code, message) => new ApiError(code, message, { status: 409 });
const summaryColumns = `run_id,project_id,plan_id,plan_version,snapshot_id,input_hash,ruleset,created_by,created_at,
  spatial_report->>'status' AS spatial_status,equipment_report->>'status' AS equipment_status`;
function present(row, layout, fingerprint = rackCheckFingerprint(layout)) {
  const reasons = [];
  if (row.plan_version !== layout.version) reasons.push('PLAN_VERSION_CHANGED');
  if (row.snapshot_id !== layout.snapshot?.snapshotId) reasons.push('SNAPSHOT_CHANGED');
  if (row.input_hash !== fingerprint) reasons.push('INPUTS_CHANGED');
  if (row.ruleset !== RACK_CHECK_RULESET) reasons.push('RULESET_CHANGED');
  if (layout.sourceStatus.status !== 'UNCHANGED') reasons.push('SOURCE_CHANGED');
  return {
    runId: row.run_id, projectId: row.project_id, planId: row.plan_id, planVersion: row.plan_version,
    snapshotId: row.snapshot_id, inputHash: row.input_hash, ruleset: row.ruleset,
    createdBy: row.created_by, createdAt: row.created_at,
    spatialStatus: row.spatial_status ?? row.spatial_report?.status,
    equipmentStatus: row.equipment_status ?? row.equipment_report?.status,
    freshness: { status: reasons.length ? 'HISTORICAL' : 'CURRENT', reasons },
    ...(row.spatial_report ? { report: row.spatial_report, equipmentReport: row.equipment_report } : {}),
  };
}

export function createSavedRackChecks({ pool, read, check }) {
  return {
    async listCheckRuns({ projectId, planId }) {
      scope(projectId, planId);
      return withTenant(pool, projectId, async client => {
        const layout = await read(client, projectId, planId), fingerprint = rackCheckFingerprint(layout);
        const { rows } = await client.query(`SELECT ${summaryColumns} FROM rack_check_runs
          WHERE project_id=$1 AND plan_id=$2 ORDER BY created_at DESC,run_id DESC LIMIT 21`, [projectId, planId]);
        return { projectId, planId, version: layout.version, items: rows.slice(0, 20).map(row => present(row, layout, fingerprint)),
          hasOlder: rows.length > 20, limit: 20 };
      }, { readOnly: true });
    },
    async getCheckRun({ projectId, planId, runId }) {
      scope(projectId, planId);
      if (!UUID.test(runId ?? '')) throw errors.notFound('Rack check run not found.');
      return withTenant(pool, projectId, async client => {
        const layout = await read(client, projectId, planId);
        const { rows } = await client.query('SELECT * FROM rack_check_runs WHERE project_id=$1 AND plan_id=$2 AND run_id=$3', [projectId, planId, runId]);
        if (!rows.length) throw errors.notFound('Rack check run not found.');
        return present(rows[0], layout);
      }, { readOnly: true });
    },
    async getReport({ projectId, planId }) {
      scope(projectId, planId);
      return withTenant(pool, projectId, async client => {
        const layout = await read(client, projectId, planId);
        const { rows } = await client.query(`SELECT * FROM rack_check_runs WHERE project_id=$1 AND plan_id=$2
          AND plan_version=$3 AND input_hash=$4 AND ruleset=$5 ORDER BY created_at DESC,run_id DESC LIMIT 1`,
        [projectId, planId, layout.version, rackCheckFingerprint(layout), RACK_CHECK_RULESET]);
        const candidate = rows[0] ? present(rows[0], layout) : null;
        return { contractVersion: 1, kind: 'RACK_PLANNING_REPORT', generatedAt: new Date().toISOString(), layout,
          checkRun: candidate?.freshness.status === 'CURRENT' ? candidate : null,
          scopeNote: 'Saved planning inputs and scoped checks only. Not engineering certification, approval or a cross-tool import contract.',
          validationState: 'NOT_RUN' };
      }, { readOnly: true });
    },
    async recordCheckRun({ projectId, planId, actorId, body, key }) {
      scope(projectId, planId);
      if (!UUID.test(actorId ?? '')) throw errors.unauthorized();
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['contract_version', 'base_version', 'snapshot_id'].includes(k)))
        throw new RackInputError('body', 'unexpected field or malformed body');
      if (body.contract_version !== 1) throw errors.unsupportedContractVersion(body.contract_version);
      if (!Number.isSafeInteger(body.base_version) || body.base_version < 1) throw new RackInputError('base_version', 'must be a positive integer');
      if (!UUID.test(body.snapshot_id ?? '')) throw new RackInputError('snapshot_id', 'must be a UUID');
      if (!key) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'A check recording key is required.', { status: 428 });
      if (!UUID.test(key)) throw new RackInputError('Idempotency-Key', 'must be a UUID');
      const requestHash = hash({ actorId: actorId.toLowerCase(), body });
      return withTenant(pool, projectId, async client => {
        await client.query("SET LOCAL statement_timeout = '5s'");
        const exists = await client.query('SELECT plan_id FROM rack_plans WHERE project_id=$1 AND plan_id=$2 FOR UPDATE', [projectId, planId]);
        if (!exists.rows.length) throw errors.notFound('Rack plan not found.');
        let layout = await read(client, projectId, planId);
        const previous = (await client.query('SELECT * FROM rack_check_runs WHERE project_id=$1 AND plan_id=$2 AND command_key=$3', [projectId, planId, key])).rows[0];
        if (previous) {
          if (previous.request_hash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This key belongs to another check request.');
          return { run: present(previous, layout), replayed: true };
        }
        if (layout.version !== body.base_version) throw new ApiError('RACK_VERSION_CONFLICT', 'Reload the saved plan before recording checks.', { status: 412 });
        if (!layout.snapshot || layout.snapshot.snapshotId !== body.snapshot_id)
          throw conflict('RACK_SNAPSHOT_MISMATCH', 'Reload the fixed room input.');
        await client.query('SELECT etag FROM revision_etags WHERE project_id=$1 AND revision_id=$2 FOR SHARE', [projectId, layout.facilityInput.revisionId]);
        await client.query('SELECT revision_id FROM revisions WHERE project_id=$1 AND revision_id=$2 FOR SHARE', [projectId, layout.facilityInput.revisionId]);
        layout = await read(client, projectId, planId);
        if (layout.sourceStatus.status !== 'UNCHANGED') throw conflict('RACK_SOURCE_STALE', 'Facility source changed. Refresh inputs before recording checks.');
        const entries = normalizeEditableLayout({ placements: layout.placements, models: layout.models, projectId, planId });
        const report = await check(client, layout, entries, normalizeSpatialConstraints(layout.constraints));
        const equipmentReport = checkEquipment(normalizeEquipment(layout.equipment, layout.placements), layout.placements, layout.models);
        const row = (await client.query(`INSERT INTO rack_check_runs
          (run_id,project_id,plan_id,plan_version,snapshot_id,input_hash,ruleset,command_key,request_hash,spatial_report,equipment_report,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [randomUUID(), projectId, planId, layout.version, layout.snapshot.snapshotId, rackCheckFingerprint(layout), RACK_CHECK_RULESET,
          key, requestHash, JSON.stringify(report), JSON.stringify(equipmentReport), actorId])).rows[0];
        return { run: present(row, layout), replayed: false };
      }).catch(error => {
        if (error.code === '57014') throw new ApiError('RACK_CHECK_TIMEOUT', 'The scoped check exceeded its query limit. No record was saved.', { status: 503 });
        throw error;
      });
    },
  };
}
