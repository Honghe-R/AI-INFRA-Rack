import { createHash, randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { normalizeEditableLayout, assertLockedRacksUnchanged, RackInputError } from '@ai-infra/rack';
import { readRackRoomView } from './rack-plans.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflict = (code, message, details = []) => new ApiError(code, message, { status: 409, details });
function scope(projectId, planId) {
  if (!UUID.test(projectId ?? '') || !UUID.test(planId ?? '')) throw errors.notFound('Rack plan not found.');
}
function bodyFields(body, names) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !names.includes(key))
  ) {
    throw new RackInputError('body', 'unexpected field or malformed body');
  }
  if (body.contract_version !== 1) throw errors.unsupportedContractVersion(body.contract_version);
}
// A single statement gives reads a coherent plan/source/snapshot/layout/catalog.
async function read(client, projectId, planId) {
  const row = (
    await client.query(
      `SELECT p.plan_id,p.project_id,p.scenario_id,p.version,p.source_revision_id,
    p.source_container_id,p.source_revision_etag,r.lifecycle_state,e.etag,s.snapshot_id,s.document,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('rackId',q.rack_id,'modelId',q.model_id,'name',q.name,
      'xM',q.x_m,'yM',q.y_m,'rotationDeg',q.rotation_deg,'locked',q.locked) ORDER BY q.rack_id)
      FROM rack_placements q WHERE q.project_id=p.project_id AND q.plan_id=p.plan_id),'[]'::jsonb) AS placements,
    (SELECT jsonb_agg(definition ORDER BY model_id) FROM rack_models) AS models
    FROM rack_plans p JOIN revisions r ON r.project_id=p.project_id AND r.revision_id=p.source_revision_id
    LEFT JOIN revision_etags e ON e.project_id=p.project_id AND e.revision_id=p.source_revision_id
    LEFT JOIN rack_room_snapshots s ON s.project_id=p.project_id AND s.plan_id=p.plan_id
    WHERE p.project_id=$1 AND p.plan_id=$2`,
      [projectId, planId],
    )
  ).rows[0];
  if (!row) throw errors.notFound('Rack plan not found.');
  const reasons = [];
  if (row.lifecycle_state !== 'DRAFT') reasons.push('SOURCE_NOT_DRAFT');
  if (!row.etag) reasons.push('ETAG_MISSING');
  else if (row.etag !== row.source_revision_etag) reasons.push('ETAG_CHANGED');
  return {
    contractVersion: 1,
    projectId: row.project_id,
    planId: row.plan_id,
    scenarioId: row.scenario_id,
    version: row.version,
    facilityInput: {
      projectId: row.project_id,
      scenarioId: row.scenario_id,
      revisionId: row.source_revision_id,
      containerId: row.source_container_id,
      revisionEtag: row.source_revision_etag,
    },
    sourceStatus: { status: !row.etag ? 'UNAVAILABLE' : reasons.length ? 'STALE' : 'UNCHANGED', reasons },
    snapshot: row.document ? { snapshotId: row.snapshot_id, ...row.document } : null,
    placements: row.placements,
    models: row.models ?? [],
    validationState: 'NOT_RUN',
  };
}

/** SQL topology predicates operate on the exact stored Polygon in local metres.
 * Outer-wall contact is allowed; hole contact is conservatively a conflict.
 * Rack interior overlaps are conflicts; rack edge/corner contact is allowed. */
