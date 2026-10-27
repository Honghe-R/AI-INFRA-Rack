import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ENTITY_GEOMETRY,
  authoringBlockers,
  bindChangeSet,
  changeKey,
  changeSetSummary,
  conflictFrom,
  countPositions,
  describeChange,
  draftAreaHint,
  emptyChangeSet,
  isDirty,
  pointFromCoordinates,
  polygonFromPoints,
  rebaseChangeSet,
  stageChange,
  stageUtilityInterface,
  unstageChange,
} from '../facility/authoring-state.js';

const geometry = (entityId, role = 'FOOTPRINT', ring = [[0, 0], [1, 0], [1, 1], [0, 0]]) => ({
  kind: 'set_geometry',
  entity_ref: { entity_id: entityId },
  payload: { role, geojson_4326: { type: 'Polygon', coordinates: [ring] } },
});

/* ------------------------------------------------------------------ staging */

test('staging accumulates, and the set is dirty until it is cleared', () => {
  let set = emptyChangeSet({ revisionId: 'r-1' });
  assert.equal(isDirty(set), false);

  set = stageChange(set, { kind: 'update_entity', entity_ref: { entity_id: 'e-1' }, payload: { patch: { name: 'A' } } });
  set = stageChange(set, { kind: 'update_entity', entity_ref: { entity_id: 'e-2' }, payload: { patch: { name: 'B' } } });
  assert.equal(isDirty(set), true);
  assert.equal(set.changes.length, 2);
  assert.deepEqual(changeSetSummary(set), { total: 2, byKind: { update_entity: 2 } });
});

test('a re-drawn footprint replaces the earlier one instead of stacking', () => {
  // Two geometry records for one role would fight over it; the last drawing is the intent.
  let set = emptyChangeSet();
  set = stageChange(set, geometry('e-1', 'FOOTPRINT', [[0, 0], [1, 0], [1, 1], [0, 0]]));
  set = stageChange(set, geometry('e-1', 'FOOTPRINT', [[0, 0], [2, 0], [2, 2], [0, 0]]));

  assert.equal(set.changes.length, 1);
  assert.equal(countPositions(set.changes[0].payload.geojson_4326), 4);
  assert.deepEqual(set.changes[0].payload.geojson_4326.coordinates[0][1], [2, 0]);
});

test('a different role for the same entity is a separate change', () => {
  let set = emptyChangeSet();
  set = stageChange(set, geometry('e-1', 'FOOTPRINT'));
  set = stageChange(set, geometry('e-1', 'BOUNDARY'));
  assert.equal(set.changes.length, 2);
  assert.deepEqual(
    set.changes.map((change) => changeKey(change)).sort(),
    ['geometry:e-1:BOUNDARY:0', 'geometry:e-1:FOOTPRINT:0'],
  );
});

test('staging a removal cancels that entity\u2019s pending edits', () => {
  // Asking the server to update and delete one entity in the same set is a conflict the
  // user did not create.
  let set = emptyChangeSet();
  set = stageChange(set, { kind: 'update_entity', entity_ref: { entity_id: 'e-1' }, payload: { patch: { name: 'A' } } });
  set = stageChange(set, geometry('e-1'));
  set = stageChange(set, { kind: 'update_entity', entity_ref: { entity_id: 'e-2' }, payload: { patch: { name: 'B' } } });
  set = stageChange(set, { kind: 'remove_entity', entity_ref: { entity_id: 'e-1' }, payload: { cascade: 'NONE' } });

  assert.equal(set.changes.length, 2, 'only the removal and the unrelated edit remain');
  assert.deepEqual(
    set.changes.map((change) => change.kind).sort(),
    ['remove_entity', 'update_entity'],
  );
  assert.equal(set.changes.some((change) => change.entity_ref?.entity_id === 'e-1' && change.kind !== 'remove_entity'), false);
});

test('un-staging removes one change and ignores an out-of-range index', () => {
  let set = emptyChangeSet();
  set = stageChange(set, { kind: 'update_entity', entity_ref: { entity_id: 'e-1' }, payload: { patch: { name: 'A' } } });
  set = stageChange(set, { kind: 'update_entity', entity_ref: { entity_id: 'e-2' }, payload: { patch: { name: 'B' } } });

  set = unstageChange(set, 0);
  assert.equal(set.changes.length, 1);
  assert.equal(set.changes[0].entity_ref.entity_id, 'e-2');
  assert.equal(unstageChange(set, 99).changes.length, 1);
});

