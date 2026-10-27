import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  REQUIRED_GEOMETRY_ROLE,
  ROLE_GEOMETRY,
  entityTypeOf,
  geometryPlacement,
  placementLabel,
  unplacedObjects,
} from '../facility/geometry-placement.js';

/**
 * The role is derived from the entity's kind, never chosen, so that the tool and the
 * validator agree on what "fixed" means. These tests pin the derivation against the server's
 * tables — a divergence here would place geometry the validator still refuses.
 */

test('the role tables mirror the validator', () => {
  // Captured from packages/facility/src/checks/data.js, where these are canonical. Duplicated
  // because the web app has no dependency on the server package, so the copy is asserted
  // rather than trusted.
  const serverRequiredRole = {
    SITE: 'BOUNDARY',
    PARCEL: 'BOUNDARY',
    BUILDING: 'FOOTPRINT',
    FLOOR: 'FLOOR_BOUNDARY',
    HALL: 'FLOOR_BOUNDARY',
    SUPPORT_SPACE: 'ROOM_BOUNDARY',
    EQUIPMENT_YARD: 'BOUNDARY',
    RESERVED_AREA: 'BOUNDARY',
    UTILITY_SOURCE: 'CONNECTION_POINT',
    UTILITY_INTERFACE: 'CONNECTION_POINT',
  };
  const serverRoleTypes = {
    BOUNDARY: ['POLYGON', 'MULTIPOLYGON'],
    FOOTPRINT: ['POLYGON'],
    FLOOR_BOUNDARY: ['POLYGON'],
    ROOM_BOUNDARY: ['POLYGON'],
    CONNECTION_POINT: ['POINT'],
  };

  assert.deepEqual({ ...REQUIRED_GEOMETRY_ROLE }, serverRequiredRole, 'REQUIRED_ROLE matches');

  // Every required role must be drawable, and as a type the server admits for it.
  for (const role of Object.values(REQUIRED_GEOMETRY_ROLE)) {
    const ours = ROLE_GEOMETRY[role];
    assert.ok(ours, `${role} is drawable`);
    assert.ok(serverRoleTypes[role].includes(ours), `${role} draws as a type the server admits`);
  }
  // And we do not offer a role the server has no required role for.
  for (const role of Object.keys(ROLE_GEOMETRY)) {
    assert.ok(Object.values(REQUIRED_GEOMETRY_ROLE).includes(role), `${role} is a required role`);
  }
});

test('the entity type is read from wherever that kind keeps it', () => {
  assert.equal(entityTypeOf({ container: { kind: 'BUILDING' } }), 'BUILDING');
  assert.equal(entityTypeOf({ container: { kind: 'EQUIPMENT_YARD' } }), 'EQUIPMENT_YARD');
  // A utility source carries no kind that names it; the collection does.
  assert.equal(entityTypeOf({ utilitySource: { utilitySourceId: 's-1' } }), 'UTILITY_SOURCE');
  assert.equal(entityTypeOf({ utilityInterface: { interfaceId: 'i-1' } }), 'UTILITY_INTERFACE');
  // Nothing recognisable makes no claim, rather than guessing.
  assert.equal(entityTypeOf({}), null);
  assert.equal(entityTypeOf(), null);
  assert.equal(entityTypeOf({ container: { kind: null } }), null);
});

test('a utility source with no connection point is placeable, as a point', () => {
  // The defect this was built for: `Utility Entrance B` had no CONNECTION_POINT.
  const outcome = geometryPlacement({ entityType: 'UTILITY_SOURCE', roles: [] });
  assert.deepEqual(outcome, {
    status: 'placeable',
    entityType: 'UTILITY_SOURCE',
    role: 'CONNECTION_POINT',
    geometryType: 'POINT',
  });
});

test('a polygon kind is placeable as a polygon', () => {
  for (const [entityType, role] of [
    ['BUILDING', 'FOOTPRINT'],
    ['PARCEL', 'BOUNDARY'],
    ['EQUIPMENT_YARD', 'BOUNDARY'],
    ['SUPPORT_SPACE', 'ROOM_BOUNDARY'],
    ['FLOOR', 'FLOOR_BOUNDARY'],
  ]) {
    const outcome = geometryPlacement({ entityType, roles: [] });
    assert.equal(outcome.status, 'placeable', entityType);
    assert.equal(outcome.role, role, entityType);
    assert.equal(outcome.geometryType, 'POLYGON', entityType);
  }
});

test('an entity that already has its role offers nothing', () => {
  // Otherwise the tool would invite placing a second CONNECTION_POINT, which the validator
  // would not have asked for.
  const outcome = geometryPlacement({ entityType: 'UTILITY_SOURCE', roles: ['CONNECTION_POINT'] });
  assert.equal(outcome.status, 'already-present');
  assert.equal(outcome.role, 'CONNECTION_POINT');
  assert.equal(outcome.geometryType, undefined, 'nothing to place');
});

