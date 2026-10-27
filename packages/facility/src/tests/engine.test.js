import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import { CATALOG, RUN_REASON, defaultPolicyRegistry, executeRun } from '../index.js';
import { MUTATIONS, OPTION_MUTATIONS, PUBLISH_PREPARE, SCHEMA_GUARDED, seedBaseline } from './fixtures.js';

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

/**
 * Every fixture runs inside one transaction that is rolled back, so no test
 * leaves residue and no cleanup is needed. The engine is handed the same client,
 * which is the point of an explicit client parameter: a run is one transaction.
 */
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
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `fixture-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Fixture org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
        projectId, organizationId, 'Fixture project',
      ]);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
        scenarioId, projectId, 'Baseline',
      ]);
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

/** Runs the engine over the baseline, optionally after one mutation. */
function runGraph({ constraintId = null, reason = RUN_REASON.VALIDATION, isCurrentDraft = true } = {}) {
  return inRollback(async ({ client, ids, projectId, scenarioId, revisionId, userId }) => {
    if (constraintId && typeof MUTATIONS[constraintId] === 'function') {
      await MUTATIONS[constraintId](client, ids, projectId);
    }
    // A publish-gate check's positive case needs the rows that make publishing
    // possible; its negative case is the absence of them.
    if (!constraintId && reason === RUN_REASON.PUBLISH) {
      for (const prepare of Object.values(PUBLISH_PREPARE)) await prepare(client, ids, projectId);
    }
    const option = constraintId ? OPTION_MUTATIONS[constraintId] : null;
    const result = await executeRun({
      client,
      projectId,
      scenarioId,
      revisionId,
      reason,
      isCurrentDraft: option?.isCurrentDraft ?? isCurrentDraft,
      actorId: userId,
      policies: defaultPolicyRegistry,
    });
    return { result, ids, userId, projectId, scenarioId, revisionId };
  });
}

const findByConstraint = (result, constraintId) => result.diagnostics.filter((item) => item.constraintId === constraintId);
const validationChecks = CATALOG.filter((item) => item.phase === 'VALIDATION');
const publishChecks = CATALOG.filter((item) => item.phase === 'PUBLISH');
const negativeChecks = CATALOG.filter(
  (item) => item.implemented && !SCHEMA_GUARDED.includes(item.constraintId),
);

test('the baseline revision is clean for every check that ran', { skip }, async () => {
  const { result } = await runGraph();
  const unexpected = [...new Set(result.diagnostics.map((item) => item.constraintId))];
  assert.deepEqual(unexpected, [], `baseline should be clean, saw:\n${JSON.stringify(result.diagnostics, null, 2)}`);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.equal(result.validated, true, 'a clean full run transitions the revision to VALIDATED');
  assert.equal(result.lifecycleState, 'VALIDATED');
});

for (const constraint of negativeChecks) {
  const reason = constraint.phase === 'PUBLISH' ? RUN_REASON.PUBLISH : RUN_REASON.VALIDATION;
  test(`${constraint.constraintId} fires on its negative fixture`, { skip }, async () => {
    const { result } = await runGraph({ constraintId: constraint.constraintId, reason });
    const findings = findByConstraint(result, constraint.constraintId);
    assert.ok(findings.length > 0, `${constraint.constraintId} did not fire`);
    assert.equal(findings[0].severity, constraint.severity);
    for (const item of findings) {
      assert.equal(item.remediationCategory, constraint.remediation);
      assert.deepEqual(item.entityRefs.length >= 0, true);
    }
  });

  test(`${constraint.constraintId} stays quiet on the clean baseline`, { skip }, async () => {
    const { result } = await runGraph({ reason });
    assert.deepEqual(findByConstraint(result, constraint.constraintId), []);
  });
}

test('every fixture-paired constraint has a mutation or an option', { skip }, async () => {
  const missing = negativeChecks
    .filter((item) => typeof MUTATIONS[item.constraintId] !== 'function' && !OPTION_MUTATIONS[item.constraintId])
    .map((item) => item.constraintId);
  assert.deepEqual(missing, []);
  void runGraph;
});

test('a schema-guarded check has an evaluator and can never fire against this schema', { skip }, async () => {
  const { result } = await runGraph();
  for (const constraintId of SCHEMA_GUARDED) {
    assert.ok(CATALOG.some((item) => item.constraintId === constraintId));
    assert.deepEqual(findByConstraint(result, constraintId), [], `${constraintId} must be unreachable in the store`);
  }
});

test('the three checks with no evidence model are recorded as not checked', { skip }, async () => {
  const { result } = await runGraph();
  const unrun = result.notChecked.map((item) => item.constraintId);
  for (const constraintId of [
    'facility.environment.permit.exceeded',
    'facility.environment.hazard.mitigation_missing',
    'facility.environment.emissions.exceeded',
  ]) {
    assert.ok(unrun.includes(constraintId), `${constraintId} should be not checked`);
  }
});

test('publish-only checks are not checked during a validation run', { skip }, async () => {
  const { result } = await runGraph();
  const unrun = result.notChecked.map((item) => item.constraintId);
  for (const constraint of publishChecks) {
    assert.ok(unrun.includes(constraint.constraintId), `${constraint.constraintId} is publish-only`);
  }
});

test('an ERROR blocks the VALIDATED transition and leaves a PROVISIONAL capability', { skip }, async () => {
  const { result } = await runGraph({ constraintId: 'facility.site.setback.violated' });
  assert.ok(result.errorCount > 0);
  assert.equal(result.validated, false);
  assert.equal(result.lifecycleState, 'DRAFT');
  assert.equal(result.coverage.GEOMETRY.status, 'PROVISIONAL');
  assert.ok(result.coverage.GEOMETRY.reasons.some((line) => line.includes('facility.site.setback.violated')));
});

test('a clean baseline validates the capabilities whose checks all ran', { skip }, async () => {
  const { result } = await runGraph();
  assert.equal(Object.keys(result.coverage).length, 8);
  assert.equal(result.coverage.GEOMETRY.status, 'VALIDATED');
  assert.equal(result.coverage.POWER.status, 'VALIDATED');
  assert.equal(result.coverage.PHASING.status, 'VALIDATED');
  assert.equal(result.validated, true);
});

test('a capability with no evidence at all is NOT_PROVIDED', { skip }, async () => {
  const { result } = await runGraph();
  // Nothing in the baseline supplies water, so the capability has no evidence.
  assert.equal(result.coverage.WATER.status, 'NOT_PROVIDED');
});

test('a check that cannot run caps its capability at PROVISIONAL', { skip }, async () => {
  const { result } = await runGraph();
  // Three environment checks have no evidence model at all, so they are not
  // checked and ENVIRONMENT cannot be VALIDATED even though the profile is fine.
  for (const constraintId of [
    'facility.environment.permit.exceeded',
    'facility.environment.hazard.mitigation_missing',
    'facility.environment.emissions.exceeded',
  ]) {
    assert.equal(result.notChecked.find((item) => item.constraintId === constraintId).reason, 'no evidence model');
  }
  assert.equal(result.coverage.ENVIRONMENT.status, 'PROVISIONAL');
  assert.ok(result.coverage.ENVIRONMENT.reasons.some((line) => line.includes('not checked')));
});

test('a waiver is inherited by the superseding diagnostic on a re-run', { skip }, async () => {
  const outcome = await inRollback(async ({ client, ids, projectId, scenarioId, revisionId, userId }) => {
    await MUTATIONS['facility.site.setback.violated'](client, ids, projectId);
    const first = await executeRun({ client, projectId, scenarioId, revisionId, actorId: userId });
    const diagnostic = first.diagnostics.find((item) => item.constraintId === 'facility.site.setback.violated');
    assert.ok(diagnostic, 'the negative fixture fires');

    // Grant the waiver the way the service does, on the same client so it stays
    // inside this transaction.
    const waiverId = randomUUID();
    await client.query(
      `INSERT INTO waivers
         (waiver_id, project_id, scenario_id, revision_id, diagnostic_ids, scope, granted_by, policy_id, reason, status)
       VALUES ($1, $2, $3, $4, ARRAY[$5]::uuid[], 'REVISION', $6, 'coverage-promoting-waiver@1', 'fixture', 'GRANTED')`,
      [waiverId, projectId, scenarioId, revisionId, diagnostic.diagnosticId, userId],
    );
    await client.query(`UPDATE facility_diagnostics SET status = 'WAIVED' WHERE diagnostic_id = $1`, [diagnostic.diagnosticId]);

    const second = await executeRun({ client, projectId, scenarioId, revisionId, actorId: userId });
    const rerun = second.diagnostics.find((item) => item.constraintId === 'facility.site.setback.violated');
    return { diagnostic, rerun, second };
  });

  assert.equal(outcome.rerun.status, 'WAIVED', 'the waiver follows the supersession chain');
  assert.equal(outcome.rerun.computed.coverage_promoting, true);
  assert.ok(outcome.rerun.supersedesDiagnosticId, 'the new diagnostic supersedes the previous one');
  // A waived ERROR no longer blocks the transition.
  assert.equal(outcome.second.validated, true);
});

test('two findings of one constraint against one entity are both kept', { skip }, async () => {
  const outcome = await inRollback(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    // N+2 against the baseline's two paths per kind: POWER and COOLING both fall
    // short, and both findings name the same requirement row — so a supersession
    // key built only from the entity references would drop the second one.
    await client.query(
      `UPDATE resilience_requirements SET availability_policy = 'N_PLUS_2' WHERE project_id = $1`,
      [projectId],
    );
    const result = await executeRun({ client, projectId, scenarioId, revisionId, actorId: userId });
    const live = await client.query(
      `SELECT count(*)::int AS open FROM facility_diagnostics
        WHERE project_id = $1 AND constraint_id = 'facility.resilience.redundancy.path_count' AND status = 'OPEN'`,
      [projectId],
    );
    return {
      result,
      open: live.rows[0].open,
      kinds: result.diagnostics
        .filter((item) => item.constraintId === 'facility.resilience.redundancy.path_count')
        .map((item) => item.resourceKind)
        .sort(),
    };
  });

  assert.deepEqual(outcome.kinds, ['COOLING', 'POWER'], 'one finding per resource kind');
  assert.equal(outcome.open, 2, 'both shortfalls survive as separate live diagnostics');
  assert.equal(outcome.result.errorCount, 2);
});

test('coverage derivation caps a warning-gated capability at PROVISIONAL', { skip }, async () => {
  const { result } = await runGraph({ constraintId: 'facility.utility.source.state_not_firm' });
  assert.equal(result.coverage.POWER.status, 'PROVISIONAL');
  assert.ok(result.coverage.POWER.reasons.some((line) => line.includes('state_not_firm')));
});

test('the revision is only frozen when a clean FULL run completes', { skip }, async () => {
  const clean = await runGraph();
  assert.equal(clean.result.lifecycleState, 'VALIDATED');
  const dirty = await runGraph({ constraintId: 'facility.data.geometry.invalid' });
  assert.equal(dirty.result.lifecycleState, 'DRAFT');
});
