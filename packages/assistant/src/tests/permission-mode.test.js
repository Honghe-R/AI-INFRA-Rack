import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantHost, defineCapability, defineSurface, createGuide, LlmError } from '../index.js';

function fixture({ mode, deniedKey = null, readOnly = false, target = 'rack_apply_changes', failSave = false, surfaceKey = 'rack', confirmedCalls = [] } = {}) {
  const executions = [], requests = [], audits = [];
  const capabilities = [
    ['rack_read_plan', 'read', ['rack.read']],
    ['rack_preview_changes', 'read', ['rack.read', 'rack.write']],
    ['rack_apply_changes', 'write', ['rack.read', 'rack.write']],
    ['other_write', 'write', ['rack.write']],
  ].map(([name, access, requiredFunctions]) => defineCapability({ name, access, requiredFunctions,
    surfaces: [surfaceKey], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      executions.push(name);
      if (failSave && name === 'rack_apply_changes') throw new LlmError('RACK_VERSION_CONFLICT', 'The version changed.', { status: 412 });
      return { saved: name === 'rack_apply_changes' };
    },
  }));
  const host = createAssistantHost({
    logger: { info(event, entry) { if (event === 'assistant.tool_call') audits.push(entry); } },
    surfaces: [defineSurface({ key: surfaceKey })],
    guides: [createGuide({ key: 'mode-test', surface: surfaceKey, requiredEntryFunctions: ['rack.read'] })],
    capabilities,
    authorize: async ({ key }) => key !== deniedKey,
    resolveScope: async () => ({ surface: surfaceKey, workspaceId: 'p', readOnly }),
    provider: { async complete(request) {
      requests.push(request);
      return { choices: [{ message: requests.length === 1 && !confirmedCalls.length
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: target, arguments: '{}' } }] }
        : { role: 'assistant', content: 'Finished.' } }] };
    } },
  });
  const run = () => host.orchestrator.runTurn({ messages: [{ role: 'user', content: 'Perform the requested operation.' }],
    contextKey: 'mode-test', context: { userId: 'u' }, ...(mode === undefined ? {} : { permissionMode: mode }), confirmedCalls });
  return { run, executions, requests, audits };
}

test('absent mode defaults to confirmation; explicit Ask does the same', async () => {
  for (const mode of [undefined, 'ask']) {
    const f = fixture({ mode });
    const result = await f.run();
    assert.equal(result.status, 'confirmation_required');
    assert.deepEqual(f.executions, []);
    assert.match(f.requests[0].messages[0].content, /Active Rack operation mode\nAsk for permission/);
  }
});

test('Read only removes both edit tools and refuses forged confirmations', async () => {
  for (const target of ['rack_preview_changes', 'rack_apply_changes', 'other_write']) {
    const f = fixture({ mode: 'read_only', target });
    const result = await f.run();
    assert.equal(result.draftChanged, false);
    assert.deepEqual(f.requests[0].tools.map(t => t.function.name), ['rack_read_plan']);
    assert.deepEqual(f.executions, []);
    const forged = fixture({ mode: 'read_only', confirmedCalls: [{ callId: 'forged', name: target, arguments: {} }] });
    assert.equal((await forged.run()).draftChanged, false);
    assert.deepEqual(forged.executions, []);
  }
});

test('Full authorization skips only the Rack apply card; successful writes report draftChanged', async () => {
  const f = fixture({ mode: 'full' });
  const result = await f.run();
  assert.equal(result.status, 'ok');
  assert.equal(result.draftChanged, true);
  assert.deepEqual(f.executions, ['rack_apply_changes']);
  assert.equal(f.audits[0].confirmation, 'full_authorization');
  assert.match(f.requests[0].messages[0].content, /Full authorization/);
  for (const options of [{ target: 'other_write' }, { surfaceKey: 'site_facility' }]) {
    const unrelated = fixture({ mode: 'full', ...options });
    assert.equal((await unrelated.run()).status, 'confirmation_required');
    assert.deepEqual(unrelated.executions, []);
  }
});

test('Full authorization cannot grant RBAC permissions or edit an immutable context', async () => {
  for (const options of [{ deniedKey: 'rack.write' }, { readOnly: true }]) {
    const f = fixture({ mode: 'full', ...options });
    const result = await f.run();
    assert.equal(result.draftChanged, false);
    assert.deepEqual(f.executions, []);
    assert.deepEqual(f.requests[0].tools.map(t => t.function.name), ['rack_read_plan']);
  }
});

test('Full authorization retains save errors instead of reporting a successful mutation', async () => {
  const f = fixture({ mode: 'full', failSave: true });
  const result = await f.run();
  assert.equal(result.draftChanged, false);
  assert.ok(result.trace.rounds.some(round => round.calls.some(call => call.error?.code === 'RACK_VERSION_CONFLICT')));
});

test('invalid modes fail before context resolution or provider work', async () => {
  for (const mode of [null, '', 'FULL', {}, true, 'administrator']) {
    const f = fixture({ mode });
    await assert.rejects(f.run(), error => error.code === 'ASSISTANT_PERMISSION_MODE_INVALID' && error.status === 400);
    assert.deepEqual(f.executions, []);
    assert.deepEqual(f.requests, []);
  }
});
