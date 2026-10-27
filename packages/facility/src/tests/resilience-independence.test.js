import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import { CATALOG, CHECKS, RUN_REASON, defaultPolicyRegistry, executeRun } from '../index.js';
import { seedBaseline } from './fixtures.js';

/**
 * T6's independence rule, stated once and tested twice.
 *
 * [D6]/entity-model.md make failure-domain independence "no shared ancestor", not
 * "different leaf domain": two domains under one parent are both lost when the
 * parent fails, so a revision that declares Feed A and Feed B as siblings of one
 * upstream feed has one independent path, not two. The same rule governs fuel and
 * water autonomy: two reserves in domains that share an ancestor are one reserve,
 * and their durations do not add.
 */
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

async function inRollback(fn) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `independence-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Independence org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Independence project']);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [scenarioId, projectId, 'Baseline']);
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
         VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
        [revisionId, projectId, scenarioId],
      );
      const ids = await seedBaseline(client, { projectId, scenarioId, revisionId, actorId: userId });
      const value = await fn({ client, ids, projectId, scenarioId, revisionId, userId });
      throw new Rollback(value);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
  return undefined;
}

function run(client, { projectId, scenarioId, revisionId, userId }) {
  return executeRun({
    client,
    projectId,
    scenarioId,
    revisionId,
    reason: RUN_REASON.VALIDATION,
    actorId: userId,
    policies: defaultPolicyRegistry,
  });
}

const findingsFor = (result, constraintId) => result.diagnostics.filter((item) => item.constraintId === constraintId);

test('two sibling domains under one parent count as one independent path', { skip }, async () => {
  const result = await inRollback(async (scope) => {
    const clean = await run(scope.client, scope);
    await scope.client.query(
      `UPDATE failure_domains SET parent_failure_domain_id = $2
        WHERE project_id = $1 AND failure_domain_id = $3`,
      [scope.projectId, scope.ids.domainA, scope.ids.domainB],
    );
    const nested = await run(scope.client, scope);
    return { clean, nested };
  });

  assert.equal(findingsFor(result.clean, 'facility.resilience.redundancy.path_count').length, 0);
  // Both COOLING sources now sit under Feed A, so the requirement's N+1 is not met.
  assert.ok(findingsFor(result.nested, 'facility.resilience.redundancy.path_count').length > 0);
  assert.ok(findingsFor(result.nested, 'facility.resilience.failure_domain.shared').length > 0);
});

test('fuel autonomy is summed over independent reserves, not over every reserve', async () => {
  const constraint = CATALOG.find((item) => item.constraintId === 'facility.resilience.fuel_duration.insufficient');
  const check = CHECKS['facility.resilience.fuel_duration.insufficient'];
  const requirement = {
    requirement_id: 'req-1',
    active: true,
    applies_to: ['FUEL'],
    autonomy_duration_seconds: 200000,
    policy_id: 'corp-dc-standard@3',
  };
  const reserve = (domainId, seconds) => ({
    kind: 'FUEL',
    failure_domain_id: domainId,
    autonomy_duration_seconds: seconds,
  });

  const ctxFor = (reserves, domains) => ({
    requirements: [requirement],
    reserves,
    domainById: new Map(domains.map((domain) => [domain.failure_domain_id, domain])),
    policies: defaultPolicyRegistry,
    client: null,
  });
  const flat = [
    { failure_domain_id: 'A', parent_failure_domain_id: null },
    { failure_domain_id: 'B', parent_failure_domain_id: null },
  ];
  const nested = [
    { failure_domain_id: 'A', parent_failure_domain_id: null },
    { failure_domain_id: 'B', parent_failure_domain_id: 'A' },
  ];
  const twoReserves = [reserve('A', 172800), reserve('B', 50000)];

  // Independent domains: 172800 + 50000 clears the 200000 s requirement.
  assert.equal((await check(ctxFor(twoReserves, flat), constraint)).length, 0);
  // One shared ancestor makes them one reserve, so only the larger duration counts.
  const shortfall = await check(ctxFor(twoReserves, nested), constraint);
  assert.equal(shortfall.length, 1);
  assert.equal(shortfall[0].computed.actual, '172800 s');
  // A single reserve that already clears the requirement is never reported.
  assert.equal((await check(ctxFor([reserve('A', 250000)], nested), constraint)).length, 0);
});
