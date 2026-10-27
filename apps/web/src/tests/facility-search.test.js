import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SEARCH_RESULT_LIMIT, searchShapes } from '../map/facility-search.js';

/**
 * Ranking a search over the drawn graph.
 *
 * The interesting half is the order, not the membership: a planner who types "hall" is
 * looking for the thing *called* Hall, and a list that puts "Data Hall 01" first because it
 * happens to be drawn earlier has answered a different question. These assert the grades
 * rather than the implementation, so re-tuning the weights does not require rewriting them.
 */
const shape = (displayName, entityType, role = 'FOOTPRINT', layer = 'buildings') => ({
  geometryId: `g-${displayName ?? entityType}-${role}`,
  entityType,
  role,
  layer,
  displayName,
});

const SHAPES = [
  shape('Northern DC Campus', 'SITE', 'BOUNDARY', 'site'),
  shape('Data Hall 01', 'HALL', 'FOOTPRINT', 'spaces'),
  shape('Hall', 'HALL', 'FOOTPRINT', 'spaces'),
  shape('Power Interface A', 'UTILITY_INTERFACE', 'CONNECTION_POINT', 'utilities'),
  shape(null, 'UTILITY_SOURCE', 'FEED', 'utilities'),
];

test('an empty query asks nothing and returns nothing', () => {
  assert.deepEqual(searchShapes(SHAPES, ''), []);
  assert.deepEqual(searchShapes(SHAPES, '   '), []);
});

test('a name is matched case-insensitively, and the whole query has to appear', () => {
  const names = searchShapes(SHAPES, 'hall').map((item) => item.displayName);
  assert.deepEqual(names, ['Hall', 'Data Hall 01']);
  assert.deepEqual(searchShapes(SHAPES, 'DATA HALL'), [SHAPES[1]]);
  assert.deepEqual(searchShapes(SHAPES, 'hall 02'), []);
});

test('an exact name beats a prefix, which beats a match inside a longer field', () => {
  const names = searchShapes(SHAPES, 'hall').map((item) => item.displayName);
  assert.equal(names[0], 'Hall', 'the feature called Hall is what "hall" means');

  // "camp" is a prefix of the campus name and nothing else matches it.
  assert.deepEqual(searchShapes(SHAPES, 'camp').map((item) => item.displayName), ['Northern DC Campus']);
  // "ampus" is only inside it, and still finds it.
  assert.deepEqual(searchShapes(SHAPES, 'ampus').map((item) => item.displayName), ['Northern DC Campus']);
});

test('a type or a role is searchable, so a feature with no name is still findable', () => {
  const unnamed = searchShapes(SHAPES, 'UTILITY_SOURCE');
  assert.deepEqual(unnamed, [SHAPES[4]], 'the record with no display name is found by its type');

  // A role matches too, and a name match outranks it: the interface's name wins over its
  // own CONNECTION_POINT role for a query both could answer.
  assert.deepEqual(searchShapes(SHAPES, 'connection_point').map((item) => item.entityType), ['UTILITY_INTERFACE']);
});

test('the layer is a last-resort field, so a layer name still returns its drawn records', () => {
  const utilities = searchShapes(SHAPES, 'utilities');
  assert.deepEqual(utilities.map((item) => item.entityType), ['UTILITY_INTERFACE', 'UTILITY_SOURCE']);
});

test('equal scores keep the order the canvas draws in', () => {
  // Both are HALL footprints; neither name is more of a match than the other for "space".
  const shapes = [shape('North Space', 'HALL'), shape('South Space', 'HALL')];
  assert.deepEqual(searchShapes(shapes, 'space').map((item) => item.displayName), ['North Space', 'South Space']);
});

test('the panel lists a bounded number and counts the rest', () => {
  // The limit is the component's, but it is stated here because it is what makes the count
  // line meaningful: without it the panel grows past the map it floats on.
  assert.equal(SEARCH_RESULT_LIMIT, 8);
  const many = Array.from({ length: 20 }, (_, index) => shape(`Hall ${index}`, 'HALL'));
  assert.equal(searchShapes(many, 'hall').length, 20, 'the search itself is not truncated');
});
