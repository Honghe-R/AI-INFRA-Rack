import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAssistantHost, createExecutionContext } from '@ai-infra/assistant';
import { createRackAssistantSurface } from '../services/rack-assistant.js';
import { createAssistantHostFor } from '../assistant-host.js';

function fixture() {
  const ids = Object.fromEntries(['project', 'scenario', 'revision', 'plan', 'model', 'rack', 'device', 'snapshot', 'user'].map(k => [k, randomUUID()]));
  const layout = { projectId: ids.project, planId: ids.plan, scenarioId: ids.scenario, version: 3,
    facilityInput: { revisionId: ids.revision }, sourceStatus: { status: 'UNCHANGED' }, snapshot: { snapshotId: ids.snapshot },
    placements: [{ rackId: ids.rack, modelId: ids.model, name: 'Rack A', xM: 2, yM: 2, rotationDeg: 0, locked: true }],
    models: [{ modelId: ids.model, heightU: 42, maxWeightKg: null, maxPowerKw: 4, maxCoolingKw: null }],
    constraints: { obstacles: [], clearance: null }, equipment: { coverage: 'UNKNOWN', source: { kind: 'ASSUMED', reference: 'unit fixture' },
      devices: [{ deviceId: ids.device, name: 'Device A', rackId: ids.rack, startU: 1, heightU: 4, weightKg: null, powerKw: 2, coolingKw: null }], rackLimits: [] } };
  const calls = [], permissions = [];
  let denied = null;
  const authorize = async q => { permissions.push(q); return q.key !== denied; };
  const layouts = { get: async q => { calls.push(['get', q]); return structuredClone(layout); },
    check: async q => { calls.push(['check', q]); return { report: { status: 'INCOMPLETE', diagnostics: [], uncheckedRules: ['UNRECORDED_OBSTACLES'] },
      equipmentReport: { status: 'INCOMPLETE', diagnostics: [], uncheckedRules: ['FLOOR_LOAD'] } }; },
    options: async q => { calls.push(['options', q]); return { inputFingerprint: 'hash', options: q.body.options, scope: 'EXISTING_RACK_RELOCATION', limits: {}, elapsedMs: 1,
      baseline: { metrics: { envelopeAreaM2: 10 } }, candidates: [{ optionId: 'test:hash', algorithmId: 'row-scan-v1', metrics: { envelopeAreaM2: 8 }, unplaced: [], canStage: true,
        placements: layout.placements, body: { equipment: layout.equipment } }] }; } };
  const plans = { list: async q => { calls.push(['list', q]); return { items: [{ planId: ids.plan, name: 'Test plan' }], nextCursor: null }; } };
  const surface = createRackAssistantSurface({ layouts, plans, authorize });
  const context = () => createExecutionContext({ userId: ids.user, requestId: randomUUID(), workspaceId: ids.project,
    scenarioId: ids.scenario, revisionId: ids.revision, rackContext: { planId: ids.plan, version: 3, clientVersion: 3, hasUnsavedDraft: false } });
  const invoke = (name, args = {}, ctx = context()) => surface.capabilities.find(c => c.name === name).handler(ctx, args);
  return { ids, layout, layouts, surface, context, invoke, calls, permissions, deny: key => { denied = key; } };
}

test('API host registers Rack read tools and guarded edit tools alongside Facility', async () => {
  const host = await createAssistantHostFor({ config: { llmEndpoint: 'http://127.0.0.1:1', llmModel: 'scripted-test', llmApiKeySecret: 'TEST_KEY' }, pool: { query() { throw new Error('No database reads during registration'); } }, secrets: { get: async () => null }, guard: null });
  const names=host.toolRegistry.describe().filter(t=>t.surfaces.includes('rack')).map(t=>t.name);
  for(const name of ['rack_read_plan','rack_preview_changes','rack_apply_changes','rack_preview_automatic_design','rack_search_knowledge','rack_read_knowledge','rack_list_rooms','rack_create_plan','rack_delete_plan','rack_restore_plan']) assert.ok(names.includes(name),name);
  assert.ok(host.contextResolver.surfaces().some(s => s.key === 'rack' && s.version === 1));
  assert.deepEqual(host.contextResolver.guides().find(g => g.surface === 'rack').requiredEntryFunctions, ['rack.read', 'facility.read']);
});

test('an unconfigured provider is explicitly unavailable and never replaced by a fake answer', async () => {
  await assert.rejects(createAssistantHostFor({ config: {}, pool: null, secrets: null, guard: null }), e => e.code === 'LLM_PROVIDER_UNSUPPORTED' && e.status === 500);
});

test('Rack tools are read-only and selection cannot expose Facility mutation capabilities', async () => {
  const f = fixture();
  const host = createAssistantHost({ provider: {}, surfaces: [f.surface.surface], guides: [f.surface.guide], capabilities: f.surface.capabilities, resolveScope: async () => null });
  const selected = await host.toolRegistry.select({ surfaceKey: 'rack', readOnly: true });
  assert.equal(selected.length, 5);
  assert.ok(selected.every(c => c.access === 'read' && c.confirmation === 'none' && c.name.startsWith('rack_')));
  assert.equal((await host.toolRegistry.select({ surfaceKey: 'site_facility' })).length, 0);
  assert.equal((await host.toolRegistry.select({ surfaceKey: 'rack', authorize: async key => key !== 'facility.read' })).length, 0);
});

