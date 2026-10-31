import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createLogger, errors } from '@ai-infra/core';
import { createAssistantHost } from '@ai-infra/assistant';
import { createDeveloperWorkspace, dockerRunArguments } from '../services/developer-workspace.js';
import { createDeveloperSurface } from '../services/developer-assistant.js';
import { composeSystemPrompt } from '../../../../packages/assistant/src/prompt.js';
import { registerAssistantRoutes } from '../routes/assistant.js';
import { createRouter } from '../router.js';
import { createApp } from '../app.js';

async function fixture(fn) {
  const fixtureRoot = fileURLToPath(new URL('../../../../.local-runtime/developer-tests/', import.meta.url));
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(join(fixtureRoot, 'case-')), sourceRoot = join(directory, 'source'), root = join(directory, 'workspaces');
  await mkdir(join(sourceRoot, 'apps'), { recursive: true });
  await mkdir(join(sourceRoot, '.local-runtime/auth'), { recursive: true });
  await writeFile(join(sourceRoot, 'apps/example.js'), 'export const count = 1;\n');
  await writeFile(join(sourceRoot, 'README.md'), '# Example\n');
  await writeFile(join(sourceRoot, '.env'), 'SECRET=not-for-the-agent');
  await writeFile(join(sourceRoot, '.local-runtime/auth/accounts.json'), 'private-fixture');
  let authorized = true;
  const executions = [];
  const service = createDeveloperWorkspace({ sourceRoot, root, enabled: true, authorize: async () => authorized,
    execute: async (args, options) => { executions.push({ args, options }); return { exitCode: 0, output: 'fixture passed', truncated: false, timedOut: false }; } });
  const ctx = { workspaceId: randomUUID(), initiatedBy: { userId: randomUUID() }, requestId: randomUUID() };
  const fresh = () => ({ ...ctx, requestId: randomUUID() });
  try { await fn({ service, ctx, sourceRoot, root, directory, executions, fresh, revoke: () => { authorized = false; } }); }
  finally {
    const absolute = resolve(directory), parent = resolve(fixtureRoot);
    if (!(absolute.startsWith(parent + '\\') || absolute.startsWith(parent + '/'))) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}

test('file tools edit an isolated snapshot with version hashes and export an applicable patch', () => fixture(async f => {
  const files = await f.service.list(f.ctx, {}); assert.ok(files.files.includes('apps/example.js')); assert.ok(!files.files.includes('.env'));
  const first = await f.service.read(f.ctx, { path: 'apps/example.js' });
  await f.service.edit(f.ctx, { path: first.path, expected_hash: first.hash, find: 'count = 1', replace: 'count = 2' });
  assert.equal(await readFile(join(f.sourceRoot, first.path), 'utf8'), 'export const count = 1;\n');
  await assert.rejects(f.service.edit(f.ctx, { path: first.path, expected_hash: first.hash, content: 'stale' }), e => e.code === 'DEVELOPER_FILE_CONFLICT');
  const result = await f.service.export(f.ctx); assert.equal(result.items.length, 1); assert.match(result.patch, /\+export const count = 2/);
  const patchFile = join(f.directory, 'changes.patch'); await writeFile(patchFile, result.patch);
  const check = spawnSync('git', ['apply', '--check', patchFile], { cwd: f.sourceRoot, windowsHide: true, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.ok((await f.service.search(f.ctx, { query: 'count = 2' })).items.length);
}));

test('paths cannot reach secrets, runtime, teacher directories or alternate Windows paths', () => fixture(async f => {
  for (const path of ['../README.md', 'C:/Users/RHH/Desktop/AI-INFRA/README.md', '/README.md', '.env',
    'apps/../../.env', '.local-runtime/auth/accounts.json', 'apps/example.js:stream', 'apps/CON.js']) {
    await assert.rejects(f.service.read(f.fresh(), { path }), e => e.code === 'DEVELOPER_INPUT_INVALID');
  }
  const denied = createDeveloperWorkspace({ enabled: false });
  await assert.rejects(denied.list(f.ctx, {}), e => e.code === 'DEVELOPER_DISABLED');
}));

test('create/delete are hash-checked, owner/project isolated and recheck revocation', () => fixture(async f => {
  await f.service.edit(f.ctx, { path: 'apps/new.js', expected_hash: null, content: 'hello' });
  assert.equal((await f.service.read(f.ctx, { path: 'apps/new.js' })).content, 'hello');
  const other = { ...f.ctx, initiatedBy: { userId: randomUUID() } };
  await assert.rejects(f.service.read(other, { path: 'apps/new.js' }), e => e.code === 'ENOENT');
  const third = { ...f.ctx, workspaceId: randomUUID() };
  await assert.rejects(f.service.read(third, { path: 'apps/new.js' }), e => e.code === 'ENOENT');
  const file = await f.service.read(f.ctx, { path: 'apps/new.js' });
  await f.service.edit(f.ctx, { path: file.path, expected_hash: file.hash }, true);
  assert.deepEqual((await f.service.export(f.ctx)).items, []);
  f.revoke(); await assert.rejects(f.service.list(f.ctx, {}), e => e.status === 403);
}));

test('snapshot rejects a junction and edit replacement must be unique', () => fixture(async f => {
  await f.service.list(f.ctx, {});
  const directories = await (await import('node:fs/promises')).readdir(f.root);
  const tree = join(f.root, directories[0], 'tree');
  await symlink(f.sourceRoot, join(tree, 'apps/link'), 'junction');
  await assert.rejects(f.service.read(f.ctx, { path: 'apps/link/README.md' }), e => e.code === 'DEVELOPER_INPUT_INVALID');
  const first = await f.service.read(f.ctx, { path: 'apps/example.js' });
  await assert.rejects(f.service.edit(f.ctx, { path: first.path, expected_hash: first.hash, find: 'missing', replace: 'new' }), /exactly once/);
}));

test('Docker execution enforces isolation, no live mounts, cancellation propagation and turn budgets', () => fixture(async f => {
  await assert.rejects(f.service.edit({ ...f.ctx, readOnly: true }, { path: 'apps/new.js', expected_hash: null, content: 'blocked' }), e => e.status === 403);
  await assert.rejects(f.service.run({ ...f.ctx, readOnly: true }, { command: 'node --version' }), e => e.status === 403);
  const abort = new AbortController();
  await f.service.run({ ...f.ctx, signal: abort.signal }, { command: 'node --check apps/example.js' });
  const run = f.executions[0];
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--user=1000:1000', '--pids-limit=128']) assert.ok(run.args.includes(flag));
  const mount = run.args[run.args.indexOf('--mount') + 1]; assert.match(mount, /target=\/input,readonly/); assert.ok(!mount.includes(f.sourceRoot));
  assert.equal(run.options.signal, abort.signal);
  assert.deepEqual(f.executions[1].args.slice(0, 2), ['rm', '-f']);
  await f.service.run(f.ctx, { command: 'node --version' });
  await assert.rejects(f.service.run(f.ctx, { command: 'node --version' }), e => e.code === 'DEVELOPER_CALL_LIMIT');
  assert.equal(dockerRunArguments({ tree: 'tree', name: 'name', command: 'echo example' }).at(-1), 'echo example');
}));

test('Rack and legacy development prompts permit relative source paths while other surfaces stay restricted', () => {
  const development = composeSystemPrompt({ guide: { surface: 'rack_developer' } });
  assert.match(development, /show relative source paths, sandbox commands and test diagnostics/);
  assert.match(development, /Never reveal credentials, private host paths/);
  assert.match(composeSystemPrompt({ guide: { surface: 'rack' } }), /show relative source paths/);
  assert.match(composeSystemPrompt({ guide: { surface: 'site_facility' } }), /commands, credentials, or file paths/);
});

test('status and patch HTTP routes authenticate actor, bind project and recheck revoked access', () => fixture(async f => {
  const router = createRouter();
  registerAssistantRoutes(router, { orchestrator: {}, developer: f.service });
  const server = createServer(createApp({ router,
    logger: createLogger({ sink: { log() {}, warn() {}, error() {} }, level: 'error' }),
    authenticator: { async authenticate(ctx) {
      if (ctx.headers['x-test-user'] !== 'fixture') throw errors.unauthorized();
      ctx.user = { userId: f.ctx.initiatedBy.userId };
    } },
  }));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/assistant/developer`;
  const headers = { 'x-test-user': 'fixture' };
  const url = kind => `${base}/${kind}?project_id=${f.ctx.workspaceId}`;
  try {
    assert.equal((await fetch(url('status'))).status, 401);
    const status = await fetch(url('status'), { headers });
    assert.equal(status.status, 200); assert.equal((await status.json()).data.runtimeReady, true);
    await f.service.edit(f.ctx, { path: 'apps/http.js', expected_hash: null, content: 'export const ready = true;\n' });
    const patch = await fetch(url('patch'), { headers });
    assert.equal(patch.status, 200); assert.equal(patch.headers.get('cache-control'), 'no-store');
    assert.match(patch.headers.get('content-disposition'), /attachment/);
    assert.match(await patch.text(), /apps\/http.js/);
    f.revoke();
    assert.equal((await fetch(url('patch'), { headers })).status, 403);
    assert.equal((await fetch(url('status'), { headers })).status, 403);
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
}));

test('scripted model performs read → edit → command → diff without any provider network or paid tokens', () => fixture(async f => {
  const development = createDeveloperSurface(f.service); let round = 0;
  const toolCall = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call-${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const provider = { async complete(request) {
    round++; assert.equal(request.modelOptions.max_tokens, 900);
    assert.ok(request.tools.every(t => t.function.name.startsWith('dev_')));
    const read = request.messages.find(m => m.name === 'dev_read_file');
    return { choices: [{ message: round === 1 ? toolCall('dev_read_file', { path: 'apps/example.js' })
      : round === 2 ? toolCall('dev_edit_file', { path: 'apps/example.js', expected_hash: JSON.parse(read.content).hash, find: 'count = 1', replace: 'count = 2' })
      : round === 3 ? toolCall('dev_run_command', { command: 'node --check apps/example.js' })
      : round === 4 ? toolCall('dev_changes', { include_diff: true }) : { role: 'assistant', content: 'Private source updated; fixture syntax check passed. Download and review the patch.' } }] };
  } };
  const host = createAssistantHost({ provider, surfaces: [development.surface], guides: [development.guide], capabilities: development.capabilities,
    authorize: async () => true, resolveScope: async () => ({ surface: 'rack_developer', workspaceId: f.ctx.workspaceId }) });
  const result = await host.orchestrator.runTurn({ contextKey: 'test|rack_developer', permissionMode: 'full', context: { userId: f.ctx.initiatedBy.userId }, messages: [{ role: 'user', content: 'Change example count to 2 and check syntax.' }] });
  assert.equal(result.status, 'ok'); assert.equal(round, 5); assert.equal((await f.service.export(f.ctx)).items.length, 1);
  assert.equal(result.draftChanged, false, 'Private code edits must not trigger a live Plan reload.');
  assert.equal(await readFile(join(f.sourceRoot, 'apps/example.js'), 'utf8'), 'export const count = 1;\n');
}));

test('development stops at six scripted model rounds instead of running indefinitely', () => fixture(async f => {
  const development = createDeveloperSurface(f.service); let rounds = 0;
  const host = createAssistantHost({ surfaces: [development.surface], guides: [development.guide], capabilities: development.capabilities,
    authorize: async () => true, resolveScope: async () => ({ surface: 'rack_developer', workspaceId: f.ctx.workspaceId }),
    provider: { async complete() {
      rounds++;
      return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: `read-${rounds}`, type: 'function',
        function: { name: 'dev_read_file', arguments: JSON.stringify({ path: 'apps/example.js' }) } }] } }] };
    } } });
  await assert.rejects(host.orchestrator.runTurn({ contextKey: 'budget|rack_developer', context: { userId: f.ctx.initiatedBy.userId },
    messages: [{ role: 'user', content: 'Read the file.' }] }), e => e.code === 'ASSISTANT_ITERATION_BUDGET');
  assert.equal(rounds, 6);
}));

test('Ask gates edits and Read only rejects confirmed writes while retaining source queries', () => fixture(async f => {
  const surface = createDeveloperSurface(f.service);
  for (const mode of ['ask', 'read_only']) {
    let calls = 0;
    const host = createAssistantHost({ surfaces: [surface.surface], guides: [surface.guide], capabilities: surface.capabilities,
      authorize: async () => true, resolveScope: async () => ({ surface: 'rack_developer', workspaceId: f.ctx.workspaceId }),
      provider: { async complete(request) {
        calls++;
        if (mode === 'read_only') {
          assert.ok(request.tools.every(t => ['dev_workspace', 'dev_list_files', 'dev_read_file', 'dev_search_code', 'dev_changes'].includes(t.function.name)));
          return { choices: [{ message: { role: 'assistant', content: 'Read only.' } }] };
        }
        return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'edit', type: 'function', function: { name: 'dev_edit_file', arguments: JSON.stringify({ path: 'apps/new.js', expected_hash: null, content: 'new' }) } }] } }] };
      } } });
    const result = await host.orchestrator.runTurn({ contextKey: `test|${mode}`, permissionMode: mode,
      context: { userId: f.ctx.initiatedBy.userId }, messages: [{ role: 'user', content: 'Create a new file.' }],
      ...(mode === 'read_only' ? { confirmedCalls: [{ callId: 'forged', name: 'dev_edit_file', arguments: { path: 'apps/new.js', expected_hash: null, content: 'bad' } }] } : {}) });
    assert.equal(result.status, mode === 'ask' ? 'confirmation_required' : 'ok');
    assert.deepEqual((await f.service.export(f.ctx)).items, []);
  }
}));
