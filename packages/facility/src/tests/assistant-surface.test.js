import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createContextResolver } from '../../../assistant/src/context.js';
import { createRedactor } from '../../../assistant/src/errors.js';
import { createOrchestrator } from '../../../assistant/src/orchestrator.js';
import { createToolRegistry, createUiActionRegistry } from '../../../assistant/src/registry.js';
import {
  ASSISTANT_SURFACE_KEY,
  ASSISTANT_SURFACE_VERSION,
  SITE_FACILITY_CAPABILITIES,
  SITE_FACILITY_CAPABILITY_NAMES,
  SITE_FACILITY_GUIDE,
  SITE_FACILITY_UI_ACTIONS,
  createAssistantProjection,
  createAssistantSurface,
} from '../assistant-surface.js';
import { READ_TOOLS, createToolExecutor, createToolRegistry as createFacilityToolRegistry } from '../index.js';
import { createActionTools } from '../tools/actions.js';
import { CHANGE_KIND_NAMES } from '../change-kinds.js';

/**
 * The assistant surface is a *projection*: it declares names, schemas, permissions,
 * and confirmation states, and every handler bridges to the one facility executor.
 * These tests pin the declaration against the contract and the bridge against a fake
 * executor, so a schema drift or a mistranslated argument fails here rather than in a
 * model turn.
 */

const REVISION = '11111111-1111-4111-8111-111111111111';
const OTHER_REVISION = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const SCENARIO = '55555555-5555-4555-8555-555555555555';
const ENTITY = '66666666-6666-4666-8666-666666666666';
const PARENT = '77777777-7777-4777-8777-777777777777';
const SCOPE = '88888888-8888-4888-8888-888888888888';
const PHASE = '99999999-9999-4999-8999-999999999999';
const BASE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const FACETS = Object.freeze(['GEOMETRY', 'POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY', 'ENVIRONMENT', 'PHASING']);
const FORBIDDEN = Object.freeze([
  'facility.approve',
  'facility.capacity.allocate',
  'facility.share',
  'facility.export',
  'facility.document.manage',
  'facility.import.initiate',
]);

const projection = createAssistantProjection({ execute: async () => ({ ok: true }) });
const byName = new Map(projection.capabilities.map((capability) => [capability.name, capability]));
const reads = projection.capabilities.filter((capability) => capability.access === 'read');
const writes = projection.capabilities.filter((capability) => capability.access === 'write');

function executionContext(overrides = {}) {
  return {
    principal: { type: 'service', name: 'assistant' },
    initiatedBy: { type: 'user', userId: 'user-1', publicId: null },
    workspaceId: PROJECT,
    organisationId: 'org-1',
    scenarioId: SCENARIO,
    revisionId: REVISION,
    readOnly: false,
    requestId: 'request-1',
    ...overrides,
  };
}

/**
 * A recording executor for the bridge tests.
 *
 * The bridge verifies every entity reference before it runs a command, so a fake executor that
 * answered only the command would fail every test that names an entity as "no such entity".
 * This answers the verification the way the real store does — the reference it was asked about
 * exists — and records only the command calls. The verification itself is pinned by the
 * reference tests below; a bridge test is about what reaches the command.
 */
function commandExecutor(handler = async () => ({})) {
  const calls = [];
  const execute = async (call) => {
    if (call.name === 'list_entities') {
      return {
        items: [
          {
            entityId: call.args.entity_id ?? ENTITY,
            entityType: call.args.entity_type ?? 'BUILDING',
            displayName: call.args.name ?? 'Test entity',
          },
        ],
      };
    }
    calls.push(call);
    return handler(call);
  };
  return { calls, execute };
}

/* ============================================================== the surface */

test('the surface declares key site_facility, version 2, no digest, and 22 capabilities', () => {
  const assistant = createAssistantSurface({ execute: async () => ({}) });

  assert.equal(ASSISTANT_SURFACE_KEY, 'site_facility');
  assert.equal(ASSISTANT_SURFACE_VERSION, 2);
  assert.equal(assistant.surface.key, 'site_facility');
  assert.equal(assistant.surface.version, 2);
  assert.equal(assistant.surface.digest, null, 'a tool-only surface declares no digest');
  assert.equal(Object.isFrozen(assistant.surface), true);
  assert.equal(assistant.capabilities.length, 22);
  assert.equal(reads.length, 12);
  assert.equal(writes.length, 10);
  assert.deepEqual([...SITE_FACILITY_CAPABILITY_NAMES].sort(), projection.capabilities.map((capability) => capability.name).sort());
  for (const capability of projection.capabilities) {
    assert.deepEqual(capability.surfaces, ['site_facility']);
  }
});

test('createAssistantProjection refuses a missing executor', () => {
  assert.throws(() => createAssistantProjection({}), /requires the facility tool executor/);
});

test('the published descriptors are frozen and carry no executable leak in describe()', () => {
  for (const capability of SITE_FACILITY_CAPABILITIES) {
    assert.equal(Object.isFrozen(capability), true, `${capability.name} is not frozen`);
    assert.equal(typeof capability.handler, 'function');
    assert.ok(capability.description.length > 20, `${capability.name} has no usable description`);
  }
  const registry = createToolRegistry({ capabilities: projection.capabilities });
  for (const descriptor of registry.describe()) {
    assert.equal(descriptor.handler, undefined, 'describe() never leaks the handler');
  }
});

test('the eight engineering facets never appear as capabilities', () => {
  const names = new Set(projection.capabilities.map((capability) => capability.name));
  for (const facet of FACETS) {
    assert.equal(names.has(facet), false, `${facet} must be a coverage state, not a capability`);
    assert.equal(names.has(facet.toLowerCase()), false);
  }
  // They do appear where the contract puts them: the capability subset of a run.
  const runValidation = byName.get('run_validation');
  assert.deepEqual(runValidation.inputSchema.properties.capability_subset.items.enum, [...FACETS]);
});

test('the assistant capability names are exactly the tool-surface names they project', () => {
  // The registry is built without a database: constructing descriptors never touches
  // a store, so the two registries can be compared by name in a unit test.
  const tools = [...READ_TOOLS, ...createActionTools({ validationService: {} })];
  const registry = createFacilityToolRegistry({ tools });
  const toolNames = new Set(registry.list().map((tool) => tool.name));
  const kindNames = new Set(CHANGE_KIND_NAMES);

  for (const name of SITE_FACILITY_CAPABILITY_NAMES) {
    assert.ok(
      toolNames.has(name) || kindNames.has(name),
      `${name} is neither a registered facility tool nor a registered change kind`,
    );
  }
  // The projection is a subset that shares names; it never renames a tool and it
  // never exposes an operation the contract forbids.
  for (const name of FORBIDDEN) {
    assert.equal(SITE_FACILITY_CAPABILITY_NAMES.includes(name), false, `${name} must not be a capability`);
    assert.equal(toolNames.has(name), false, `${name} must not be a facility tool either`);
  }
  for (const capability of projection.capabilities) {
    for (const key of capability.requiredFunctions) {
      assert.equal(FORBIDDEN.includes(key), false, `${capability.name} declares the forbidden key ${key}`);
    }
  }
  assert.deepEqual(
    SITE_FACILITY_UI_ACTIONS.map((action) => `${action.type}@${action.version}`),
    ['highlight_entity@1', 'focus_geometry@1', 'open_inspector@1', 'show_finding@1', 'reveal_asset_layer@1', 'set_layer_visibility@1'],
  );
});