/* -------------------------------------------------------------- descriptors */

test('a pending change is described in words, not by its change kind', () => {
  const names = new Map([['e-1', 'Data Centre A']]);
  const nameOf = (id) => names.get(id) ?? null;

  assert.match(describeChange({ kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'Data Centre C' } }), /Create building “Data Centre C”/);
  assert.match(describeChange({ kind: 'update_entity', entity_ref: { entity_id: 'e-1' }, payload: { patch: { name: 'x', elevation_top_m: 12 } } }, { nameOf }), /Edit Data Centre A \(name, elevation_top_m\)/);
  assert.match(describeChange(geometry('e-1'), { nameOf }), /Draw footprint for Data Centre A \(4 vertices\)/);
  assert.match(describeChange({ kind: 'remove_entity', entity_ref: { entity_id: 'e-1' }, payload: { cascade: 'CHILDREN' } }, { nameOf }), /Remove Data Centre A and its children/);
  assert.match(describeChange({ kind: 'update_entity', entity_ref: { entity_id: 'e-9' }, payload: { patch: { name: 'x' } } }, { nameOf }), /entity e-9…/);
});

/* ------------------------------------------------------------------ blockers */

test('a validated revision, a missing token, and a read-only role each say why', () => {
  assert.match(authoringBlockers({ envelope: { lifecycleState: 'DRAFT', etag: null }, canWrite: true }), /no draft ETag/);
  assert.match(
    authoringBlockers({ envelope: { lifecycleState: 'VALIDATED', etag: 'e' }, canWrite: true }),
    /VALIDATED and cannot be edited/,
  );
  assert.match(authoringBlockers({ envelope: { lifecycleState: 'DRAFT', etag: 'e' }, canWrite: false }), /write permission/);
  assert.equal(authoringBlockers({ envelope: { lifecycleState: 'DRAFT', etag: 'e' }, canWrite: true }), null);
});

/* ------------------------------------------------------------------ geometry */

test('a polygon needs three vertices, and closes itself', () => {
  assert.equal(polygonFromPoints([[0, 0], [1, 0]]), null);
  const polygon = polygonFromPoints([[0, 0], [1, 0], [1, 1]]);
  assert.equal(polygon.type, 'Polygon');
  assert.deepEqual(polygon.coordinates[0], [[0, 0], [1, 0], [1, 1], [0, 0]]);
});

test('the drawing hint is an area in square metres, and only once a shape exists', () => {
  assert.equal(draftAreaHint([[0, 0], [1, 0]]), 0);
  // One thousandth of a degree square at the equator is roughly 111 m on a side.
  const area = draftAreaHint([[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001]]);
  assert.ok(area > 10_000 && area < 13_000, `expected about 12,300 m², got ${area}`);
});

/* ----------------------------------------------------------------- conflicts */

test('a stale token becomes a decision, not a silent re-base', () => {
  const conflict = conflictFrom({
    status: 409,
    code: 'REVISION_ETAG_STALE',
    message: 'The draft has changed since this write was prepared.',
    details: [{ constraint_id: 'facility.revision.current', current_etag: 'e-2', current_etag_version: 5 }],
  });

  assert.equal(conflict.kind, 'stale');
  assert.equal(conflict.currentEtag, 'e-2');
  assert.equal(conflict.currentEtagVersion, 5);
  assert.match(conflict.message, /Someone else changed this draft/);

  const rebased = rebaseChangeSet({ ...emptyChangeSet({ revisionId: 'r-1', etag: 'e-1' }), changes: [geometry('e-1')] }, 'e-2');
  assert.equal(rebased.etag, 'e-2');
  assert.equal(rebased.changes.length, 1, 'the pending work survives a re-base');
});

test('an immutable revision and an unrelated failure are distinguished', () => {
  const immutable = conflictFrom({ status: 409, code: 'REVISION_IMMUTABLE', message: 'frozen', details: [] });
  assert.equal(immutable.kind, 'immutable');
  assert.equal(conflictFrom({ status: 500, code: 'INTERNAL_ERROR' }), null);
  assert.equal(conflictFrom(null), null);
});

