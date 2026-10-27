import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { withTenant } from '@ai-infra/db';
import { RUN_REASON, executeRun } from '../engine.js';
import { ensureEtag } from '../etags.js';
import {
  createRevision,
  envelopeKey,
  issueImpactNotice,
  publishRevision,
  recordApproval,
} from '../publication.js';
import { MUTATIONS, seedBaseline } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';
const { default: pg } = await import('pg');
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
test.after(() => pool?.end());

/* ==================================================== pure rules */

test('envelopeKey is deterministic and sanitized', () => {
  const projectId = '11111111-1111-1111-1111-111111111111';
  const revisionId = '22222222-2222-2222-2222-222222222222';
  const key = `projects/${projectId}/revisions/${revisionId}/facility-envelope.json.gz`;
  assert.equal(envelopeKey(projectId, revisionId), key);
  assert.equal(envelopeKey(projectId, revisionId), envelopeKey(projectId, revisionId));
  // A hostile id cannot add a path segment.
  assert.equal(envelopeKey('../../etc', revisionId), `projects/.._.._etc/revisions/${revisionId}/facility-envelope.json.gz`);
});

/* ==================================================== harness */

class Rollback extends Error {
  constructor(value) {
    super('rollback');
    this.value = value;
  }
}

/** Seeds a project/scenario/revision and rolls the whole fixture back. */
async function withBaseline(fn) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `publication-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Publication org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
        projectId, organizationId, 'Publication project',
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
      const token = await ensureEtag({ client, projectId, revisionId, scenarioId, actorId: userId });
      throw new Rollback(await fn({ client, ids, projectId, scenarioId, revisionId, userId, token }));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
  return undefined;
}

/** A clean FULL validation run, which is what publication needs. */
function validate(client, { projectId, scenarioId, revisionId, actorId }) {
  return executeRun({
    client, projectId, scenarioId, revisionId, scope: 'FULL', reason: RUN_REASON.VALIDATION, actorId,
  });
}

/** A fake object store that records what was written. */
function fakeStorage() {
  const calls = [];
  return {
    calls,
    async putObject({ key, body, contentType }) {
      calls.push({ key, body, contentType });
      return { key, size: body.length };
    },
    async getObject({ key }) {
      const call = calls.find((entry) => entry.key === key);
      return call ? { body: call.body, size: call.body.length } : null;
    },
  };
}

/** Runs an expected refusal on a savepoint so the fixture transaction stays usable. */
async function expectRefused(client, fn) {
  await client.query('SAVEPOINT expected_refusal');
  try {
    await fn();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_refusal');
    await client.query('RELEASE SAVEPOINT expected_refusal');
    return error;
  }
  await client.query('RELEASE SAVEPOINT expected_refusal');
  return null;
}

const scalar = async (client, sql, params) => (await client.query(sql, params)).rows[0];

/* ==================================================== branching */

test('a branch copies the graph with fresh ids and records lineage', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, ids, projectId, scenarioId, revisionId, userId }) => {
    // A diagnostic on the base proves the branch does not inherit validation output.
    await MUTATIONS['facility.site.setback.violated'](client, ids, projectId);
    await validate(client, { projectId, scenarioId, revisionId, actorId: userId });

    const base = {
      entities: Number((await scalar(client, 'SELECT count(*)::int AS c FROM entity_registry WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId])).c),
      geometry: Number((await scalar(client, 'SELECT count(*)::int AS c FROM geometry_records WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId])).c),
      diagnostics: Number((await scalar(client, 'SELECT count(*)::int AS c FROM facility_diagnostics WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId])).c),
      runs: Number((await scalar(client, 'SELECT count(*)::int AS c FROM validation_runs WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId])).c),
    };

    const branch = await createRevision({
      client, projectId, scenarioId, actorId: userId, name: 'Correction', baseRevisionId: revisionId,
    });

    const revision = await scalar(
      client,
      `SELECT lifecycle_state, base_revision_id, scenario_id FROM revisions WHERE project_id = $1 AND revision_id = $2`,
      [projectId, branch.revisionId],
    );
    const lineage = await scalar(
      client,
      `SELECT parent_revision_id FROM revision_lineage WHERE project_id = $1 AND revision_id = $2`,
      [projectId, branch.revisionId],
    );
    const branchCounts = {
      entities: Number((await scalar(client, 'SELECT count(*)::int AS c FROM entity_registry WHERE project_id = $1 AND revision_id = $2', [projectId, branch.revisionId])).c),
      geometry: Number((await scalar(client, 'SELECT count(*)::int AS c FROM geometry_records WHERE project_id = $1 AND revision_id = $2', [projectId, branch.revisionId])).c),
      diagnostics: Number((await scalar(client, 'SELECT count(*)::int AS c FROM facility_diagnostics WHERE project_id = $1 AND revision_id = $2', [projectId, branch.revisionId])).c),
      runs: Number((await scalar(client, 'SELECT count(*)::int AS c FROM validation_runs WHERE project_id = $1 AND revision_id = $2', [projectId, branch.revisionId])).c),
      // References inside the copy resolve inside the copy, not back to the base.
      danglingGeometry: Number((await scalar(
        client,
        `SELECT count(*)::int AS c FROM geometry_records g
          WHERE g.project_id = $1 AND g.revision_id = $2
            AND NOT EXISTS (SELECT 1 FROM entity_registry e
                             WHERE e.project_id = g.project_id AND e.revision_id = g.revision_id AND e.entity_id = g.entity_id)`,
        [projectId, branch.revisionId],
      )).c),
      danglingContainers: Number((await scalar(
        client,
        `SELECT count(*)::int AS c FROM facility_containers c
          WHERE c.project_id = $1 AND c.revision_id = $2
            AND (NOT EXISTS (SELECT 1 FROM design_scopes s
                              WHERE s.project_id = c.project_id AND s.revision_id = c.revision_id AND s.scope_id = c.scope_id)
              OR (c.parent_container_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM facility_containers p
                     WHERE p.project_id = c.project_id AND p.revision_id = c.revision_id AND p.container_id = c.parent_container_id)))`,
        [projectId, branch.revisionId],
      )).c),
      coverage: (await client.query(
        'SELECT status FROM capability_coverage WHERE project_id = $1 AND revision_id = $2',
        [projectId, branch.revisionId],
      )).rows.map((row) => row.status),
    };

    return { base, branch, revision, lineage, branchCounts };
  });

  assert.equal(outcome.revision.lifecycle_state, 'DRAFT');
  assert.equal(outcome.revision.base_revision_id, outcome.branch.baseRevisionId);
  assert.equal(outcome.revision.base_revision_id, outcome.branch.baseRevisionId);
  assert.equal(outcome.branch.baseRevisionId !== null, true);
  assert.equal(outcome.lineage.parent_revision_id, outcome.branch.baseRevisionId);
  assert.equal(outcome.revision.scenario_id, outcome.branch.scenarioId);

  assert.equal(outcome.branch.etagVersion, 0);
  assert.ok(outcome.branch.etag);
  assert.ok(outcome.branch.envelopeId);

  // The graph is copied, and each table reports its count.
  assert.equal(outcome.branch.copied.entity_registry, outcome.base.entities);
  assert.equal(outcome.branch.copied.geometry_records, outcome.base.geometry);
  assert.equal(outcome.branchCounts.entities, outcome.base.entities);
  assert.equal(outcome.branchCounts.geometry, outcome.base.geometry);
  assert.ok(outcome.branch.copied.facility_containers > 0);
  assert.ok(outcome.branch.copied.utility_sources > 0);
  assert.ok(outcome.branch.copied.capacity_budgets > 0);

  // Diagnostics and validation runs are not design decisions and are not copied.
  assert.ok(outcome.base.diagnostics > 0);
  assert.ok(outcome.base.runs > 0);
  assert.equal(outcome.branchCounts.diagnostics, 0);
  assert.equal(outcome.branchCounts.runs, 0);

  // Fresh ids preserve references.
  assert.equal(outcome.branchCounts.danglingGeometry, 0);
  assert.equal(outcome.branchCounts.danglingContainers, 0);
  assert.ok(outcome.branchCounts.coverage.length > 0);
  assert.deepEqual([...new Set(outcome.branchCounts.coverage)], ['NOT_PROVIDED']);
});

test('a branch of a VALIDATED revision is allowed and records its base', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    const run = await validate(client, { projectId, scenarioId, revisionId, actorId: userId });
    const branch = await createRevision({ client, projectId, scenarioId, actorId: userId, name: 'From validated', baseRevisionId: revisionId });
    const revision = await scalar(client, 'SELECT lifecycle_state, base_revision_id FROM revisions WHERE project_id = $1 AND revision_id = $2', [projectId, branch.revisionId]);
    return { run, branch, revision };
  });

  assert.equal(outcome.run.lifecycleState, 'VALIDATED');
  assert.equal(outcome.revision.lifecycle_state, 'DRAFT');
  assert.equal(outcome.revision.base_revision_id, outcome.branch.baseRevisionId);
});

/* ==================================================== publication refusals */

test('publish is refused on a DRAFT revision', { skip }, async () => {
  const error = await withBaseline(async ({ client, projectId, revisionId, userId }) =>
    expectRefused(client, () => publishRevision({ client, projectId, revisionId, actorId: userId, storage: null })));

  assert.ok(error);
  assert.equal(error.code, 'VALIDATION_REQUIRED');
  assert.equal(error.status, 409);
  assert.ok(error.details.some((detail) => detail.constraint_id === 'facility.revision.publish.requires_validation'));
});

test('publish is refused when the publish run finds an unpinned source', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, ids, projectId, scenarioId, revisionId, userId }) => {
    await validate(client, { projectId, scenarioId, revisionId, actorId: userId });
    await MUTATIONS['facility.revision.publish.source_unpinned'](client, ids, projectId);

    const error = await expectRefused(client, () =>
      publishRevision({ client, projectId, revisionId, actorId: userId, storage: fakeStorage() }));
    // A refusal leaves the revision exactly where it was.
    const revision = await scalar(client, 'SELECT lifecycle_state FROM revisions WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId]);
    return { error, revision };
  });

  assert.equal(outcome.error.code, 'VALIDATION_REQUIRED');
  assert.equal(outcome.error.status, 409);
  assert.ok(outcome.error.details.some(
    (detail) => detail.constraint_id === 'facility.revision.publish.source_unpinned' && detail.severity === 'ERROR',
  ));
  assert.equal(outcome.revision.lifecycle_state, 'VALIDATED');
});

test('publish is refused when deployment policy requires an approval that is absent', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, ids, projectId, scenarioId, revisionId, userId }) => {
    await validate(client, { projectId, scenarioId, revisionId, actorId: userId });
    await MUTATIONS['facility.governance.approval.required'](client, ids, projectId);
    const error = await expectRefused(client, () =>
      publishRevision({ client, projectId, revisionId, actorId: userId, storage: null }));
    return { error };
  });

  assert.equal(outcome.error.code, 'VALIDATION_REQUIRED');
  assert.ok(outcome.error.details.some((detail) => detail.constraint_id === 'facility.governance.approval.required'));
});

/* ==================================================== publication */

/**
 * A clean branch that is ready to publish.
 *
 * The branch copies `import_mappings` but not `import_features` (see the module
 * report), so the required mapping is relaxed before branching; otherwise the
 * copied mapping would have no matching feature and raise
 * `facility.import.mapping.unresolved` on the branch. Everything else is the
 * fixture's clean baseline.
 */
async function publishableBranch({ client, projectId, scenarioId, revisionId, userId }) {
  await client.query('UPDATE import_mappings SET required = false WHERE project_id = $1', [projectId]);
  await validate(client, { projectId, scenarioId, revisionId, actorId: userId });
  const branch = await createRevision({ client, projectId, scenarioId, actorId: userId, name: 'Correction', baseRevisionId: revisionId });
  const branchRun = await validate(client, { projectId, scenarioId, revisionId: branch.revisionId, actorId: userId });
  return { branch, branchRun };
}

test('a clean VALIDATED revision publishes, freezes the envelope, and notices the base', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    const storage = fakeStorage();
    const { branch, branchRun } = await publishableBranch({ client, projectId, scenarioId, revisionId, userId });
    const result = await publishRevision({
      client, projectId, revisionId: branch.revisionId, actorId: userId, storage, correlationId: randomUUID(),
    });

    const revision = await scalar(
      client,
      'SELECT lifecycle_state, content_checksum, published_at FROM revisions WHERE project_id = $1 AND revision_id = $2',
      [projectId, branch.revisionId],
    );
    const envelope = await scalar(
      client,
      'SELECT lifecycle_state, content_checksum, published_at, validation_run_id, approval_state FROM facility_envelopes WHERE project_id = $1 AND envelope_id = $2',
      [projectId, branch.envelopeId],
    );
    const event = await scalar(
      client,
      `SELECT payload FROM outbox_events WHERE project_id = $1 AND revision_id = $2 AND event_type = 'facility.envelope.published.v1'`,
      [projectId, branch.revisionId],
    );
    const notice = await scalar(
      client,
      `SELECT previous_revision_id, revision_id, changed_entity_refs, invalidated_consumer_types::text[] AS invalidated_consumer_types
         FROM impact_notices WHERE project_id = $1 AND revision_id = $2`,
      [projectId, branch.revisionId],
    );
    // The publication run must not persist the change-set immutability check as an
    // open ERROR against the revision it just published.
    const immutabilityFindings = (await client.query(
      `SELECT count(*)::int AS c FROM facility_diagnostics
        WHERE project_id = $1 AND revision_id = $2 AND constraint_id = 'facility.revision.writes_immutable'`,
      [projectId, branch.revisionId],
    )).rows[0].c;
    return { storage, branch, branchRun, result, revision, envelope, event, notice, immutabilityFindings, projectId };
  });

  assert.equal(outcome.branchRun.lifecycleState, 'VALIDATED');
  assert.equal(outcome.result.lifecycleState, 'PUBLISHED');
  assert.equal(outcome.result.revisionId, outcome.branch.revisionId);
  assert.equal(outcome.result.contentChecksum, outcome.revision.content_checksum);
  assert.equal(outcome.result.validationRunId, outcome.envelope.validation_run_id);
  assert.deepEqual(outcome.result.warnings, []);

  assert.equal(outcome.revision.lifecycle_state, 'PUBLISHED');
  assert.ok(outcome.revision.published_at);
  assert.equal(outcome.envelope.lifecycle_state, 'PUBLISHED');
  assert.equal(outcome.envelope.content_checksum, outcome.result.contentChecksum);
  assert.equal(outcome.envelope.validation_run_id, outcome.result.validationRunId);
  assert.equal(outcome.envelope.approval_state, 'NOT_REQUIRED');

  // The outbox event names the frozen object and the checksum.
  assert.ok(outcome.event);
  assert.equal(outcome.event.payload.content_checksum, outcome.result.contentChecksum);
  assert.equal(outcome.event.payload.object_key, outcome.result.objectKey);

  // The Impact Notice names the superseded revision and the invalidated consumers.
  assert.ok(outcome.notice);
  assert.equal(outcome.notice.previous_revision_id, outcome.branch.baseRevisionId);
  assert.equal(outcome.notice.revision_id, outcome.branch.revisionId);
  assert.deepEqual(outcome.notice.changed_entity_refs, []);
  assert.deepEqual(
    [...outcome.notice.invalidated_consumer_types].sort(),
    ['DEPLOYMENT', 'FLOORPLAN', 'NETWORK', 'POWER', 'THERMAL'],
  );
  assert.equal(outcome.result.impactNoticeId !== null, true);
  assert.equal(outcome.immutabilityFindings, 0);

  // The envelope is frozen at the deterministic, sanitized key.
  assert.equal(outcome.result.objectKey, envelopeKey(outcome.projectId, outcome.branch.revisionId));
  assert.equal(outcome.storage.calls.length, 1);
  const call = outcome.storage.calls[0];
  assert.equal(call.key, `projects/${outcome.projectId}/revisions/${outcome.branch.revisionId}/facility-envelope.json.gz`);
  assert.equal(call.contentType, 'application/gzip');
  const frozen = JSON.parse(gunzipSync(call.body).toString('utf8'));
  assert.equal(frozen.revision_id, outcome.branch.revisionId);
  assert.equal(frozen.lifecycle_state, 'PUBLISHED');
  assert.equal(frozen.content_checksum, outcome.result.contentChecksum);
  assert.equal(frozen.validation_summary.run_id, outcome.result.validationRunId);
  assert.ok(Array.isArray(frozen.capability_coverage));
  assert.ok(frozen.asset_version_refs.length >= 1);
});

test('PUBLISHED is never reopened: a second publish and a branch behave as a correction', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    const { branch } = await publishableBranch({ client, projectId, scenarioId, revisionId, userId });
    const first = await publishRevision({ client, projectId, revisionId: branch.revisionId, actorId: userId, storage: null });
    const second = await expectRefused(client, () =>
      publishRevision({ client, projectId, revisionId: branch.revisionId, actorId: userId, storage: null }));
    // The correction path: a new draft branched from the published revision.
    const correction = await createRevision({
      client, projectId, scenarioId, actorId: userId, name: 'Correction 2', baseRevisionId: branch.revisionId,
    });
    const correctionRevision = await scalar(
      client, 'SELECT lifecycle_state, base_revision_id FROM revisions WHERE project_id = $1 AND revision_id = $2',
      [projectId, correction.revisionId],
    );
    const stillPublished = await scalar(
      client, 'SELECT lifecycle_state, published_at FROM revisions WHERE project_id = $1 AND revision_id = $2',
      [projectId, branch.revisionId],
    );
    return { first, second, correction, correctionRevision, stillPublished };
  });

  assert.equal(outcome.first.lifecycleState, 'PUBLISHED');
  assert.ok(outcome.second);
  assert.equal(outcome.second.code, 'VALIDATION_REQUIRED');
  assert.equal(outcome.second.status, 409);
  assert.equal(outcome.stillPublished.lifecycle_state, 'PUBLISHED');
  assert.equal(outcome.correctionRevision.lifecycle_state, 'DRAFT');
  assert.equal(outcome.correctionRevision.base_revision_id, outcome.first.revisionId);
});

test('publication without a storage adapter still commits with a notice', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    const { branch } = await publishableBranch({ client, projectId, scenarioId, revisionId, userId });
    const result = await publishRevision({ client, projectId, revisionId: branch.revisionId, actorId: userId, storage: null });
    const revision = await scalar(
      client, 'SELECT lifecycle_state FROM revisions WHERE project_id = $1 AND revision_id = $2', [projectId, branch.revisionId],
    );
    return { result, revision };
  });

  assert.equal(outcome.result.lifecycleState, 'PUBLISHED');
  assert.equal(outcome.result.objectKey, null);
  assert.ok(outcome.result.notice);
  assert.equal(outcome.revision.lifecycle_state, 'PUBLISHED');
});

/* ==================================================== approval */

test('recordApproval appends an attestation and projects the envelope approval state', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, projectId, revisionId, userId, ids }) => {
    const approved = await recordApproval({
      client, projectId, revisionId, actorId: userId, policyId: 'deployment-approval@1', decision: 'APPROVED', comment: 'ok',
    });
    const afterApproved = (await scalar(client, 'SELECT approval_state FROM facility_envelopes WHERE project_id = $1 AND envelope_id = $2', [projectId, ids.envelope])).approval_state;
    const revoked = await recordApproval({
      client, projectId, revisionId, actorId: userId, policyId: 'deployment-approval@1', decision: 'REVOKED', comment: 'withdrawn',
    });
    const afterRevoked = (await scalar(client, 'SELECT approval_state FROM facility_envelopes WHERE project_id = $1 AND envelope_id = $2', [projectId, ids.envelope])).approval_state;
    const rows = (await client.query(
      `SELECT decision, comment FROM approval_attestations WHERE project_id = $1 AND revision_id = $2 ORDER BY approved_at, created_at`,
      [projectId, revisionId],
    )).rows;
    const events = (await client.query(
      `SELECT count(*)::int AS c FROM outbox_events WHERE project_id = $1 AND event_type = 'facility.approval.recorded.v1'`,
      [projectId],
    )).rows[0].c;
    const revision = await scalar(client, 'SELECT lifecycle_state FROM revisions WHERE project_id = $1 AND revision_id = $2', [projectId, revisionId]);
    return { approved, revoked, afterApproved, afterRevoked, rows, events, revision };
  });

  assert.equal(outcome.approved.decision, 'APPROVED');
  assert.equal(outcome.approved.approvalState, 'APPROVED');
  assert.equal(outcome.afterApproved, 'APPROVED');
  assert.equal(outcome.revoked.decision, 'REVOKED');
  assert.equal(outcome.afterRevoked, 'REVOKED');
  assert.equal(outcome.rows.length, 2);
  assert.deepEqual(outcome.rows.map((row) => row.decision), ['APPROVED', 'REVOKED']);
  assert.equal(outcome.events, 2);
  // A decision is a record, not a lifecycle mutation.
  assert.equal(outcome.revision.lifecycle_state, 'DRAFT');
});

test('an APPROVED attestation satisfies the publish gate when policy requires one', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, ids, projectId, scenarioId, revisionId, userId }) => {
    await validate(client, { projectId, scenarioId, revisionId, actorId: userId });
    await MUTATIONS['facility.governance.approval.required'](client, ids, projectId);
    const refused = await expectRefused(client, () =>
      publishRevision({ client, projectId, revisionId, actorId: userId, storage: null }));

    await recordApproval({
      client, projectId, revisionId, actorId: userId, policyId: 'deployment-approval@1', decision: 'APPROVED',
    });
    const published = await publishRevision({ client, projectId, revisionId, actorId: userId, storage: null });
    const envelope = await scalar(
      client, 'SELECT approval_state, lifecycle_state FROM facility_envelopes WHERE project_id = $1 AND envelope_id = $2',
      [projectId, ids.envelope],
    );
    return { refused, published, envelope };
  });

  assert.equal(outcome.refused.code, 'VALIDATION_REQUIRED');
  assert.equal(outcome.published.lifecycleState, 'PUBLISHED');
  assert.equal(outcome.envelope.lifecycle_state, 'PUBLISHED');
  assert.equal(outcome.envelope.approval_state, 'APPROVED');
});

test('an attestation cannot be recorded against a PUBLISHED revision', { skip }, async () => {
  const error = await withBaseline(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    const { branch } = await publishableBranch({ client, projectId, scenarioId, revisionId, userId });
    await publishRevision({ client, projectId, revisionId: branch.revisionId, actorId: userId, storage: null });
    return expectRefused(client, () => recordApproval({
      client, projectId, revisionId: branch.revisionId, actorId: userId, policyId: 'deployment-approval@1', decision: 'REVOKED',
    }));
  });

  assert.ok(error);
  assert.equal(error.code, 'REVISION_IMMUTABLE');
  assert.equal(error.status, 409);
});

/* ==================================================== impact notices */

test('issueImpactNotice inserts one notice and rejects an unknown consumer type', { skip }, async () => {
  const outcome = await withBaseline(async ({ client, projectId, scenarioId, revisionId, userId }) => {
    const previous = randomUUID();
    await client.query(
      `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
       VALUES ($1, $2, $3, 'DRAFT', 'Previous')`,
      [previous, projectId, scenarioId],
    );
    const notice = await issueImpactNotice({
      client,
      projectId,
      scenarioId,
      previousRevisionId: previous,
      revisionId,
      changedEntityRefs: [{ entity_type: 'BUILDING', entity_id: randomUUID() }],
      invalidatedConsumerTypes: ['POWER', 'THERMAL'],
      actorId: userId,
    });
    const rows = (await client.query(
      'SELECT count(*)::int AS c FROM impact_notices WHERE project_id = $1',
      [projectId],
    )).rows[0].c;
    const error = await expectRefused(client, () => issueImpactNotice({
      client,
      projectId,
      scenarioId,
      previousRevisionId: previous,
      revisionId,
      invalidatedConsumerTypes: ['NOT_A_CONSUMER'],
      actorId: userId,
    }));
    return { notice, rows, error };
  });

  assert.ok(outcome.notice.impactNoticeId);
  assert.equal(outcome.notice.previousRevisionId !== outcome.notice.revisionId, true);
  assert.deepEqual([...outcome.notice.invalidatedConsumerTypes].sort(), ['POWER', 'THERMAL']);
  assert.equal(outcome.rows, 1);
  assert.ok(outcome.error);
  assert.equal(outcome.error.code, 'VALIDATION_FAILED');
  assert.equal(outcome.error.status, 400);
});