async function check(client, layout, entries) {
  if (!layout.snapshot)
    throw conflict('RACK_SNAPSHOT_REQUIRED', 'Capture the unchanged room input before editing.');
  const footprints = entries.map(({ placement, footprint }) => ({
    rackId: placement.rackId,
    geometry: { type: 'Polygon', coordinates: [[...footprint.cornersM, footprint.cornersM[0]]] },
  }));
  const result = await client.query(
    `WITH room AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),0) AS geom),
    holes AS (SELECT ST_MakePolygon(ST_InteriorRingN(room.geom,n)) AS geom
      FROM room, generate_series(1, ST_NumInteriorRings(room.geom)) n),
    racks AS (SELECT x->>'rackId' AS id, ST_SetSRID(ST_GeomFromGeoJSON(x->'geometry'),0) AS geom FROM jsonb_array_elements($2::jsonb) x)
    SELECT 'RACK_OUTSIDE_ROOM' AS code, ARRAY[a.id] AS rack_ids FROM racks a,room WHERE NOT ST_Covers(room.geom,a.geom)
    UNION ALL SELECT 'RACK_HOLE_CONFLICT',ARRAY[a.id] FROM racks a WHERE EXISTS (SELECT 1 FROM holes h WHERE ST_Intersects(h.geom,a.geom))
    UNION ALL SELECT 'RACK_PAIR_OVERLAP',ARRAY[a.id,b.id] FROM racks a JOIN racks b ON a.id<b.id
      WHERE ST_Relate(a.geom,b.geom,'T********') ORDER BY code,rack_ids`,
    [JSON.stringify(layout.snapshot.view.boundaryLocalM), JSON.stringify(footprints)],
  );
  const diagnostics = result.rows.map((row) => ({
    code: row.code,
    rackIds: row.rack_ids,
    severity: 'ERROR',
    message: {
      RACK_OUTSIDE_ROOM: 'Rack footprint leaves the room Polygon.',
      RACK_HOLE_CONFLICT: 'Rack touches or overlaps an interior hole.',
      RACK_PAIR_OVERLAP: 'Rack footprints overlap.',
    }[row.code],
  }));
  return {
    status: diagnostics.length ? 'ISSUES_FOUND' : entries.length ? 'CHECKED_SCOPE_CLEAR' : 'NOT_CHECKED',
    scope: ['POLYGON_CONTAINMENT', 'INTERIOR_HOLES', 'RACK_PAIR_OVERLAP'],
    diagnostics,
    racksChecked: entries.length,
    pairsChecked: (entries.length * (entries.length - 1)) / 2,
    obstacleCoverage: 'UNKNOWN',
    uncheckedRules: [
      'OBSTACLES',
      'MAINTENANCE_CLEARANCE',
      'AISLES',
      'EQUIPMENT',
      'CAPACITY',
      'ENGINEERING_ACCURACY',
    ],
  };
}