test('no forbidden operation is exposed as a capability or a required function', () => {
  for (const capability of projection.capabilities) {
    assert.equal(FORBIDDEN.includes(capability.name), false, `${capability.name} is a forbidden operation`);
    for (const key of capability.requiredFunctions) {
      assert.equal(FORBIDDEN.includes(key), false, `${capability.name} requires forbidden key ${key}`);
    }
  }
  for (const name of ['decide_allocation', 'revoke_waiver', 'create_asset_binding']) {
    assert.equal(byName.has(name), false, `${name} is not declared by assistant surface version 2`);
  }
});

test('every write declares confirmation, and declares the server-bound draft preconditions', () => {
  // The preconditions are declared — the contract names them — but not required of the model:
  // they are the resolved revision and the editor's draft token, both of which the server fills.
  // A live turn reached a correct `set_geometry` and was refused for the "missing"
  // `base_revision_id` the server already had.
  for (const capability of writes) {
    assert.equal(capability.confirmation, 'required', `${capability.name} must require confirmation`);
    assert.equal(
      capability.inputSchema.required.includes('base_revision_id'),
      false,
      `${capability.name} must not require base_revision_id of the model`,
    );
    assert.equal(
      capability.inputSchema.required.includes('if_match'),
      false,
      `${capability.name} must not require if_match of the model`,
    );
    assert.ok('base_revision_id' in capability.inputSchema.properties, `${capability.name} must still declare base_revision_id`);
    assert.ok('if_match' in capability.inputSchema.properties, `${capability.name} must still declare if_match`);
  }
});

test('query_geometry can be asked about one named entity', () => {
  // A caller asking where a *named* object is has a name and no bounding box. `bbox` was required,
  // so the one question this tool was most needed for — what is this object's geometry — was the
  // one it could not be asked, even though the store's own tool has filtered on `entity_id` all
  // along. The schema now exposes it and stops requiring a box.
  const tool = byName.get('query_geometry');

  assert.ok('entity_id' in tool.inputSchema.properties, 'the entity filter is reachable');
  assert.equal(tool.inputSchema.required.includes('bbox'), false, 'a box is one way to ask, not the only way');
  // Nothing is required of the model at all: the revision is bound by the server, and asking about
  // a named entity needs no other argument.
  assert.deepEqual(tool.inputSchema.required, []);
  assert.ok('revision_id' in tool.inputSchema.properties, 'and the revision is still declared, so a caller that supplies one is checked');
});

test('the entity filter reaches the executor, and a box is not required to send it', async () => {
  // The projection is where a declared argument is either forwarded or quietly dropped, so this
  // asserts the bridge rather than the declaration.
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'query_geometry');

  await tool.handler(executionContext(), { entity_id: ENTITY, include_geojson: true });

  assert.equal(calls.length, 1);
  const call = calls[0];
  // The executor is invoked with one request carrying the tool name and its arguments.
  assert.equal(call.name, 'query_geometry');
  assert.equal(call.args.entity_id, ENTITY, 'the entity the model named arrives');
  assert.equal(call.args.include_geojson, true);
  // `bbox` is absent because the caller had no box to give, and the store's predicate is written
  // to accept that: every filter is `IS NULL OR ...`.
  assert.equal('bbox' in call.args, false, 'no box was invented on the way through');
});

test('query_geometry asks for the shape rather than assuming it', async () => {
  // A position is never the part that is missing: every record carries bbox4326 and vertexCount
  // whatever the caller passed, and the coordinates — the part that grows with the shape — are
  // asked for. A live turn read the old null as "coordinate data is not exposed in this
  // environment", spent six rounds re-asking, and abandoned the task.
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'query_geometry');

  await tool.handler(executionContext(), { entity_id: ENTITY });
  assert.equal(calls[0].args.include_geojson, false, 'a caller who did not think about coordinates is not sent a shape');

  await tool.handler(executionContext(), { entity_id: ENTITY, include_geojson: true });
  assert.equal(calls[1].args.include_geojson, true, 'and one who asked for the shape gets it');
});

test('the schema says a record always carries a position, and how to read the shape', () => {
  // The declaration is where the model learns what a result will hold, so it has to name the two
  // fields that are always there — otherwise "no coordinates" is the only thing it can see.
  const tool = byName.get('query_geometry');
  assert.equal(tool.inputSchema.properties.include_geojson.default, false);
  const declaration = tool.inputSchema.properties.include_geojson.description;
  assert.match(declaration, /bbox4326/);
  assert.match(declaration, /vertexCount/);
  assert.match(tool.description, /bounding box/, 'and the tool description says the same');
  // The redirect from `get_entity` names the flag again, because that is now what it takes.
  const getEntity = byName.get('get_entity');
  assert.match(getEntity.inputSchema.properties.include_geometry_metadata.description, /query_geometry with include_geojson/);
});

