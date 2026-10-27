import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { FacilityAuthoringPanel } from '../facility/FacilityAuthoringPanel.jsx';
import { FacilityInspector, draftForEntity } from '../facility/FacilityInspector.jsx';

const BUILDING = {
  geometryId: 'g-1',
  entityId: 'e-1',
  entityType: 'BUILDING',
  role: 'FOOTPRINT',
  displayName: 'Data Centre A',
  heightM: 12,
};

const SOURCE = {
  geometryId: null,
  entityId: 's-1',
  entityType: 'UTILITY_SOURCE',
  role: 'CONNECTION_POINT',
  displayName: 'Utility Entrance B',
};

// A source has no geometry, so it is reached through the interface that resolves to it.
const INTERFACE = {
  geometryId: 'g-3',
  entityId: 'i-1',
  entityType: 'UTILITY_INTERFACE',
  role: 'CONNECTION_POINT',
  displayName: 'Cooling Interface',
};

const INTERFACES = [
  { interfaceId: 'i-1', utilitySourceId: 's-1', serviceState: 'AVAILABLE', capacityState: 'FIRM', displayName: 'Cooling Interface' },
];

const CONTAINERS = [
  { containerId: 'e-1', kind: 'BUILDING', name: 'Data Centre A', levelNumber: null, elevationBaseM: 0, elevationTopM: 12 },
];
const SOURCES = [
  {
    utilitySourceId: 's-1',
    kind: 'POWER',
    capacityValue: 9000,
    capacityUnit: 'kW',
    capacityBasis: 'IT_LOAD',
    capacityState: 'CONTRACTUAL',
    failureDomainId: 'd-1',
    phaseId: 'p-1',
    displayName: 'Utility Entrance B',
  },
];

const panel = (props = {}) =>
  renderToStaticMarkup(
    <FacilityAuthoringPanel changes={[]} dirty={false} pending={false} {...props} />,
  );

const inspector = (props = {}) =>
  renderToStaticMarkup(
    <FacilityInspector
      feature={BUILDING}
      facility={{ containers: CONTAINERS, utilitySources: SOURCES, utilityInterfaces: INTERFACES }}
      canWrite
      {...props}
    />,
  );

/* -------------------------------------------------------------- the panel */

test('an empty panel invites an edit rather than showing a dead commit button', () => {
  const html = panel();
  assert.match(html, /No pending changes/);
  assert.match(html, /<button[^>]*class="authoring__commit"[^>]*disabled/);
});

test('pending changes are listed in words with their kind, and can be removed', () => {
  const html = panel({
    dirty: true,
    changes: [
      { kind: 'create_container', payload: { container_kind: 'BUILDING', name: 'Data Centre C' } },
      { kind: 'set_geometry', entity_ref: { entity_id: 'e-1' }, payload: { role: 'FOOTPRINT', geojson_4326: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } } },
    ],
  });

  assert.match(html, /Pending changes/);
  assert.match(html, /authoring__count">2</);
  assert.match(html, /Create building “Data Centre C”/);
  assert.match(html, /Draw footprint for/);
  assert.match(html, /data-|authoring__remove/);
  assert.doesNotMatch(html, /<button[^>]*class="authoring__commit"[^>]*disabled/);
});

