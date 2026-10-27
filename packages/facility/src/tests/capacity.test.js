import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { withTenant } from '@ai-infra/db';
import { availableCapacity, contentionOrder, decideAllocation, requestCapacityAllocation } from '../capacity.js';
import { ensureEtag } from '../etags.js';
import { seedBaseline } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';
const { default: pg } = await import('pg');
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
test.after(() => pool?.end());

/* ==================================================== pure rules (D5, D6) */

test('availableCapacity is exactly the D5 formula', () => {
  assert.equal(availableCapacity({ commissioned: 10000, deratingFactor: 0, reserved: 1000, accepted: 2000 }), 7000);
  // Derating applies to firm capacity, and only reserved and accepted subtract.
  assert.equal(availableCapacity({ commissioned: 10000, deratingFactor: 0.05, reserved: 1000, accepted: 0 }), 8500);
  // Planned capacity is not an argument at all: there is no way to leak it into the formula.
  assert.equal(availableCapacity({ commissioned: 0 }), 0);
});

test('contentionOrder follows D6 and reports a tie rather than resolving it', () => {
  const at = (priority, requiredFrom, createdAt, requestId) => ({
    requestId, priority, requiredFrom, createdAt,
  });
  const requests = [
    at('LOW', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'low'),
    at('CRITICAL', '2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z', 'crit-late'),
    at('CRITICAL', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'crit-early'),
    at('RESERVED', '2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z', 'reserved'),
  ];
  const { ordered, ties } = contentionOrder(requests);
  assert.deepEqual(ordered.map((entry) => entry.requestId), ['reserved', 'crit-early', 'crit-late', 'low']);
  assert.equal(ties.size, 0);

  const tied = contentionOrder([
    at('HIGH', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'a'),
    at('HIGH', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'b'),
  ]);
  assert.deepEqual(new Set(tied.ties), new Set(['a', 'b']));
});

/* ==================================================== command over the store */

class Rollback extends Error {
  constructor(value) {
    super('rollback');
    this.value = value;
  }
}

async function withBaseline(fn) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `capacity-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Capacity org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Capacity project']);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [scenarioId, projectId, 'Baseline']);
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
         VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
        [revisionId, projectId, scenarioId],
      );
      const ids = await seedBaseline(client, { projectId, scenarioId, revisionId, actorId: userId });
      const token = await ensureEtag({ client, projectId, revisionId, scenarioId, actorId: userId });
      const request = (overrides = {}) =>
        requestCapacityAllocation({
          client,
          projectId,
          revisionId,
          actorId: userId,
          baseRevisionId: ids.envelope,
          etag: token.etag,
          consumerType: 'RACK',
          consumerId: ids.building,
          phaseId: ids.phase1,
          resourceKind: 'POWER',
          requestedCapacity: { value: 1000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM' },
          requiredFrom: '2026-01-01T00:00:00Z',
          priority: 'NORMAL',
          ...overrides,
        });
      const budget = async () =>
        (await client.query('SELECT available_value, allocated_value FROM capacity_budgets WHERE project_id = $1 AND budget_id = $2', [projectId, ids.budget])).rows[0];
      throw new Rollback(await fn({ client, ids, projectId, scenarioId, revisionId, userId, token, request, budget }));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
}

test('a satisfiable request records a PROVISIONAL allocation without touching availability', { skip }, async () => {
  const result = await withBaseline(async ({ ids, budget, request }) => {
    const before = await budget();
    const decision = await request();
    const after = await budget();
    return { decision, before, after, ids };
  });

  assert.equal(result.decision.state, 'PROVISIONAL');
  assert.equal(result.decision.reason, null);
  assert.equal(result.decision.allocations.length, 1);
  assert.equal(result.decision.allocations[0].state, 'PROVISIONAL');
  assert.equal(result.decision.allocations[0].quantityValue, 1000);
  // D5: only ACCEPTED allocations reduce availability, so a provisional one leaves the
  // stored budget untouched.
  assert.equal(Number(result.after.available_value), Number(result.before.available_value));
  assert.equal(Number(result.after.available_value), 7000);
});

test('decideAllocation accepts, recomputes the budget, and records the event', { skip }, async () => {
  const result = await withBaseline(async ({ client, ids, projectId, revisionId, token, request, budget }) => {
    const decision = await request();
    const allocationId = decision.allocations[0].allocationId;
    const accepted = await decideAllocation({
      client,
      projectId,
      revisionId,
      allocationId,
      state: 'ACCEPTED',
      baseRevisionId: ids.envelope,
      etag: decision.etag,
      actorId: null,
    });
    const after = await budget();
    const events = await client.query(
      `SELECT event_type, payload FROM outbox_events WHERE project_id = $1 AND event_type = 'facility.allocation.decided.v1'`,
      [projectId],
    );
    void token;
    return { accepted, after, events: events.rows };
  });

  assert.equal(result.accepted.state, 'ACCEPTED');
  assert.equal(Number(result.accepted.budget.availableValue), 6000);
  assert.equal(Number(result.after.available_value), 6000);
  assert.equal(Number(result.after.allocated_value), 3000);
  assert.ok(result.events.length >= 1);
});

test('a request that cannot be satisfied is refused whole with the shortfall', { skip }, async () => {
  const result = await withBaseline(async ({ request }) => {
    const decision = await request({ requestedCapacity: { value: 99999, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM' } });
    return decision;
  });

  assert.equal(result.state, 'REJECTED');
  assert.equal(result.reason, 'insufficient_capacity');
  assert.equal(result.allocations[0].state, 'REJECTED');
  assert.ok(result.shortfall > 0);
});

test('a request with no budget is refused and says so', { skip }, async () => {
  const result = await withBaseline(async ({ request }) => {
    return request({ resourceKind: 'WATER', requestedCapacity: { value: 10, unit: 'm3/h', basis: 'WATER_FLOW', state: 'FIRM' } });
  });

  assert.equal(result.state, 'REJECTED');
  assert.equal(result.reason, 'no_budget');
  assert.equal(result.allocations.length, 0);
});

test('two requests that tie on the D6 keys are refused rather than arbitrarily ordered', { skip }, async () => {
  const result = await withBaseline(async ({ request }) => {
    const first = await request();
    // `now()` is the transaction clock, so the second request shares the first's
    // required_from and created_at: the D6 triple cannot separate them.
    const second = await request({ etag: first.etag });
    return { first, second };
  });

  assert.equal(result.first.state, 'PROVISIONAL');
  assert.equal(result.second.state, 'REJECTED');
  assert.equal(result.second.reason, 'contention_tie');
});
