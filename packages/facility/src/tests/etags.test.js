import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import { advanceEtag, ensureEtag, readEtag, requireBaseRevision, requireDraft } from '../index.js';

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
 * A revision with no ETag row yet, inside one transaction that is rolled back.
 *
 * The row is deliberately *not* created, because "a revision predating the token"
 * is the state this module has to handle and the state the dev database is in.
 */
async function withRevision(fn, { lifecycleState = 'DRAFT', baseRevisionId = null } = {}) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `etag-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Etag org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
        projectId,
        organizationId,
        'Etag project',
      ]);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
        scenarioId,
        projectId,
        'Baseline',
      ]);

      // A base revision has to exist to be referenced, so a real one is inserted
      // rather than a dangling id: the contract's whole point is that the base is
      // validated, and a fixture that could not violate it would prove nothing.
      let base = null;
      if (baseRevisionId === 'generate') {
        base = randomUUID();
        await client.query(
          `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
           VALUES ($1, $2, $3, 'DRAFT', 'Base draft')`,
          [base, projectId, scenarioId],
        );
      }

      // A revision that is no longer a draft must carry a content checksum: the
      // schema enforces that a frozen revision has immutable content to hash.
      const checksum = lifecycleState === 'DRAFT' ? null : 'fixture-content-checksum';
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name, base_revision_id, content_checksum)
         VALUES ($1, $2, $3, $4, 'Draft 1', $5, $6)`,
        [revisionId, projectId, scenarioId, lifecycleState, base, checksum],
      );

      const scope = { client, projectId, scenarioId, revisionId, userId, base };
      throw new Rollback(await fn(scope));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
}

const scopeArgs = (scope) => ({ projectId: scope.projectId, revisionId: scope.revisionId });

/** Captures a synchronous guard's refusal, which throws rather than returning. */
const refusal = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
};

test('a revision begins with no token, and reads as absent rather than invented', { skip }, async () => {
  const result = await withRevision(async (scope) => ({
    before: await readEtag({ client: scope.client, ...scopeArgs(scope) }),
    after: await ensureEtag({ client: scope.client, ...scopeArgs(scope), scenarioId: scope.scenarioId, actorId: scope.userId }),
  }));

  assert.equal(result.before, null, 'a read must not create the row');
  assert.match(result.after.etag, /^[0-9a-f-]{36}$/i);
  assert.equal(result.after.etagVersion, 0, 'a fresh token is version zero');
});

test('ensuring a token twice does not advance it', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const first = await ensureEtag({ client: scope.client, ...scopeArgs(scope), scenarioId: scope.scenarioId });
    const second = await ensureEtag({ client: scope.client, ...scopeArgs(scope), scenarioId: scope.scenarioId });
    return { first, second };
  });

  assert.equal(result.second.etag, result.first.etag, 'a backfill is idempotent');
  assert.equal(result.second.etagVersion, 0);
});

test('advancing with the current token changes it and bumps the version', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const before = await ensureEtag({ client: scope.client, ...scopeArgs(scope), scenarioId: scope.scenarioId });
    const after = await advanceEtag({ client: scope.client, ...scopeArgs(scope), expectedEtag: before.etag, actorId: scope.userId });
    const reread = await readEtag({ client: scope.client, ...scopeArgs(scope) });
    return { before, after, reread };
  });

  assert.notEqual(result.after.etag, result.before.etag, 'the token is opaque and changes on every commit');
  assert.equal(result.after.etagVersion, 1);
  assert.deepEqual(result.reread, result.after, 'the advanced value is the stored value');
});

