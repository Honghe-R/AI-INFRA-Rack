import test from 'node:test';
import assert from 'node:assert/strict';
import { SelectorError, matchesSelector, normalizeSelector, parseSelector } from '../selector.js';

const feature = {
  layer: 'ELEC-13.8KV',
  block: 'SUBSTATION-A',
  entity: 'LWPOLYLINE',
  geometryType: 'POLYGON',
  group: 'Site/Parcels/North',
  file: 'site.dxf',
  attributes: { VOLTAGE: '13.8kV', use: 'utility', city: 'Miami', levels: 3 },
};

test('a literal clause matches a feature field', () => {
  assert.equal(matchesSelector('layer:ELEC-13.8KV', feature), true);
  assert.equal(matchesSelector('layer:ELEC-480V', feature), false);
});

test('globs match with *, ?, and a character class', () => {
  assert.equal(matchesSelector('layer:ELEC-*', feature), true);
  assert.equal(matchesSelector('group:Site/Parcels/*', feature), true);
  // "13.8KV" is exactly six characters after the prefix.
  assert.equal(matchesSelector('layer:ELEC-??????', feature), true);
  assert.equal(matchesSelector('layer:ELEC-???', feature), false);
  assert.equal(matchesSelector('block:SUBSTATION-[AB]', feature), true);
});

test('a predicate compares an attribute with an operator', () => {
  assert.equal(matchesSelector('attr:use=utility', feature), true);
  assert.equal(matchesSelector('attr:use=office', feature), false);
  assert.equal(matchesSelector('attrib:VOLTAGE=13.8kV', feature), true);
  assert.equal(matchesSelector('attr:levels>=3', feature), true);
  assert.equal(matchesSelector('attr:levels>3', feature), false);
  assert.equal(matchesSelector('attr:use!=office', feature), true);
});

test('the ~ operator matches a glob', () => {
  assert.equal(matchesSelector('attr:city~Mia*', feature), true);
  assert.equal(matchesSelector('attr:city~Zurich', feature), false);
});

test('attribute field lookup is case-insensitive', () => {
  assert.equal(matchesSelector('attr:voltage=13.8kV', feature), true);
});

test('the entity clause reads the geometry type', () => {
  assert.equal(matchesSelector('entity:LWPOLYLINE', feature), true);
  assert.equal(matchesSelector('feature:POLYGON', feature), true);
});

test('AND binds tighter than OR', () => {
  // layer:ELEC-* OR (layer:NOPE AND entity:LINE) -> true because the left side matches.
  assert.equal(matchesSelector('layer:ELEC-* OR layer:NOPE AND entity:LINE', feature), true);
  // (layer:ELEC-* OR layer:NOPE) AND entity:LINE -> false because the right side does not.
  assert.equal(matchesSelector('(layer:ELEC-* OR layer:NOPE) AND entity:LINE', feature), false);
});

test('NOT inverts a term, and parentheses group', () => {
  assert.equal(matchesSelector('NOT layer:ELEC-480V', feature), true);
  // The feature's entity is LWPOLYLINE, so this conjunction holds and NOT makes it false.
  assert.equal(matchesSelector('NOT (layer:ELEC-* AND entity:LWPOLYLINE)', feature), false);
});

test('a quoted value may contain spaces and reserved characters', () => {
  const withSpace = { ...feature, attributes: { ...feature.attributes, name: 'Main St, North' } };
  assert.equal(matchesSelector("attr:name='Main St, North'", withSpace), true);
  assert.equal(matchesSelector("attr:name='Main St'", withSpace), false);
});

test('the i suffix makes a quoted comparison case-insensitive without truncating values', () => {
  assert.equal(matchesSelector("attr:use='UTILITY'i", feature), true);
  assert.equal(matchesSelector("attr:city='miami'i", feature), true);
  // A value that genuinely ends in "i" is not treated as a flag.
  assert.equal(matchesSelector('attr:city=Miami', feature), true);
  assert.equal(matchesSelector("attr:city='Miami'", feature), true);
});

test('an invalid selector is refused with a position-free, typed error', () => {
  assert.throws(() => parseSelector(''), SelectorError);
  assert.throws(() => parseSelector('nosuchkey:value'), SelectorError);
  assert.throws(() => parseSelector('(layer:A'), SelectorError);
  assert.throws(() => parseSelector('layer:A OR'), SelectorError);
});

test('the normalised form round-trips to the same matches', () => {
  const normalized = normalizeSelector('layer:ELEC-* and attr:use=utility');
  assert.equal(normalized, 'layer:ELEC-* AND attr:use=utility');
  assert.equal(matchesSelector(normalized, feature), true);
});