test('a change-set conflict names what still refers to the object', () => {
  // The domain collects the referrers precisely so the refusal is actionable; dropping
  // them here would leave the user with "conflicts with existing records" and no next step.
  const conflict = conflictFrom({
    status: 409,
    code: 'CHANGE_SET_CONFLICT',
    message: 'The change set conflicts with existing records.',
    details: [
      {
        index: 0,
        kind: 'remove_entity',
        reason: 'referenced',
        referrers: [
          { table: 'spatial_constraints', label: 'spatial constraint', name: 'HEIGHT_LIMIT' },
          { table: 'capacity_budgets', label: 'capacity budget', name: 'POWER' },
        ],
      },
    ],
  });

  assert.equal(conflict.kind, 'referenced');
  assert.match(conflict.message, /a spatial constraint and a capacity budget/);

  const children = conflictFrom({
    status: 409,
    code: 'CHANGE_SET_CONFLICT',
    details: [{ reason: 'has_children', referrers: [{ table: 'facility_containers', label: 'child container', name: 'Hall A' }] }],
  });
  assert.equal(children.kind, 'referenced');
  assert.match(children.message, /children/);

  assert.equal(
    conflictFrom({ status: 409, code: 'CHANGE_SET_CONFLICT', details: [] }).kind,
    'referenced',
    'a conflict with no usable detail still reaches the panel',
  );
});

test('a rejected change names the rule it broke, not just that the set was invalid', () => {
  const rejection = conflictFrom({
    status: 422,
    code: 'CHANGE_SET_REJECTED',
    message: 'One or more changes are not valid.',
    details: [
      {
        index: 0,
        kind: 'update_entity',
        reason: 'not_allowed',
        field: 'payload.patch.level_number',
        message: 'Only a FLOOR or a HALL carries a level number.',
      },
    ],
  });

  assert.equal(rejection.kind, 'rejected');
  assert.match(rejection.message, /Only a FLOOR or a HALL carries a level number/);
  assert.match(rejection.message, /Nothing was applied/);

  // The last-resort store refusal is still the server's sentence, so the user is told
  // what the store would not accept rather than only that the set was refused.
  const storeRefused = conflictFrom({
    status: 422,
    code: 'CHANGE_SET_REJECTED',
    details: [{ index: 0, reason: 'store_refused', message: 'the store refused the row' }],
  });
  assert.match(storeRefused.message, /the store refused the row/);

  assert.equal(conflictFrom({ status: 422, code: 'VALIDATION_FAILED' }), null, 'a 422 that is not a change-set refusal is left alone');
});

test('binding to the revision already bound is not a state change', () => {
  // The surface binds from an effect keyed on the envelope. If an unchanged binding
  // produced a new set, the effect would set state, re-render, and bind again — the
  // "Maximum update depth exceeded" loop, not a redundant update.
  const bound = bindChangeSet(emptyChangeSet({ revisionId: 'r-1' }), {
    revisionId: 'r-1',
    envelope: { revisionId: 'r-1', etag: 'e-1' },
  });

  assert.equal(bound.etag, 'e-1');
  assert.equal(bound.baseRevisionId, 'r-1');

  const again = bindChangeSet(bound, { revisionId: 'r-1', envelope: { revisionId: 'r-1', etag: 'e-1' } });
  assert.equal(again, bound, 'the identical set object comes back');

  const advanced = bindChangeSet(bound, { revisionId: 'r-1', envelope: { revisionId: 'r-1', etag: 'e-2' } });
  assert.notEqual(advanced, bound, 'a new token re-bases');
  assert.equal(advanced.etag, 'e-2');
});

test('a different revision starts a fresh set rather than carrying edits across', () => {
  const carrying = { ...emptyChangeSet({ revisionId: 'r-1', etag: 'e-1' }), changes: [geometry('x-1')] };

  const rebound = bindChangeSet(carrying, { revisionId: 'r-2', envelope: { revisionId: 'r-2', etag: 'e-9' } });
  assert.equal(rebound.revisionId, 'r-2');
  assert.equal(rebound.etag, 'e-9');
  assert.deepEqual(rebound.changes, [], 'edits for a graph the user never saw are not applied to this one');
});

