import { createHash, randomUUID } from 'node:crypto';
import { ApiError, errors } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { RackInputError, assessFacilityInput, createRackPlan, localizeRoomBoundary, MAX_ROOM_VIEW_POINTS } from '@ai-infra/rack';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = () => errors.notFound('The requested resource was not found.');
function fields(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RackInputError(field, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new RackInputError(`${field}.${key}`, 'unknown or server-owned field');
  }
}

function normalize(projectId, body) {
  fields(body, 'body', ['contract_version', 'name', 'scenario_id', 'facility_input']);
  if (body.contract_version !== 1) throw errors.unsupportedContractVersion(body.contract_version);
  fields(body.facility_input, 'facility_input', ['revision_id', 'container_id', 'revision_etag']);
  return createRackPlan({
    planId: randomUUID(), projectId, scenarioId: body.scenario_id, name: body.name,
    facilityInput: {
      projectId, scenarioId: body.scenario_id,
      revisionId: body.facility_input.revision_id,
      containerId: body.facility_input.container_id,
      revisionEtag: body.facility_input.revision_etag,
    },
  });
}

// One statement makes the stored pointer and current source one coherent read.
const READ = `SELECT p.*, r.lifecycle_state AS source_state, e.etag AS current_etag,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('rackId', q.rack_id, 'planId', q.plan_id, 'projectId', q.project_id,
    'modelId',q.model_id,'name',q.name,'xM',q.x_m,'yM',q.y_m,'rotationDeg',q.rotation_deg,'locked',q.locked) ORDER BY q.rack_id)
    FROM rack_placements q WHERE q.project_id=p.project_id AND q.plan_id=p.plan_id), '[]'::jsonb) AS placements
  FROM rack_plans p
  JOIN revisions r ON r.revision_id = p.source_revision_id AND r.project_id = p.project_id
  LEFT JOIN revision_etags e ON e.revision_id = p.source_revision_id AND e.project_id = p.project_id`;

function present(row) {
  const plan = createRackPlan({
    planId: row.plan_id, projectId: row.project_id, scenarioId: row.scenario_id, name: row.name,
    facilityInput: {
      projectId: row.project_id, scenarioId: row.scenario_id,
      revisionId: row.source_revision_id, containerId: row.source_container_id,
      revisionEtag: row.source_revision_etag,
    },
  });
  const reasons = [];
  if (row.source_state !== 'DRAFT') reasons.push('SOURCE_NOT_DRAFT');
  if (!row.current_etag) reasons.push('ETAG_MISSING');
  else if (assessFacilityInput(plan.facilityInput, {
    ...plan.facilityInput, revisionEtag: row.current_etag,
  }).status === 'STALE') reasons.push('ETAG_CHANGED');
  return {
    ...plan, version: row.version, placements: row.placements ?? [],
    createdAt: row.created_at.toISOString(), createdBy: row.created_by,
    facilityInputStatus: {
      status: !row.current_etag ? 'UNAVAILABLE' : reasons.length ? 'STALE' : 'UNCHANGED',
      reasons, currentRevisionEtag: row.current_etag ?? null, lifecycleState: row.source_state,
    },
  };
}

/** Internal service: callers must authorize rack.read/write before calling.
 * Supported room geometry is captured once; layout writes use the layout service.
 */