test('a gated write is described in a reader\'s words, and the object is named rather than addressed', async () => {
  // The card is built from what the gate returns. A tool name and a JSON payload ask the reader
  // to approve a function they never called about an object named by a uuid; the sentence has to
  // come from here, because this is the layer that knows what the arguments mean.
  const { execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const setGeometry = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  const summary = await setGeometry.describe(executionContext(), {
    entity_id: ENTITY,
    geometry_role: 'CONNECTION_POINT',
    geometry: { type: 'Point', coordinates: [-77.4895, 39.04485] },
  });

  assert.match(summary, /^Move /, 'what happens, in a verb a reader uses');
  assert.match(summary, /Test entity/, 'and to what, by the name it is called');
  assert.match(summary, /39\.04485, -77\.48950/, 'and where, in degrees a map shows');
  assert.doesNotMatch(summary, /\{/, 'no payload reaches the sentence');
  assert.doesNotMatch(summary, new RegExp(ENTITY), 'and no identifier does either');
});

test('every gated write has a sentence, so no card falls back to a payload', async () => {
  const { execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  for (const capability of surface.capabilities.filter((entry) => entry.confirmation === 'required')) {
    assert.equal(typeof capability.describe, 'function', `${capability.name} needs a describe`);
    assert.equal(typeof capability.confirmable, 'function', `${capability.name} is a draft write and needs a confirmable`);
  }
});

test('a write whose draft token has moved is refused before the reader is asked to confirm it', async () => {
  // The gate runs before the handler, so the token is not compared with the draft until after
  // the reader has decided — and a draft moves in between. It moved here because of the write the
  // reader had just confirmed, and every later confirmation of the stored proposal was refused
  // with a sentence they could do nothing about. The check is now made where the question is
  // asked, and the refusal reaches the model instead of the reader.
  const { calls, execute } = commandExecutor(async (call) => {
    if (call.name === 'get_revision_context') return { draftEtag: 'moved-on' };
    return { applied: true };
  });
  const surface = createAssistantProjection({ execute });
  const setGeometry = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  await assert.rejects(
    setGeometry.confirmable(executionContext(), { if_match: 'the-token-it-was-prepared-against' }),
    (error) => {
      assert.equal(error.code, 'REVISION_ETAG_STALE');
      assert.equal(error.status, 409);
      assert.equal(error.details[0].current_etag, 'moved-on', 'and the current token travels, so the model can retry');
      return true;
    },
  );
  assert.equal(calls.some((call) => call.name === 'apply_change_set'), false, 'nothing was applied');

  // A token that still holds is not refused, and neither is a call with no token to check: the
  // executor's own required-field refusal is the one that should name a missing argument.
  const current = commandExecutor(async () => ({ draftEtag: 'still-here' }));
  const currentSurface = createAssistantProjection({ execute: current.execute });
  const currentTool = currentSurface.capabilities.find((capability) => capability.name === 'set_geometry');
  await currentTool.confirmable(executionContext(), { if_match: 'still-here' });
  await currentTool.confirmable(executionContext(), {});
});

test('list_entities is exposed, so a display name can be found and not only used', async () => {
  // The resolver turns a name into an id, but only when the caller already knows the name is
  // the object's. A live turn asked "is anything called Central Chiller Plant?", read the
  // container list instead, and concluded it did not exist. This is that question's read.
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return { items: [] }; } });
  const tool = surface.capabilities.find((capability) => capability.name === 'list_entities');

  await tool.handler(executionContext(), { name: 'Central Chiller Plant', entity_type: 'UTILITY_SOURCE' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_entities');
  assert.equal(calls[0].args.name, 'Central Chiller Plant');
  assert.equal(calls[0].args.entity_type, 'UTILITY_SOURCE');
  assert.equal(calls[0].args.revision_id, REVISION, 'the scope is bound from the resolved context');
  assert.equal(tool.inputSchema.required.includes('revision_id'), false, 'the revision is never required of the model');
});

test('a scope identifier the model invented is replaced, not passed through', async () => {
  // A live turn failed with `CONTEXT_MISMATCH` — "The arguments name a different scope than the
  // resolved context" — on a call whose scope was correct, because the model echoed a UUID it
  // cannot know: the resolved ids never appear in the prompt or in any tool result. `withBoundIdentity`
  // filled an *omitted* id and left a supplied one alone, so an invented value travelled to the
  // executor's mismatch check, which refused the call with a 403 the model had no way to repair.
  //
  // These three are server-bound: the executor's tenant, revision, and lifecycle all come from the
  // resolved context, and no tool may target another scope. Binding them unconditionally makes the
  // mismatch impossible while keeping the executor's check meaningful for the HTTP path.
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'query_geometry');

  await tool.handler(executionContext(), {
    // The three scope identifiers are well-formed UUIDs that name nothing in this scope, which is
    // exactly what a language model produces when asked to reproduce one. The entity resolves, and
    // is checked by the same bridge.
    project_id: OTHER_PROJECT,
    scenario_id: '00000000-0000-4000-8000-000000000000',
    revision_id: OTHER_REVISION,
    entity_id: ENTITY,
  });

  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args.project_id, PROJECT, 'the resolved project wins');
  assert.equal(args.scenario_id, SCENARIO, 'and the resolved scenario');
  assert.equal(args.revision_id, REVISION, 'and the resolved revision');
  assert.equal(args.entity_id, ENTITY, 'what the model was actually asking about is untouched');
});

test('a write takes its draft preconditions from the resolved context, not the model', async () => {
  // The trace that motivated this: a correct `set_geometry` refused for a "missing
  // base_revision_id" the server already held, and an `if_match` the client had already sent.
  // Both are server-owned, so a call that names neither still reaches the command with them.
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  await tool.handler(executionContext({ baseRevisionId: BASE, ifMatch: 'etag-7' }), {
    entity_id: ENTITY,
    geometry_role: 'CONNECTION_POINT',
    geometry: { type: 'Point', coordinates: [0, 0] },
    crs: 'EPSG:4326',
  });

  assert.equal(calls[0].name, 'apply_change_set');
  assert.equal(calls[0].args.base_revision_id, BASE, 'the base comes from the resolved revision');
  assert.equal(calls[0].args.etag, 'etag-7', 'and the draft token from the editor snapshot');
});

test('a draft precondition the model supplied is overwritten, never trusted', async () => {
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  await tool.handler(executionContext({ baseRevisionId: BASE, ifMatch: 'etag-real' }), {
    base_revision_id: '00000000-0000-4000-8000-000000000000',
    if_match: 'etag-invented',
    entity_id: ENTITY,
    geometry_role: 'CONNECTION_POINT',
    geometry: { type: 'Point', coordinates: [0, 0] },
    crs: 'EPSG:4326',
  });

  assert.equal(calls[0].args.base_revision_id, BASE, 'the resolved base wins over the echo');
  assert.equal(calls[0].args.etag, 'etag-real', 'and the editor token over the invented one');
});

test('binding the preconditions does not leak if_match into the composed command', async () => {
  // The capability's schema declares `if_match`; the command it composes takes `etag`. Binding the
  // precondition a second time on the composed arguments injected a field `apply_change_set` does
  // not accept, and the real executor refused every write with `unknown_property`. A fake executor
  // does not validate, so this pins the shape the command actually receives.
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  await tool.handler(executionContext({ baseRevisionId: BASE, ifMatch: 'etag-7' }), {
    entity_id: ENTITY,
    geometry_role: 'CONNECTION_POINT',
    geometry: { type: 'Point', coordinates: [0, 0] },
    crs: 'EPSG:4326',
  });

  assert.equal(calls[0].name, 'apply_change_set');
  assert.equal(calls[0].args.etag, 'etag-7', 'the token reaches the command as its own field');
  assert.equal('if_match' in calls[0].args, false, 'and not as one the command does not declare');
});

/* ------------------------------------------------- entity references by name */

/**
 * A model cannot copy a UUID — and when it invents one, the invention is well-formed and
 * survives every downstream check. A live session showed the cost: a hallucinated yard id
 * (`…-d4e80bafdf6e` where the revision holds `…-e3de2bf37fd7`) entered the transcript at one
 * turn, was reused for nine more, and every read answered it with a successful empty result —
 * `get_entity` null, `query_geometry` an empty page, `geometry_point` a null point — so the
 * model reported that the revision held no boundary polygon and asked the user to re-upload one.
 *
 * These pin the bridge's half of the repair: an entity argument accepts a display name, and
 * *every* reference — name or id — is resolved and checked against the revision before the
 * command runs. A reference that names nothing is a `404`, never an empty result to interpret.
 */

