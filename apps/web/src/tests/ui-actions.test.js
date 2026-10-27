import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  INSPECTOR_FIELD_PATHS,
  INSPECTOR_TABS,
  LAYER_KINDS,
  MAX_HANDLER_RETRIES,
  UI_ACTION_TYPES,
  createEffectHandlers,
  createUiActionDispatcher,
  describeAvailableActions,
  noticeFor,
  uiActionTypeFor,
  validateUiAction,
} from '../assistant/ui-actions.js';

/**
 * The client registry is a mirror of the server's UI-action descriptors
 * (assistant-integration.md, "UI-Action Type Registry"; chatbox blueprint §4.6).
 *
 * These tests are the client half of the contract: the exact six `type@version`
 * values, snake_case payload properties, presentation-only confirmation, and a
 * dispatcher that validates, rejects stale scopes, is idempotent by action id, and
 * reports failure as a notice rather than an exception in the transcript.
 */

const uuid = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

const CONTEXT = { surface: 'site_facility', contextKey: 'p-1|s-1|r-1', workspaceId: 'p-1' };

function action(overrides = {}) {
  return {
    id: 'a-1',
    type: 'highlight_entity',
    version: 1,
    context: { ...CONTEXT },
    confirmation: 'none',
    payload: { entity_id: uuid(1), entity_type: 'BUILDING' },
    ...overrides,
  };
}

/* ------------------------------------------------------------- the registry */

test('the registry declares exactly the six type@version descriptors', () => {
  assert.deepEqual(
    UI_ACTION_TYPES.map((item) => `${item.type}@${item.version}`),
    [
      'highlight_entity@1',
      'focus_geometry@1',
      'open_inspector@1',
      'show_finding@1',
      'reveal_asset_layer@1',
      'set_layer_visibility@1',
    ],
  );
});

test('every type is presentation-only and declares confirmation none', () => {
  for (const descriptor of UI_ACTION_TYPES) {
    assert.equal(descriptor.confirmation, 'none', `${descriptor.type} must never claim a confirmation gate`);
  }
});

test('the payload schemas use the spec snake_case property names and bounds', () => {
  const expectedKeys = {
    highlight_entity: ['entity_id', 'entity_type', 'label'],
    focus_geometry: ['entity_id', 'geometry_id', 'geometry_role', 'bbox'],
    open_inspector: ['entity_id', 'entity_type', 'tab', 'field_path'],
    show_finding: ['revision_id', 'diagnostic_id', 'constraint_id', 'severity'],
    reveal_asset_layer: ['asset_version_id', 'representation_id', 'layer_selector', 'visible'],
    set_layer_visibility: ['layer_kind', 'visible', 'geometry_role'],
  };

  for (const descriptor of UI_ACTION_TYPES) {
    assert.deepEqual(Object.keys(descriptor.inputSchema), expectedKeys[descriptor.type], descriptor.type);
  }

  assert.equal(uiActionTypeFor('highlight_entity', 1).inputSchema.label.maxLength, 256);
  assert.deepEqual(uiActionTypeFor('open_inspector', 1).inputSchema.tab.values, INSPECTOR_TABS);
  assert.deepEqual(uiActionTypeFor('set_layer_visibility', 1).inputSchema.layer_kind.values, LAYER_KINDS);
  assert.equal(uiActionTypeFor('highlight_entity', 2), null, 'version 2 is not declared');
  assert.equal(uiActionTypeFor('run_sql', 1), null);
});

test('available_actions reports the registry with an enabled flag and no disabled reason', () => {
  const available = describeAvailableActions();
  assert.equal(available.length, 6);
  for (const item of available) {
    assert.equal(typeof item.type, 'string');
    assert.equal(item.version, 1);
    assert.equal(item.enabled, true);
    assert.equal(item.disabled_reason, null);
  }
});

/* ------------------------------------------------------------ validation */

test('an unknown type or version is rejected before any handler could run', () => {
  assert.equal(validateUiAction(action({ type: 'run_javascript' })).ok, false);
  assert.match(validateUiAction(action({ type: 'run_javascript' })).reason, /unknown action type/);
  assert.equal(validateUiAction(action({ version: 2 })).ok, false);
  assert.equal(validateUiAction(null).ok, false);
});