test('capacity uses the shared checker and distinguishes known power from unknown weight', async () => {
  const f = fixture(), result = await f.invoke('rack_query_capacity', { rack: 'Rack A' });
  const r = result.racks.items[0];
  assert.equal(r.freeU, 38);
  assert.equal(r.capacities.powerKw.status, 'WITHIN_LIMIT');
  assert.equal(r.capacities.powerKw.total, 2);
  assert.equal(r.capacities.weightKg.total, null);
  assert.equal(r.capacities.weightKg.status, 'UNKNOWN');
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.validationState, 'NOT_RUN');
  assert.ok(f.permissions.some(p => p.key === 'rack.read'));
});

test('capacity reports plan-wide room totals even when filtered to one rack, bounding diagnostic device identities', async () => {
  const f = fixture();
  const secondRack = { ...f.layout.placements[0], rackId: randomUUID(), name: 'Rack B' };
  f.layout.placements.push(secondRack);
  const base = f.layout.equipment.devices[0];
  f.layout.equipment.devices = Array.from({ length: 42 }, (_, i) => ({ ...base,
    deviceId: randomUUID(), heightU: 1, startU: i % 21 + 1, rackId: i < 21 ? base.rackId : secondRack.rackId }));
  f.layout.equipment.roomBudget = { maxPowerKw: 3, maxCoolingKw: null,
    source: { kind: 'ASSUMED', reference: 'Test room budget' } };
  const result = await f.invoke('rack_query_capacity', { rack: 'Rack A' });
  assert.equal(result.racks.items.length, 1);
  assert.equal(result.roomCapacity.scope, 'PLAN_INSTALLED_DEVICE_DEMAND');
  assert.equal(result.roomCapacity.resources.powerKw.total, 84);
  assert.equal(result.roomCapacity.status, 'ISSUES_FOUND');
  const diagnostic = result.roomCapacity.diagnostics[0];
  assert.equal(diagnostic.deviceCount, 42); assert.equal(diagnostic.deviceIds.length, 20);
  assert.equal(diagnostic.deviceIdsTruncated, true);
  assert.equal(result.validationState, 'NOT_RUN');
});

test('every call reauthorizes both permissions before any service read', async () => {
  const f = fixture(); f.deny('facility.read');
  await assert.rejects(f.invoke('rack_read_plan'), e => e.status === 403);
  assert.equal(f.calls.length, 0);
});

test('strict schemas reject forged plan/scope arguments, invalid pagination and invalid planner parameters', async () => {
  const f = fixture();
  for (const args of [{ plan_id: randomUUID() }, { project_id: randomUUID() }, { offset: -1 }, { offset: '1' }, { offset: 1001 }])
    await assert.rejects(f.invoke('rack_read_plan', args), e => e.status === 400);
  for (const args of [{ cursor: true }, { cursor: '' }]) await assert.rejects(f.invoke('rack_list_plans', args), e => e.status === 400);
  for (const args of [{ grid_step_m: '1' }, { strategy: 'OPTIMAL' }, { allow_rotation: null }]) await assert.rejects(f.invoke('rack_generate_layout_options', args));
  assert.equal(f.calls.length, 0);
});

test('tools require a selected plan, and refuse mismatched scenario/revision or advanced version', async () => {
  const f = fixture(), ctx = f.context();
  await assert.rejects(f.invoke('rack_read_plan', {}, { ...ctx, rackContext: null }), e => e.code === 'RACK_ASSISTANT_PLAN_REQUIRED');
  await assert.rejects(f.invoke('rack_read_plan', {}, { ...ctx, scenarioId: randomUUID() }), e => e.status === 404);
  await assert.rejects(f.invoke('rack_read_plan', {}, { ...ctx, revisionId: randomUUID() }), e => e.status === 404);
  f.layout.version++;
  await assert.rejects(f.invoke('rack_read_plan', {}, ctx), e => e.status === 412);
});

test('inventory pages do not silently pretend to be complete and duplicate rack names are refused', async () => {
  const f = fixture();
  f.layout.placements = Array.from({ length: 25 }, (_, i) => ({ ...f.layout.placements[0], rackId: randomUUID(), name: `Rack ${i}` }));
  f.layout.equipment.devices = [];
  const first = await f.invoke('rack_read_plan');
  assert.equal(first.racks.items.length, 20); assert.equal(first.racks.total, 25); assert.equal(first.racks.nextOffset, 20);
  assert.equal((await f.invoke('rack_read_plan', { offset: 20 })).racks.items.length, 5);
  f.layout.placements[1].name = f.layout.placements[0].name;
  await assert.rejects(f.invoke('rack_query_capacity', { rack: 'Rack 0' }), e => e.code === 'RACK_ASSISTANT_AMBIGUOUS_RACK');
});