test('an unrelated role does not satisfy the requirement', () => {
  // A utility interface may hold a ROUTE as well as its point; holding the route is not
  // holding the point.
  const outcome = geometryPlacement({ entityType: 'UTILITY_INTERFACE', roles: ['ROUTE'] });
  assert.equal(outcome.status, 'placeable');
  assert.equal(outcome.role, 'CONNECTION_POINT');
});

test('a role set is accepted as a Set or an array', () => {
  assert.equal(geometryPlacement({ entityType: 'BUILDING', roles: new Set(['FOOTPRINT']) }).status, 'already-present');
  assert.equal(geometryPlacement({ entityType: 'BUILDING', roles: ['FOOTPRINT'] }).status, 'already-present');
  assert.equal(geometryPlacement({ entityType: 'BUILDING' }).status, 'placeable', 'no roles at all is missing');
});

test('kinds that are not required to have geometry are not treated as defects', () => {
  // These are real entity types the canvas can select; a missing geometry on one is not a
  // finding, so the tool must stay out of the way rather than offer a role.
  for (const entityType of ['SPATIAL_CONSTRAINT', 'METER', 'GATEWAY', 'UNKNOWN']) {
    const outcome = geometryPlacement({ entityType, roles: [] });
    assert.equal(outcome.status, 'not-required', entityType);
    assert.equal(outcome.geometryType, undefined, entityType);
  }
});

test('an unresolvable kind makes no claim', () => {
  assert.equal(geometryPlacement({ entityType: null, roles: [] }).status, 'unknown-kind');
  assert.equal(geometryPlacement().status, 'unknown-kind');
});

test('the control is labelled with the geometry it will place', () => {
  assert.match(placementLabel({ role: 'CONNECTION_POINT', geometryType: 'POINT' }), /connection point point/);
  assert.match(placementLabel({ role: 'FOOTPRINT', geometryType: 'POLYGON' }), /outline/);
  assert.equal(placementLabel({}), 'Place geometry');
});

test('the bucket names exactly the objects the validator is asking about', () => {
  const container = (containerId, name, kind) => ({ containerId, name, kind });
  const source = (utilitySourceId, displayName) => ({ utilitySourceId, displayName });
  const record = (entityId, role) => ({ entityId, role });

  const unplaced = unplacedObjects({
    containers: [
      container('c-site', 'Campus', 'SITE'),
      container('c-building', 'Data Centre A', 'BUILDING'),
      container('c-yard', 'Chiller Yard', 'EQUIPMENT_YARD'),
      container('c-placed', 'Data Hall A1', 'HALL'),
      container('c-unknown', 'Mystery', 'SOMETHING_ELSE'),
    ],
    utilitySources: [source('s-entrance', 'Utility Entrance B'), source('s-placed', 'Utility Entrance A')],
    geometryRecords: [record('c-placed', 'FLOOR_BOUNDARY'), record('s-placed', 'CONNECTION_POINT')],
  });

  assert.deepEqual(
    unplaced.map((item) => [item.entityId, item.entityType, item.role, item.geometryType]),
    [
      // Sorted by kind then name, so the list does not reorder itself under the pointer.
      ['c-building', 'BUILDING', 'FOOTPRINT', 'POLYGON'],
      ['c-yard', 'EQUIPMENT_YARD', 'BOUNDARY', 'POLYGON'],
      ['c-site', 'SITE', 'BOUNDARY', 'POLYGON'],
      ['s-entrance', 'UTILITY_SOURCE', 'CONNECTION_POINT', 'POINT'],
    ],
  );

  // What is already placed is not in the bucket, and neither is a kind that owes no geometry:
  // offering to place one would invent a requirement the validator does not have.
  const ids = unplaced.map((item) => item.entityId);
  assert.ok(!ids.includes('c-placed'), 'a placed entity is not unplaced');
  assert.ok(!ids.includes('s-placed'), 'a placed source is not unplaced');
  assert.ok(!ids.includes('c-unknown'), 'a kind with no required role is not a defect');
});

test('the bucket is empty when nothing is missing', () => {
  assert.deepEqual(unplacedObjects(), []);
  assert.deepEqual(
    unplacedObjects({ containers: [{ containerId: 'c', name: 'X', kind: 'BUILDING' }], geometryRecords: [{ entityId: 'c', role: 'FOOTPRINT' }] }),
    [],
  );
});

test('an entity with no id is skipped rather than listed as nameless', () => {
  assert.deepEqual(unplacedObjects({ containers: [{ name: 'no id', kind: 'BUILDING' }] }), []);
});