test('a rejected action is named, without a version joined on that was never there', () => {
  // The reason is shown to the reader, so `highlight_entity@undefined` would name nothing and
  // hide which action was refused — the identity the model's `type@version` spelling produced.
  assert.equal(validateUiAction({ type: 'run_javascript' }).reason, 'unknown action type "run_javascript"');
  assert.equal(validateUiAction({ type: 'run_javascript', version: 2 }).reason, 'unknown action type "run_javascript@2"');
});

test('a payload missing a required field is rejected', () => {
  const verdict = validateUiAction(action({ payload: { entity_type: 'BUILDING' } }));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /missing entity_id/);

  const missingBool = validateUiAction(
    action({ type: 'set_layer_visibility', payload: { layer_kind: 'FACILITIES' } }),
  );
  assert.equal(missingBool.ok, false);
  assert.match(missingBool.reason, /missing visible/);
});

test('field-level rules reject a bad enum, a bad uuid, and an over-long string', () => {
  assert.equal(validateUiAction(action({ payload: { entity_id: uuid(1), entity_type: 'SPACESHIP' } })).ok, false);
  assert.equal(validateUiAction(action({ payload: { entity_id: 'not-a-uuid', entity_type: 'BUILDING' } })).ok, false);
  assert.equal(validateUiAction(action({ payload: { entity_id: uuid(1), entity_type: 'BUILDING', label: 'x'.repeat(257) } })).ok, false);
  assert.equal(validateUiAction(action({ payload: { entity_id: uuid(1), entity_type: 'BUILDING', label: 'x'.repeat(256) } })).ok, true);
});

test('focus_geometry needs a geometry id or a well-formed bbox', () => {
  const base = { entity_id: uuid(1) };
  const none = validateUiAction(action({ type: 'focus_geometry', payload: base }));
  assert.equal(none.ok, false);
  assert.match(none.reason, /requires one of geometry_id, bbox/);

  for (const bbox of [[0, 0, 1], [0, 0, 1, 'x'], [2, 0, 1, 1], [0, 2, 1, 1], [NaN, 0, 1, 1]]) {
    assert.equal(
      validateUiAction(action({ type: 'focus_geometry', payload: { ...base, bbox } })).ok,
      false,
      `${JSON.stringify(bbox)} must be rejected`,
    );
  }
  assert.equal(validateUiAction(action({ type: 'focus_geometry', payload: { ...base, bbox: [0, 0, 1, 1] } })).ok, true);
  assert.equal(
    validateUiAction(action({ type: 'focus_geometry', payload: { ...base, geometry_id: uuid(2) } })).ok,
    true,
  );
});

test('show_finding needs a diagnostic or a constraint id', () => {
  const base = { revision_id: uuid(1) };
  assert.equal(validateUiAction(action({ type: 'show_finding', payload: base })).ok, false);
  assert.equal(
    validateUiAction(action({ type: 'show_finding', payload: { ...base, constraint_id: 'facility.site.height' } })).ok,
    true,
  );
  assert.equal(
    validateUiAction(action({ type: 'show_finding', payload: { ...base, diagnostic_id: uuid(3) } })).ok,
    true,
  );
  assert.equal(
    validateUiAction(action({ type: 'show_finding', payload: { ...base, constraint_id: 'x', severity: 'FATAL' } })).ok,
    false,
  );
});

test('open_inspector rejects a field path that is not a field of the selected entity', () => {
  const base = { entity_id: uuid(1), entity_type: 'BUILDING', tab: 'OVERVIEW' };
  assert.equal(validateUiAction(action({ type: 'open_inspector', payload: base })).ok, true);
  assert.equal(
    validateUiAction(action({ type: 'open_inspector', payload: { ...base, field_path: 'elevation_top_m' } })).ok,
    true,
  );
  assert.equal(
    validateUiAction(action({ type: 'open_inspector', payload: { ...base, field_path: 'object_store_key' } })).ok,
    false,
  );
  assert.ok(INSPECTOR_FIELD_PATHS.includes('capacity_state'));
});

/* ------------------------------------------------------------- staleness */

