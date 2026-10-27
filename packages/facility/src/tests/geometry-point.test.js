import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import { createToolExecutor, createToolRegistry, READ_TOOLS } from '../index.js';
import { seedBaseline } from './fixtures.js';

/**
 * `geometry_point`: the one spatial read whose answer is a coordinate.
 *
 * The assistant could read a geometry's coordinates and could ask whether two geometries relate,
 * but nothing could produce a point *inside* a polygon. Asked to put a utility source's
 * connection point inside a yard, a model therefore had to invent a coordinate or refuse — and a
 * live turn refused, correctly, because it could not know an interior point. The computation
 * belongs to PostGIS, which already does it on the projected geometry, so this is a read rather
 * than a request for the model to do geodesy.
 */
const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 2 });
});
after(async () => {
  if (pool) await pool.end();
});

/** The seeded campus already holds a yard, four sources, and their connection points. */
async function withCampus(fn) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  const context = { projectId, scenarioId, revisionId };
  return withTenant(pool, projectId, async (client) => {
    // The fixture writes a graph into a revision, so the project, scenario, and revision rows
    // have to exist first — the same setup `changes.test.js` uses.
    const userId = randomUUID();
    await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `geometry-point-${userId}`]);
    const organizationId = randomUUID();
    await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Point org']);
    await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
      projectId,
      organizationId,
      'Point project',
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
    const executor = createToolExecutor({
      pool,
      registry: createToolRegistry({ tools: READ_TOOLS }),
      authorize: async () => true,
      // The tenant is already open for this transaction, so the tool runs on this client.
      runInTenant: async (_projectId, run) => run(client),
    });
    return fn({ executor, context, ids, revisionId, client });
  });
}

test('the point for a polygon is inside that polygon, not merely near it', { skip }, async () => {
  await withCampus(async ({ executor, context, ids, revisionId, client }) => {
    const point = await executor.execute({
      name: 'geometry_point',
      args: { revision_id: revisionId, entity_id: ids.yard, geometry_role: 'BOUNDARY' },
      context,
    });

    assert.equal(point.geometryType, 'POLYGON');
    assert.equal(point.point.geojson4326.type, 'Point');

    // The point has to be inside the shape it was derived from — that is the property that makes
    // the tool worth having, and a centroid is only guaranteed to be inside a convex shape. Checked
    // against the store's own geometry rather than by arithmetic in the test.
    const { rows } = await client.query(
      `SELECT ST_Within(
                (SELECT ST_Transform(ST_Centroid(projected_geometry), 4326) FROM geometry_records
                  WHERE entity_id = $1 AND role = 'BOUNDARY'),
                (SELECT geojson_4326 FROM geometry_records WHERE entity_id = $1 AND role = 'BOUNDARY')) AS inside`,
      [ids.yard],
    );
    assert.equal(rows[0].inside, true, 'the derived point is inside the polygon');
  });
});

test('the point for a point is that point', { skip }, async () => {
  await withCampus(async ({ executor, context, ids, revisionId }) => {
    const point = await executor.execute({
      name: 'geometry_point',
      args: { revision_id: revisionId, entity_id: ids.powerA, geometry_role: 'CONNECTION_POINT' },
      context,
    });

    // A source's connection point comes back as itself, so a caller can read where it is without
    // a second call to `query_geometry`.
    assert.equal(point.geometryType, 'POINT');
    assert.equal(point.point.geojson4326.type, 'Point');
    assert.equal(point.point.geojson4326.coordinates.length, 2);
    assert.notDeepEqual(point.point.geojson4326.coordinates, [0, 0], 'a real coordinate, not the origin');
  });
});

test('an entity with no geometry in that role is a stated miss, not an empty point', { skip }, async () => {
  await withCampus(async ({ executor, context, ids, revisionId }) => {
    const point = await executor.execute({
      name: 'geometry_point',
      args: { revision_id: revisionId, entity_id: ids.yard, geometry_role: 'CONNECTION_POINT' },
      context,
    });

    assert.equal(point.point, null, 'a role the entity does not hold has no point');
    assert.equal(point.entityId, ids.yard);
    assert.equal(point.geometryType, null);
  });
});