export function createRackPlanService({ pool }) {
  if (!pool) throw new Error('createRackPlanService requires a pool.');
  return {
    async roomView({ projectId, planId }) {
      if (typeof projectId !== 'string' || !UUID.test(projectId) || typeof planId !== 'string' || !UUID.test(planId)) throw missing();
      return withTenant(pool, projectId, client => readRackRoomView(client, { projectId, planId }), { readOnly: true });
    },
    async list({ projectId, query = {} }) {
      if (typeof projectId !== 'string' || !UUID.test(projectId)) throw missing();
      fields(query, 'query', ['scenario_id', 'revision_id', 'cursor', 'limit']);
      for (const key of ['scenario_id', 'revision_id', 'cursor']) {
        if (query[key] !== undefined && !UUID.test(query[key])) throw new RackInputError(key, 'must be a UUID');
      }
      if (query.limit !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit)) {
        throw new RackInputError('limit', 'must be an integer from 1 to 50');
      }
      const limit = Number(query.limit ?? 20);
      return withTenant(pool, projectId, async client => {
        // Cursor lookup remains inside the same tenant and filters. Compare in SQL
        // to retain PostgreSQL timestamp precision, including tied creation times.
        const result = await client.query(`${READ}
          WHERE p.project_id = $1
            AND ($2::uuid IS NULL OR p.scenario_id = $2)
            AND ($3::uuid IS NULL OR p.source_revision_id = $3)
            AND ($4::uuid IS NULL OR (p.created_at, p.plan_id) < (
              SELECT c.created_at, c.plan_id FROM rack_plans c
              WHERE c.project_id = $1 AND c.plan_id = $4
                AND ($2::uuid IS NULL OR c.scenario_id = $2)
                AND ($3::uuid IS NULL OR c.source_revision_id = $3)))
          ORDER BY p.created_at DESC, p.plan_id DESC LIMIT $5`,
        [projectId, query.scenario_id ?? null, query.revision_id ?? null, query.cursor ?? null, limit + 1]);
        const items = result.rows.slice(0, limit).map(present);
        return { items, nextCursor: result.rows.length > limit ? items.at(-1).planId : null };
      }, { readOnly: true });
    },
    async create({ projectId, actorId, body, creationKey }) {
      if (!actorId || !UUID.test(actorId)) throw errors.unauthorized();
      if (!creationKey) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'Creating a Rack plan requires Idempotency-Key.', { status: 428 });
      if (typeof creationKey !== 'string' || !UUID.test(creationKey)) {
        throw new RackInputError('Idempotency-Key', 'must be a UUID');
      }
      const plan = normalize(projectId, body);
      const { facilityInput: source } = plan;
      const key = creationKey.toLowerCase();
      const hash = createHash('sha256').update(JSON.stringify({
        name: plan.name, scenarioId: plan.scenarioId, facilityInput: source,
      })).digest('hex');
      return withTenant(pool, plan.projectId, async (client) => {
        // Serialize only retries sharing a project/key. The unique constraint is a backstop.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rack-plan:${plan.projectId}:${key}`]);
        const replay = await client.query(`${READ} WHERE p.project_id = $1 AND p.creation_key = $2`, [plan.projectId, key]);
        if (replay.rows[0]) {
          if (replay.rows[0].creation_hash !== hash) {
            throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'This key was already used for a different Rack plan request.', { status: 409 });
          }
          return { plan: present(replay.rows[0]), replayed: true };
        }
        // Lock the upstream token before checking source records.
        // A draft mutation cannot advance it between our comparison and insertion.
        const token = await client.query(`SELECT etag FROM revision_etags
          WHERE project_id = $1 AND revision_id = $2 FOR SHARE`, [plan.projectId, source.revisionId]);
        const upstream = await client.query(`SELECT r.lifecycle_state, c.kind
          FROM revisions r JOIN facility_containers c
            ON c.revision_id = r.revision_id AND c.project_id = r.project_id AND c.scenario_id = r.scenario_id
          WHERE r.project_id = $1 AND r.scenario_id = $2 AND r.revision_id = $3 AND c.container_id = $4
          FOR SHARE OF r, c`, [plan.projectId, plan.scenarioId, source.revisionId, source.containerId]);
        if (!upstream.rows[0]) throw missing();
        if (upstream.rows[0].kind !== 'HALL') {
          throw new ApiError('RACK_ROOM_REQUIRED', 'The first Rack plan slice supports HALL containers only.', { status: 409 });
        }
        if (upstream.rows[0].lifecycle_state !== 'DRAFT') {
          throw new ApiError('RACK_SOURCE_STATE_UNSUPPORTED', 'New plans currently require a draft Facility source.', { status: 409 });
        }
        if (!token.rows[0]) throw new ApiError('RACK_SOURCE_ETAG_MISSING', 'The Facility source has no version token.', { status: 409 });
        if (token.rows[0].etag !== source.revisionEtag) {
          throw new ApiError('RACK_SOURCE_STALE', 'The Facility source changed; read it again before creating a plan.', { status: 409 });
        }
        await client.query(`INSERT INTO rack_plans
          (plan_id, project_id, scenario_id, source_revision_id, source_container_id,
           source_revision_etag, name, creation_key, creation_hash, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
          plan.planId, plan.projectId, plan.scenarioId, source.revisionId, source.containerId,
          source.revisionEtag, plan.name, key, hash, actorId,
        ]);
        // New plans capture supported geometry in the same creation transaction.
        // Legacy/missing-geometry plans retain the explicit capture path.
        const room = await readRackRoomView(client, { projectId: plan.projectId, planId: plan.planId });
        if (room.status === 'AVAILABLE') {
          await client.query('INSERT INTO rack_room_snapshots(plan_id,project_id,document,created_by) VALUES($1,$2,$3,$4)',
            [plan.planId, plan.projectId, JSON.stringify({ room: room.room, view: room.view, sourceGeometry: room.sourceGeometry, facilityInput: room.facilityInput }), actorId]);
        }
        const stored = await client.query(`${READ} WHERE p.project_id = $1 AND p.plan_id = $2`, [plan.projectId, plan.planId]);
        return { plan: present(stored.rows[0]), replayed: false };
      });
    },
    async get({ projectId, planId }) {
      if (typeof projectId !== 'string' || !UUID.test(projectId) || typeof planId !== 'string' || !UUID.test(planId)) throw missing();
      return withTenant(pool, projectId, async (client) => {
        const result = await client.query(`${READ} WHERE p.project_id = $1 AND p.plan_id = $2`, [projectId, planId]);
        if (!result.rows[0]) throw missing();
        return present(result.rows[0]);
      }, { readOnly: true });
    },
  };
}

// Internal adapter: caller authorizes and supplies the transaction/project scope.
export async function readRackRoomView(client, { projectId, planId }) {
  // One statement pins plan, source token and geometry to the same MVCC
  // snapshot. Bound candidates/vertices before serializing coordinates.
  const result = await client.query(`SELECT p.*, r.lifecycle_state AS source_state,
    e.etag AS current_etag, c.name AS room_name,
    (SELECT jsonb_agg(boundary) FROM (
      SELECT g.geometry_id, g.role, g.projected_crs,
        ST_SRID(g.projected_geometry) AS srid, ST_NDims(g.projected_geometry) AS dimensions,
        CASE WHEN ST_NPoints(g.projected_geometry) <= $3 THEN ST_IsValid(g.projected_geometry) ELSE false END AS valid,
        ST_NPoints(g.projected_geometry) AS point_count,
        CASE WHEN ST_NPoints(g.projected_geometry) <= $3
          THEN ST_AsGeoJSON(g.projected_geometry, 15, 0)::jsonb ELSE NULL END AS geometry,
        g.provenance->>'source_ref' AS source_ref,
        COALESCE(t.review_state::text, 'NOT_RECORDED') AS transform_review_state
      FROM geometry_records g LEFT JOIN spatial_transforms t
        ON t.project_id=g.project_id AND t.transform_id=g.parent_transform_id
      WHERE g.project_id=p.project_id AND g.scenario_id=p.scenario_id
        AND g.revision_id=p.source_revision_id AND g.entity_id=p.source_container_id
        AND g.entity_type='HALL' AND g.role IN ('FLOOR_BOUNDARY','ROOM_BOUNDARY')
      ORDER BY g.geometry_id LIMIT 2
    ) boundary) AS boundaries
    FROM rack_plans p
    JOIN revisions r ON r.project_id=p.project_id AND r.revision_id=p.source_revision_id
    JOIN facility_containers c ON c.project_id=p.project_id AND c.revision_id=p.source_revision_id
      AND c.container_id=p.source_container_id AND c.scenario_id=p.scenario_id AND c.kind='HALL'
    LEFT JOIN revision_etags e ON e.project_id=p.project_id AND e.revision_id=p.source_revision_id
    WHERE p.project_id=$1 AND p.plan_id=$2`, [projectId, planId, MAX_ROOM_VIEW_POINTS]);
  const row = result.rows[0];
  if (!row) throw missing();
  const plan = present(row);
  const base = { contractVersion: 1, planId: plan.planId, planVersion: plan.version,
    facilityInput: plan.facilityInput, facilityInputStatus: plan.facilityInputStatus,
    room: { containerId: plan.facilityInput.containerId, name: row.room_name }, view: null, sourceGeometry: null };
  if (plan.facilityInputStatus.status !== 'UNCHANGED') {
    return { ...base, status: 'BLOCKED', reason: 'FACILITY_SOURCE_CHANGED' };
  }
  const boundaries = row.boundaries ?? [];
  if (boundaries.length === 0) return { ...base, status: 'UNAVAILABLE', reason: 'BOUNDARY_MISSING' };
  if (boundaries.length > 1) return { ...base, status: 'UNSUPPORTED', reason: 'BOUNDARY_AMBIGUOUS' };
  const g = boundaries[0];
  const sourceGeometry = { geometryId: g.geometry_id, role: g.role, crs: g.projected_crs, srid: g.srid,
    provenanceReference: g.source_ref, transformReviewState: g.transform_review_state };
  const localized = g.point_count > MAX_ROOM_VIEW_POINTS
    ? { status: 'UNSUPPORTED', reason: 'GEOMETRY_TOO_COMPLEX', view: null }
    : localizeRoomBoundary({ geometry: g.geometry, crs: g.projected_crs, srid: g.srid, valid: g.valid, dimensions: g.dimensions });
  return { ...base, sourceGeometry, ...localized };
}