test('a stale action whose embedded scope no longer matches is rejected', () => {
  const stale = validateUiAction(action({ context: { ...CONTEXT, contextKey: 'p-1|s-1|r-2' } }), {
    currentContextKey: 'p-1|s-1|r-1',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /different workspace context/);

  const foreign = validateUiAction(action({ context: { ...CONTEXT, workspaceId: 'p-9' } }), {
    currentContextKey: 'p-1|s-1|r-1',
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /different workspace/);

  assert.equal(validateUiAction(action(), { currentContextKey: 'p-1|s-1|r-1' }).ok, true);
  // An envelope with no embedded scope carries nothing that can be stale.
  assert.equal(validateUiAction(action({ context: undefined }), { currentContextKey: 'p-1|s-1|r-1' }).ok, true);
});

test('an applied action id is a no-op on re-validation', () => {
  const appliedIds = new Set(['a-1']);
  const verdict = validateUiAction(action(), { appliedIds });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /already applied/);
  assert.equal(validateUiAction(action({ id: 'a-2' }), { appliedIds }).ok, true);
});

/* ------------------------------------------------------------ dispatcher */

test('the dispatcher validates, runs the handler, and records the applied id', async () => {
  const seen = [];
  const dispatcher = createUiActionDispatcher({
    handlers: { 'highlight_entity@1': (act) => seen.push(act.payload.entity_id) },
  });

  const result = await dispatcher.dispatch([action()], { currentContextKey: 'p-1|s-1|r-1' });
  assert.deepEqual(seen, [uuid(1)]);
  assert.deepEqual(result.applied, ['a-1']);
  assert.deepEqual(result.notices, []);
  assert.equal(result.stopped, false);

  // Same action again: the applied-id set makes it a no-op rather than a second run.
  const again = await dispatcher.dispatch([action()], { currentContextKey: 'p-1|s-1|r-1' });
  assert.deepEqual(seen, [uuid(1)]);
  assert.equal(again.applied.length, 0);
  assert.match(again.notices[0], /already applied/);
});

test('a stale or unknown action is reported as a notice, never thrown into the transcript', async () => {
  const notices = [];
  const dispatcher = createUiActionDispatcher({
    handlers: {},
    onNotice: (line) => notices.push(line),
  });

  const result = await dispatcher.dispatch(
    [action({ context: { ...CONTEXT, contextKey: 'other' } }), action({ id: 'a-2', type: 'set_layer_visibility', payload: { layer_kind: 'FACILITIES', visible: false } })],
    { currentContextKey: 'p-1|s-1|r-1' },
  );

  // The unhandled-but-valid action got its own notice; the stale one did not stop it.
  assert.equal(result.notices.length, 2);
  assert.match(result.notices[0], /different workspace context/);
  assert.match(result.notices[1], /no handler is registered/);
  assert.deepEqual(notices, result.notices);
  assert.equal(result.applied.length, 0);
});

test('a failing handler follows its failurePolicy: stop by default, continue when asked', async () => {
  const attempted = [];
  const handling = (failurePolicy) => ({
    ['highlight_entity@1']: { handler: () => { attempted.push('one'); throw new Error('the canvas refused'); }, failurePolicy },
    ['set_layer_visibility@1']: { handler: () => { attempted.push('two'); } },
  });

  const stopped = await createUiActionDispatcher({ handlers: handling('stop') }).dispatch(
    [action(), action({ id: 'a-2', type: 'set_layer_visibility', payload: { layer_kind: 'HAZARDS', visible: false } })],
  );
  assert.deepEqual(attempted, ['one'], 'a stop handler aborts the remaining actions');
  assert.equal(stopped.stopped, true);
  assert.match(stopped.notices[0], /the canvas refused/);

  const continued = await createUiActionDispatcher({ handlers: handling('continue') }).dispatch(
    [action(), action({ id: 'a-2', type: 'set_layer_visibility', payload: { layer_kind: 'HAZARDS', visible: false } })],
  );
  assert.deepEqual(continued.applied, ['a-2']);
  assert.match(continued.notices[0], /the canvas refused/);
});

test('only a retryable handler is retried, and only up to the small cap', async () => {
  let transientAttempts = 0;
  const transient = createUiActionDispatcher({
    handlers: {
      'highlight_entity@1': {
        handler: () => {
          transientAttempts += 1;
          if (transientAttempts < 3) throw new Error('temporarily unavailable');
          return { ok: true };
        },
        retryable: true,
      },
    },
  });
  const recovered = await transient.dispatch([action()]);
  assert.equal(transientAttempts, 3);
  assert.deepEqual(recovered.applied, ['a-1']);
  assert.deepEqual(recovered.notices, []);

  let attempts = 0;
  const always = createUiActionDispatcher({
    handlers: {
      'highlight_entity@1': {
        handler: () => {
          attempts += 1;
          const error = new Error('still unavailable');
          throw error;
        },
        retryable: true,
      },
    },
  });
  const failed = await always.dispatch([action()]);
  assert.equal(attempts, MAX_HANDLER_RETRIES + 1, 'the retry cap bounds the attempts');
  assert.deepEqual(failed.applied, []);
  assert.match(failed.notices[0], /still unavailable/);

  let notRetried = 0;
  const plain = createUiActionDispatcher({
    handlers: {
      'highlight_entity@1': () => {
        notRetried += 1;
        throw new Error('no retry for me');
      },
    },
  });
  await plain.dispatch([action()]);
  assert.equal(notRetried, 1, 'a handler that did not opt in runs once');
});

test('a handler that only partly acted reports a delta as a notice', async () => {
  const dispatcher = createUiActionDispatcher({
    handlers: { 'set_layer_visibility@1': () => ({ applied: false, delta: ['that layer is not drawn yet'] }) },
  });
  const result = await dispatcher.dispatch([
    action({ type: 'set_layer_visibility', payload: { layer_kind: 'PHASES', visible: false } }),
  ]);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], /that layer is not drawn yet/);
});

