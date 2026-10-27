import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  HOVER_PREVIEW_DELAY_MS,
  createEntityHoverPreview,
  entityIdentity,
  resolveEntityReference,
  restoreSelectionSnapshot,
} from '../assistant/entity-resolver.js';

/**
 * One resolver for hover preview and click (chatbox blueprint §3.6,
 * assistant-integration.md "Entity-Reference Kinds").
 *
 * The assertions here are about *effect calls*: each kind must reach the workspace
 * target the spec names, an unknown kind must do nothing, and hover must restore the
 * snapshot it took. There is deliberately no second name→highlight path to test.
 */

const uuid = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

function recorder(overrides = {}) {
  const calls = [];
  const record = (name) => (input) => {
    calls.push([name, input]);
    return { applied: true };
  };
  return {
    calls,
    names: () => calls.map(([name]) => name),
    selectEntity: record('selectEntity'),
    highlightEntity: record('highlightEntity'),
    clearHighlight: record('clearHighlight'),
    focusGeometry: record('focusGeometry'),
    setLayerVisible: record('setLayerVisible'),
    revealAssetLayer: record('revealAssetLayer'),
    openInspector: record('openInspector'),
    showFinding: record('showFinding'),
    openRoute: record('openRoute'),
    openTool: record('openTool'),
    snapshot: () => {
      calls.push(['snapshot', undefined]);
      return overrides.snapshot ?? { routeState: {}, selectionRefs: [], draftSummary: null };
    },
    ...overrides,
  };
}

function scheduler() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimer(fn) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, fn);
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    flush() {
      const fns = [...tasks.values()];
      tasks.clear();
      for (const fn of fns) fn();
    },
    get size() {
      return tasks.size;
    },
  };
}

/* -------------------------------------------------------------- the kinds */

test('facility.entity selects and highlights the entity', () => {
  const effects = recorder();
  const outcome = resolveEntityReference(
    { kind: 'facility.entity', entity_id: uuid(1), entity_type: 'BUILDING', label: 'Hall 01' },
    effects,
  );

  assert.equal(outcome.handled, true);
  assert.deepEqual(effects.names(), ['selectEntity', 'highlightEntity']);
  assert.deepEqual(effects.calls[0][1], { entityId: uuid(1), entityType: 'BUILDING', geometryId: undefined, geometryRole: undefined });
  assert.deepEqual(effects.calls[1][1], { entityId: uuid(1), transient: false });
});

test('facility.geometry selects the entity and focuses the geometry', () => {
  const effects = recorder();
  const outcome = resolveEntityReference(
    { kind: 'facility.geometry', geometry_id: uuid(2), entity_id: uuid(1), entity_type: 'BUILDING', geometry_role: 'FOOTPRINT' },
    effects,
  );

  assert.equal(outcome.action, 'focus');
  assert.deepEqual(effects.names(), ['selectEntity', 'focusGeometry']);
  assert.deepEqual(effects.calls[0][1], { entityId: uuid(1), entityType: 'BUILDING', geometryId: uuid(2), geometryRole: 'FOOTPRINT' });
  assert.deepEqual(effects.calls[1][1], { geometryId: uuid(2) });
});

test('facility.diagnostic opens the validate route and focuses the finding', () => {
  const effects = recorder();
  const outcome = resolveEntityReference(
    { kind: 'facility.diagnostic', revision_id: uuid(3), diagnostic_id: uuid(4), constraint_id: 'facility.site.height.exceeded' },
    effects,
  );

  assert.equal(outcome.route, 'validate');
  assert.deepEqual(effects.names(), ['showFinding']);
  assert.deepEqual(effects.calls[0][1], {
    revisionId: uuid(3),
    diagnosticId: uuid(4),
    constraintId: 'facility.site.height.exceeded',
    severity: null,
  });
});

