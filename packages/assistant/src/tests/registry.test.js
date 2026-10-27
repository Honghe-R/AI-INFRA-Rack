import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createUiActionRegistry, defineCapability, defineSurface } from '../registry.js';

const readTool = defineCapability({
  name: 'list_containers',
  description: 'List containers.',
  inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] },
  access: 'read',
  surfaces: ['site_facility'],
  requiredFunctions: ['facility.read'],
  handler: async () => ({ containers: [] }),
});

const writeTool = defineCapability({
  name: 'create_container',
  description: 'Create a container.',
  inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'] },
  access: 'write',
  surfaces: ['site_facility'],
  requiredFunctions: ['facility.entity.write'],
  handler: async () => ({ created: true }),
});

test('a capability is validated and a duplicate name is refused', () => {
  assert.throws(() => defineCapability({ name: 'Bad-Name', inputSchema: { type: 'object' }, handler: async () => ({}) }));
  assert.throws(() => defineCapability({ name: 'ok_name', inputSchema: { type: 'array' }, handler: async () => ({}) }));
  assert.throws(() => defineCapability({ name: 'ok_name', inputSchema: { type: 'object' } }), /handler/);
  const registry = createToolRegistry({ capabilities: [readTool] });
  assert.throws(() => createToolRegistry({ capabilities: [readTool, readTool] }), /Duplicate/);
  assert.equal(registry.describe()[0].handler, undefined, 'describe never leaks the handler');
});

test('selection drops a tool for surface, read-only, or a denied permission', async () => {
  const registry = createToolRegistry({ capabilities: [readTool, writeTool] });

  const all = await registry.select({ surfaceKey: 'site_facility', authorize: async () => true });
  assert.deepEqual(all.map((tool) => tool.name), ['create_container', 'list_containers']);

  const other = await registry.select({ surfaceKey: 'floorplan', authorize: async () => true });
  assert.deepEqual(other, [], 'a tool scoped to another surface is not offered');

  const readOnly = await registry.select({ surfaceKey: 'site_facility', readOnly: true, authorize: async () => true });
  assert.deepEqual(readOnly.map((tool) => tool.name), ['list_containers'], 'a read-only scope drops writes');

  const denied = await registry.select({
    surfaceKey: 'site_facility',
    authorize: async (key) => key !== 'facility.entity.write',
  });
  assert.deepEqual(denied.map((tool) => tool.name), ['list_containers'], 'any denied requirement drops the tool');
});

test('the gate carries the surface\'s own sentence about the call, and a failed one costs only the sentence', async () => {
  // The card is drawn from what the gate returns, and `{ toolName, arguments }` is a function
  // name and a JSON blob — a question the reader cannot answer. Only the surface knows what its
  // arguments mean and what its objects are called, so the sentence comes from the surface.
  const described = defineCapability({
    name: 'set_geometry',
    description: 'Set geometry.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => ({ ok: true }),
    describe: async (_executionContext, args) => `Move the chiller plant to ${args.to}.`,
  });
  const broken = defineCapability({
    name: 'create_container',
    description: 'Create a container.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => ({ ok: true }),
    describe: async () => {
      throw new Error('the description failed');
    },
  });

  const executionContext = {
    principal: { type: 'service', name: 'assistant' },
    initiatedBy: { type: 'user', userId: 'user-1', publicId: null },
    workspaceId: 'ws-1',
    organisationId: null,
  };
  const registry = createToolRegistry({ capabilities: [described, broken] });
  const selected = await registry.select({ surfaceKey: 'site_facility', authorize: async () => true });
  const host = registry.createHost({ selected, executionContext });

  const gated = await host.callTool({ name: 'set_geometry', arguments: { to: '39.04485, -77.48950' } });
  assert.equal(gated.confirmationRequired, true);
  assert.equal(gated.summary, 'Move the chiller plant to 39.04485, -77.48950.');

  // A description is a courtesy, never a precondition: the reader still gets a card, and the
  // client falls back to words of its own rather than to the payload.
  const stillGated = await host.callTool({ name: 'create_container', arguments: {} });
  assert.equal(stillGated.confirmationRequired, true);
  assert.equal(stillGated.summary, null);
});

test('a confirmation is not offered for a call the surface already knows cannot run', async () => {
  // The gate is before the handler, so a write's precondition is not reached until after the
  // reader has decided — and a draft can move in between. A capability that can tell refuses at
  // the gate, where the refusal is answered in the transcript and the model corrects itself,
  // rather than being offered and then failed in the reader's face.
  const stale = defineCapability({
    name: 'set_geometry',
    description: 'Set geometry.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => ({ applied: true }),
    confirmable: async (_executionContext, args) => {
      if (args.if_match !== 'current') {
        throw Object.assign(new Error('The draft has changed since this write was prepared.'), {
          code: 'REVISION_ETAG_STALE',
          status: 409,
          details: [{ reason: 'etag_mismatch', expected_etag: args.if_match, current_etag: 'current' }],
        });
      }
    },
  });

  const executionContext = {
    principal: { type: 'service', name: 'assistant' },
    initiatedBy: { type: 'user', userId: 'user-1', publicId: null },
    workspaceId: 'ws-1',
    organisationId: null,
  };
  const registry = createToolRegistry({ capabilities: [stale] });
  const selected = await registry.select({ surfaceKey: 'site_facility', authorize: async () => true });
  const host = registry.createHost({ selected, executionContext });

  await assert.rejects(host.callTool({ name: 'set_geometry', arguments: { if_match: 'stale' } }), (error) => {
    assert.equal(error.code, 'REVISION_ETAG_STALE');
    assert.equal(error.details[0].current_etag, 'current', 'and the current value travels, so a caller can retry');
    return true;
  });

  const gated = await host.callTool({ name: 'set_geometry', arguments: { if_match: 'current' } });
  assert.equal(gated.confirmationRequired, true, 'a token that still holds is asked about as usual');
  const confirmed = await host.callTool({ name: 'set_geometry', arguments: { if_match: 'stale' }, confirmed: true });
  assert.deepEqual(confirmed.result, { applied: true }, 'and a call the reader already confirmed is not re-checked');
});