test('a display name is resolved to the entity id before the executor sees it', async () => {
  const calls = [];
  const execute = async (call) => {
    calls.push(call);
    if (call.name === 'list_entities') {
      return { items: [{ entityId: ENTITY, entityType: 'UTILITY_SOURCE', displayName: 'Central Chiller Plant' }] };
    }
    return { applied: [] };
  };
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  const result = await tool.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-1',
    entity_id: 'Central Chiller Plant',
    geometry_role: 'CONNECTION_POINT',
    geometry: { type: 'Point', coordinates: [0, 0] },
    crs: 'EPSG:4326',
  });

  assert.equal(calls.length, 2, 'the lookup, then the command');
  assert.equal(calls[0].name, 'list_entities');
  assert.equal(calls[0].args.name, 'Central Chiller Plant', 'the name is what is searched');
  assert.equal(calls[0].args.revision_id, REVISION, 'and the scope is the resolved one');
  // A write handler composes a change set, so the reference is nested. A shallow pass would
  // have missed it and the executor would have refused the name as `not_a_uuid`.
  assert.equal(calls[1].name, 'apply_change_set');
  assert.equal(calls[1].args.changes[0].entity_ref.entity_id, ENTITY, 'the name is replaced by the identity');
  assert.deepEqual(result, { applied: [] });
});

test('a UUID is checked against the revision before it is passed through', async () => {
  // An id is not taken on trust either. What this closes is not a malformed id — those were
  // always refused — but a well-formed one whose tail was invented, which every read answers
  // with a successful empty result.
  const calls = [];
  const execute = async (call) => {
    calls.push(call);
    if (call.name === 'list_entities') {
      assert.equal(call.args.entity_id, ENTITY, 'the id is what is checked');
      assert.equal(call.args.name, undefined, 'not searched as a name');
      return { items: [{ entityId: ENTITY, entityType: 'UTILITY_SOURCE', displayName: 'Central Chiller Plant' }] };
    }
    return {};
  };
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  await tool.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-1',
    entity_id: ENTITY,
    geometry_role: 'CONNECTION_POINT',
    geometry: { type: 'Point', coordinates: [0, 0] },
    crs: 'EPSG:4326',
  });

  assert.equal(calls.length, 2, 'the check, then the command');
  assert.equal(calls[0].name, 'list_entities');
  assert.equal(calls[1].name, 'apply_change_set');
  assert.equal(calls[1].args.changes[0].entity_ref.entity_id, ENTITY, 'the verified id reaches the command');
});

test('a well-formed id that names nothing is refused, never answered with an empty result', async () => {
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return { items: [] }; } });
  const tool = surface.capabilities.find((capability) => capability.name === 'query_geometry');
  // The exact invented id from the transcript: the real yard id with its last two groups replaced.
  const hallucinated = 'e273643a-e06a-5303-b747-d4e80bafdf6e';

  await assert.rejects(
    tool.handler(executionContext(), { entity_id: hallucinated, geometry_role: 'BOUNDARY', include_geojson: true }),
    (error) => {
      assert.equal(error.code, 'ENTITY_REFERENCE_NOT_FOUND');
      assert.equal(error.status, 404, 'a refusal the model can repair, not an empty page it must interpret');
      assert.equal(error.details[0].entity_id, hallucinated);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'only the check ran; the command was never attempted');
});

test('a reference named twice is checked once per call', async () => {
  const checks = [];
  const execute = async (call) => {
    if (call.name === 'list_entities') {
      checks.push(call.args.entity_id ?? call.args.name);
      return { items: [{ entityId: call.args.entity_id ?? ENTITY, entityType: 'BUILDING', displayName: 'Test' }] };
    }
    return {};
  };
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'assign_phase');

  await tool.handler(executionContext(), { base_revision_id: BASE, if_match: 'etag-1', entity_ids: [ENTITY, ENTITY], phase_id: PHASE });

  assert.equal(checks.filter((value) => value === ENTITY).length, 1, 'one read for one reference, however often it appears');
  assert.equal(checks.length, 2, 'the phase is a second, distinct reference');
});

test('an entity_type narrows a name two objects could share', async () => {
  const calls = [];
  const execute = async (call) => {
    calls.push(call);
    if (call.name === 'list_entities') {
      return { items: [{ entityId: ENTITY, entityType: 'EQUIPMENT_YARD', displayName: 'Yard' }] };
    }
    return {};
  };
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'get_entity');

  await tool.handler(executionContext(), { entity_id: 'Yard', entity_type: 'EQUIPMENT_YARD' });

  assert.equal(calls[0].args.entity_type, 'EQUIPMENT_YARD', 'the declared type narrows the lookup');
  assert.equal(calls[1].name, 'get_entity');
  assert.equal(calls[1].args.entity_id, ENTITY);
});

test('an unknown name is refused before the command is attempted', async () => {
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return { items: [] }; } });
  const tool = surface.capabilities.find((capability) => capability.name === 'set_geometry');

  await assert.rejects(
    tool.handler(executionContext(), {
      base_revision_id: BASE,
      if_match: 'etag-1',
      entity_id: 'Nowhere Plant',
      geometry_role: 'CONNECTION_POINT',
      geometry: { type: 'Point', coordinates: [0, 0] },
      crs: 'EPSG:4326',
    }),
    (error) => {
      assert.equal(error.code, 'ENTITY_REFERENCE_NOT_FOUND');
      assert.equal(error.status, 404, 'a 404 is a read refusal the loop may answer and retry');
      assert.equal(error.details[0].label, 'Nowhere Plant');
      return true;
    },
  );
  assert.equal(calls.length, 1, 'only the lookup ran; nothing was written');
});

test('an ambiguous name is refused with the candidates, never guessed', async () => {
  const execute = async () => ({
    items: [
      { entityId: ENTITY, entityType: 'UTILITY_SOURCE', displayName: 'Central Plant' },
      { entityId: PARENT, entityType: 'EQUIPMENT_YARD', displayName: 'Central Plant' },
    ],
  });
  const surface = createAssistantProjection({ execute });
  const tool = surface.capabilities.find((capability) => capability.name === 'assign_phase');

  await assert.rejects(
    tool.handler(executionContext(), {
      base_revision_id: BASE,
      if_match: 'etag-1',
      entity_ids: ['Central Plant'],
      phase_id: PHASE,
    }),
    (error) => {
      assert.equal(error.code, 'ENTITY_REFERENCE_AMBIGUOUS');
      assert.equal(error.status, 422);
      assert.deepEqual(
        error.details[0].candidates.map((candidate) => candidate.entity_type),
        ['UTILITY_SOURCE', 'EQUIPMENT_YARD'],
      );
      return true;
    },
  );
});

test('the entity-targeting schemas accept a name, not only a uuid', () => {
  for (const name of ['get_entity', 'query_geometry', 'geometry_point', 'update_entity', 'set_geometry']) {
    const schema = byName.get(name).inputSchema.properties.entity_id;
    assert.equal(schema.format, undefined, `${name}: a uuid format would tell the model to supply an id`);
    assert.match(schema.description, /display name/);
  }
  assert.equal(byName.get('assign_phase').inputSchema.properties.entity_ids.items.format, undefined);
});