/* ------------------------------------------------- interfaces and geometry roles */

test('a new interface takes its domain and phase from the source it connects to', () => {
  // An interface that declared its own would be `facility.utility.interface.redefines_source`,
  // which is an ERROR, so the tool must not offer the choice at all.
  const staged = [];
  const source = {
    utilitySourceId: 's-1',
    kind: 'POWER',
    failureDomainId: 'd-1',
    phaseId: 'p-1',
  };

  const result = stageUtilityInterface({
    stage: (change) => staged.push(change),
    source,
    coordinates: [-77.5, 39.1],
    name: '  Substation A  ',
  });

  assert.equal(staged.length, 2, 'one change for the interface and one for its geometry');
  const [iface, geometry] = staged;

  assert.equal(iface.kind, 'set_utility_interface');
  assert.equal(iface.payload.failure_domain_id, 'd-1', 'inherited from the source');
  assert.equal(iface.payload.phase_id, 'p-1', 'inherited from the source');
  assert.equal(iface.payload.service_state, 'AVAILABLE', 'a working connection is the default');
  assert.equal(iface.payload.name, 'Substation A', 'the name is trimmed');
  assert.equal(
    iface.payload.capacity_value,
    undefined,
    'capacity is omitted rather than defaulted: a state that disagreed with the source is the same ERROR',
  );

  // The geometry addresses the interface minted in the same set, so the pair can be
  // applied in one transaction where no id exists to read back in between.
  assert.equal(geometry.kind, 'set_geometry');
  assert.equal(geometry.entity_ref.entity_id, result.interfaceId);
  assert.equal(geometry.payload.role, 'CONNECTION_POINT');
  assert.deepEqual(geometry.payload.geojson_4326, { type: 'Point', coordinates: [-77.5, 39.1] });
});

test('an unnamed interface is named from its source rather than left blank', () => {
  const staged = [];
  stageUtilityInterface({ stage: (change) => staged.push(change), source: { utilitySourceId: 's-2', kind: 'COOLING', failureDomainId: 'd', phaseId: 'p' }, coordinates: [0, 0] });
  assert.equal(staged[0].payload.name, 'COOLING interface');
});

test('an interface without a source or a point is refused before anything is staged', () => {
  const stage = () => assert.fail('nothing should be staged');
  assert.throws(() => stageUtilityInterface({ stage, source: null, coordinates: [0, 0] }), /source it connects to/);
  assert.throws(() => stageUtilityInterface({ stage, source: { utilitySourceId: 's' }, coordinates: null }), /one connection point/);
  assert.throws(() => stageUtilityInterface({ stage, source: { utilitySourceId: 's' }, coordinates: [1, Number.NaN] }), /one connection point/);
});

test('a connection point is projected as GeoJSON only when it is a real pair', () => {
  assert.deepEqual(pointFromCoordinates([-77.5, 39.1]), { type: 'Point', coordinates: [-77.5, 39.1] });
  assert.equal(pointFromCoordinates([-77.5]), null);
  assert.equal(pointFromCoordinates([]), null);
  assert.equal(pointFromCoordinates(null), null);
  assert.equal(pointFromCoordinates(['a', 'b']), null);
});

test('each entity kind declares the geometry role and type the store accepts', () => {
  // The server rejects a mismatched pair with "the geometry type does not match the
  // declared role", so the client must not be able to offer one.
  assert.deepEqual(ENTITY_GEOMETRY.CONTAINER, { role: 'FOOTPRINT', type: 'Polygon' });
  assert.deepEqual(ENTITY_GEOMETRY.UTILITY_INTERFACE, { role: 'CONNECTION_POINT', type: 'Point' });
});

test('a placed point reads as placed, and one vertex is not "1 vertices"', () => {
  const point = { role: 'CONNECTION_POINT', geojson_4326: { type: 'Point', coordinates: [0, 0] } };
  const ring = { role: 'FOOTPRINT', geojson_4326: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };

  assert.match(describeChange({ kind: 'set_geometry', payload: point }), /^Place connection point for the revision \(1 vertex\)$/);
  assert.match(describeChange({ kind: 'set_geometry', payload: ring }), /^Draw footprint for the revision \(4 vertices\)$/);
});