test('noticeFor always produces a short user-facing line', () => {
  assert.match(noticeFor('the action belongs to a different workspace context'), /different workspace context/);
  assert.match(noticeFor(''), /could not be applied/);
  assert.match(noticeFor(null), /could not be applied/);
  assert.match(noticeFor(), /could not be applied/);
});

/* --------------------------------------------- the effect-handler mapping */

test('the effect handlers map snake_case payloads onto the effects vocabulary', async () => {
  const calls = [];
  const effects = new Proxy(
    {},
    {
      get: (_target, name) => (...args) => {
        calls.push([name, args[0]]);
        return { applied: true };
      },
    },
  );
  const handlers = createEffectHandlers(effects);

  await handlers['highlight_entity@1'](action());
  assert.deepEqual(calls.at(-1), ['highlightEntity', { entityId: uuid(1), entityType: 'BUILDING', transient: false }]);

  await handlers['focus_geometry@1'](action({ type: 'focus_geometry', payload: { entity_id: uuid(1), geometry_id: uuid(2), bbox: [0, 0, 1, 1] } }));
  assert.deepEqual(calls.at(-2), ['selectEntity', { entityId: uuid(1), geometryId: uuid(2) }]);
  assert.deepEqual(calls.at(-1), ['focusGeometry', { geometryId: uuid(2), bbox: [0, 0, 1, 1] }]);

  await handlers['open_inspector@1'](action({ type: 'open_inspector', payload: { entity_id: uuid(1), entity_type: 'UTILITY_SOURCE', tab: 'UTILITIES', field_path: 'capacity_state' } }));
  assert.deepEqual(calls.at(-1), [
    'openInspector',
    { entityId: uuid(1), entityType: 'UTILITY_SOURCE', tab: 'UTILITIES', fieldPath: 'capacity_state' },
  ]);

  await handlers['show_finding@1'](action({ type: 'show_finding', payload: { revision_id: uuid(1), constraint_id: 'facility.site.height' } }));
  assert.deepEqual(calls.at(-1), [
    'showFinding',
    { revisionId: uuid(1), diagnosticId: null, constraintId: 'facility.site.height', severity: null },
  ]);

  await handlers['reveal_asset_layer@1'](action({ type: 'reveal_asset_layer', payload: { asset_version_id: uuid(4), visible: true, layer_selector: 'A-LEVEL' } }));
  assert.deepEqual(calls.at(-1), [
    'revealAssetLayer',
    { assetVersionId: uuid(4), representationId: null, layerSelector: 'A-LEVEL', visible: true },
  ]);

  await handlers['set_layer_visibility@1'](action({ type: 'set_layer_visibility', payload: { layer_kind: 'HAZARDS', visible: false } }));
  assert.deepEqual(calls.at(-1), ['setLayerVisible', { layerKind: 'HAZARDS', visible: false, geometryRole: null }]);
});

test('an effects handle is optional: dispatch still validates and reports', async () => {
  const dispatcher = createUiActionDispatcher({ handlers: createEffectHandlers(null) });
  const result = await dispatcher.dispatch([action()]);
  assert.equal(result.applied.length, 0);
  assert.match(result.notices[0], /no handler is registered/);
});