test('a stale token is refused with the catalog diagnostic, not a silent overwrite', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const first = await ensureEtag({ client: scope.client, ...scopeArgs(scope), scenarioId: scope.scenarioId });
    // One writer wins.
    const winner = await advanceEtag({ client: scope.client, ...scopeArgs(scope), expectedEtag: first.etag });
    // The second still holds the token it read.
    const loser = await advanceEtag({ client: scope.client, ...scopeArgs(scope), expectedEtag: first.etag }).catch((error) => error);
    const current = await readEtag({ client: scope.client, ...scopeArgs(scope) });
    return { first, winner, loser, current };
  });

  assert.equal(result.loser.status, 409);
  assert.equal(result.loser.code, 'REVISION_ETAG_STALE');
  assert.equal(result.loser.details[0].constraint_id, 'facility.revision.current');
  assert.equal(result.loser.details[0].expected_etag, result.first.etag);
  assert.equal(result.loser.details[0].current_etag, result.winner.etag, 'the loser is told the current value');
  assert.deepEqual(result.current, result.winner, 'the winner is not overwritten');
});

test('a missing token is refused, and a write without one is refused earlier still', { skip }, async () => {
  const result = await withRevision(async (scope) => {
    const missing = await advanceEtag({ client: scope.client, ...scopeArgs(scope), expectedEtag: randomUUID() }).catch((error) => error);
    const omitted = await advanceEtag({ client: scope.client, ...scopeArgs(scope), expectedEtag: null }).catch((error) => error);
    return { missing, omitted };
  });

  assert.equal(result.missing.code, 'REVISION_ETAG_MISSING');
  assert.equal(result.missing.details[0].reason, 'no_etag_row');
  assert.equal(result.omitted.status, 428, 'an unconditional draft write is refused before it is attempted');
  assert.equal(result.omitted.code, 'REVISION_ETAG_REQUIRED');
});

test('the lifecycle guard freezes a revision that is no longer a draft', { skip }, async () => {
  const result = await withRevision(
    async (scope) => {
      const allowed = await requireDraft({ client: scope.client, ...scopeArgs(scope) }).catch((error) => error);
      return { allowed };
    },
    { lifecycleState: 'VALIDATED' },
  );

  assert.equal(result.allowed.status, 409);
  assert.equal(result.allowed.code, 'REVISION_IMMUTABLE');
  assert.equal(result.allowed.details[0].constraint_id, 'facility.revision.writes_immutable');
  assert.equal(result.allowed.details[0].lifecycle_state, 'VALIDATED');
});

test('a draft is allowed through the lifecycle guard', { skip }, async () => {
  const result = await withRevision(async (scope) =>
    requireDraft({ client: scope.client, ...scopeArgs(scope) }),
  );
  assert.equal(result.lifecycle_state, 'DRAFT');
});

test('a matching token never excuses an unrelated base revision', { skip }, async () => {
  // [D2]: the two preconditions are independent.
  const result = await withRevision(
    async (scope) => {
      const token = await ensureEtag({ client: scope.client, ...scopeArgs(scope), scenarioId: scope.scenarioId });
      const revision = await requireDraft({ client: scope.client, ...scopeArgs(scope) });
      const matching = refusal(() => requireBaseRevision({ revision, baseRevisionId: scope.base }));
      const wrongBase = refusal(() => requireBaseRevision({ revision, baseRevisionId: randomUUID() }));
      const omittedBase = refusal(() => requireBaseRevision({ revision, baseRevisionId: null }));
      return { token, base: scope.base, matching, wrongBase, omittedBase };
    },
    { baseRevisionId: 'generate' },
  );

  assert.equal(result.matching.value, true);
  assert.equal(result.wrongBase.error.status, 409);
  assert.equal(result.wrongBase.error.code, 'REVISION_BASE_MISMATCH');
  assert.equal(result.wrongBase.error.details[0].reason, 'base_revision_mismatch');
  assert.equal(result.wrongBase.error.details[0].expected_base_revision_id, result.base);
  assert.notEqual(result.wrongBase.error.details[0].supplied_base_revision_id, result.base);
  assert.equal(result.omittedBase.error.status, 428);
  assert.equal(result.omittedBase.error.code, 'REVISION_BASE_REQUIRED');
  assert.equal(result.omittedBase.error.details[0].reason, 'required');
});