test('reads never require a concurrency token', () => {
  for (const capability of reads) {
    assert.equal(capability.confirmation, 'none');
    assert.equal(capability.inputSchema.required.includes('if_match'), false, `${capability.name} must not require if_match`);
    assert.equal(capability.access, 'read');
  }
  // Every read is revision-scoped, but the scope is bound by the server rather than
  // required from the model: a language model asked to echo a UUID truncates or invents
  // one, and a mismatch is a 403 it cannot repair. The tool still declares the field, so
  // a caller that supplies one is checked rather than silently ignored.
  assert.ok('revision_id' in byName.get('get_revision_context').inputSchema.properties);
  assert.equal(byName.get('get_revision_context').inputSchema.required.includes('revision_id'), false);
});

/* --------------------------------------------------------------- schema caps */

function walkSchema(node, path, depth, issues) {
  if (!node || typeof node !== 'object') return;
  if (depth > 4) issues.push(`${path}: nesting depth ${depth} exceeds 4`);
  if (node.type === 'string') {
    const expected = path.endsWith('justification') ? 2_048 : 256;
    if (typeof node.maxLength !== 'number') issues.push(`${path}: string has no maxLength`);
    else if (node.maxLength > expected) issues.push(`${path}: maxLength ${node.maxLength} exceeds ${expected}`);
  }
  if (node.type === 'array' && typeof node.maxItems === 'number' && node.maxItems > 200) {
    issues.push(`${path}: maxItems ${node.maxItems} exceeds 200`);
  }
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    walkSchema(value, `${path}.${key}`, depth + 1, issues);
  }
  if (node.items) walkSchema(node.items, `${path}[]`, depth + 1, issues);
}