test('a binding or an import opens Import & Map on the named binding', () => {
  for (const kind of ['facility.asset_binding', 'facility.import']) {
    const effects = recorder();
    const outcome = resolveEntityReference(
      { kind, binding_id: uuid(5), mapping_id: uuid(6), asset_version_id: uuid(7) },
      effects,
    );
    assert.equal(outcome.route, 'import_map');
    assert.deepEqual(effects.names(), ['openRoute']);
    assert.deepEqual(effects.calls[0][1], {
      functionId: 'import_map',
      bindingId: uuid(5),
      mappingId: uuid(6),
      assetVersionId: uuid(7),
    });
  }
});

test('utility interfaces, phases, and budgets route and open the owning inspector', () => {
  const iface = recorder();
  resolveEntityReference({ kind: 'facility.utility_interface', interface_id: uuid(8) }, iface);
  assert.deepEqual(iface.calls[0], ['openRoute', { functionId: 'utilities', interfaceId: uuid(8) }]);
  assert.deepEqual(iface.calls[1], ['openInspector', { entityId: uuid(8), entityType: 'UTILITY_INTERFACE', tab: 'UTILITIES' }]);

  const phase = recorder();
  resolveEntityReference({ kind: 'facility.phase', phase_id: uuid(9) }, phase);
  assert.deepEqual(phase.calls[0], ['openRoute', { functionId: 'phasing', phaseId: uuid(9) }]);
  assert.deepEqual(phase.calls[1], ['openInspector', { entityId: uuid(9), entityType: 'FACILITY_PHASE', tab: 'PHASING' }]);

  const owned = recorder();
  resolveEntityReference({ kind: 'facility.capacity_budget', budget_id: uuid(10), owner_entity_id: uuid(11), entity_type: 'POWER' }, owned);
  assert.deepEqual(owned.calls[0], ['openRoute', { functionId: 'capacity', budgetId: uuid(10) }]);
  assert.deepEqual(owned.calls[1], ['openInspector', { entityId: uuid(11), entityType: 'POWER', tab: 'OVERVIEW' }]);

  // A budget with no owning entity is honest about what it could not do.
  const orphan = recorder();
  const outcome = resolveEntityReference({ kind: 'facility.capacity_budget', budget_id: uuid(10) }, orphan);
  assert.deepEqual(orphan.names(), ['openRoute']);
  assert.equal(outcome.delta.length, 1);
  assert.match(outcome.delta[0], /no inspector of its own/);
});

test('asset references open the Assets tool', () => {
  for (const kind of ['asset', 'asset.version']) {
    const effects = recorder();
    const outcome = resolveEntityReference({ kind, asset_id: uuid(12), asset_version_id: uuid(13) }, effects);
    assert.equal(outcome.toolId, 'assets');
    assert.deepEqual(effects.calls[0], ['openTool', { toolId: 'assets', assetId: uuid(12), assetVersionId: uuid(13) }]);
    assert.match(outcome.delta[0], /Assets tool was opened/);
  }
});

test("the server's own entity shape resolves, because it carries the id as `id`", () => {
  /**
   * A regression against a real payload, not a paraphrase of one. The collection pass
   * emits `{ kind: 'facility.entity', id, label }` — a bare `id`, neither `entityId`
   * nor `entity_id` — so a resolver reading only those two spellings refused every
   * reference the transcript had already rendered as a button: the label was clickable
   * and nothing happened. This is the shape captured from the deployment.
   */
  const serverEntity = { kind: 'facility.entity', id: uuid(1), label: 'Data Centre A' };

  const identity = entityIdentity(serverEntity);
  assert.equal(identity.entityId, uuid(1), 'the bare `id` is the entity identity');
  assert.equal(identity.kind, 'facility.entity');

  // Click: select and highlight, which is what the canvas needs to react.
  const clicked = recorder();
  assert.equal(resolveEntityReference(serverEntity, clicked).handled, true);
  assert.deepEqual(clicked.names(), ['selectEntity', 'highlightEntity']);
  assert.equal(clicked.calls[0][1].entityId, uuid(1));

  // Hover: the transient preview, the behaviour the chatbox advertises.
  const hovered = recorder();
  assert.equal(resolveEntityReference(serverEntity, hovered, { transient: true }).handled, true);
  assert.deepEqual(hovered.names(), ['selectEntity', 'highlightEntity']);
  assert.equal(hovered.calls[1][1].transient, true);
});