test('the host validates, gates confirmation, and invokes the handler', async () => {
  const registry = createToolRegistry({ capabilities: [readTool, writeTool] });
  const executionContext = {
    principal: { type: 'service', name: 'assistant' },
    initiatedBy: { type: 'user', userId: 'user-1', publicId: null },
    workspaceId: 'ws-1',
    organisationId: null,
  };
  const selected = await registry.select({ surfaceKey: 'site_facility', authorize: async () => true });
  const host = registry.createHost({ selected, executionContext });

  const readResult = await host.callTool({ name: 'list_containers', arguments: { workspaceId: 'ws-1' } });
  assert.deepEqual(readResult.result, { containers: [] });

  const gated = await host.callTool({ name: 'create_container', arguments: { workspaceId: 'ws-1' } });
  assert.equal(gated.confirmationRequired, true);
  assert.equal(gated.toolName, 'create_container');

  const confirmed = await host.callTool({ name: 'create_container', arguments: { workspaceId: 'ws-1' }, confirmed: true });
  assert.deepEqual(confirmed.result, { created: true });

  await assert.rejects(host.callTool({ name: 'nope', arguments: {} }), (error) => error.code === 'ASSISTANT_TOOL_NOT_SELECTED');
  await assert.rejects(host.callTool({ name: 'list_containers', arguments: {} }), (error) => error.code === 'ASSISTANT_TOOL_ARGUMENTS_INVALID');
  await assert.rejects(
    host.callTool({ name: 'list_containers', arguments: { workspaceId: 'other' } }),
    (error) => error.code === 'ASSISTANT_SCOPE_MISMATCH' && error.status === 403,
  );
});

test('UI actions are validated, surface-gated, and normalized into envelopes', () => {
  const registry = createUiActionRegistry({
    actions: [
      { type: 'highlight_entity', version: 1, surfaces: ['site_facility'], description: 'Highlight.', inputSchema: { type: 'object', properties: { entityId: { type: 'string' } }, required: ['entityId'] } },
      { type: 'open_inspector', version: 1, description: 'Open the inspector.' },
    ],
  });

  assert.deepEqual(registry.describe({ surfaceKey: 'site_facility' }).map((action) => `${action.type}@${action.version}`), ['highlight_entity@1', 'open_inspector@1']);
  assert.deepEqual(registry.describe({ surfaceKey: 'floorplan' }).map((action) => action.type), ['open_inspector']);

  const envelope = registry.normalize({ type: 'highlight_entity', version: 1, payload: { entityId: 'e-1' }, context: { surface: 'site_facility', contextKey: 'facility', workspaceId: 'ws-1' } });
  assert.equal(envelope.type, 'highlight_entity');
  assert.equal(envelope.context.surface, 'site_facility');
  assert.equal(Object.isFrozen(envelope), true);

  assert.throws(() => registry.normalize({ type: 'highlight_entity', version: 2, payload: { entityId: 'e-1' } }), (error) => error.code === 'ASSISTANT_ACTION_UNKNOWN');
  assert.throws(() => registry.normalize({ type: 'highlight_entity', version: 1, payload: {}, context: { surface: 'site_facility' } }), (error) => error.code === 'ASSISTANT_ACTION_INVALID');
  assert.throws(() => registry.normalize({ type: 'highlight_entity', version: 1, payload: { entityId: 'e-1' }, context: { surface: 'floorplan' } }), (error) => error.code === 'ASSISTANT_ACTION_UNKNOWN');
});

test('an action named the way the prompt names it is read, not dropped', () => {
  // A live turn was told the actions as `highlight_entity@1`, copied that name whole into
  // `type`, and lost the highlight: the action was well-formed and only the spelling was not.
  // Refusing it over punctuation helps no one, and the reader saw the refusal as
  // `Unknown UI action "highlight_entity@1@undefined"` — an identity naming nothing.
  const registry = createUiActionRegistry({
    actions: [
      { type: 'highlight_entity', version: 1, surfaces: ['site_facility'], inputSchema: { type: 'object', properties: { entityId: { type: 'string' } }, required: ['entityId'] } },
    ],
  });

  const envelope = registry.normalize({ type: 'highlight_entity@1', payload: { entityId: 'e-1' }, context: { surface: 'site_facility' } });
  assert.equal(envelope.type, 'highlight_entity');
  assert.equal(envelope.version, 1);
  assert.deepEqual(envelope.payload, { entityId: 'e-1' });

  assert.equal(registry.extract([{ type: 'highlight_entity@1', payload: { entityId: 'e-1' } }], { surface: 'site_facility' }).length, 1);

  // A version the registry does not hold is still refused, and the message names what was
  // asked for rather than joining a missing version on as `undefined`.
  assert.throws(
    () => registry.normalize({ type: 'highlight_entity@9', payload: { entityId: 'e-1' } }),
    (error) => error.code === 'ASSISTANT_ACTION_UNKNOWN' && error.message === 'Unknown UI action "highlight_entity@9".',
  );
  assert.throws(
    () => registry.normalize({ type: 'made_up', payload: {} }),
    (error) => error.message === 'Unknown UI action "made_up".',
  );
});
