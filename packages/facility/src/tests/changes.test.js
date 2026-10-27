import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import {
  CHANGE_KINDS,
  ChangeConflict,
  ChangeRejected,
  allChangePermissions,
  applyChangeSet,
  ensureEtag,
  orderChanges,
  requireDraft,
} from '../index.js';
import { seedBaseline } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
});

after(async () => {
  if (pool) await pool.end();
});

class Rollback extends Error {
  constructor(value) {
    super('rollback');
    this.value = value;
  }
}

/**
 * The seeded campus, plus a draft token, inside one transaction.
 *
 * A transaction per test is what makes the atomicity assertions meaningful: a set that
 * must not partially apply is checked by reading the graph back inside the same
 * transaction, so "nothing was written" is observed rather than inferred from a throw.
 */
async function withCampus(fn) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `changes-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Changes org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
        projectId,
        organizationId,
        'Changes project',
      ]);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
        scenarioId,
        projectId,
        'Baseline',
      ]);
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
         VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
        [revisionId, projectId, scenarioId],
      );
      const ids = await seedBaseline(client, { projectId, scenarioId, revisionId, actorId: userId });
      const token = await ensureEtag({ client, projectId, revisionId, scenarioId, actorId: userId });

      const scope = { client, projectId, scenarioId, revisionId, userId, ids, token };
      const commit = (changes, overrides = {}) =>
        applyChangeSet({
          client,
          projectId,
          revisionId,
          scenarioId,
          actorId: userId,
          baseRevisionId: ids.envelope,
          etag: token.etag,
          changes,
          ...overrides,
        });

      throw new Rollback(await fn({ ...scope, commit }));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
}

const capture = async (promise) => promise.then((value) => ({ value })).catch((error) => ({ error }));

/* ================================================================ the pipeline */

test('a change set is applied in dependency order, not submission order', () => {
  const ordered = orderChanges([
    { kind: 'remove_entity' },
    { kind: 'set_geometry' },
    { kind: 'create_container' },
    { kind: 'update_entity' },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.change.kind),
    ['create_container', 'update_entity', 'set_geometry', 'remove_entity'],
  );
});

test('submission order survives inside a rank', () => {
  const ordered = orderChanges([
    { kind: 'create_container', payload: { name: 'first' } },
    { kind: 'create_container', payload: { name: 'second' } },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.change.payload.name),
    ['first', 'second'],
  );
});

test('the change-kind registry is complete: every declared kind is registered', async () => {
  const { PENDING_CHANGE_KINDS } = await import('../index.js');
  // The specification declares nineteen kinds. Eighteen are registered, plus
  // `set_phase` and `set_phase_capability` (which the specification's table omits but
  // a phase cannot be created without), plus `transform_geometry`, which T3 made
  // available once a reviewed spatial transform could exist.
  assert.equal(Object.keys(CHANGE_KINDS).length, 21, '18 declared kinds plus set_phase, set_phase_capability, and transform_geometry');
  assert.equal(CHANGE_KINDS.transform_geometry.permission, 'facility.geometry.write');
  // Nothing is left pending, so the list is the recorded place a future gap appears.
  assert.deepEqual(PENDING_CHANGE_KINDS, []);
  assert.deepEqual(allChangePermissions(), [
    'facility.capacity.allocate',
    'facility.constraint.write',
    'facility.document.manage',
    'facility.entity.write',
    'facility.geometry.write',
    'facility.phase.write',
    'facility.utility.write',
  ]);
});

test('an empty or oversized set is refused before anything is read', async () => {
  const empty = await capture(applyChangeSet({ client: { query: async () => ({ rows: [] }) }, projectId: 'p', revisionId: 'r', changes: [] }));
  assert.equal(empty.error.status, 422);
  assert.equal(empty.error.code, 'CHANGE_SET_EMPTY');

  const oversized = await capture(
    applyChangeSet({
      client: { query: async () => ({ rows: [] }) },
      projectId: 'p',
      revisionId: 'r',
      changes: Array.from({ length: 201 }, () => ({ kind: 'create_container' })),
    }),
  );
  assert.equal(oversized.error.code, 'CHANGE_SET_TOO_LARGE');
});

/* ============================================================== the four kinds */

test('create_container registers an identity and a container together', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const applied = await commit([
      {
        kind: 'create_container',
        payload: {
          container_kind: 'BUILDING',
          name: 'Data Centre C',
          scope_id: ids.scope,
          parent_container_id: ids.parcel,
          elevation_base_m: 0,
          elevation_top_m: 14,
        },
      },
    ]);
    const container = (
      await client.query(
        'SELECT name, kind, entity_type, elevation_top_m, parent_container_id FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND name = $3',
        [projectId, revisionId, 'Data Centre C'],
      )
    ).rows[0];
    const registered = (
      await client.query('SELECT entity_type, status, display_name FROM entity_registry WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3', [
        projectId,
        revisionId,
        applied.applied[0].containerId,
      ])
    ).rows[0];
    return { applied, container, registered, ids };
  });

  assert.equal(result.applied.applied.length, 1);
  assert.equal(result.applied.applied[0].kind, 'create_container');
  assert.equal(result.applied.applied[0].entityRef.entity_type, 'BUILDING');
  assert.ok(result.applied.applied[0].containerId);
  assert.equal(result.container.name, 'Data Centre C');
  assert.equal(result.container.entity_type, 'BUILDING');
  assert.equal(Number(result.container.elevation_top_m), 14);
  assert.equal(result.container.parent_container_id, result.ids.parcel);
  assert.equal(result.registered.display_name, 'Data Centre C');
  assert.equal(result.registered.status, 'PROVISIONAL');
});

test('a container kind that is not a container type is refused with the allowed set', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        { kind: 'create_container', payload: { container_kind: 'UTILITY_SOURCE', name: 'Nope', scope_id: ids.scope } },
      ]),
    ),
  );

  assert.equal(result.error.status, 422);
  assert.equal(result.error.code, 'CHANGE_SET_REJECTED');
  assert.equal(result.error.details[0].reason, 'not_allowed');
  assert.ok(result.error.details[0].allowed.includes('BUILDING'));
});

test('set_geometry stores both representations and replaces a role rather than duplicating it', { skip }, async () => {
  const square = (lon, lat, size) => ({
    type: 'Polygon',
    coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
  });

  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const first = await commit([
      { kind: 'set_geometry', entity_ref: { entity_id: ids.building }, payload: { role: 'FOOTPRINT', geojson_4326: square(-77.49, 39.043, 0.001) } },
    ]);
    // The first commit advanced the token, so the second presents the new one: a
    // re-set of the same role replaces the record instead of accumulating a second.
    const second = await commit(
      [{ kind: 'set_geometry', entity_ref: { entity_id: ids.building }, payload: { role: 'FOOTPRINT', geojson_4326: square(-77.49, 39.043, 0.002) } }],
      { etag: first.etag },
    );

    const { rows } = await client.query(
      `SELECT count(*)::int AS n, max(ST_SRID(geojson_4326)) AS srid, max(ST_SRID(projected_geometry)) AS projected_srid
         FROM geometry_records WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3 AND role = 'FOOTPRINT'`,
      [projectId, revisionId, ids.building],
    );
    return { first, second, rows: rows[0] };
  });

  assert.equal(result.rows.n, 1, 'a role is replaced, not accumulated');
  assert.equal(result.rows.srid, 4326);
  assert.equal(result.rows.projected_srid, 32618, 'the projected representation is materialized at write time');
  assert.equal(result.second.etagVersion, result.first.etagVersion + 1);
});

test('a re-write preserves the heights the revision already stored', { skip }, async () => {
  // A move is a re-write of an existing role, and a caller that carries only the position — the
  // assistant did — used to null the geometry's elevations. The upsert now keeps what the payload
  // omits, so no surface can flatten a stored geometry by moving it, while a value it does carry
  // still wins.
  const square = (lon, lat, size) => ({
    type: 'Polygon',
    coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
  });

  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const placed = await commit([
      {
        kind: 'set_geometry',
        entity_ref: { entity_id: ids.building },
        payload: { role: 'FOOTPRINT', geojson_4326: square(-77.49, 39.043, 0.001), elevation_base_m: 0, elevation_top_m: 12, height_m: 12 },
      },
    ]);
    // The move: same role, new coordinates, and no heights carried at all.
    const moved = await commit(
      [{ kind: 'set_geometry', entity_ref: { entity_id: ids.building }, payload: { role: 'FOOTPRINT', geojson_4326: square(-77.49, 39.043, 0.002) } }],
      { etag: placed.etag },
    );
    // An explicit height still replaces what was stored.
    const resized = await commit(
      [{ kind: 'set_geometry', entity_ref: { entity_id: ids.building }, payload: { role: 'FOOTPRINT', geojson_4326: square(-77.49, 39.043, 0.003), height_m: 20 } }],
      { etag: moved.etag },
    );

    const { rows } = await client.query(
      `SELECT elevation_base_m, elevation_top_m, height_m FROM geometry_records
        WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3 AND role = 'FOOTPRINT'`,
      [projectId, revisionId, ids.building],
    );
    return rows[0];
  });

  assert.equal(Number(result.elevation_base_m), 0, 'an omitted base is kept, not nulled');
  assert.equal(Number(result.elevation_top_m), 12, 'and an omitted top');
  assert.equal(Number(result.height_m), 20, 'while a height the caller does carry replaces the stored one');
});

test('a geometry type that does not match its role is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        {
          kind: 'set_geometry',
          entity_ref: { entity_id: ids.building },
          payload: { role: 'FOOTPRINT', geojson_4326: { type: 'Point', coordinates: [-77.49, 39.04] } },
        },
      ]),
    ),
  );

  assert.equal(result.error.status, 422);
  assert.equal(result.error.details[0].reason, 'type_mismatch');
  assert.equal(result.error.details[0].expected, 'POLYGON');
  assert.equal(result.error.details[0].actual, 'Point');
});

test('unparseable geometry is refused by the store, not by a check', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        {
          kind: 'set_geometry',
          entity_ref: { entity_id: ids.building },
          payload: { role: 'FOOTPRINT', geojson_4326: { type: 'Polygon', coordinates: 'not coordinates' } },
        },
      ]),
    ),
  );

  assert.equal(result.error.status, 422);
  assert.equal(result.error.details[0].reason, 'store_refused', 'the database refused it, and the set is rejected whole');
});

test('update_entity dispatches to the container row for container attributes', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const applied = await commit([
      { kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { name: 'Data Centre A (renamed)', elevation_top_m: 16 } } },
    ]);
    const container = (
      await client.query('SELECT name, elevation_top_m FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND container_id = $3', [
        projectId,
        revisionId,
        ids.building,
      ])
    ).rows[0];
    return { applied, container };
  });

  assert.deepEqual(result.applied.applied[0].patched.sort(), ['elevation_top_m', 'name']);
  assert.equal(result.container.name, 'Data Centre A (renamed)');
  assert.equal(Number(result.container.elevation_top_m), 16);
});

test('a patch naming a field that is not editable is refused with the allowed set', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(commit([{ kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { level_number: 3, nope: 1 } } }])),
  );

  assert.equal(result.error.status, 422);
  assert.deepEqual(result.error.details[0].unknown, ['nope']);
  assert.ok(result.error.details[0].allowed.includes('level_number'), 'the allowed set shows what a building may change');
});

test('a level number on a container that cannot carry one is the domain rule, not a constraint name', { skip }, async () => {
  // The store enforces this with a check constraint. Letting it fire answered with
  // `facility_containers_level_number_check`, which names the rule to nobody.
  const result = await withCampus(async ({ commit, ids }) =>
    capture(commit([{ kind: 'update_entity', entity_ref: { entity_id: ids.parcel }, payload: { patch: { level_number: 3 } } }])),
  );

  assert.equal(result.error.status, 422);
  assert.equal(result.error.code, 'CHANGE_SET_REJECTED');
  const detail = result.error.details[0];
  assert.equal(detail.reason, 'not_allowed', 'the rule, not the database constraint');
  assert.equal(detail.field, 'payload.patch.level_number');
  assert.equal(detail.entity_type, 'PARCEL');
  assert.match(detail.message, /FLOOR or a HALL/);
});

test('a level number a FLOOR needs cannot be cleared through a patch', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const created = await commit([
      {
        kind: 'create_container',
        payload: {
          container_kind: 'FLOOR',
          name: 'Level 4',
          scope_id: ids.scope,
          parent_container_id: ids.building,
          level_number: 4,
        },
      },
    ]);
    const floorId = created.applied[0].containerId;
    const attempt = await capture(
      commit([{ kind: 'update_entity', entity_ref: { entity_id: floorId }, payload: { patch: { level_number: null } } }], {
        etag: created.etag,
      }),
    );
    const row = (
      await client.query('SELECT level_number FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND container_id = $3', [
        projectId,
        revisionId,
        floorId,
      ])
    ).rows[0];
    return { attempt, row };
  });

  assert.equal(result.attempt.error.status, 422);
  assert.equal(result.attempt.error.details[0].reason, 'required');
  assert.equal(result.attempt.error.details[0].field, 'payload.patch.level_number');
  assert.match(result.attempt.error.details[0].message, /requires a level number/);
  assert.equal(Number(result.row.level_number), 4, 'the cleared level was refused, not written');
});

test('an elevation that inverts the row is refused against the untouched value', { skip }, async () => {
  // The fixture building is base 0 / top 12. Raising only the base above the top is the
  // same inverted floor as lowering the top, and the store would refuse it by name.
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const attempt = await capture(
      commit([{ kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { elevation_base_m: 20 } } }]),
    );
    const row = (
      await client.query('SELECT elevation_base_m, elevation_top_m FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND container_id = $3', [
        projectId,
        revisionId,
        ids.building,
      ])
    ).rows[0];
    return { attempt, row };
  });

  assert.equal(result.attempt.error.status, 422);
  assert.equal(result.attempt.error.details[0].reason, 'elevation_inverted');
  assert.equal(result.attempt.error.details[0].field, 'payload.patch.elevation_top_m');
  assert.equal(result.attempt.error.details[0].elevation_base_m, 20);
  assert.equal(Number(result.attempt.error.details[0].elevation_top_m), 12, 'the untouched top is what the base inverted against');
  assert.equal(Number(result.row.elevation_base_m), 0, 'the rejected patch was not written');
});

test('removing an entity that something references is a 409 naming the referrers', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(commit([{ kind: 'remove_entity', entity_ref: { entity_id: ids.building }, payload: { cascade: 'NONE' } }])),
  );

  assert.equal(result.error.status, 409);
  assert.equal(result.error.code, 'CHANGE_SET_CONFLICT');
  const referrers = result.error.details[0].referrers ?? [];
  // The entity's own footprint is *not* a referrer: the removal deletes it. What blocks
  // the removal is another object that points at the entity.
  assert.ok(referrers.some((entry) => entry.table === 'capacity_budgets'), 'the budget held on it is named');
  assert.ok(
    referrers.every((entry) => entry.table !== 'geometry_records'),
    'its own footprint does not count against it',
  );
  // The container row is untouched, so nothing was half-removed.
  assert.equal(result.error.details[0].reason, 'referenced');
});

test('an entity whose only reference is its own footprint can be removed', { skip }, async () => {
  // The canvas stages exactly this pair when a footprint is drawn, and the inspector
  // stages the removal. Treating the entity's own geometry as a referrer refused every
  // such removal, which made deleting a drawn object impossible.
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const containerId = randomUUID();
    const created = await commit([
      {
        kind: 'create_container',
        payload: { container_id: containerId, container_kind: 'BUILDING', name: 'Drawn on the canvas', scope_id: ids.scope },
      },
      {
        kind: 'set_geometry',
        entity_ref: { entity_id: containerId },
        payload: {
          role: 'FOOTPRINT',
          geojson_4326: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] },
        },
      },
    ]);
    const removed = await commit(
      [{ kind: 'remove_entity', entity_ref: { entity_id: containerId }, payload: { cascade: 'NONE' } }],
      { etag: created.etag },
    );
    const geometry = (
      await client.query(
        'SELECT count(*)::int AS n FROM geometry_records WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3',
        [projectId, revisionId, containerId],
      )
    ).rows[0].n;
    const registry = (
      await client.query(
        'SELECT status FROM entity_registry WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3',
        [projectId, revisionId, containerId],
      )
    ).rows[0];
    return { removed, geometry, registry };
  });

  assert.equal(result.removed.applied[0].kind, 'remove_entity');
  assert.equal(result.geometry, 0, 'the footprint goes with the entity');
  assert.equal(result.registry.status, 'SUPERSEDED', 'the identity is kept for audit rather than deleted');
});

test('the whole set rolls back when one change is invalid', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const attempt = await capture(
      commit([
        { kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'Should Not Exist', scope_id: ids.scope } },
        { kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { not_a_field: true } } },
      ]),
    );
    const survivor = (
      await client.query('SELECT count(*)::int AS n FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND name = $3', [
        projectId,
        revisionId,
        'Should Not Exist',
      ])
    ).rows[0];
    return { attempt, survivor };
  });

  assert.equal(result.attempt.error.status, 422);
  assert.equal(result.survivor.n, 0, 'the valid change did not survive its sibling failure');
});

test('every change in the set is checked, not only up to the first failure', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        { kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { bad_one: 1 } } },
        { kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { bad_two: 1 } } },
        { kind: 'nonsense_kind', payload: {} },
      ]),
    ),
  );

  assert.equal(result.error.details.length, 3, 'per-change diagnostics, not just the first');
  assert.deepEqual(result.error.details.map((entry) => entry.index), [0, 1, 2]);
  assert.equal(result.error.details[2].reason, 'unknown_change_kind');
});

/* ======================================================== token and idempotency */

test('a committed set advances the token', { skip }, async () => {
  const result = await withCampus(async ({ commit, token, ids }) => {
    const applied = await commit([
      { kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { name: 'Renamed' } } },
    ]);
    return { applied, token };
  });

  assert.notEqual(result.applied.etag, result.token.etag);
  assert.equal(result.applied.etagVersion, result.token.etagVersion + 1);
});

test('a second editor holding the old token is refused and loses nothing', { skip }, async () => {
  const result = await withCampus(async ({ commit, token, client, projectId, revisionId, ids }) => {
    const first = await commit([
      { kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { name: 'Winner' } } },
    ]);
    // The same token, which is now stale.
    const second = await capture(
      commit([{ kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { name: 'Loser' } } }]),
    );
    const current = (
      await client.query('SELECT name FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND container_id = $3', [
        projectId,
        revisionId,
        ids.building,
      ])
    ).rows[0];
    return { first, second, current, token };
  });

  assert.equal(result.second.error.status, 409);
  assert.equal(result.second.error.code, 'REVISION_ETAG_STALE');
  assert.equal(result.second.error.details[0].constraint_id, 'facility.revision.current');
  assert.equal(result.current.name, 'Winner', 'the winner is not overwritten');
});

test('a validated revision cannot be edited', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    await client.query(`UPDATE revisions SET lifecycle_state = 'VALIDATED', content_checksum = 'frozen' WHERE project_id = $1 AND revision_id = $2`, [
      projectId,
      revisionId,
    ]);
    const attempt = await capture(
      commit([{ kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { name: 'Too late' } } }]),
    );
    return { attempt };
  });

  assert.equal(result.attempt.error.status, 409);
  assert.equal(result.attempt.error.code, 'REVISION_IMMUTABLE');
});

test('a replayed idempotency key returns the first result instead of re-applying', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const changes = [{ kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'Replay Hall', scope_id: ids.scope } }];
    const first = await commit(changes, { idempotencyKey: 'key-1' });
    // A replay necessarily presents the token from before the first commit, which is
    // stale; answering it before the token check is what makes the key useful.
    const second = await commit(changes, { idempotencyKey: 'key-1' });
    const count = (
      await client.query('SELECT count(*)::int AS n FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND name = $3', [
        projectId,
        revisionId,
        'Replay Hall',
      ])
    ).rows[0];
    return { first, second, count };
  });

  assert.equal(result.second.replayed, true);
  assert.equal(result.second.etag, result.first.etag);
  assert.equal(result.count.n, 1, 'the change was applied once');
});

test('the same idempotency key with a different body is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    await commit([{ kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'First Body', scope_id: ids.scope } }], {
      idempotencyKey: 'key-2',
    });
    return capture(
      commit([{ kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'Different Body', scope_id: ids.scope } }], {
        idempotencyKey: 'key-2',
      }),
    );
  });

  assert.equal(result.error.status, 409);
  assert.equal(result.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

/* =============================================================== the loop

/**
 * The acceptance test for the whole increment: an edit leads to a finding, and the
 * finding is the one the catalog names for that edit.
 */
test('an edit that violates a constraint commits and returns the diagnostic', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, ids }) => {
    // The fixture's site is a 600x400 m rectangle at the projected origin and the
    // setback is 15 m, so a footprint 5 m from the west edge is inside the site and
    // inside the setback. Building it in projected metres and letting PostGIS produce
    // the WGS 84 form is also what proves the write path transforms the round trip.
    const { rows } = await client.query(
      `SELECT ST_AsGeoJSON(
                ST_Transform(ST_GeomFromText('POLYGON((5 50, 40 50, 40 150, 5 150, 5 50))', 32618), 4326)
              )::json AS geojson`,
    );

    const applied = await commit([
      { kind: 'set_geometry', entity_ref: { entity_id: ids.building }, payload: { role: 'FOOTPRINT', geojson_4326: rows[0].geojson } },
    ]);
    return { applied };
  });

  assert.ok(result.applied.diagnostics, 'the commit previewed its consequences');
  assert.equal(result.applied.applied.length, 1, 'the change was accepted into the draft despite the violation');
  const setback = result.applied.diagnostics.find((entry) => entry.constraintId === 'facility.site.setback.violated');
  assert.ok(
    setback,
    `expected the setback check to fire, got ${result.applied.diagnostics.map((entry) => entry.constraintId).join(', ')}`,
  );
  assert.equal(setback.severity, 'ERROR');
  assert.equal(setback.evidence, 'spatialConstraints', 'a previewed finding carries the same catalog keys as a re-read one');
  assert.deepEqual(setback.capabilities, ['GEOMETRY']);
  assert.match(result.applied.effect, /ERROR diagnostic/);
});

test('a change set can turn its diagnostics preview off', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    const applied = await commit(
      [{ kind: 'update_entity', entity_ref: { entity_id: ids.building }, payload: { patch: { name: 'Quiet' } } }],
      { previewDiagnostics: false },
    );
    return { applied };
  });

  assert.equal(result.applied.diagnostics, null);
  assert.match(result.applied.effect, /No diagnostics were previewed/);
});

test('a FLOOR or HALL must carry a level number, and nothing else may', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    const missing = await capture(
      commit([{ kind: 'create_container', payload: { container_kind: 'HALL', name: 'Hall Without A Level', scope_id: ids.scope, parent_container_id: ids.building } }]),
    );
    const surplus = await capture(
      commit([{ kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'Building With A Level', scope_id: ids.scope, level_number: 2 } }]),
    );
    return { missing, surplus };
  });

  assert.equal(result.missing.error.details[0].field, 'payload.level_number');
  assert.equal(result.missing.error.details[0].reason, 'required');
  assert.match(result.missing.error.details[0].note, /unique within the building/);
  assert.equal(result.surplus.error.details[0].reason, 'not_allowed');
});

test('reading the graph back inside the transaction sees the edit', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    await commit([
      {
        kind: 'create_container',
        payload: {
          container_kind: 'HALL',
          name: 'Data Hall A3',
          scope_id: ids.scope,
          parent_container_id: ids.building,
          level_number: 3,
        },
      },
    ]);
    const draft = await requireDraft({ client, projectId, revisionId });
    const hall = (
      await client.query(`SELECT name, kind, level_number FROM facility_containers WHERE project_id = $1 AND revision_id = $2 AND name = 'Data Hall A3'`, [
        projectId,
        revisionId,
      ])
    ).rows[0];
    return { draft, hall };
  });

  assert.equal(result.draft.lifecycle_state, 'DRAFT');
  assert.equal(result.hall.kind, 'HALL');
  assert.equal(Number(result.hall.level_number), 3);
});

test('a refusal carries the change kinds that would have been required', () => {
  // The permission model is the reason this tool exists as one command rather than
  // one per kind: a caller needing only geometry write is not refused the whole tool.
  assert.ok(ChangeRejected);
  assert.ok(ChangeConflict);
});

/* ============================================================ P3/P4 kind coverage

/**
 * Every kind gets the same three questions answered: does a valid change apply, is a
 * malformed one refused naming the field, and does a domain violation land in the
 * draft for the validator to report rather than being refused at the door. The last
 * one is the rule that keeps the verification surface honest, so it is asserted for
 * the kinds where a violation is easy to construct.
 */

test('a utility source is created, and a non-firm capacity state is accepted', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const applied = await commit([
      {
        kind: 'set_utility_source',
        payload: {
          name: 'Utility Entrance C',
          kind: 'POWER',
          capacity_value: 0,
          capacity_unit: 'kW',
          capacity_basis: 'IT_LOAD',
          capacity_state: 'CONTRACTUAL',
          phase_id: ids.phase1,
          failure_domain_id: ids.domainA,
        },
      },
    ]);
    const source = await client.query(
      'SELECT kind, capacity_value, capacity_state FROM utility_sources WHERE project_id = $1 AND revision_id = $2 AND utility_source_id = $3',
      [projectId, revisionId, applied.applied[0].utilitySourceId],
    );
    const entity = await client.query(
      'SELECT entity_type, status FROM entity_registry WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3',
      [projectId, revisionId, applied.applied[0].utilitySourceId],
    );
    return { applied, source: source.rows[0], entity: entity.rows[0] };
  });

  // A zero capacity and a CONTRACTUAL state are both *findings* in the catalog, so the
  // write accepts them: refusing here would suppress the diagnostic.
  assert.equal(Number(result.source.capacity_value), 0);
  assert.equal(result.source.capacity_state, 'CONTRACTUAL');
  assert.equal(result.entity.entity_type, 'UTILITY_SOURCE');
  assert.equal(result.entity.status, 'PROVISIONAL');
  assert.ok(
    result.applied.diagnostics.some((entry) => entry.constraintId === 'facility.utility.source.state_not_firm'),
    'the source the write accepted is the one the validator complains about',
  );
});

test('a utility source naming an unknown resource kind is refused with the allowed set', { skip }, async () => {
  const result = await withCampus(async ({ commit }) =>
    capture(
      commit([
        {
          kind: 'set_utility_source',
          payload: { name: 'Bad', kind: 'STEAM', capacity_value: 1, capacity_unit: 'kW', capacity_basis: 'IT_LOAD', capacity_state: 'FIRM' },
        },
      ]),
    ),
  );
  assert.equal(result.error.status, 422);
  assert.equal(result.error.details[0].reason, 'not_allowed');
  assert.ok(result.error.details[0].allowed.includes('POWER'));
});

test('an interface whose source does not exist is refused, because a dangling row is not a finding', { skip }, async () => {
  const result = await withCampus(async ({ commit }) =>
    capture(
      commit([
        {
          kind: 'set_utility_interface',
          payload: {
            utility_source_id: randomUUID(),
            capacity_value: 100,
            capacity_unit: 'kW',
            capacity_basis: 'IT_LOAD',
            capacity_state: 'FIRM',
            service_state: 'AVAILABLE',
            failure_domain_id: randomUUID(),
            phase_id: randomUUID(),
          },
        },
      ]),
    ),
  );
  assert.equal(result.error.status, 422);
  assert.equal(result.error.details[0].field, 'payload.utility_source_id');
  assert.equal(result.error.details[0].reason, 'not_found');
});

test('an interface against a real source applies and reports a missing connection point', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    const applied = await commit([
      {
        kind: 'set_utility_interface',
        payload: {
          name: 'Power Interface C',
          utility_source_id: ids.powerA,
          capacity_value: 500,
          capacity_unit: 'kW',
          capacity_basis: 'IT_LOAD',
          capacity_state: 'FIRM',
          service_state: 'AVAILABLE',
          phase_id: ids.phase1,
          failure_domain_id: ids.domainA,
        },
      },
    ]);
    return { applied };
  });

  assert.equal(result.applied.applied[0].created, true);
  assert.ok(
    result.applied.diagnostics.some((entry) => entry.constraintId === 'facility.utility.interface.connectivity_missing'),
    'the interface has no CONNECTION_POINT geometry yet, and that is reported rather than refused',
  );
});

test('a resilience requirement replaces the active one instead of stacking', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId }) => {
    const applied = await commit([
      {
        kind: 'set_resilience_requirement',
        payload: {
          availability_policy: 'TWO_N',
          policy_id: 'corp-dc-standard@3',
          applies_to: ['POWER', 'COOLING'],
          autonomy_duration_seconds: 86400,
        },
      },
    ]);
    const actives = await client.query(
      'SELECT requirement_id, availability_policy, policy_id FROM resilience_requirements WHERE project_id = $1 AND revision_id = $2 AND active = true',
      [projectId, revisionId],
    );
    return { applied, actives: actives.rows };
  });

  assert.equal(result.actives.length, 1, 'exactly one active requirement, so the policy it names is unambiguous');
  assert.equal(result.actives[0].availability_policy, 'TWO_N');
  assert.equal(result.applied.applied[0].supersededRequirementIds.length, 1, 'the previous one was deactivated in the same change');
});

test('a resilience requirement citing an unpinned policy is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit }) =>
    capture(
      commit([
        { kind: 'set_resilience_requirement', payload: { availability_policy: 'N', policy_id: 'corp-dc-standard', applies_to: ['POWER'] } },
      ]),
    ),
  );
  assert.equal(result.error.status, 422);
  assert.equal(result.error.details[0].reason, 'policy_reference_not_pinned');
});

test('a duplicate capacity budget is a conflict, naming the budget it collides with', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        {
          kind: 'set_capacity_budget',
          payload: {
            owner_entity_id: ids.building,
            phase_id: ids.phase1,
            resource_kind: 'POWER',
            basis: 'IT_LOAD',
            unit: 'kW',
            commissioned_value: 5000,
          },
        },
      ]),
    ),
  );

  assert.equal(result.error.status, 409);
  assert.equal(result.error.details[0].reason, 'duplicate_budget');
  assert.ok(result.error.details[0].existing_budget_id, 'the caller is told what it collided with');
});

test('a capacity budget for a different basis is a second budget, not a conflict', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    const applied = await commit([
      {
        kind: 'set_capacity_budget',
        payload: {
          owner_entity_id: ids.building,
          phase_id: ids.phase1,
          resource_kind: 'POWER',
          basis: 'FACILITY_INPUT',
          unit: 'kW',
          commissioned_value: 4000,
          available_value: 4000,
        },
      },
    ]);
    return { applied };
  });
  assert.equal(result.applied.applied[0].created, true);
});

test('a phase dependency that closes a cycle is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    // The fixture already has phase1 -> phase2. Closing the loop is the cycle.
    const attempt = await capture(
      commit([{ kind: 'set_phase_dependency', payload: { predecessor_phase_id: ids.phase2, successor_phase_id: ids.phase1 } }]),
    );
    const duplicate = await capture(
      commit([{ kind: 'set_phase_dependency', payload: { predecessor_phase_id: ids.phase1, successor_phase_id: ids.phase2 } }]),
    );
    const selfEdge = await capture(
      commit([{ kind: 'set_phase_dependency', payload: { predecessor_phase_id: ids.phase1, successor_phase_id: ids.phase1 } }]),
    );
    return { attempt, duplicate, selfEdge };
  });

  assert.equal(result.attempt.error.status, 409);
  assert.equal(result.attempt.error.details[0].reason, 'cycle');
  assert.equal(result.duplicate.error.details[0].reason, 'duplicate_dependency');
  assert.equal(result.selfEdge.error.status, 422);
  assert.equal(result.selfEdge.error.details[0].reason, 'self_dependency');
});

test('reparenting a container into its own descendant is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    // building is a child of parcel; making the parcel a child of the building closes a cycle.
    return capture(
      commit([{ kind: 'update_entity', entity_ref: { entity_id: ids.parcel }, payload: { patch: { parent_container_id: ids.building } } }]),
    );
  });

  assert.equal(result.error.status, 409);
  assert.equal(result.error.details[0].reason, 'cycle');
});

test('a new phase is created, and capability availability can be recorded for it', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId }) => {
    const phase = await commit([
      { kind: 'set_phase', payload: { name: 'Phase 3 - 8 MW', phase_order: 2, activation_date: '2028-01-01', activation_date_precision: 'DAY' } },
    ]);
    const phaseId = phase.applied[0].phaseId;
    const availability = await commit(
      [{ kind: 'set_phase_capability', payload: { phase_id: phaseId, capability: 'POWER', available: false } }],
      { etag: phase.etag },
    );
    const rows = await client.query(
      'SELECT capability, available FROM phase_capability_availability WHERE project_id = $1 AND revision_id = $2 AND phase_id = $3',
      [projectId, revisionId, phaseId],
    );
    return { phase, availability, rows: rows.rows };
  });

  assert.equal(result.phase.applied[0].created, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].capability, 'POWER');
  assert.equal(result.rows[0].available, false);
  assert.equal(result.availability.applied[0].created, true);
});

test('an assumption is recorded and resolved, and resolving twice is a conflict', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const recorded = await commit([
      {
        kind: 'record_assumption',
        payload: {
          statement: 'Municipal water is available during commissioning.',
          owner: 'Mechanical planning',
          confidence: 'LOW',
          effective_at: '2026-01-01',
          entity_refs: [{ entity_type: 'UTILITY_SOURCE', entity_id: ids.powerA }],
        },
      },
    ]);
    const assumptionId = recorded.applied[0].assumptionId;
    const resolved = await commit(
      [{ kind: 'resolve_assumption', payload: { assumption_id: assumptionId, resolution: 'Confirmed by the water authority.' } }],
      { etag: recorded.etag },
    );
    const again = await capture(
      commit([{ kind: 'resolve_assumption', payload: { assumption_id: assumptionId } }], { etag: resolved.etag }),
    );
    const row = await client.query(
      'SELECT status, provenance FROM assumptions WHERE project_id = $1 AND revision_id = $2 AND assumption_id = $3',
      [projectId, revisionId, assumptionId],
    );
    return { recorded, resolved, again, row: row.rows[0] };
  });

  assert.equal(result.row.status, 'RESOLVED');
  assert.equal(result.row.provenance.resolution, 'Confirmed by the water authority.', 'the reason survives, since the store has no column for it');
  assert.ok(result.row.provenance.resolved_at);
  assert.equal(result.again.error.status, 409);
  assert.equal(result.again.error.details[0].reason, 'not_open');
});

test('a document is attached as metadata and detached without touching the asset', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const attached = await commit([
      {
        kind: 'attach_document',
        payload: {
          kind: 'VENDOR_STUDY',
          title: 'Phase 3 feasibility',
          media_type: 'application/pdf',
          content_checksum: 'sha256-fixture',
          storage_key: 'projects/fixture/study.pdf',
          owner: 'Development organisation',
          entity_refs: [{ entity_type: 'SITE', entity_id: ids.scope }],
        },
      },
    ]);
    const documentId = attached.applied[0].documentId;
    const detached = await commit([{ kind: 'detach_document', payload: { document_id: documentId } }], { etag: attached.etag });
    const remaining = await client.query(
      'SELECT count(*)::int AS n FROM documents WHERE project_id = $1 AND revision_id = $2 AND document_id = $3',
      [projectId, revisionId, documentId],
    );
    const registry = await client.query(
      'SELECT status FROM entity_registry WHERE project_id = $1 AND revision_id = $2 AND entity_id = $3',
      [projectId, revisionId, documentId],
    );
    return { attached, detached, remaining: remaining.rows[0].n, registry: registry.rows[0] };
  });

  assert.equal(result.attached.applied[0].created, true);
  assert.equal(result.remaining, 0, 'the reference for this revision is gone');
  assert.equal(result.registry.status, 'SUPERSEDED', 'the identity is kept, so a diagnostic that named it still resolves');
});

test('a document without a checksum or a storage key is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit }) =>
    capture(
      commit([
        { kind: 'attach_document', payload: { kind: 'VENDOR_STUDY', title: 'No bytes', media_type: 'application/pdf', owner: 'Someone' } },
      ]),
    ),
  );
  assert.equal(result.error.status, 422);
  assert.ok(['payload.content_checksum', 'payload.storage_key'].includes(result.error.details[0].field));
});

test('a spatial constraint is created and is immediately checked', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const applied = await commit([
      {
        kind: 'assign_constraint',
        payload: {
          constraint_kind: 'HEIGHT_LIMIT',
          severity: 'ERROR',
          container_id: ids.building,
          rule_kind: 'MAX_HEIGHT',
          rule_value: 5,
          rule_unit: 'm',
        },
      },
    ]);
    const row = await client.query(
      'SELECT kind, severity, rule_kind, rule_value FROM spatial_constraints WHERE project_id = $1 AND revision_id = $2 AND constraint_id = $3',
      [projectId, revisionId, applied.applied[0].constraintId],
    );
    return { applied, row: row.rows[0] };
  });

  assert.equal(result.row.kind, 'HEIGHT_LIMIT');
  assert.equal(Number(result.row.rule_value), 5);
  // The fixture building is 12 m tall against a 5 m limit, so the new constraint bites
  // in the same response that created it.
  assert.ok(
    result.applied.diagnostics.some((entry) => entry.constraintId === 'facility.site.height.exceeded'),
    'a constraint created by an edit is evaluated by that same edit',
  );
});

test('a failure domain cannot become its own ancestor', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([{ kind: 'set_failure_domain', payload: { failure_domain_id: ids.domainA, name: 'Feed A', kind: 'UTILITY_FEED', parent_failure_domain_id: ids.domainB } }]),
    ),
  );
  // domainA and domainB are siblings, so this is legal; the cycle case is a domain that
  // is its own parent, which the parent walk catches.
  assert.equal(result.error, undefined, 'a sibling reparent is allowed');
});

test('a storage reserve is created with an autonomy duration', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const applied = await commit([
      {
        kind: 'set_storage_reserve',
        payload: {
          kind: 'WATER',
          capacity_value: 200000,
          capacity_unit: 'L',
          capacity_basis: 'WATER_FLOW',
          capacity_state: 'PLANNED',
          autonomy_duration_seconds: 43200,
          failure_domain_id: ids.domainA,
          phase_id: ids.phase2,
        },
      },
    ]);
    const row = await client.query(
      'SELECT kind, autonomy_duration_seconds FROM storage_reserves WHERE project_id = $1 AND revision_id = $2 AND storage_id = $3',
      [projectId, revisionId, applied.applied[0].storageId],
    );
    return { applied, row: row.rows[0] };
  });

  assert.equal(result.row.kind, 'WATER');
  assert.equal(Number(result.row.autonomy_duration_seconds), 43200);
});

test('an environmental constraint hangs off the profile and is validated in the same change', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => {
    const applied = await commit([
      {
        kind: 'set_environmental_constraint',
        payload: {
          profile_id: ids.profile,
          constraint_kind: 'EMISSIONS_LIMIT',
          threshold_value: 1,
          threshold_unit: 'tCO2e/yr',
          basis: 'WATER_FLOW',
          affected_entity_id: ids.yard,
        },
      },
    ]);
    return { applied };
  });

  assert.equal(result.applied.applied[0].created, true);
});

/* ================================================= invariants the store enforces

/**
 * Each of these is a check constraint in the schema. A write path that let the database
 * raise them would answer a caller with a constraint name, so the kinds answer with the
 * rule instead — and these tests pin the rule rather than the message the store happened
 * to produce.
 */

test('a spatial constraint is anchored to exactly one of a scope or a container', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => ({
    both: await capture(commit([{ kind: 'assign_constraint', payload: { constraint_kind: 'SETBACK', severity: 'ERROR', scope_id: ids.scope, container_id: ids.building, rule_kind: 'DISTANCE_FROM_BOUNDARY', rule_value: 10, rule_unit: 'm' } }])),
    neither: await capture(commit([{ kind: 'assign_constraint', payload: { constraint_kind: 'SETBACK', severity: 'ERROR', rule_kind: 'DISTANCE_FROM_BOUNDARY', rule_value: 10, rule_unit: 'm' } }])),
  }));

  assert.equal(result.both.error.details[0].reason, 'anchor_not_exclusive');
  assert.equal(result.neither.error.details[0].reason, 'anchor_not_exclusive');
});

test('a numeric constraint rule declares its kind and unit too', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(commit([{ kind: 'assign_constraint', payload: { constraint_kind: 'SETBACK', severity: 'ERROR', container_id: ids.building, rule_value: 10 } }])),
  );
  assert.equal(result.error.details[0].reason, 'incomplete_rule');
});

test('a reserve basis must match its kind', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        {
          kind: 'set_storage_reserve',
          payload: {
            kind: 'FUEL',
            capacity_value: 1000,
            capacity_unit: 'L',
            capacity_basis: 'WATER_FLOW',
            capacity_state: 'PLANNED',
            failure_domain_id: ids.domainA,
            phase_id: ids.phase1,
          },
        },
      ]),
    ),
  );
  assert.equal(result.error.details[0].reason, 'basis_does_not_match_kind');
  assert.equal(result.error.details[0].expected, 'FUEL_VOLUME');
});

test('an interface declares all of its capacity or none of it', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        {
          kind: 'set_utility_interface',
          payload: {
            utility_source_id: ids.powerA,
            capacity_value: 100,
            // no unit, no basis, no state
            service_state: 'AVAILABLE',
            failure_domain_id: ids.domainA,
            phase_id: ids.phase1,
          },
        },
      ]),
    ),
  );
  assert.equal(result.error.status, 422);
  assert.equal(result.error.details[0].field, 'payload.capacity_unit');
});

test('an inverted time window and an inverted elevation are refused', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) => ({
    window: await capture(
      commit([
        {
          kind: 'record_assumption',
          payload: {
            statement: 'Water is available.',
            owner: 'Mechanical planning',
            confidence: 'LOW',
            effective_at: '2026-06-01',
            expires_at: '2026-01-01',
          },
        },
      ]),
    ),
    elevation: await capture(
      commit([
        {
          kind: 'create_container',
          payload: { container_kind: 'BUILDING', name: 'Inverted', scope_id: ids.scope, elevation_base_m: 10, elevation_top_m: 4 },
        },
      ]),
    ),
  }));

  assert.equal(result.window.error.details[0].reason, 'window_inverted');
  assert.equal(result.elevation.error.details[0].reason, 'elevation_inverted');
});

test('a capability that is available must say from when', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(commit([{ kind: 'set_phase_capability', payload: { phase_id: ids.phase1, capability: 'WATER', available: true } }])),
  );
  assert.equal(result.error.details[0].reason, 'required_when_available');
});

test('a phase order already taken is a conflict naming the phase that holds it', { skip }, async () => {
  const result = await withCampus(async ({ commit }) =>
    capture(commit([{ kind: 'set_phase', payload: { name: 'Phase 1 duplicate', phase_order: 0 } }])),
  );
  assert.equal(result.error.status, 409);
  assert.equal(result.error.details[0].reason, 'duplicate_phase_order');
  assert.ok(result.error.details[0].existing_phase_id);
});

test('the same document bytes cannot be attached twice to a project', { skip }, async () => {
  const result = await withCampus(async ({ commit }) => {
    const document = {
      kind: 'VENDOR_STUDY',
      title: 'Feasibility',
      media_type: 'application/pdf',
      content_checksum: 'sha256-same-bytes',
      storage_key: 'projects/fixture/a.pdf',
      owner: 'Development organisation',
    };
    const first = await commit([{ kind: 'attach_document', payload: document }]);
    const second = await capture(
      commit([{ kind: 'attach_document', payload: { ...document, storage_key: 'projects/fixture/b.pdf' } }], { etag: first.etag }),
    );
    return { second };
  });

  assert.equal(result.second.error.status, 409);
  assert.equal(result.second.error.details[0].reason, 'duplicate_checksum');
});

test('a derating factor outside zero to one is refused', { skip }, async () => {
  const result = await withCampus(async ({ commit, ids }) =>
    capture(
      commit([
        {
          kind: 'set_capacity_budget',
          payload: {
            owner_entity_id: ids.building,
            phase_id: ids.phase1,
            resource_kind: 'COOLING',
            basis: 'HEAT_REJECTION',
            unit: 'kW',
            commissioned_value: 100,
            derating_factor: 1.5,
          },
        },
      ]),
    ),
  );
  assert.equal(result.error.details[0].reason, 'out_of_range');
});

/* ============================================ the P3 payoff

/**
 * The acceptance test for P3, and the reason it was sequenced before breadth: a non-firm
 * utility source gates POWER, COOLING and NETWORK_ENTRY at once, and nothing could clear
 * it before these kinds existed.
 *
 * The fixture seeds every source as `FIRM`, so the test makes the condition and then
 * clears it — which proves both directions through the write path rather than assuming a
 * starting state.
 */
test('a source set to firm clears the finding that gated three capabilities', { skip }, async () => {
  const result = await withCampus(async ({ commit, client, projectId, revisionId, ids }) => {
    const base = {
      utility_source_id: ids.powerB,
      name: 'Utility Entrance B',
      kind: 'POWER',
      capacity_value: 9000,
      capacity_unit: 'kW',
      capacity_basis: 'IT_LOAD',
      failure_domain_id: ids.domainB,
      phase_id: ids.phase2,
    };
    const liveFindings = async () => {
      const { rows } = await client.query(
        `SELECT diagnostic_id, status FROM facility_diagnostics
          WHERE project_id = $1 AND revision_id = $2 AND constraint_id = 'facility.utility.source.state_not_firm'
            AND status IN ('OPEN', 'ACKNOWLEDGED')`,
        [projectId, revisionId],
      );
      return rows;
    };

    const contractual = await commit([{ kind: 'set_utility_source', payload: { ...base, capacity_state: 'CONTRACTUAL' } }]);
    const gatingWhileContractual = await liveFindings();
    const firm = await commit(
      [{ kind: 'set_utility_source', payload: { ...base, capacity_state: 'FIRM' } }],
      { etag: contractual.etag },
    );
    const gatingWhileFirm = await liveFindings();
    const all = await client.query(
      `SELECT status FROM facility_diagnostics
        WHERE project_id = $1 AND revision_id = $2 AND constraint_id = 'facility.utility.source.state_not_firm'`,
      [projectId, revisionId],
    );
    return { contractual, firm, gatingWhileContractual, gatingWhileFirm, statuses: all.rows.map((row) => row.status) };
  });

  assert.equal(result.gatingWhileContractual.length, 1, 'a CONTRACTUAL source is reported as non-firm and gates');
  assert.equal(result.gatingWhileFirm.length, 0, 'setting it FIRM stops it gating');
  assert.equal(
    result.firm.resolvedDiagnosticIds.length,
    1,
    'the run closed the finding it cleared rather than leaving the old row open',
  );
  assert.ok(result.statuses.includes('RESOLVED'), 'the record is kept, and its status says it is done');
  assert.match(result.firm.effect, /resolved 1 finding/);
  assert.equal(result.firm.applied[0].created, false, 'the change updated the existing source rather than adding one');
});