test('the id fallback belongs to facility.entity alone, so other kinds keep theirs', () => {
  // `candidateFrom` maps these fields to `facility.entity` too, so they must resolve.
  for (const field of ['containerId', 'scopeId', 'requirementId', 'storageId']) {
    const effects = recorder();
    assert.equal(resolveEntityReference({ kind: 'facility.entity', [field]: uuid(2) }, effects).handled, true, field);
    assert.equal(effects.calls[0][1].entityId, uuid(2), field);
  }

  // An asset row also carries an `id` column. It must NOT be read as the entity id:
  // `assetId` is the identity, and the resolver falls back to `entityId`, not `id`.
  const asset = entityIdentity({ kind: 'asset', id: 'the-row-id', assetId: uuid(3) });
  assert.equal(asset.entityId, null, 'a bare `id` is not an asset identity');

  // A kind that names no entity gets no fallback at all — unchanged behaviour.
  assert.equal(entityIdentity({ kind: 'document', id: 'row-1' }).entityId, null);
  assert.equal(entityIdentity({ id: 'row-1' }).entityId, null);

  // The explicit spellings still win over the fallback.
  assert.equal(entityIdentity({ kind: 'facility.entity', entityId: uuid(4), id: uuid(5) }).entityId, uuid(4));
  assert.equal(entityIdentity({ kind: 'facility.entity', entity_id: uuid(6), id: uuid(7) }).entityId, uuid(6));
});

test('an unknown kind or a reference with no identity is an unhandled no-op', () => {
  const effects = recorder();
  assert.deepEqual(resolveEntityReference({ kind: 'facility.spaceship', entity_id: uuid(1) }, effects), {
    handled: false,
    kind: 'facility.spaceship',
    reason: 'unknown entity-reference kind "facility.spaceship"',
  });
  assert.deepEqual(resolveEntityReference({ kind: 'facility.entity' }, effects), {
    handled: false,
    kind: 'facility.entity',
    reason: 'the reference names no entity id',
  });
  assert.deepEqual(resolveEntityReference({}, effects).handled, false);
  assert.deepEqual(effects.names(), [], 'nothing was called for an unresolved reference');
});

test('identity is read from both wire spellings, which is what keeps one matcher', () => {
  assert.deepEqual(entityIdentity({ kind: 'facility.entity', entityId: 'e-1', entityType: 'BUILDING' }), {
    kind: 'facility.entity',
    entityId: 'e-1',
    entityType: 'BUILDING',
    geometryId: null,
    geometryRole: null,
    revisionId: null,
    projectId: null,
    diagnosticId: null,
    constraintId: null,
    severity: null,
    bindingId: null,
    mappingId: null,
    assetId: null,
    assetVersionId: null,
    representationId: null,
    interfaceId: null,
    utilitySourceId: null,
    phaseId: null,
    budgetId: null,
    ownerEntityId: null,
    resourceKind: null,
    basis: null,
    label: null,
  });

  const effects = recorder();
  resolveEntityReference({ kind: 'facility.entity', entityId: 'e-1', entityType: 'BUILDING' }, effects);
  assert.deepEqual(effects.calls[0][1].entityId, 'e-1');
});

/* ------------------------------------------------------------- hover */

