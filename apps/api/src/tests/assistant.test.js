import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAssistantHost, createDefaultCatalog, createLlmProvider, defineCapability } from '@ai-infra/assistant';
import { createLogger } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createApp } from '../app.js';
import { createAssistantScopeResolver, createPermissionAuthorizer } from '../assistant-host.js';
import { createRouter } from '../router.js';
import { registerAssistantRoutes } from '../routes/assistant.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;
let repository;
let evaluator;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
  repository = createRbacRepository({ pool });
  evaluator = createEvaluator({ repository });
});

after(async () => {
  if (pool) await pool.end();
});

const listTool = defineCapability({
  name: 'list_containers',
  description: 'List containers.',
  inputSchema: { type: 'object', properties: {} },
  access: 'read',
  surfaces: ['site_facility'],
  handler: async () => ({ containers: [{ entityId: 'e-1', name: 'Data Hall 01', entityType: 'HALL' }] }),
});

function assistantMessage(content, toolCalls = null) {
  return {
    choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
    model: 'fake-1',
    provider: 'fake',
  };
}

function toolCall(name, args = {}, id = 'call-1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** The session store only needs put/get; a Map proves the API path without S3. */
function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    async putObject({ key, body }) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      objects.set(key, buffer);
      return { key, size: buffer.length };
    },
    async getObject({ key }) {
      const buffer = objects.get(key);
      if (!buffer) return null;
      return {
        size: buffer.length,
        body: (async function* stream() {
          yield buffer;
        })(),
      };
    },
    async deleteObject({ key }) {
      objects.delete(key);
      return { key, deleted: true };
    },
  };
}

async function fixture() {
  const suffix = randomUUID();
  const member = await repository.createUser({ subject: `assistant-member-${suffix}` });
  const outsider = await repository.createUser({ subject: `assistant-outsider-${suffix}` });
  const organization = await repository.createOrganization({ name: `Assistant Org ${suffix}`, ownerUserId: member.userId });
  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organization.organizationId,
    'Assistant Project',
  ]);
  // A project viewer holds facility.read, which is the guide's entry permission.
  await repository.assignRole({ userId: member.userId, roleKey: 'project-viewer', scopeKind: 'project', scopeId: projectId });

  return {
    member,
    outsider,
    projectId,
    async cleanup() {
      await pool.query(
        `DELETE FROM role_assignments
          WHERE user_id = ANY($1) OR created_by = ANY($1)
             OR (scope_kind = 'project' AND scope_id = $2)`,
        [[member.userId, outsider.userId], projectId],
      );
      await pool.query('DELETE FROM projects WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM organizations WHERE organization_id = $1', [organization.organizationId]);
      // Sessions, turns, and the usage ledger cascade from the users row.
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2)', [member.userId, outsider.userId]);
    },
  };
}