test('every argument schema stays within the documented caps', () => {
  for (const capability of projection.capabilities) {
    const schema = capability.inputSchema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${capability.name} accepts unknown properties`);
    const propertyCount = Object.keys(schema.properties).length;
    assert.ok(propertyCount <= 12, `${capability.name} declares ${propertyCount} properties`);
    const issues = [];
    walkSchema(schema, capability.name, 1, issues);
    assert.deepEqual(issues, [], `${capability.name} exceeds a documented cap:\n  ${issues.join('\n  ')}`);
  }
  assert.equal(byName.get('grant_waiver').inputSchema.properties.justification.maxLength, 2_048);
  assert.equal(byName.get('assign_phase').inputSchema.properties.entity_ids.maxItems, 200);
  assert.equal(byName.get('apply_asset_binding').inputSchema.properties.mapping_ids.maxItems, 100);
  assert.equal(byName.get('grant_waiver').inputSchema.properties.diagnostic_ids.maxItems, 100);
});

test('an over-cap argument is rejected before the executor is reached', async () => {
  let called = false;
  const guarded = createAssistantProjection({ execute: async () => { called = true; return {}; } });
  const createContainer = guarded.capabilities.find((capability) => capability.name === 'create_container');
  await assert.rejects(
    createContainer.handler(executionContext(), {
      base_revision_id: BASE,
      if_match: 'etag-1',
      parent_entity_id: PARENT,
      entity_type: 'BUILDING',
      name: 'x'.repeat(257),
    }),
    (error) => error.code === 'VALIDATION_FAILED' && error.status === 400 && error.details[0].field === 'name',
  );
  assert.equal(called, false, 'the handler never reached the executor');
});

test('geometry coordinates are bounded by the position cap, not the array cap', async () => {
  let called = 0;
  const { execute } = commandExecutor(async () => { called += 1; return {}; });
  const guarded = createAssistantProjection({ execute });
  const setGeometry = guarded.capabilities.find((capability) => capability.name === 'set_geometry');
  const args = (positions) => ({
    base_revision_id: BASE,
    if_match: 'etag-1',
    entity_id: ENTITY,
    geometry_role: 'BOUNDARY',
    geometry: { type: 'Polygon', coordinates: [Array.from({ length: positions }, (_, index) => [index, index])] },
    crs: 'EPSG:4326',
  });

  // 300 positions exceeds the 200-item array cap but is well inside the position cap.
  await setGeometry.handler(executionContext(), args(300));
  assert.equal(called, 1, 'a 300-point ring is accepted');

  // A geometry over the position cap is also over the 8192-byte argument cap, so the
  // byte cap fires first; either rejection is the documented "refused before the
  // handler runs".
  await assert.rejects(
    setGeometry.handler(executionContext(), args(10_001)),
    (error) =>
      error.code === 'VALIDATION_FAILED' &&
      ['over_budget', 'too_many_positions'].includes(error.details[0].reason),
  );
  assert.equal(called, 1, 'the over-cap geometry never reached the executor');
});

/* ================================================================ selection */

test('selection drops writes in a read-only scope and drops a tool on any denied function', async () => {
  const registry = createToolRegistry({ capabilities: projection.capabilities });

  const readOnly = await registry.select({ surfaceKey: 'site_facility', readOnly: true, authorize: async () => true });
  assert.equal(readOnly.length, 12, 'a read-only scope offers exactly the reads');
  assert.equal(readOnly.every((capability) => capability.access === 'read'), true);

  const deniedGeometry = await registry.select({
    surfaceKey: 'site_facility',
    authorize: async (key) => key !== 'facility.geometry.write',
  });
  assert.equal(deniedGeometry.some((capability) => capability.name === 'set_geometry'), false);
  assert.equal(deniedGeometry.some((capability) => capability.name === 'create_container'), true);

  const deniedDraft = await registry.select({
    surfaceKey: 'site_facility',
    authorize: async (key) => key !== 'facility.draft.create',
  });
  assert.equal(
    deniedDraft.some((capability) => capability.name === 'create_container'),
    false,
    'one denied requirement drops the tool entirely',
  );

  const otherSurface = await registry.select({ surfaceKey: 'floorplan', authorize: async () => true });
  assert.deepEqual(otherSurface, []);
});

/* ========================================================= scope enforcement */

test('the executor still refuses a scope mismatch for a caller that chooses its own scope', async () => {
  // The check belongs to the executor, and the HTTP path — and any other caller that really does
  // address a scope — still gets it. The stub pool is never reached: identity is checked first.
  //
  // The assistant no longer reaches this error: the projection binds the server-owned identifiers
  // from the resolved context before the executor sees the arguments (see `withBoundIdentity`).
  // Adding another bound identifier means adding it to both places, and this test is what shows
  // there is still something enforcing it underneath.
  const facilityRegistry = createFacilityToolRegistry({ tools: READ_TOOLS });
  const executor = createToolExecutor({ pool: {}, registry: facilityRegistry, authorize: async () => true });
  // The context shape the projection builds: `projectId` and the resolved scenario and revision.
  const resolved = { projectId: PROJECT, scenarioId: SCENARIO, revisionId: REVISION, userId: 'user-1', readOnly: false, confirmed: true };

  await assert.rejects(
    executor.execute({ name: 'get_revision_context', args: { revision_id: OTHER_REVISION }, context: resolved }),
    (error) => error.code === 'CONTEXT_MISMATCH' && error.status === 403 && error.details.some((detail) => detail.field === 'revision_id'),
  );
  await assert.rejects(
    executor.execute({
      name: 'get_revision_context',
      args: { revision_id: REVISION, project_id: OTHER_PROJECT },
      context: resolved,
    }),
    (error) => error.code === 'CONTEXT_MISMATCH' && error.status === 403 && error.details.some((detail) => detail.field === 'project_id'),
  );
});

/* ============================================================ the bridge */

test('an omitted scope identifier is bound from the resolved context, never required of the model', async () => {
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return {}; } });
  const getRevisionContext = surface.capabilities.find((capability) => capability.name === 'get_revision_context');

  // The model passes no scope at all, which is the behaviour the prompt asks for.
  await getRevisionContext.handler(executionContext(), { include_coverage: false });
  assert.equal(calls[0].args.revision_id, REVISION);
  assert.equal(calls[0].args.project_id, PROJECT);
  assert.equal(calls[0].args.scenario_id, SCENARIO);

  // A value the model did supply is replaced rather than forwarded. The resolved ids are in no
  // prompt and in no tool result, so a model that "supplies" one has invented it, and forwarding
  // an invention produced a `CONTEXT_MISMATCH` on a call whose scope was correct.
  calls.length = 0;
  await getRevisionContext.handler(executionContext(), { revision_id: OTHER_REVISION });
  assert.equal(calls[0].args.revision_id, REVISION, 'the resolved revision wins over the invented one');
});

test('a read handler bridges with the resolved context and the read arguments', async () => {
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return { revisionId: REVISION }; } });
  const getRevisionContext = surface.capabilities.find((capability) => capability.name === 'get_revision_context');

  const result = await getRevisionContext.handler(executionContext(), { revision_id: REVISION, include_coverage: false });

  assert.deepEqual(result, { revisionId: REVISION });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'get_revision_context');
  assert.deepEqual(calls[0].args, {
    revision_id: REVISION,
    project_id: PROJECT,
    scenario_id: SCENARIO,
    include_coverage: false,
    include_validation: true,
  });
  assert.deepEqual(calls[0].context, {
    projectId: PROJECT,
    scenarioId: SCENARIO,
    revisionId: REVISION,
    userId: 'user-1',
    correlationId: 'request-1',
    readOnly: false,
    confirmed: true,
  });
});

test('create_container composes one apply_change_set call and translates the schema', async () => {
  const { calls, execute } = commandExecutor(async () => ({ applied: true, effect: 'applied' }));
  const surface = createAssistantProjection({ execute });
  const createContainer = surface.capabilities.find((capability) => capability.name === 'create_container');

  await createContainer.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-1',
    parent_entity_id: PARENT,
    entity_type: 'BUILDING',
    name: 'Building A',
    phase_id: PHASE,
    scope_id: SCOPE,
  });

  assert.equal(calls[0].name, 'apply_change_set');
  assert.equal(calls[0].args.revision_id, REVISION);
  assert.equal(calls[0].args.base_revision_id, BASE);
  assert.equal(calls[0].args.etag, 'etag-1');
  assert.deepEqual(calls[0].args.changes, [
    {
      kind: 'create_container',
      payload: {
        container_kind: 'BUILDING',
        name: 'Building A',
        scope_id: SCOPE,
        parent_container_id: PARENT,
        phase_id: PHASE,
      },
    },
  ]);
});

test('create_container with geometry appends a set_geometry change for the new container', async () => {
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const createContainer = surface.capabilities.find((capability) => capability.name === 'create_container');

  await createContainer.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-1',
    parent_entity_id: PARENT,
    entity_type: 'PARCEL',
    name: 'Parcel A',
    scope_id: SCOPE,
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    crs: 'EPSG:4326',
  });

  const changes = calls[0].args.changes;
  assert.equal(changes.length, 2);
  const containerId = changes[0].payload.container_id;
  assert.equal(typeof containerId, 'string');
  assert.deepEqual(changes[1], {
    kind: 'set_geometry',
    entity_ref: { entity_id: containerId, entity_type: 'PARCEL' },
    payload: { role: 'BOUNDARY', geojson_4326: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] }, crs: 'EPSG:4326' },
  });
});

test('request_capacity_allocation maps if_match to the command etag and passes the request through', async () => {
  const { calls, execute } = commandExecutor(async () => ({ decision: 'ACCEPTED' }));
  const surface = createAssistantProjection({ execute });
  const request = surface.capabilities.find((capability) => capability.name === 'request_capacity_allocation');

  const result = await request.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-9',
    consumer_type: 'RACK',
    consumer_id: ENTITY,
    phase_id: PHASE,
    resource_kind: 'POWER',
    requested_capacity: { value: 120, unit: 'kW', basis: 'IT_LOAD', state: 'PLANNED' },
    required_from: '2026-01-01T00:00:00Z',
    priority: 'HIGH',
  });

  assert.deepEqual(result, { decision: 'ACCEPTED' });
  assert.equal(calls[0].name, 'request_capacity_allocation');
  assert.equal(calls[0].args.etag, 'etag-9');
  assert.equal(calls[0].args.if_match, undefined);
  assert.deepEqual(calls[0].args.requested_capacity, { value: 120, unit: 'kW', basis: 'IT_LOAD', state: 'PLANNED' });
  assert.equal(calls[0].args.revision_id, REVISION);
});

test('run_validation maps if_match to base_etag and states the FULL consequence', async () => {
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return { runId: 'run-1', status: 'COMPLETED' }; } });
  const run = surface.capabilities.find((capability) => capability.name === 'run_validation');

  const result = await run.handler(executionContext(), { base_revision_id: BASE, if_match: 'etag-2', capability_subset: ['POWER'] });

  assert.equal(calls[0].args.base_etag, 'etag-2');
  assert.equal(calls[0].args.scope, 'FULL');
  assert.deepEqual(calls[0].args.capabilities, ['POWER']);
  assert.match(result.effect, /freezes this revision as VALIDATED/);
});

test('assign_phase emits one change per entity, and the change-kind writes all compose apply_change_set', async () => {
  const { calls, execute } = commandExecutor();
  const surface = createAssistantProjection({ execute });
  const assignPhase = surface.capabilities.find((capability) => capability.name === 'assign_phase');

  await assignPhase.handler(executionContext(), { base_revision_id: BASE, if_match: 'etag-1', entity_ids: [ENTITY, PARENT], phase_id: PHASE });

  assert.equal(calls[0].name, 'apply_change_set');
  assert.deepEqual(calls[0].args.changes, [
    { kind: 'assign_phase', entity_ref: { entity_id: ENTITY }, payload: { phase_id: PHASE } },
    { kind: 'assign_phase', entity_ref: { entity_id: PARENT }, payload: { phase_id: PHASE } },
  ]);

  const updateEntity = surface.capabilities.find((capability) => capability.name === 'update_entity');
  await updateEntity.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-1',
    entity_id: ENTITY,
    entity_type: 'BUILDING',
    patch: { name: 'Renamed' },
  });
  const updateCall = calls.find((call) => call.args.changes[0].kind === 'update_entity');
  assert.deepEqual(updateCall.args.changes[0], {
    kind: 'update_entity',
    entity_ref: { entity_id: ENTITY, entity_type: 'BUILDING' },
    payload: { patch: { name: 'Renamed' } },
  });
});

test('assign_constraint maps to the same-named change kind and reports what it cannot express', async () => {
  const { calls, execute } = commandExecutor(async () => ({ constraintId: 'c-1' }));
  const surface = createAssistantProjection({ execute });
  const constraint = surface.capabilities.find((capability) => capability.name === 'assign_constraint');

  const result = await constraint.handler(executionContext(), {
    base_revision_id: BASE,
    if_match: 'etag-1',
    constraint_kind: 'SETBACK',
    target_entity_id: ENTITY,
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    rule_reference: 'policy@1',
  });

  assert.equal(calls[0].args.changes[0].kind, 'assign_constraint');
  assert.deepEqual(calls[0].args.changes[0].payload, { constraint_kind: 'SETBACK', container_id: ENTITY, severity: 'ERROR' });
  assert.equal(result.constraintId, 'c-1');
  assert.match(result.note, /constraint area and the rule reference were not expressible/);
  assert.deepEqual(result.unmapped, [
    'geometry: the constraint area must be recorded as a geometry record first',
    'rule_reference: the store carries a numeric rule, not a free-text reference',
  ]);
});

test('the remaining writes bridge 1:1 by tool name', async () => {
  const calls = [];
  const surface = createAssistantProjection({ execute: async (call) => { calls.push(call); return {}; } });
  const call = async (name, args) => (await surface.capabilities.find((capability) => capability.name === name).handler(executionContext(), args));

  await call('publish_revision', { base_revision_id: BASE, if_match: 'etag-1', validation_run_id: ENTITY });
  await call('grant_waiver', {
    base_revision_id: BASE,
    if_match: 'etag-1',
    diagnostic_ids: [ENTITY],
    scope: 'REVISION',
    expires_at: '2026-06-01T00:00:00Z',
    justification: 'Accepted with mitigation.',
    policy_id: BASE,
  });
  await call('apply_asset_binding', {
    base_revision_id: BASE,
    if_match: 'etag-1',
    binding_id: ENTITY,
    transform_id: PARENT,
    mapping_ids: [SCOPE],
    target_revision_id: REVISION,
  });

  const publish = calls.find((entry) => entry.name === 'publish_revision');
  assert.equal(publish.args.if_match, 'etag-1');

  const waiver = calls.find((entry) => entry.name === 'grant_waiver');
  assert.equal(waiver.args.reason, 'Accepted with mitigation.');
  assert.equal(waiver.args.policy_id, BASE);
  assert.deepEqual(waiver.args.diagnostic_ids, [ENTITY]);

  const binding = calls.find((entry) => entry.name === 'apply_asset_binding');
  assert.equal(binding.args.etag, 'etag-1');
  assert.deepEqual(binding.args.mapping_ids, [SCOPE]);
});

/* ================================================================ the guide */

test('the guide is versioned, requires facility.read, and populates every section', () => {
  assert.equal(SITE_FACILITY_GUIDE.key, 'site-facility-guide');
  assert.equal(SITE_FACILITY_GUIDE.version, 2);
  assert.equal(SITE_FACILITY_GUIDE.surface, 'site_facility');
  assert.deepEqual(SITE_FACILITY_GUIDE.requiredEntryFunctions, ['facility.read']);

  // Five prose sections plus the entry-permission section: the guide is not a partial
  // declaration that leaves the model guessing about one of them.
  for (const section of ['instructions', 'operatingPrinciples', 'workflow', 'stateSignals', 'guardrails']) {
    assert.ok(Array.isArray(SITE_FACILITY_GUIDE[section]), `${section} is not a list`);
    assert.ok(SITE_FACILITY_GUIDE[section].length > 0, `${section} is empty`);
  }

  const prose = [
    ...SITE_FACILITY_GUIDE.instructions,
    ...SITE_FACILITY_GUIDE.operatingPrinciples,
    ...SITE_FACILITY_GUIDE.workflow,
    ...SITE_FACILITY_GUIDE.stateSignals,
    ...SITE_FACILITY_GUIDE.guardrails,
  ].join('\n');

  assert.match(prose, /`NOT_PROVIDED` MUST never be described as feasible/, 'the NOT_PROVIDED rule is stated');
  assert.match(prose, /Never offer to set coverage/, 'coverage cannot be asserted directly');
  assert.match(prose, /Cite the revision and the entity, geometry, diagnostic, interface, or budget reference for every claim/, 'the citation rule is stated');
  assert.match(prose, /without a successful tool result in the same turn/, 'no success without a tool result');
  assert.match(prose, /get_revision_context/, 'the guide names the declared read');
  assert.match(prose, /Name an entity by its display name, never by a transcribed identifier/, 'the guide says how to address an entity');
  assert.equal(prose.includes('get_facility_envelope'), false, 'the superseded name is not used');
});

/* ============================================================= UI actions */

test('the six UI actions are exactly the documented type@version set and the registry accepts them', () => {
  const keys = SITE_FACILITY_UI_ACTIONS.map((action) => `${action.type}@${action.version}`);
  assert.deepEqual(keys, [
    'highlight_entity@1',
    'focus_geometry@1',
    'open_inspector@1',
    'show_finding@1',
    'reveal_asset_layer@1',
    'set_layer_visibility@1',
  ]);
  for (const action of SITE_FACILITY_UI_ACTIONS) {
    assert.equal(action.confirmation, 'none');
    assert.deepEqual(action.surfaces, ['site_facility']);
    assert.equal(action.inputSchema.type, 'object');
    assert.ok(Array.isArray(action.validate) && action.validate.length > 0, `${action.type} records no bounds`);
  }

  const registry = createUiActionRegistry({ actions: SITE_FACILITY_UI_ACTIONS });
  assert.equal(registry.size(), 6);
  const envelope = registry.normalize({
    type: 'highlight_entity',
    version: 1,
    payload: { entity_id: ENTITY, entity_type: 'BUILDING' },
    context: { surface: 'site_facility', contextKey: 'facility', workspaceId: PROJECT },
  });
  assert.equal(envelope.type, 'highlight_entity');
  assert.equal(envelope.confirmation, 'none');
  assert.equal(envelope.context.surface, 'site_facility');
  assert.throws(
    () => registry.normalize({ type: 'highlight_entity', version: 1, payload: { entity_id: ENTITY }, context: { surface: 'site_facility' } }),
    (error) => error.code === 'ASSISTANT_ACTION_INVALID',
  );
  assert.throws(
    () => registry.normalize({ type: 'run_javascript', version: 1, payload: {}, context: { surface: 'site_facility' } }),
    (error) => error.code === 'ASSISTANT_ACTION_UNKNOWN',
  );
  assert.throws(
    () => registry.normalize({ type: 'highlight_entity', version: 1, payload: { entity_id: ENTITY, entity_type: 'BUILDING' }, context: { surface: 'floorplan' } }),
    (error) => error.code === 'ASSISTANT_ACTION_UNKNOWN',
  );
});

/* ==================================================== orchestrator integration */

function scriptedProvider(responses) {
  let index = 0;
  return {
    name: 'fake',
    model: 'fake-1',
    get callCount() {
      return index;
    },
    async complete() {
      const entry = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        choices: [{ message: { role: 'assistant', content: typeof entry === 'function' ? entry() : entry } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        model: 'fake-1',
        provider: 'fake',
      };
    },
  };
}

function orchestratorHarness({ provider, execute = async () => ({ ok: true }), redact = (value) => value } = {}) {
  const assistant = createAssistantSurface({ execute });
  const contextResolver = createContextResolver({
    surfaces: [assistant.surface],
    guides: [assistant.guide],
    resolveScope: async () => ({
      surface: 'site_facility',
      workspaceId: PROJECT,
      organisationId: 'org-1',
      scenarioId: SCENARIO,
      revisionId: REVISION,
      scopeKind: 'project',
      displayName: 'Project',
      readOnly: false,
    }),
  });
  return createOrchestrator({
    provider,
    contextResolver,
    toolRegistry: createToolRegistry({ capabilities: assistant.capabilities }),
    uiActionRegistry: createUiActionRegistry({ actions: assistant.uiActions }),
    authorize: async () => true,
    redact,
  });
}

const turnRequest = () => ({
  messages: [{ role: 'user', content: 'Highlight Building A.' }],
  contextKey: 'facility',
  context: { userId: 'user-1', projectId: PROJECT, scenarioId: SCENARIO, revisionId: REVISION },
});

test('the orchestrator extracts an allow-listed uiActions array from the model envelope', async () => {
  const provider = scriptedProvider([
    JSON.stringify({
      type: 'message',
      payload: 'Building A is highlighted.',
      uiActions: [{ type: 'highlight_entity', version: 1, payload: { entity_id: ENTITY, entity_type: 'BUILDING' } }],
    }),
  ]);
  const result = await orchestratorHarness({ provider }).runTurn(turnRequest());

  assert.equal(result.status, 'ok');
  assert.equal(result.uiActions.length, 1);
  assert.equal(result.uiActions[0].type, 'highlight_entity');
  assert.equal(result.uiActions[0].confirmation, 'none');
  assert.deepEqual(result.uiActions[0].context, { surface: 'site_facility', contextKey: 'facility', workspaceId: PROJECT });
  assert.equal(result.trace.notices.length, 0);
});

test('an unlisted UI action is refused with a notice and the listed ones still dispatch', async () => {
  const provider = scriptedProvider([
    JSON.stringify({
      type: 'message',
      payload: 'Done.',
      uiActions: [
        { type: 'highlight_entity', version: 1, payload: { entity_id: ENTITY, entity_type: 'BUILDING' } },
        { type: 'run_javascript', version: 1, payload: { source: 'alert(1)' } },
      ],
    }),
  ]);
  const result = await orchestratorHarness({ provider }).runTurn(turnRequest());

  assert.deepEqual(result.uiActions.map((action) => action.type), ['highlight_entity']);
  const rejected = result.trace.notices.find((notice) => notice.code === 'UI_ACTION_REJECTED');
  assert.ok(rejected, 'the unlisted action is recorded as a notice');
  assert.match(rejected.message, /Unknown UI action/);
});

test('a UI action missing a required field is refused with a notice', async () => {
  const provider = scriptedProvider([
    JSON.stringify({
      type: 'message',
      payload: 'Done.',
      uiActions: [{ type: 'open_inspector', version: 1, payload: { entity_id: ENTITY } }],
    }),
  ]);
  const result = await orchestratorHarness({ provider }).runTurn(turnRequest());

  assert.deepEqual(result.uiActions, []);
  assert.ok(result.trace.notices.some((notice) => notice.code === 'UI_ACTION_REJECTED' && /missing/.test(notice.message)));
});

test('a configured secret is redacted from the returned content and the stored transcript', async () => {
  const provider = scriptedProvider([JSON.stringify({ type: 'message', payload: 'The key is super-secret-value.' })]);
  const result = await orchestratorHarness({ provider, redact: createRedactor(['super-secret-value']) }).runTurn(turnRequest());

  assert.equal(result.choices[0].message.content.includes('super-secret-value'), false);
  assert.equal(JSON.stringify(result).includes('super-secret-value'), false);
  assert.match(result.choices[0].message.content, /\[redacted\]/);
});

test('a tool call emits one audit record with a digest and no argument values', async () => {
  const audited = [];
  const assistant = createAssistantSurface({ execute: async () => ({ revisionId: REVISION, lifecycleState: 'DRAFT' }) });
  const contextResolver = createContextResolver({
    surfaces: [assistant.surface],
    guides: [assistant.guide],
    resolveScope: async () => ({
      surface: 'site_facility',
      workspaceId: PROJECT,
      organisationId: 'org-1',
      scenarioId: SCENARIO,
      revisionId: REVISION,
      scopeKind: 'project',
      displayName: 'P',
      readOnly: false,
    }),
  });
  const args = { revision_id: REVISION, include_coverage: false, include_validation: true };
  let round = 0;
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete() {
      round += 1;
      if (round === 1) {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_revision_context', arguments: JSON.stringify(args) } }],
              },
            },
          ],
          usage: { total_tokens: 1 },
          model: 'fake-1',
          provider: 'fake',
        };
      }
      return {
        choices: [{ message: { role: 'assistant', content: '{"type":"message","payload":"Draft.","uiActions":[]}' } }],
        usage: { total_tokens: 1 },
        model: 'fake-1',
        provider: 'fake',
      };
    },
  };
  const orchestrator = createOrchestrator({
    provider,
    contextResolver,
    toolRegistry: createToolRegistry({ capabilities: assistant.capabilities }),
    uiActionRegistry: createUiActionRegistry({ actions: assistant.uiActions }),
    authorize: async () => true,
    auditService: { record() {}, recordToolCall: (entry) => audited.push(entry) },
  });

  const result = await orchestrator.runTurn({
    messages: [{ role: 'user', content: 'read' }],
    contextKey: 'facility',
    context: { userId: 'user-1', projectId: PROJECT, scenarioId: SCENARIO, revisionId: REVISION },
  });

  assert.equal(result.status, 'ok');
  assert.equal(audited.length, 1, 'exactly one audit record per tool call');
  assert.equal(audited[0].tool, 'get_revision_context');
  assert.equal(audited[0].access, 'read');
  assert.equal(audited[0].outcome, 'ok');
  assert.equal(audited[0].user_id, 'user-1');
  assert.equal(audited[0].project_id, PROJECT);
  assert.equal(audited[0].scenario_id, SCENARIO);
  assert.equal(audited[0].revision_id, REVISION);
  assert.equal(audited[0].context_key, 'facility');
  assert.equal(audited[0].argument_digest, createHash('sha256').update(JSON.stringify(args)).digest('hex'));
  assert.deepEqual(audited[0].scope_ids, { project_id: PROJECT, scenario_id: SCENARIO, revision_id: REVISION });
  assert.equal(JSON.stringify(audited[0]).includes('include_coverage'), false, 'no argument value reaches the audit record');
});
