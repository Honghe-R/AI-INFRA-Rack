import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import { createValidationWorker } from '../worker.js';
import { seedBaseline } from './fixtures.js';

/**
 * The worker test runs against committed rows, because a claim has to be visible
 * to a second connection — that is the whole point of a queue in the database.
 * The fixture is therefore cleaned up explicitly, in reverse dependency order.
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

// Reverse dependency order, children first: a leftover row in a parent table
// makes the project delete fail, and a swallowed cleanup error then leaks into
// the next test.
const FACILITY_TABLES = [
  'outbox_events',
  'capacity_allocations', 'capacity_demand_requests', 'capacity_budgets', 'storage_reserves',
  'utility_interfaces', 'utility_sources', 'resilience_requirements',
  'spatial_constraints', 'environmental_constraints', 'environmental_profiles',
  'facility_containers', 'design_scopes',
  'phase_capability_availability', 'phase_dependencies', 'facility_phases', 'failure_domains', 'geometry_records',
  'import_features', 'import_mappings',
  // A binding and its transform reference each other: the binding's pointer is
  // cleared first, then the transform, then the binding.
  'spatial_transforms', 'asset_bindings',
  'assumptions', 'documents', 'waivers', 'approval_attestations',
  'facility_diagnostics', 'capability_coverage', 'validation_runs', 'entity_registry', 'facility_envelopes', 'jobs',
];

async function fixture() {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();

  await pool.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `worker-${userId}`]);
  await pool.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Worker org']);
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId, organizationId, 'Worker project',
  ]);
  await pool.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
    scenarioId, projectId, 'Baseline',
  ]);
  await pool.query(
    `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
     VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
    [revisionId, projectId, scenarioId],
  );
  await withTenant(pool, projectId, (client) =>
    seedBaseline(client, { projectId, scenarioId, revisionId, actorId: userId }),
  );

  return {
    userId, organizationId, projectId, scenarioId, revisionId,
    async cleanup() {
      await pool.query('UPDATE asset_bindings SET transform_id = NULL WHERE project_id = $1', [projectId]);
      // The envelope points at its last validation run, which points back at the
      // envelope; clearing the pointer breaks that cycle for deletion.
      await pool.query('UPDATE facility_envelopes SET validation_run_id = NULL WHERE project_id = $1', [projectId]);
      for (const table of FACILITY_TABLES) {
        await pool.query(`DELETE FROM ${table} WHERE project_id = $1`, [projectId]);
      }
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organizationId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    },
  };
}

async function enqueueValidation(f, { scope = 'FULL' } = {}) {
  const jobId = randomUUID();
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO jobs (job_id, project_id, scenario_id, revision_id, job_type, state, payload)
     VALUES ($1, $2, $3, $4, 'VALIDATION', 'QUEUED', $5::jsonb)`,
    [jobId, f.projectId, f.scenarioId, f.revisionId, JSON.stringify({ validation_run_id: runId, scope })],
  );
  return { jobId, runId };
}

test('a queued validation job is claimed, executed, and completed', { skip }, async () => {
  const f = await fixture();
  try {
    const worker = createValidationWorker({ pool });
    const { jobId, runId } = await enqueueValidation(f);

    const outcomes = await worker.runOnce();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].state, 'SUCCEEDED');
    assert.equal(outcomes[0].runId, runId);

    const job = (await pool.query('SELECT state, progress_pct, result FROM jobs WHERE job_id = $1', [jobId])).rows[0];
    assert.equal(job.state, 'SUCCEEDED');
    assert.equal(job.progress_pct, 100);
    assert.equal(job.result.validation_run_id, runId);
    assert.equal(job.result.lifecycle_state, 'VALIDATED', 'the clean fixture validates');

    const workers = await withTenant(pool, f.projectId, async (client) => ({
      run: (await client.query('SELECT status, error_count, checked_capabilities::text[] AS checked FROM validation_runs WHERE validation_run_id = $1', [runId])).rows[0],
      coverage: (await client.query('SELECT count(*)::int AS rows FROM capability_coverage WHERE revision_id = $1', [f.revisionId])).rows[0],
      diagnostics: (await client.query('SELECT count(*)::int AS rows FROM facility_diagnostics WHERE revision_id = $1', [f.revisionId])).rows[0],
      revision: (await client.query('SELECT lifecycle_state FROM revisions WHERE revision_id = $1', [f.revisionId])).rows[0],
    }), { readOnly: true });

    assert.equal(workers.run.status, 'COMPLETED');
    assert.equal(workers.run.error_count, 0);
    assert.equal(workers.coverage.rows, 8, 'one coverage row per capability');
    assert.equal(workers.diagnostics.rows, 0);
    assert.equal(workers.revision.lifecycle_state, 'VALIDATED');
  } finally {
    await f.cleanup();
  }
});

test('a queue with nothing in it returns no outcomes', { skip }, async () => {
  const f = await fixture();
  try {
    const worker = createValidationWorker({ pool });
    assert.deepEqual(await worker.runOnce(), []);
  } finally {
    await f.cleanup();
  }
});

test('two workers do not claim the same job', { skip }, async () => {
  const f = await fixture();
  try {
    await enqueueValidation(f);
    const left = createValidationWorker({ pool });
    const right = createValidationWorker({ pool });
    const results = await Promise.all([left.runOnce(), right.runOnce()]);
    const claimed = results.flat();
    assert.equal(claimed.length, 1, 'SKIP LOCKED gives the job to exactly one worker');
    assert.equal(claimed[0].state, 'SUCCEEDED');
  } finally {
    await f.cleanup();
  }
});

test('a failed run marks the job failed without losing the job row', { skip }, async () => {
  const f = await fixture();
  try {
    const jobId = randomUUID();
    // A job for a revision with no envelope cannot be validated.
    const bareRevision = randomUUID();
    await pool.query(
      `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
       VALUES ($1, $2, $3, 'DRAFT', 'No envelope')`,
      [bareRevision, f.projectId, f.scenarioId],
    );
    await pool.query(
      `INSERT INTO jobs (job_id, project_id, scenario_id, revision_id, job_type, state, payload)
       VALUES ($1, $2, $3, $4, 'VALIDATION', 'QUEUED', $5::jsonb)`,
      [jobId, f.projectId, f.scenarioId, bareRevision, JSON.stringify({ scope: 'FULL' })],
    );
    const worker = createValidationWorker({ pool });
    const outcomes = await worker.runOnce();
    assert.equal(outcomes[0].state, 'FAILED');
    const job = (await pool.query('SELECT state, error_message FROM jobs WHERE job_id = $1', [jobId])).rows[0];
    assert.equal(job.state, 'FAILED');
    assert.ok(job.error_message.length > 0);
  } finally {
    await f.cleanup();
  }
});