async function withServer(userId, fn, { responses = [], models = [] } = {}) {
  let calls = 0;
  // What the provider was actually asked to run, so a test can prove a choice reached it
  // rather than inferring it from a gateway that would have accepted anything.
  let lastCompleteArgs = null;
  const provider = createLlmProvider({
    name: 'fake',
    model: 'fake-1',
    complete: async (args) => {
      lastCompleteArgs = args;
      const entry = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (typeof entry === 'function') return entry();
      if (entry instanceof Error) throw entry;
      return entry;
    },
  });

  const guard = createPermissionGuard({ evaluator, repository });
  const storage = memoryStorage();
  const host = createAssistantHost({
    provider,
    pool,
    storage,
    ...createDefaultCatalog(),
    capabilities: [listTool],
    resolveScope: createAssistantScopeResolver({ pool }),
    authorize: createPermissionAuthorizer({ guard }),
  });

  const router = createRouter();
  registerAssistantRoutes(router, { ...host, models });

  const authenticator = {
    async authenticate(ctx) {
      ctx.user = { userId, status: 'ACTIVE' };
      return ctx.user;
    },
  };
  const logger = createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' });
  const server = createServer(createApp({ config: {}, logger, pool, router, authenticator, guard }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await fn({
      base: `http://127.0.0.1:${port}`,
      host,
      storage,
      get calls() {
        return calls;
      },
      get lastCompleteArgs() {
        return lastCompleteArgs;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postChat(base, body) {
  const response = await fetch(`${base}/api/v1/assistant/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

const chatBody = (projectId, overrides = {}) => ({
  messages: [{ role: 'user', content: 'What is in the facility?' }],
  context_key: `${projectId}|scenario-1|revision-1`,
  context: { surface: 'site_facility', projectId },
  ...overrides,
});

test('a turn runs the model the caller chose, and only from the menu', async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      // Read lazily, not destructured: `lastCompleteArgs` is a getter, and destructuring
      // would evaluate it once before the request and always see null.
      async (state) => {
        const chosen = await postChat(state.base, chatBody(f.projectId, { model: 'fake-2' }));
        assert.equal(chosen.response.status, 200);
        assert.equal(state.lastCompleteArgs.model, 'fake-2', 'the chosen model reaches the provider');

        // Absent means the deployment's own model, not "any model".
        await postChat(state.base, chatBody(f.projectId));
        assert.equal(state.lastCompleteArgs.model, 'fake-1');

        // A model outside the published menu is refused rather than silently swapped: the
        // composer would otherwise label the turn with a model that did not answer it.
        const denied = await postChat(state.base, chatBody(f.projectId, { model: 'not-offered' }));
        assert.equal(denied.response.status, 400);
        assert.equal(denied.body.error.code, 'MODEL_NOT_ALLOWED');
      },
      { models: ['fake-1', 'fake-2'], responses: [assistantMessage('ok')] },
    );
  } finally {
    await f.cleanup();
  }
});

test('a streamed turn reports each round before the envelope', async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      async ({ base }) => {
        const response = await fetch(`${base}/api/v1/assistant/chat?stream=1`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(chatBody(f.projectId)),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /ndjson/, 'the mode is declared');

        const events = (await response.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const types = events.map((event) => event.type);

        // The envelope is last, so a reader that ignores the stream still ends up with the
        // same turn — and a reader that follows it has the rounds before the answer.
        assert.equal(types[types.length - 1], 'turn');
        assert.equal(types.filter((type) => type === 'round').length, 2, 'one record per round');

        const firstRound = events.find((event) => event.type === 'round');
        assert.equal(firstRound.round.iteration, 1);
        assert.equal(firstRound.round.calls[0].name, 'list_containers');
        assert.equal(firstRound.round.calls[0].outcome, 'ok');
        assert.ok(firstRound.round.providerMs >= 0);
        assert.equal(events[events.length - 1].data.status, 'ok');
      },
      { responses: [assistantMessage('', [toolCall('list_containers')]), assistantMessage('Data Hall 01 is provisional.')] },
    );
  } finally {
    await f.cleanup();
  }
});

test('a turn returns the client envelope and persists the session and its history', { skip }, async () => {
  const f = await fixture();
  try {
    const contextKey = chatBody(f.projectId).context_key;
    await withServer(
      f.member.userId,
      async ({ base }) => {
        const { response, body } = await postChat(base, chatBody(f.projectId));
        assert.equal(response.status, 200);
        assert.equal(body.data.status, 'ok');
        assert.ok(body.data.sessionId, 'a session id comes back for the composer');
        assert.equal(body.data.trace.toolCalls[0].name, 'list_containers');
        assert.ok(body.data.choices[0].message.content.includes('[**Data Hall 01**](entity://facility.entity/e-1)'));
        assert.deepEqual(body.data.entities.map((entity) => entity.label), ['Data Hall 01']);
        assert.equal(body.data.usage.total_tokens, 6, 'usage is summed across rounds');
        assert.equal(body.data.usage.cached_input_tokens, 2);

        const sessions = await (await fetch(`${base}/api/v1/assistant/sessions?context_key=${encodeURIComponent(contextKey)}`)).json();
        assert.equal(sessions.data.sessions.length, 1);
        assert.equal(sessions.data.sessions[0].turnCount, 1);

        const history = await (
          await fetch(`${base}/api/v1/assistant/sessions/${body.data.sessionId}/history?context_key=${encodeURIComponent(contextKey)}`)
        ).json();
        assert.equal(history.data.turnCount, 1);
        assert.equal(history.data.turns[0].messages[0].content, 'What is in the facility?');
        assert.equal(history.data.turns[0].response.status, 'ok');
      },
      { responses: [assistantMessage('', [toolCall('list_containers')]), assistantMessage('Data Hall 01 is provisional.')] },
    );
  } finally {
    await f.cleanup();
  }
});

test('a caller without the entry permission is refused before any provider call', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(
      f.outsider.userId,
      async (state) => {
        const { response, body } = await postChat(state.base, chatBody(f.projectId));
        assert.equal(response.status, 403);
        assert.equal(body.error.code, 'ASSISTANT_FORBIDDEN');
        assert.deepEqual(body.error.details, [{ permission_key: 'facility.read' }]);
        assert.equal(state.calls, 0);
      },
      { responses: [assistantMessage('should never run')] },
    );
  } finally {
    await f.cleanup();
  }
});

test('a missing context and an unknown project are refused, not defaulted', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      async (state) => {
        const missing = await postChat(state.base, { messages: [{ role: 'user', content: 'hi' }], context_key: 'x' });
        assert.equal(missing.response.status, 400);
        assert.equal(missing.body.error.code, 'ASSISTANT_CONTEXT_UNKNOWN');

        const unknown = await postChat(state.base, chatBody(randomUUID()));
        assert.equal(unknown.response.status, 404);
        assert.equal(state.calls, 0);
      },
      { responses: [assistantMessage('should never run')] },
    );
  } finally {
    await f.cleanup();
  }
});

test('a provider failure is mapped to its documented status and an empty turn is refused', { skip }, async () => {
  const f = await fixture();
  try {
    await withServer(
      f.member.userId,
      async (state) => {
        const limited = await postChat(state.base, chatBody(f.projectId));
        assert.equal(limited.response.status, 429);
        assert.equal(limited.body.error.code, 'LLM_RATE_LIMITED');

        const empty = await postChat(state.base, chatBody(f.projectId, { messages: [] }));
        assert.equal(empty.response.status, 400);
        assert.equal(empty.body.error.code, 'ASSISTANT_MESSAGES_REQUIRED');
        assert.equal(state.calls, 1, 'a rejected turn reaches no provider');
      },
      {
        responses: [Object.assign(new Error('slow down'), { status: 429 })],
      },
    );
  } finally {
    await f.cleanup();
  }
});

test('another user sees an empty history and the caller sees their own usage', { skip }, async () => {
  const f = await fixture();
  try {
    const sessionId = await withServer(
      f.member.userId,
      async ({ base }) => {
        const { body } = await postChat(base, chatBody(f.projectId));
        await waitFor(async () => {
          const usage = await (await fetch(`${base}/api/v1/assistant/usage`)).json();
          return usage.data.totalTokens >= 3 ? usage.data : null;
        });
        return body.data.sessionId;
      },
      { responses: [assistantMessage('No tools were needed.')] },
    );

    await withServer(f.outsider.userId, async ({ base }) => {
      const history = await (
        await fetch(`${base}/api/v1/assistant/sessions/${sessionId}/history?context_key=${encodeURIComponent(chatBody(f.projectId).context_key)}`)
      ).json();
      assert.equal(history.data.turns.length, 0, 'a foreign session reads as empty, not an error');
    });
  } finally {
    await f.cleanup();
  }
});

/** Usage is recorded post-response, so give the ledger a bounded moment to land. */
async function waitFor(probe, { attempts = 20, delayMs = 25 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('The usage ledger did not record the turn in time.');
}