test('hover is debounced: nothing is applied until the pointer has rested', () => {
  const effects = recorder();
  const clock = scheduler();
  const hover = createEntityHoverPreview(() => effects, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  hover.enter({ kind: 'facility.entity', entity_id: uuid(1), entity_type: 'BUILDING' });
  assert.equal(clock.size, 1, 'the preview is scheduled, not applied');
  assert.deepEqual(effects.names(), []);

  clock.flush();
  assert.deepEqual(effects.names(), ['snapshot', 'selectEntity', 'highlightEntity']);
  assert.equal(effects.calls[2][1].transient, true, 'the preview is a transient highlight');
  assert.equal(hover.previewing, true);
});

test('leaving restores the snapshot taken before the preview, and enqueues no undo', () => {
  const before = {
    routeState: { selectedEntityId: 'e-previous', selectedGeometryId: 'g-previous' },
    selectionRefs: [],
    draftSummary: null,
  };
  const calls = [];
  const effects = recorder({
    snapshot: () => {
      calls.push('snapshot');
      return before;
    },
    restoreSnapshot: (snap) => {
      calls.push(['restoreSnapshot', snap]);
    },
  });

  const clock = scheduler();
  const hover = createEntityHoverPreview(() => effects, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  hover.enter({ kind: 'facility.entity', entity_id: uuid(1), entity_type: 'BUILDING' });
  clock.flush();
  hover.leave();

  assert.deepEqual(calls, ['snapshot', ['restoreSnapshot', before]]);
  assert.equal(hover.previewing, false);
  assert.equal(hover.snapshot, null);
});

test('leaving before the delay elapses cancels the preview and restores nothing', () => {
  const effects = recorder();
  const clock = scheduler();
  const hover = createEntityHoverPreview(() => effects, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  hover.enter({ kind: 'facility.entity', entity_id: uuid(1), entity_type: 'BUILDING' });
  hover.leave();
  assert.equal(clock.size, 0, 'the scheduled preview was cancelled');
  clock.flush();
  assert.deepEqual(effects.names(), []);
  assert.equal(hover.previewing, false);
});

test('a kind that needs navigation is not previewed on hover', () => {
  const effects = recorder();
  const clock = scheduler();
  const hover = createEntityHoverPreview(() => effects, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  hover.enter({ kind: 'facility.diagnostic', revision_id: uuid(3), diagnostic_id: uuid(4) });
  clock.flush();
  assert.deepEqual(effects.names(), []);
  assert.equal(hover.previewing, false, 'the pinned path is where navigation belongs');

  // The same reference pinned does navigate.
  const outcome = resolveEntityReference({ kind: 'facility.diagnostic', revision_id: uuid(3), diagnostic_id: uuid(4) }, effects);
  assert.equal(outcome.handled, true);
  assert.deepEqual(effects.names(), ['showFinding']);
});

test('the default hover delay is the documented tens of milliseconds', () => {
  assert.ok(HOVER_PREVIEW_DELAY_MS >= 20 && HOVER_PREVIEW_DELAY_MS <= 500);
});

/* ------------------------------------------- restore without a first-class path */

test('restore falls back to the documented effect vocabulary when the handle has no restoreSnapshot', () => {
  const effects = recorder();
  delete effects.restoreSnapshot;

  restoreSelectionSnapshot(effects, {
    routeState: { selectedEntityId: 'e-previous', selectedGeometryId: 'g-previous' },
    selectionRefs: [{ kind: 'facility.entity', entity_id: 'e-previous', entity_type: 'BUILDING' }],
  });

  assert.deepEqual(effects.calls[0], ['clearHighlight', undefined]);
  assert.deepEqual(effects.calls[1], ['selectEntity', { entityId: 'e-previous', entityType: 'BUILDING', geometryId: 'g-previous' }]);
  assert.deepEqual(effects.calls[2], ['focusGeometry', { geometryId: 'g-previous' }]);

  const empty = recorder();
  delete empty.restoreSnapshot;
  restoreSelectionSnapshot(empty, { routeState: {}, selectionRefs: [] });
  assert.deepEqual(empty.calls[1], ['selectEntity', { entityId: null }]);
});