test('checks send only saved content through the original checker and limit diagnostic output', async () => {
  const f = fixture();
  f.layouts.check = async q => { f.calls.push(['check', q]); return { report: { status: 'ISSUES_FOUND', diagnostics: Array.from({ length: 30 }, () => ({ code: 'TEST' })) }, equipmentReport: { status: 'INCOMPLETE', diagnostics: [] } }; };
  const result = await f.invoke('rack_check_saved_layout');
  assert.equal(result.spatial.diagnostics.length, 20); assert.equal(result.spatial.diagnosticCount, 30); assert.equal(result.spatial.diagnosticsTruncated, true);
  assert.deepEqual(f.calls.find(([k]) => k === 'check')[1].body.placements, f.layout.placements);
  assert.equal(result.persisted, false);
  f.layouts.check = async () => { f.layout.version++; return {}; };
  await assert.rejects(f.invoke('rack_check_saved_layout'), e => e.status === 412);
});

test('candidate generation is bounded, summary-only and uses exact saved version and snapshot', async () => {
  const f = fixture(), ctx = f.context();
  const result = await f.invoke('rack_generate_layout_options', { grid_step_m: 1 }, ctx);
  assert.equal(result.candidates[0].body, undefined); assert.equal(result.candidates[0].placements, undefined);
  assert.equal(result.persisted, false); assert.equal(result.validationState, 'NOT_RUN');
  const request = f.calls.find(([k]) => k === 'options')[1];
  assert.equal(request.body.base_version, 3); assert.equal(request.body.snapshot_id, f.ids.snapshot);
  assert.deepEqual(request.body.options, { grid_step_m: 1, allow_rotation: true, strategy: 'COMPARE' });
  await assert.rejects(f.invoke('rack_generate_layout_options', {}, ctx), e => e.status === 429);
  assert.equal(f.calls.filter(([k]) => k === 'options').length, 1);
});

test('generation refuses local dirty drafts and stale UI versions without invoking the planner', async () => {
  const f = fixture(), ctx = f.context();
  await assert.rejects(f.invoke('rack_generate_layout_options', {}, { ...ctx, requestId: randomUUID(), rackContext: { ...ctx.rackContext, hasUnsavedDraft: true } }), e => e.code === 'RACK_ASSISTANT_DIRTY_DRAFT');
  await assert.rejects(f.invoke('rack_generate_layout_options', {}, { ...ctx, requestId: randomUUID(), rackContext: { ...ctx.rackContext, clientVersion: 2 } }), e => e.status === 412);
  assert.equal(f.calls.filter(([k]) => k === 'options').length, 0);
});

test('ten total calls cap a provider that emits many calls per iteration', async () => {
  const f = fixture(), ctx = f.context();
  for (let i = 0; i < 10; i++) await f.invoke('rack_list_plans', {}, ctx);
  await assert.rejects(f.invoke('rack_list_plans', {}, ctx), e => e.status === 429);
  assert.equal(f.calls.length, 10);
});

test('scripted provider drives the real orchestrator through Rack read, capacity, checks and options', async () => {
  const f = fixture(), seen = [], names = ['rack_read_plan', 'rack_query_capacity', 'rack_check_saved_layout', 'rack_generate_layout_options'];
  let iteration = 0;
  const provider = { name: 'scripted-test', async complete(request) {
    seen.push(request);
    assert.deepEqual(request.tools.map(t => t.function.name).sort(), f.surface.capabilities.map(c => c.name).sort());
    const name = names[iteration++];
    return { choices: [{ message: name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${iteration}`, type: 'function', function: { name, arguments: '{}' } }] }
      : { role: 'assistant', content: JSON.stringify({ type: 'message', payload: '已读取保存版，容量未知项仍未知。候选未保存，请在 Layout options 复核。', uiActions: [] }) } }] };
  } };
  const host = createAssistantHost({ provider, surfaces: [f.surface.surface], guides: [f.surface.guide], capabilities: f.surface.capabilities,
    resolveScope: async () => ({ surface: 'rack', workspaceId: f.ids.project, scenarioId: f.ids.scenario, revisionId: f.ids.revision,
      rackContext: f.context().rackContext }), authorize: async () => true });
  const result = await host.orchestrator.runTurn({ messages: [{ role: 'user', content: '读取并比较布局' }], contextKey: 'test|rack|plan', context: { userId: f.ids.user, surface: 'rack' } });
  assert.equal(result.status, 'ok');
  assert.match(result.choices[0].message.content, /候选未保存/);
  assert.equal(seen.length, 5);
  assert.equal(f.calls.filter(([k]) => k === 'options').length, 1);
  assert.ok(seen.at(-1).messages.some(m => m.role === 'tool' && m.name === 'rack_query_capacity' && m.content.includes('UNKNOWN')));
  assert.deepEqual(result.uiActions, []);
});