export function createRackLayoutService({ pool }) {
  return {
    async get({ projectId, planId }) {
      scope(projectId, planId);
      return withTenant(pool, projectId, (client) => read(client, projectId, planId), { readOnly: true });
    },
    async check({ projectId, planId, body }) {
      scope(projectId, planId);
      bodyFields(body, ['contract_version', 'snapshot_id', 'placements']);
      return withTenant(
        pool,
        projectId,
        async (client) => {
          const layout = await read(client, projectId, planId);
          if (!layout.snapshot || body.snapshot_id !== layout.snapshot.snapshotId)
            throw conflict('RACK_SNAPSHOT_MISMATCH', 'Reload the fixed room input.');
          const entries = normalizeEditableLayout({
            placements: body.placements,
            models: layout.models,
            projectId,
            planId,
          });
          return {
            planId,
            snapshotId: layout.snapshot.snapshotId,
            report: await check(client, layout, entries),
          };
        },
        { readOnly: true },
      );
    },
    async mutate({ projectId, planId, actorId, body, key, ifMatch, operation }) {
      scope(projectId, planId);
      bodyFields(
        body,
        operation === 'capture' ? ['contract_version'] : ['contract_version', 'snapshot_id', 'placements'],
      );
      if (!UUID.test(actorId ?? '')) throw errors.unauthorized();
      if (!key)
        throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'A creation/save key is required.', { status: 428 });
      if (!UUID.test(key)) throw new RackInputError('Idempotency-Key', 'must be a UUID');
      if (!ifMatch) throw new ApiError('PRECONDITION_REQUIRED', 'If-Match is required.', { status: 428 });
      if (!/^"[1-9][0-9]*"$/.test(ifMatch) || !Number.isSafeInteger(Number(ifMatch.slice(1, -1))))
        throw new RackInputError('If-Match', 'must be a quoted positive integer version');
      const version = Number(ifMatch.slice(1, -1));
      const hash = createHash('sha256').update(JSON.stringify({ operation, version, body })).digest('hex');
      return withTenant(pool, projectId, async (client) => {
        const exists = await client.query(
          'SELECT plan_id FROM rack_plans WHERE project_id=$1 AND plan_id=$2 FOR UPDATE',
          [projectId, planId],
        );
        if (!exists.rows.length) throw errors.notFound('Rack plan not found.');
        const previous = (
          await client.query(
            'SELECT request_hash,applied_version FROM rack_layout_commands WHERE project_id=$1 AND plan_id=$2 AND command_key=$3',
            [projectId, planId, key],
          )
        ).rows[0];
        if (previous) {
          if (previous.request_hash !== hash)
            throw conflict('IDEMPOTENCY_KEY_REUSED', 'This save key belongs to a different request.');
          return {
            layout: await read(client, projectId, planId),
            replayed: true,
            appliedVersion: previous.applied_version,
          };
        }
        let layout = await read(client, projectId, planId);
        if (layout.version !== version)
          throw new ApiError(
            'RACK_VERSION_CONFLICT',
            'Another edit changed this plan. Keep your draft and reload the saved version before retrying.',
            { status: 412, details: [{ currentVersion: layout.version }] },
          );
        // Same upstream lock ordering as create; a Facility writer cannot advance
        // its token or lifecycle between this check and the Rack commit.
        await client.query(
          'SELECT etag FROM revision_etags WHERE project_id=$1 AND revision_id=$2 FOR SHARE',
          [projectId, layout.facilityInput.revisionId],
        );
        await client.query(
          'SELECT revision_id FROM revisions WHERE project_id=$1 AND revision_id=$2 FOR SHARE',
          [projectId, layout.facilityInput.revisionId],
        );
        layout = await read(client, projectId, planId);
        if (layout.sourceStatus.status !== 'UNCHANGED')
          throw conflict(
            'RACK_SOURCE_STALE',
            'Facility source changed; the fixed snapshot remains viewable, but editing is blocked.',
          );
        let changed = true;
        if (operation === 'capture') {
          if (layout.snapshot) changed = false;
          else {
            const room = await readRackRoomView(client, { projectId, planId });
            if (room.status !== 'AVAILABLE')
              throw conflict('RACK_ROOM_UNAVAILABLE', 'The room boundary cannot be captured.', [
                { reason: room.reason },
              ]);
            await client.query(
              'INSERT INTO rack_room_snapshots(plan_id,project_id,snapshot_id,document,created_by) VALUES($1,$2,$3,$4,$5)',
              [
                planId,
                projectId,
                randomUUID(),
                JSON.stringify({
                  room: room.room,
                  view: room.view,
                  sourceGeometry: room.sourceGeometry,
                  facilityInput: room.facilityInput,
                }),
                actorId,
              ],
            );
          }
        } else {
          if (!layout.snapshot || layout.snapshot.snapshotId !== body.snapshot_id)
            throw conflict('RACK_SNAPSHOT_MISMATCH', 'Reload the fixed room input.');
          const entries = normalizeEditableLayout({
            placements: body.placements,
            models: layout.models,
            projectId,
            planId,
          });
          const placements = entries.map((item) => item.placement);
          assertLockedRacksUnchanged(layout.placements, placements);
          const report = await check(client, layout, entries);
          if (report.diagnostics.length)
            throw new ApiError('RACK_LAYOUT_CONFLICT', 'Resolve spatial conflicts before saving.', {
              status: 422,
              details: [{ report }],
            });
          await client.query('DELETE FROM rack_placements WHERE project_id=$1 AND plan_id=$2', [
            projectId,
            planId,
          ]);
          for (const p of placements)
            await client.query(
              `INSERT INTO rack_placements(plan_id,project_id,rack_id,model_id,name,x_m,y_m,rotation_deg,locked)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [planId, projectId, p.rackId, p.modelId, p.name, p.xM, p.yM, p.rotationDeg, p.locked],
            );
        }
        if (changed)
          await client.query(
            'UPDATE rack_plans SET version=version+1,updated_at=now(),updated_by=$3 WHERE project_id=$1 AND plan_id=$2',
            [projectId, planId, actorId],
          );
        const saved = await read(client, projectId, planId);
        await client.query(
          'INSERT INTO rack_layout_commands(project_id,plan_id,command_key,request_hash,applied_version,created_by) VALUES($1,$2,$3,$4,$5,$6)',
          [projectId, planId, key, hash, saved.version, actorId],
        );
        return { layout: saved, replayed: false, appliedVersion: saved.version };
      });
    },
  };
}
