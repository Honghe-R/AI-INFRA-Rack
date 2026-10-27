import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '@ai-infra/db';
import { createFilesystemStorage } from '@ai-infra/storage';
import { createSessionService } from '../sessions.js';
import { createUsageService } from '../usage.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
let root;
let storage;

before(async () => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  root = await mkdtemp(join(tmpdir(), 'ai-infra-assistant-'));
  storage = createFilesystemStorage({ root });
});

after(async () => {
  if (pool) await pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const { createRbacRepository } = await import('@ai-infra/rbac');
  const repository = createRbacRepository({ pool });
  const user = await repository.createUser({ subject: `assistant-user-${randomUUID()}` });
  return {
    userId: user.userId,
    async cleanup() {
      await pool.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
    },
  };
}

test('a session is ensured, a turn is appended, and a retry is deduplicated', { skip }, async () => {
  const f = await fixture();
  try {
    const sessions = createSessionService({ pool, storage });
    const session = await sessions.ensure({ userId: f.userId, contextKey: 'facility', surface: 'site_facility', workspaceId: null });
    assert.ok(session.sessionId);

    const requestId = randomUUID();
    const stored = { schemaVersion: 1, requestId, response: { status: 'ok' }, messages: [{ role: 'user', content: 'hello' }] };
    const first = await sessions.appendTurn({ sessionId: session.sessionId, requestId, turn: stored });
    assert.equal(first, 1);

    const retry = await sessions.appendTurn({ sessionId: session.sessionId, requestId, turn: stored });
    assert.equal(retry, null, 'a retried request appends nothing');

    const history = await sessions.load({ sessionId: session.sessionId, userId: f.userId, contextKey: 'facility' });
    assert.equal(history.turnCount, 1);
    assert.equal(history.turns[0].response.status, 'ok');
    assert.equal(history.turns[0].messages[0].content, 'hello');

    const listed = await sessions.list({ userId: f.userId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].turnCount, 1);
  } finally {
    await f.cleanup();
  }
});

test('another owner sees an empty history, not an error', { skip }, async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const sessions = createSessionService({ pool, storage });
    const session = await sessions.ensure({ userId: f.userId, contextKey: 'facility', surface: 'site_facility' });
    await sessions.appendTurn({ sessionId: session.sessionId, requestId: randomUUID(), turn: { schemaVersion: 1 } });

    const foreign = await sessions.load({ sessionId: session.sessionId, userId: other.userId, contextKey: 'facility' });
    assert.deepEqual(foreign.turns, []);
    assert.deepEqual((await sessions.list({ userId: other.userId })), []);
  } finally {
    await f.cleanup();
    await other.cleanup();
  }
});

test('the usage log is append-only and re-aggregates per scope', { skip }, async () => {
  const f = await fixture();
  try {
    const usage = createUsageService({ pool, limits: { userMonthlyTokens: 5 } });
    const executionContext = { initiatedBy: { userId: f.userId }, workspaceId: null, organisationId: null, sessionId: null };
    const context = { contextKey: 'facility', surface: 'site_facility', workspaceId: null, organisationId: null };

    const before = await usage.precheck({ context, executionContext });
    assert.equal(before.allowed, true);

    await usage.record({ context, executionContext, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_input_tokens: 1, cached_output_tokens: 0 }, requestId: randomUUID() });

    const after = await usage.precheck({ context, executionContext });
    assert.equal(after.allowed, false);
    assert.equal(after.code, 'ASSISTANT_QUOTA_EXCEEDED');
    assert.equal(after.status, 429);

    const summary = await usage.summary({ scopeKind: 'user', scopeId: f.userId });
    assert.equal(summary.totalTokens, 5);
    assert.equal(summary.turns, 1);

    // A turn spent inside a workspace records there, but the composer's "overall
    // user usage" still has to see it, because it is a per-person view.
    const workspaceId = randomUUID();
    await usage.record({
      context: { contextKey: 'facility', surface: 'site_facility', workspaceId, organisationId: null },
      executionContext: { initiatedBy: { userId: f.userId }, workspaceId, organisationId: null, sessionId: null },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_input_tokens: 0, cached_output_tokens: 0 },
      requestId: randomUUID(),
    });
    const across = await usage.userSummary({ userId: f.userId });
    assert.equal(across.totalTokens, 7, 'the user total spans every scope');
    assert.equal(across.turns, 2);
    // The overall column of the composer's usage popover shows cached tokens beside the
    // totals, and this figure spans work the open conversation never saw.
    assert.equal(across.cachedInputTokens, 1, 'the cached input of every scope is summed');
    assert.equal(across.cachedOutputTokens, 0);
    assert.equal((await usage.summary({ scopeKind: 'workspace', scopeId: workspaceId })).totalTokens, 2);

    await assert.rejects(
      pool.query("UPDATE assistant_usage_log SET total_tokens = 0 WHERE scope_id = $1", [f.userId]),
      /append-only/,
    );
  } finally {
    await f.cleanup();
  }
});
