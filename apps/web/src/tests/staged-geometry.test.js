import { test } from 'vitest';
import assert from 'node:assert/strict';
import { editFor, stagedGeometry } from '../map/staged-geometry.js';
import { overlayFor } from '../map/facility-overlay.js';

/**
 * An edit that is staged but not committed has to be visible.
 *
 * Until this existed, the map showed the revision as it currently is, so a move looked like it
 * had been thrown away the moment the pointer came up: the object snapped back to where it
 * started and the only trace of the edit was a line in a panel. An edit the author cannot see is
 * an edit the author cannot check.
 */
const change = (entityId, role, type, coordinates) => ({
  kind: 'set_geometry',
  entity_ref: { entity_id: entityId },
  payload: { role, geojson_4326: { type, coordinates } },
});

const feature = (overrides = {}) => ({
  geometryId: 'g-1',
  entityId: 'p-1',
  entityType: 'PARCEL',
  role: 'BOUNDARY',
  displayName: 'Parcel 1',
  geojson4326: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0]]] },
  ...overrides,
});

const VIEW = { lon: 0.005, lat: 0.005, zoom: 14 };
const SIZE = { widthPx: 800, heightPx: 600 };

test('a staged geometry change is the edit, addressed by entity and role', () => {
  const edits = stagedGeometry([change('p-1', 'BOUNDARY', 'Polygon', [[[1, 1], [2, 1], [2, 2], [1, 1]]])]);

  assert.equal(edits.size, 1);
  assert.deepEqual(edits.get('p-1|BOUNDARY').coordinates[0][0], [1, 1]);
  // A role is part of the address: an entity can hold several, and only one of them was edited.
  assert.equal(editFor(edits, feature({ role: 'FOOTPRINT' })), null);
  assert.equal(editFor(edits, feature({ entityId: 'p-2' })), null);
  assert.ok(editFor(edits, feature()));
});

test('only the last change for a role is drawn, which is the rule the set itself keeps', () => {
  // `stageChange` drops the change a later one supersedes, so moving an object twice leaves one
  // geometry in the set. Both orders must agree on which one, or the map and the panel disagree.
  const edits = stagedGeometry([
    change('p-1', 'BOUNDARY', 'Polygon', [[[1, 1], [2, 1], [2, 2], [1, 1]]]),
    change('p-1', 'BOUNDARY', 'Polygon', [[[5, 5], [6, 5], [6, 6], [5, 5]]]),
  ]);

  assert.deepEqual(edits.get('p-1|BOUNDARY').coordinates[0][0], [5, 5]);
});

test('a change this surface cannot draw is skipped, not drawn wrongly', () => {
  const edits = stagedGeometry([
    { kind: 'create_container', payload: { container_id: 'c-1' } },
    { kind: 'set_geometry', entity_ref: { entity_id: 'p-1' }, payload: { role: 'BOUNDARY' } },
    change('p-1', '', 'Polygon', [[[1, 1]]]),
    change('p-1', 'BOUNDARY', undefined, undefined),
    // A well-formed one survives the malformed company it keeps.
    change('p-2', 'BOUNDARY', 'Polygon', [[[3, 3], [4, 3], [4, 4], [3, 3]]]),
  ]);

  assert.equal(edits.size, 1);
  assert.ok(edits.has('p-2|BOUNDARY'));
  assert.deepEqual(stagedGeometry([]).size, 0);
  assert.deepEqual(stagedGeometry().size, 0);
});

test('the object is drawn where the change set intends, and marked as pending', () => {
  const plain = overlayFor([feature()], { view: VIEW, ...SIZE })[0];
  const staged = overlayFor([feature()], {
    view: VIEW,
    ...SIZE,
    edits: stagedGeometry([change('p-1', 'BOUNDARY', 'Polygon', [[[1, 1], [1.02, 1], [1.02, 1.02], [1, 1]]])]),
  })[0];

  // The edited geometry is a different part of the world, so its projection must differ — the
  // point of the whole thing is that the object is drawn at the position the commit will give it.
  assert.notDeepEqual(staged.geometry.polygons[0][0][0], plain.geometry.polygons[0][0][0]);
  assert.equal(staged.path === plain.path, false);
  // And it is still the same object in the same layer, so only the state is marked.
  assert.equal(staged.layer, plain.layer);
  assert.equal(staged.edited, true);
  assert.equal(plain.edited, false, 'an untouched object is not marked');
});

test('an unedited object is untouched by the presence of other edits', () => {
  const shapes = overlayFor([feature(), feature({ geometryId: 'g-2', entityId: 'p-2', displayName: 'Parcel 2' })], {
    view: VIEW,
    ...SIZE,
    edits: stagedGeometry([change('p-2', 'BOUNDARY', 'Polygon', [[[1, 1], [2, 1], [2, 2], [1, 1]]])]),
  });

  assert.equal(shapes.find((shape) => shape.entityId === 'p-1').edited, false);
  assert.equal(shapes.find((shape) => shape.entityId === 'p-2').edited, true);
});

test('unstaging the change puts the object back where the revision has it', () => {
  // This is what makes the change set reversible by looking at the map: the preview is derived
  // from the changes, so discarding them restores the revision's own geometry with no other work.
  const staged = overlayFor([feature()], {
    view: VIEW,
    ...SIZE,
    edits: stagedGeometry([change('p-1', 'BOUNDARY', 'Polygon', [[[1, 1], [1.02, 1], [1.02, 1.02], [1, 1]]])]),
  })[0];
  const afterDiscard = overlayFor([feature()], { view: VIEW, ...SIZE, edits: stagedGeometry([]) })[0];

  assert.equal(afterDiscard.edited, false);
  assert.equal(afterDiscard.path !== staged.path, true, 'the geometry is the revision’s again');
  assert.equal(afterDiscard.path, overlayFor([feature()], { view: VIEW, ...SIZE })[0].path);
});
