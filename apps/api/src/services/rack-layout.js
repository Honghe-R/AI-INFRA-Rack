import { createHash, randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { normalizeEditableLayout, assertLockedRacksUnchanged, RackInputError } from '@ai-infra/rack';
import { normalizeSpatialConstraints, localRectangle, rackClearanceBands } from '@ai-infra/rack';
import { normalizeEquipment, checkEquipment } from '@ai-infra/rack';
import { readRackRoomView } from './rack-plans.js';
import { generateRackOptions, normalizePlannerOptions, layoutMetrics, PLANNER_LIMITS } from '@ai-infra/rack';
import { pickRackPosition } from './rack-planner-geometry.js';
import { allocateUnassignedEquipment } from '@ai-infra/rack';
import { generateDemandOptions, normalizeDesignDemand, DEMAND_LIMITS } from '@ai-infra/rack';

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
function equipmentInput(body, layout) {
  if (!Object.hasOwn(body, 'equipment')) return layout.equipment;
  const incoming = body.equipment;
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
      !Object.hasOwn(incoming, 'roomBudget') && Object.hasOwn(layout.equipment, 'roomBudget'))
    return { ...incoming, roomBudget: layout.equipment.roomBudget };
  return incoming;
}
async function read(client, projectId, planId) {
  const row = (
    await client.query(
      `SELECT p.plan_id,p.project_id,p.scenario_id,p.version,p.source_revision_id,p.deleted_at,
    p.source_container_id,p.source_revision_etag,p.spatial_constraints,p.equipment,r.lifecycle_state,e.etag,s.snapshot_id,s.document,
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
  if (row.deleted_at) throw new ApiError('RACK_PLAN_DELETED','This plan is in deleted plans. Restore it before editing or planning.',{status:410});
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
    constraints: row.spatial_constraints,
    equipment: row.equipment,
    models: row.models ?? [],
    validationState: 'NOT_RUN',
  };
}

/** SQL topology predicates operate on the exact stored Polygon in local metres.
 * Outer-wall contact is allowed; hole contact is conservatively a conflict.
 * Rack interior overlaps are conflicts; rack edge/corner contact is allowed. */
async function check(client, layout, entries, constraints) {
  if (!layout.snapshot)
    throw conflict('RACK_SNAPSHOT_REQUIRED', 'Capture the unchanged room input before editing.');
  const footprints = entries.map(({ placement, footprint }) => ({
    rackId: placement.rackId,
    geometry: { type: 'Polygon', coordinates: [[...footprint.cornersM, footprint.cornersM[0]]] },
  }));
  const obstacles = constraints.obstacles.map((o) => ({
    obstacleId: o.obstacleId,
    geometry: localRectangle(o.xM, o.yM, o.widthM, o.depthM),
  }));
  const bands = entries.flatMap(({ placement }) =>
    rackClearanceBands(
      placement,
      layout.models.find((m) => m.modelId === placement.modelId),
      constraints.clearance,
    ),
  );
  const result = await client.query(
    `WITH room AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),0) AS geom),
    holes AS (SELECT ST_MakePolygon(ST_InteriorRingN(room.geom,n)) AS geom
      FROM room, generate_series(1, ST_NumInteriorRings(room.geom)) n),
    racks AS (SELECT x->>'rackId' AS id, ST_SetSRID(ST_GeomFromGeoJSON(x->'geometry'),0) AS geom FROM jsonb_array_elements($2::jsonb) x)
    ,obstacles AS (SELECT x->>'obstacleId' AS id,ST_SetSRID(ST_GeomFromGeoJSON(x->'geometry'),0) AS geom FROM jsonb_array_elements($3::jsonb) x),
    bands AS (SELECT x->>'rackId' AS id,x->>'side' AS side,ST_SetSRID(ST_GeomFromGeoJSON(x->'geometry'),0) AS geom FROM jsonb_array_elements($4::jsonb) x)
    SELECT 'RACK_OUTSIDE_ROOM' AS code, ARRAY[a.id] AS rack_ids, ARRAY[]::text[] AS obstacle_ids, NULL::text AS side FROM racks a,room WHERE NOT ST_Covers(room.geom,a.geom)
    UNION ALL SELECT 'RACK_HOLE_CONFLICT',ARRAY[a.id],ARRAY[]::text[],NULL::text FROM racks a WHERE EXISTS (SELECT 1 FROM holes h WHERE ST_Intersects(h.geom,a.geom))
    UNION ALL SELECT 'RACK_PAIR_OVERLAP',ARRAY[a.id,b.id],ARRAY[]::text[],NULL::text FROM racks a JOIN racks b ON a.id<b.id
      WHERE ST_Relate(a.geom,b.geom,'T********')
    UNION ALL SELECT 'OBSTACLE_OUTSIDE_ROOM',ARRAY[]::text[],ARRAY[o.id],NULL::text FROM obstacles o,room WHERE NOT ST_Covers(room.geom,o.geom)
      OR EXISTS(SELECT 1 FROM holes h WHERE ST_Intersects(h.geom,o.geom))
    UNION ALL SELECT 'RACK_OBSTACLE_CONFLICT',ARRAY[a.id],ARRAY[o.id],NULL::text FROM racks a,obstacles o WHERE ST_Intersects(a.geom,o.geom)
    UNION ALL SELECT 'CLEARANCE_OUTSIDE_ROOM',ARRAY[b.id],ARRAY[]::text[],b.side FROM bands b,room WHERE NOT ST_Covers(room.geom,b.geom)
      OR EXISTS(SELECT 1 FROM holes h WHERE ST_Intersects(h.geom,b.geom))
    UNION ALL SELECT 'CLEARANCE_RACK_CONFLICT',ARRAY[b.id,a.id],ARRAY[]::text[],b.side FROM bands b,racks a WHERE b.id<>a.id AND ST_Relate(b.geom,a.geom,'T********')
    UNION ALL SELECT 'CLEARANCE_OBSTACLE_CONFLICT',ARRAY[b.id],ARRAY[o.id],b.side FROM bands b,obstacles o WHERE ST_Intersects(b.geom,o.geom)
    ORDER BY code,rack_ids,obstacle_ids,side`,
    [
      JSON.stringify(layout.snapshot.view.boundaryLocalM),
      JSON.stringify(footprints),
      JSON.stringify(obstacles),
      JSON.stringify(bands),
    ],
  );
  const diagnostics = result.rows.map((row) => ({
    code: row.code,
    rackIds: row.rack_ids,
    obstacleIds: row.obstacle_ids,
    ...(row.side ? { side: row.side } : {}),
    severity: 'ERROR',
    message: {
      RACK_OUTSIDE_ROOM: 'Rack footprint leaves the room Polygon.',
      RACK_HOLE_CONFLICT: 'Rack touches or overlaps an interior hole.',
      RACK_PAIR_OVERLAP: 'Rack footprints overlap.',
      OBSTACLE_OUTSIDE_ROOM: 'Planning obstacle leaves the room or touches an interior hole.',
      RACK_OBSTACLE_CONFLICT: 'Rack touches or overlaps a planning obstacle.',
      CLEARANCE_OUTSIDE_ROOM: 'Maintenance band leaves the room or touches an interior hole.',
      CLEARANCE_RACK_CONFLICT: 'Another rack occupies the maintenance band.',
      CLEARANCE_OBSTACLE_CONFLICT: 'Maintenance band touches or overlaps a planning obstacle.',
    }[row.code],
  }));
  return {
    status: diagnostics.length
      ? 'ISSUES_FOUND'
      : !entries.length
        ? 'NOT_CHECKED'
        : constraints.obstacleCoverage === 'UNKNOWN' || !constraints.clearance
          ? 'INCOMPLETE'
          : 'CHECKED_SCOPE_CLEAR',
    scope: [
      'POLYGON_CONTAINMENT',
      'INTERIOR_HOLES',
      'RACK_PAIR_OVERLAP',
      'DECLARED_OBSTACLES',
      ...(constraints.clearance ? ['FRONT_REAR_CLEARANCE'] : []),
    ],
    obstaclesChecked: obstacles.length,
    clearanceBandsChecked: bands.length,
    clearance: constraints.clearance,
    planningSource: constraints.source,
    diagnostics,
    racksChecked: entries.length,
    pairsChecked: (entries.length * (entries.length - 1)) / 2,
    obstacleCoverage: constraints.obstacleCoverage,
    uncheckedRules: [
      ...(constraints.obstacleCoverage === 'UNKNOWN' ? ['UNRECORDED_OBSTACLES'] : []),
      ...(!constraints.clearance ? ['MAINTENANCE_CLEARANCE'] : []),
      'SIDE_CLEARANCE',
      'ACCESS_CONNECTIVITY',
      'AISLES',
      'EQUIPMENT',
      'CAPACITY',
      'ENGINEERING_ACCURACY',
    ],
  };
}

export function createRackLayoutService({ pool }) {
  return {
    async designOptions({ projectId, planId, body }) {
      scope(projectId, planId);
      bodyFields(body, ['contract_version','base_version','snapshot_id','demand']);
      if (!Number.isSafeInteger(body.base_version) || body.base_version < 1) throw new RackInputError('base_version','must be a positive integer');
      const demand = normalizeDesignDemand(body.demand), started = performance.now();
      const deadline = () => {
        if (performance.now()-started > 15000) throw new ApiError('RACK_PLANNING_TIMEOUT','Design search exceeded 15 seconds; no data changed.',{status:503});
      };
      return withTenant(pool,projectId,async client => {
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        const layout = await read(client,projectId,planId);
        if(layout.version!==body.base_version) throw new ApiError('RACK_VERSION_CONFLICT','Reload before designing.',{status:412});
        if(!layout.snapshot || layout.snapshot.snapshotId!==body.snapshot_id) throw conflict('RACK_SNAPSHOT_MISMATCH','Reload the fixed room input.');
        if(layout.sourceStatus.status!=='UNCHANGED') throw conflict('RACK_SOURCE_STALE','Review the changed Facility source before designing.');
        if(layout.placements.length || layout.equipment.devices.length || layout.equipment.rackLimits.length)
          throw conflict('RACK_DESIGN_REQUIRES_EMPTY_PLAN','Demand design starts from an empty saved plan. Create a new plan to preserve existing work.');
        const inputFingerprint=createHash('sha256').update(JSON.stringify({layout,demand})).digest('hex');
        const makeId=(kind,index)=>{
          const h=createHash('sha256').update(`${inputFingerprint}:${kind}:${index}`).digest('hex');
          return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
        };
        const generated=await generateDemandOptions({projectId,planId,demand,models:layout.models,boundary:layout.snapshot.view.boundaryLocalM,
          constraints:layout.constraints,roomBudget:layout.equipment.roomBudget,makeId,
          pickArrangement:async proposals=>{deadline();return pickRackPosition(client,layout,demand.constraints ?? layout.constraints,proposals,[]);}});
        const candidates=[];
        for(const candidate of generated) {
          deadline();
          const placements=candidate.placements.map(({projectId:_project,planId:_plan,...p})=>p);
          const entries=normalizeEditableLayout({placements,models:layout.models,projectId,planId});
          const report=await check(client,layout,entries,candidate.constraints);
          const equipmentReport=checkEquipment(candidate.equipment,candidate.placements,layout.models);
          const {equipment,constraints,...rest}=candidate;
          candidates.push({...rest,placements,optionId:`${candidate.algorithmId}:${inputFingerprint}`,report,equipmentReport,
            canStage:!candidate.unplaced.length && !report.diagnostics.length && !equipmentReport.diagnostics.length,
            body:{contract_version:1,snapshot_id:layout.snapshot.snapshotId,placements,constraints,equipment}});
        }
        deadline();
        return {contractVersion:1,projectId,planId,baseVersion:layout.version,snapshotId:layout.snapshot.snapshotId,
          facilityInput:layout.facilityInput,inputFingerprint,demand,limits:DEMAND_LIMITS,candidates,
          elapsedMs:Math.round(performance.now()-started),scope:'EMPTY_PLAN_DEMAND_DESIGN',persisted:false,validationState:'NOT_RUN'};
      },{readOnly:true}).catch(error=>{
        if(error.code==='57014')throw new ApiError('RACK_PLANNING_TIMEOUT','A design query reached its time limit. No data changed.',{status:503});
        throw error;
      });
    },
    async options({ projectId, planId, body }) {
      scope(projectId, planId);
      bodyFields(body, ['contract_version', 'base_version', 'snapshot_id', 'options']);
      if (!Number.isSafeInteger(body.base_version) || body.base_version < 1)
        throw new RackInputError('base_version', 'must be a positive integer');
      const options = normalizePlannerOptions(body.options);
      const started = performance.now();
      const deadline = () => {
        if (performance.now() - started > 15000)
          throw new ApiError('RACK_PLANNING_TIMEOUT', 'Planning exceeded 15 seconds. Try fewer unlocked racks or a coarser grid.', { status: 503 });
      };
      try { return await withTenant(pool, projectId, async client => {
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        const layout = await read(client, projectId, planId);
        if (layout.version !== body.base_version)
          throw new ApiError('RACK_VERSION_CONFLICT', 'Reload the saved plan before generating options.', { status: 412 });
        if (!layout.snapshot || layout.snapshot.snapshotId !== body.snapshot_id)
          throw conflict('RACK_SNAPSHOT_MISMATCH', 'Reload the fixed room input.');
        if (layout.sourceStatus.status !== 'UNCHANGED') throw conflict('RACK_SOURCE_STALE', 'Review the changed Facility source before planning.');
        const entries = normalizeEditableLayout({ placements: layout.placements, models: layout.models, projectId, planId });
        const placements = entries.map(e => e.placement);
        const constraints = normalizeSpatialConstraints(layout.constraints);
        const equipment = normalizeEquipment(layout.equipment, placements);
        const equipmentReport = checkEquipment(equipment, placements, layout.models);
        const baselineReport = await check(client, layout, entries, constraints);
        const inputFingerprint = createHash('sha256').update(JSON.stringify({ version: layout.version,
          facilityInput: layout.facilityInput, snapshot: layout.snapshot, models: layout.models, placements, constraints, equipment })).digest('hex');
        const generated = await generateRackOptions({ placements, models: layout.models,
          boundary: layout.snapshot.view.boundaryLocalM, constraints, options,
          pickPosition: async (proposals, placed) => {
            deadline();
            return pickRackPosition(client, layout, constraints, proposals, placed);
          },
        });
        const candidates = [];
        for (const candidate of generated) {
          deadline();
          const raw = candidate.placements.map(({projectId: _project, planId: _plan, ...p}) => p);
          const normalized = normalizeEditableLayout({ placements: raw, models: layout.models, projectId, planId });
          assertLockedRacksUnchanged(layout.placements, raw);
          const report = await check(client, layout, normalized, constraints);
          const nextEquipmentReport = checkEquipment(normalizeEquipment(equipment, raw), raw, layout.models);
          candidates.push({ ...candidate, placements: raw, optionId: `${candidate.algorithmId}:${inputFingerprint}`,
            report, equipmentReport: nextEquipmentReport,
            canStage: candidate.unplaced.length === 0 && report.diagnostics.length === 0 && nextEquipmentReport.diagnostics.length === 0,
            body: { contract_version: 1, snapshot_id: layout.snapshot.snapshotId, placements: raw, constraints, equipment } });
        }
        deadline();
        return { contractVersion: 1, projectId, planId, baseVersion: layout.version, snapshotId: layout.snapshot.snapshotId,
          facilityInput: layout.facilityInput, inputFingerprint, options, limits: PLANNER_LIMITS,
          baseline: { metrics: layoutMetrics(placements, layout.models, placements), report: baselineReport, equipmentReport },
          candidates, elapsedMs: Math.round(performance.now() - started),
          scope: 'EXISTING_RACK_RELOCATION', validationState: 'NOT_RUN', persisted: false };
      }, { readOnly: true }); }
      catch (error) {
        if (error.code === '57014') throw new ApiError('RACK_PLANNING_TIMEOUT', 'A planning query reached its time limit. No data was changed.', { status: 503 });
        throw error;
      }
    },
    async equipmentOptions({ projectId, planId, body }) {
      scope(projectId, planId);
      bodyFields(body, ['contract_version', 'base_version', 'snapshot_id']);
      if (!Number.isSafeInteger(body.base_version) || body.base_version < 1) throw new RackInputError('base_version', 'must be a positive integer');
      return withTenant(pool, projectId, async client => {
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        const layout = await read(client, projectId, planId);
        if (layout.version !== body.base_version) throw new ApiError('RACK_VERSION_CONFLICT', 'Reload before allocating equipment.', { status: 412 });
        if (!layout.snapshot || body.snapshot_id !== layout.snapshot.snapshotId) throw conflict('RACK_SNAPSHOT_MISMATCH', 'Reload the fixed room input.');
        if (layout.sourceStatus.status !== 'UNCHANGED') throw conflict('RACK_SOURCE_STALE', 'Review the changed Facility source before allocation.');
        const entries = normalizeEditableLayout({ placements: layout.placements, models: layout.models, projectId, planId });
        const placements = entries.map(e => e.placement);
        const constraints = normalizeSpatialConstraints(layout.constraints);
        const generated = allocateUnassignedEquipment({ equipment: layout.equipment, placements, models: layout.models });
        const report = await check(client, layout, entries, constraints);
        const inputFingerprint = createHash('sha256').update(JSON.stringify(layout)).digest('hex');
        const { equipment, baseline, ...candidate } = generated;
        return { contractVersion: 1, projectId, planId, baseVersion: layout.version, snapshotId: layout.snapshot.snapshotId,
          facilityInput: layout.facilityInput, inputFingerprint, persisted: false, validationState: 'NOT_RUN', scope: generated.scope,
          baseline: { equipmentReport: baseline }, candidates: [{ ...candidate,
            optionId: `${generated.algorithmId}:${inputFingerprint}`, placements: layout.placements, unplaced: [], report,
            canStage: generated.assignments.length > 0 && report.diagnostics.length === 0,
            body: { contract_version: 1, snapshot_id: layout.snapshot.snapshotId, placements: layout.placements, constraints, equipment } }] };
      }, { readOnly: true }).catch(error => {
        if (error.code === '57014') throw new ApiError('RACK_ALLOCATION_TIMEOUT', 'An allocation check reached its query time limit. No data was changed.', { status: 503 });
        throw error;
      });
    },
    async get({ projectId, planId }) {
      scope(projectId, planId);
      return withTenant(pool, projectId, (client) => read(client, projectId, planId), { readOnly: true });
    },
    async check({ projectId, planId, body }) {
      scope(projectId, planId);
      bodyFields(body, ['contract_version', 'snapshot_id', 'placements', 'constraints', 'equipment']);
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
            equipmentReport: checkEquipment(
              normalizeEquipment(equipmentInput(body, layout), entries.map(e => e.placement)),
              entries.map(e => e.placement), layout.models,
            ),
            report: await check(
              client,
              layout,
              entries,
              normalizeSpatialConstraints(
                Object.hasOwn(body, 'constraints') ? body.constraints : layout.constraints,
              ),
            ),
          };
        },
        { readOnly: true },
      );
    },
    async mutate({ projectId, planId, actorId, body, key, ifMatch, operation }) {
      scope(projectId, planId);
      bodyFields(
        body,
        operation === 'capture'
          ? ['contract_version']
          : ['contract_version', 'snapshot_id', 'placements', 'constraints', 'equipment'],
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
          // Omission preserves saved constraints for older clients. Explicit null is invalid.
          const constraints = normalizeSpatialConstraints(
            Object.hasOwn(body, 'constraints') ? body.constraints : layout.constraints,
          );
          const report = await check(client, layout, entries, constraints);
          const equipment = normalizeEquipment(equipmentInput(body, layout), placements);
          const equipmentReport = checkEquipment(equipment, placements, layout.models);
          if (equipmentReport.diagnostics.length)
            throw new ApiError('RACK_EQUIPMENT_CONFLICT', 'Resolve equipment and capacity conflicts before saving.', {
              status: 422, details: [{ equipmentReport }],
            });
          if (report.diagnostics.length)
            throw new ApiError('RACK_LAYOUT_CONFLICT', 'Resolve spatial conflicts before saving.', {
              status: 422,
              details: [{ report }],
            });
          await client.query(
            'UPDATE rack_plans SET spatial_constraints=$3,equipment=$4 WHERE project_id=$1 AND plan_id=$2',
            [projectId, planId, JSON.stringify(constraints), JSON.stringify(equipment)],
          );
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