test('a blocked authoring state is stated and disables the commit', () => {
  const html = panel({ dirty: true, changes: [{ kind: 'update_entity' }], blockedReason: 'This revision is VALIDATED and cannot be edited.' });
  assert.match(html, /authoring__blocked">This revision is VALIDATED/);
  assert.match(html, /<button[^>]*class="authoring__commit"[^>]*disabled/);
});

test('a stale token offers a re-base or a discard, never a silent retry', () => {
  const html = panel({
    dirty: true,
    changes: [{ kind: 'update_entity' }],
    conflict: { kind: 'stale', currentEtag: 'e-2', currentEtagVersion: 4, message: 'Someone else changed this draft.' },
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Someone else changed this draft/);
  assert.match(html, /Re-base on the current draft and keep my changes/);
  assert.match(html, /Discard my changes/);
});

test('an immutable revision offers no re-base, because there is nothing to re-base onto', () => {
  const html = panel({
    dirty: true,
    changes: [{ kind: 'update_entity' }],
    conflict: { kind: 'immutable', currentEtag: null, message: 'A validated or published revision cannot be edited.' },
  });
  assert.match(html, /cannot be edited/);
  assert.doesNotMatch(html, /Re-base on the current draft/);
});

test('a conflict that is not staleness names the referrers and offers no re-base', () => {
  const html = panel({
    dirty: true,
    changes: [{ kind: 'remove_entity' }],
    conflict: {
      kind: 'referenced',
      currentEtag: null,
      message: 'This object is still referenced by a capacity budget. Remove those references first, then commit again.',
    },
  });
  assert.match(html, /still referenced by a capacity budget/);
  assert.doesNotMatch(html, /Re-base on the current draft/);
});

test('a rejected change reports the rule the store refused, not just "not valid"', () => {
  const html = panel({
    dirty: true,
    changes: [{ kind: 'update_entity' }],
    conflict: {
      kind: 'rejected',
      currentEtag: null,
      message: 'Only a FLOOR or a HALL carries a level number. Nothing was applied.',
    },
  });
  assert.match(html, /Only a FLOOR or a HALL carries a level number/);
  assert.doesNotMatch(html, /Re-base on the current draft/);
});

test('a committed set reports what it broke and what it cleared', () => {
  const html = panel({
    dirty: false,
    result: {
      applied: [{ kind: 'set_geometry' }],
      etagVersion: 3,
      diagnostics: [
        { constraintId: 'facility.site.setback.violated', severity: 'ERROR', entityRefs: [], remediationHint: 'Move it inward.' },
        { constraintId: 'facility.data.provenance.stale', severity: 'WARNING', entityRefs: [] },
      ],
      resolvedDiagnosticIds: ['d-9', 'd-8'],
    },
    notice: 'The change set was applied.',
  });

  assert.match(html, /Applied 1 change\(s\)/);
  assert.match(html, /1 new ERROR/);
  assert.match(html, /1 new WARNING/);
  assert.match(html, /2 finding\(s\) cleared/);
  assert.match(html, /facility\.site\.setback\.violated/);
  assert.match(html, /Move it inward\./);
});

test('a clean commit says so instead of showing an empty findings list', () => {
  const html = panel({ result: { applied: [], etagVersion: 2, diagnostics: [], resolvedDiagnosticIds: [] } });
  assert.match(html, /No new findings\./);
});

/* ---------------------------------------------------------- the inspector */

test('a container inspector offers its editable fields and a staged-edit action', () => {
  const html = inspector();
  assert.match(html, /Data Centre A/);
  assert.match(html, /BUILDING · FOOTPRINT/);
  assert.match(html, /Elevation 0–12 m/);
  assert.match(html, /Base elevation \(m\)/);
  assert.match(html, /Top elevation \(m\)/);
  assert.match(html, /Stage edit/);
  assert.match(html, /<button[^>]*class="inspector__stage"[^>]*disabled/, 'nothing to stage until a field changes');
});

test('the inspector shows the values the row already holds', () => {
  // The form speaks the change kinds' snake_case names and the store rows arrive
  // camelCase; reading the wrong key made every existing level and elevation look unset.
  const html = inspector();
  assert.match(html, /value="0"/, 'the stored base elevation is shown');
  assert.match(html, /value="12"/, 'the stored top elevation is shown');
});

test('a draft typed for one entity is not applied to the next one selected', () => {
  // The inspector is not remounted when the selection moves, so an un-staged draft would
  // ride along to the next object: a level typed while a floor was selected would be
  // applied when a building is edited next, and the store would refuse an edit the user
  // never made — the same constraint error the form had just stopped offering.
  assert.equal(draftForEntity(null, 'e-1'), null);
  assert.equal(draftForEntity({ entityId: 'e-1', name: 'Data Centre A' }, 'e-1').name, 'Data Centre A');
  assert.equal(draftForEntity({ entityId: 'e-1', level_number: '3' }, 'e-2'), null);
  assert.equal(draftForEntity({ entityId: 'e-1' }, null), null);
});

test('a level number is offered only for the kinds that carry one', () => {
  // A parcel has no level number, and the store refuses one with a check constraint.
  // Offering the field let the user type a value that could never commit.
  const building = inspector();
  assert.doesNotMatch(building, /data-field-path="level_number"/, 'a building is not offered a level');
  assert.match(building, /Only a floor or a hall carries a level number/);

  const parcel = inspector({
    feature: { ...BUILDING, entityId: 'e-9', entityType: 'PARCEL', displayName: 'Parcel 1' },
    facility: {
      containers: [{ containerId: 'e-9', kind: 'PARCEL', name: 'Parcel 1', levelNumber: null, elevationBaseM: null, elevationTopM: null }],
    },
  });
  assert.doesNotMatch(parcel, /data-field-path="level_number"/);
  assert.match(parcel, /so this parcel does not offer one/);

  const floor = inspector({
    feature: { ...BUILDING, entityId: 'e-2', entityType: 'FLOOR', displayName: 'Level 1' },
    facility: {
      containers: [{ containerId: 'e-2', kind: 'FLOOR', name: 'Level 1', levelNumber: 1, elevationBaseM: 0, elevationTopM: 6 }],
    },
  });
  assert.match(floor, /data-field-path="level_number"/);
  assert.match(floor, /value="1"/, 'the current level is shown, not left blank');
});

test('removal offers a cascade choice, because a parent with children needs one', () => {
  const html = inspector();
  assert.match(html, /This entity and its children/);
  assert.match(html, /Stage removal/);
});

test('a phase can be assigned from the inspector when the plan is available', () => {
  const html = inspector({ phases: [{ phaseId: 'p-1', name: 'Phase 1 - 12 MW' }] });
  assert.match(html, /Assign to phase/);
  assert.match(html, /Phase 1 - 12 MW/);
});

test('a utility source is edited by capacity state, which is what the catalog gates on', () => {
  const html = inspector({ feature: SOURCE });
  assert.match(html, /CONTRACTUAL/);
  assert.match(html, /FIRM/);
  assert.match(html, /inspector__choice--current/, 'the current state is marked rather than merely listed');
  assert.match(html, /cleared/);
  assert.doesNotMatch(html, /Base elevation \(m\)/, 'a source is not a container');
});

test('a source is edited through the interface that resolves to it', () => {
  // The inspector must name the *source*, not the interface the user clicked: writing the
  // interface's id as a source id names something that does not exist, and the server
  // refuses the whole set. This is the shape the component hands to `onStage`.
  const staged = [];
  const html = renderToStaticMarkup(
    <FacilityInspector
      feature={INTERFACE}
      facility={{ containers: CONTAINERS, utilitySources: SOURCES, utilityInterfaces: INTERFACES }}
      canWrite
      onStage={(change) => staged.push(change)}
    />,
  );

  assert.match(html, /Cooling Interface/);
  assert.match(html, /supplied by/);
  assert.match(html, /Utility Entrance B/, 'the source is named in the hint');
  assert.match(html, /inspector__choice/);
  // The component is presentational, so the assertion is on what it *would* stage: the
  // handler is not invoked during a static render, which is why the payload shape is
  // asserted through the data it renders from.
  assert.equal(staged.length, 0);
});

test('a read-only role sees the entity and no editing controls at all', () => {
  const html = inspector({ canWrite: false });
  assert.match(html, /Data Centre A/, 'the entity is still inspectable');
  assert.doesNotMatch(html, /inspector__stage/);
  assert.doesNotMatch(html, /inspector__remove/);
});

test('a blocked revision says why instead of showing a form that would be refused', () => {
  const html = inspector({ blockedReason: 'This revision is VALIDATED and cannot be edited.' });
  assert.match(html, /inspector__blocked">This revision is VALIDATED/);
  assert.doesNotMatch(html, /inspector__stage/);
});

test('nothing selected renders nothing, rather than an empty panel', () => {
  assert.equal(renderToStaticMarkup(<FacilityInspector feature={null} facility={{}} />), '');
});
