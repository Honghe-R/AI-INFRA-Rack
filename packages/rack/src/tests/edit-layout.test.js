import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeEditableLayout, assertLockedRacksUnchanged } from '../index.js';
const fixture = JSON.parse(
  await readFile(new URL('../../examples/basic-rack.json', import.meta.url), 'utf8'),
);
const { projectId, planId, ...input } = fixture.placement;
const models = [fixture.model];
const normalize = (placements) => normalizeEditableLayout({ placements, models, projectId, planId });

test('editable layout derives dimensions from the server catalog, normalizes identities and leaves input unchanged', () => {
  const before = structuredClone(input);
  const result = normalize([input]);
  assert.equal(result[0].placement.projectId, projectId);
  assert.equal(result[0].placement.planId, planId);
  assert.equal(result[0].footprint.cornersM.length, 4);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result[0].placement));
});
test('editable layout rejects duplicate identities, scope injection, unknown models and unbounded collections', () => {
  for (const value of [
    null,
    Array(257).fill(input),
    [input, { ...input, rackId: input.rackId.toUpperCase() }],
    [{ ...input, projectId }],
    [{ ...input, widthM: 2 }],
    [{ ...input, modelId: '99999999-0000-4000-8000-000000000001' }],
    [{ ...input, xM: 10001 }],
    [{ ...input, yM: NaN }],
    [{ ...input, rotationDeg: 45 }],
  ])
    assert.throws(() => normalize(value), { code: 'RACK_INPUT_INVALID' });
});
test('saved locks allow name edits and an explicit unlock but forbid moving, rotating, replacement and deletion', () => {
  const previous = [{ ...input, locked: true }];
  assert.doesNotThrow(() => assertLockedRacksUnchanged(previous, [{ ...input, locked: false }]));
  assert.doesNotThrow(() =>
    assertLockedRacksUnchanged(previous, [{ ...input, locked: true, name: 'Renamed' }]),
  );
  for (const next of [
    [],
    [{ ...input, locked: false, xM: input.xM + 1 }],
    [{ ...input, rotationDeg: 90 }],
    [{ ...input, modelId: '99999999-0000-4000-8000-000000000001' }],
  ])
    assert.throws(() => assertLockedRacksUnchanged(previous, next), { code: 'RACK_INPUT_INVALID' });
});
