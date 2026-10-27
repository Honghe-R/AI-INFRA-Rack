import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONTRACT_VERSION, RackInputError, createFacilityInputReference, createRackPlan, assessFacilityInput,
} from '../index.js';

const fixture = JSON.parse(await readFile(new URL('../../examples/empty-plan.json', import.meta.url), 'utf8'));
const input = () => structuredClone(fixture);
const reference = () => input().facilityInput;
const anotherId = 'abcdefab-0000-4000-8000-000000000099';

function invalidField(fn, field) {
  assert.throws(fn, error => error instanceof RackInputError
    && error.code === 'RACK_INPUT_INVALID' && error.details[0].field === field);
}

test('an empty plan starts at its own version 1 and has never been validated', () => {
  const result = createRackPlan(input());
  assert.equal(result.contractVersion, CONTRACT_VERSION);
  assert.equal(result.version, 1);
  assert.equal(result.state, 'DRAFT');
  assert.equal(result.validationState, 'NOT_RUN');
  assert.deepEqual(result.placements, []);
  assert.equal(result.facilityInput.revisionEtag, fixture.facilityInput.revisionEtag);
});

test('plan creation does not mutate input or keep caller-owned nested references', () => {
  const raw = input();
  const before = structuredClone(raw);
  const result = createRackPlan(raw);
  assert.deepEqual(raw, before);
  raw.facilityInput.revisionEtag = 'changed-after-construction';
  assert.equal(result.facilityInput.revisionEtag, before.facilityInput.revisionEtag);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.facilityInput));
  assert.ok(Object.isFrozen(result.placements));
  assert.throws(() => result.placements.push({}), TypeError);
  assert.throws(() => { result.facilityInput.containerId = anotherId; }, TypeError);
});

test('caller cannot assert saved versions, validation, existing racks or lifecycle state', () => {
  for (const [field, value] of [['version', 8], ['validationState', 'PASSED'], ['state', 'PUBLISHED'], ['placements', [{}]], ['contractVersion', 99]]) {
    invalidField(() => createRackPlan({ ...input(), [field]: value }), `plan.${field}`);
  }
});

test('every plan and facility identity is required and must be a UUID', () => {
  for (const field of ['planId', 'projectId', 'scenarioId']) {
    for (const value of [undefined, null, '', 1, 'project-1']) {
      invalidField(() => createRackPlan({ ...input(), [field]: value }), field);
    }
  }
  for (const field of ['projectId', 'scenarioId', 'revisionId', 'containerId']) {
    invalidField(() => createFacilityInputReference({ ...reference(), [field]: null }), `facilityInput.${field}`);
  }
});

test('UUID casing is normalized before plan ownership comparisons', () => {
  const raw = input();
  raw.projectId = anotherId.toUpperCase();
  raw.facilityInput.projectId = anotherId;
  raw.scenarioId = anotherId;
  raw.facilityInput.scenarioId = anotherId.toUpperCase();
  const result = createRackPlan(raw);
  assert.equal(result.projectId, anotherId);
  assert.equal(result.facilityInput.scenarioId, anotherId);
});

test('a plan refuses a source declared in a different project or scenario', () => {
  for (const field of ['projectId', 'scenarioId']) {
    const raw = input();
    raw.facilityInput[field] = anotherId;
    invalidField(() => createRackPlan(raw), `facilityInput.${field}`);
  }
});

test('names are bounded nonempty text and valid names are trimmed', () => {
  for (const name of [undefined, null, '', '   ', 42, 'x'.repeat(161)]) {
    invalidField(() => createRackPlan({ ...input(), name }), 'name');
  }
  assert.equal(createRackPlan({ ...input(), name: ' Plan A ' }).name, 'Plan A');
});

test('reference and plan reject missing records, arrays and unknown fields', () => {
  for (const value of [undefined, null, [], 'reference']) {
    invalidField(() => createRackPlan(value), 'plan');
    invalidField(() => createRackPlan({ ...input(), facilityInput: value }), 'facilityInput');
    invalidField(() => createFacilityInputReference(value), 'facilityInput');
  }
  invalidField(() => createRackPlan({ ...input(), roomId: anotherId }), 'plan.roomId');
  invalidField(() => createFacilityInputReference({ ...reference(), geometry: {} }), 'facilityInput.geometry');
});

test('source token is mandatory, bounded and never coerced or silently trimmed', () => {
  for (const revisionEtag of [undefined, null, '', 1, '  ', ' token', 'token ', 'a\nb', 'a\u0000b', 'a\u007fb', 'x'.repeat(513)]) {
    invalidField(() => createFacilityInputReference({ ...reference(), revisionEtag }), 'facilityInput.revisionEtag');
  }
  const opaqueToken = 'W/"Opaque-Version-A"';
  assert.equal(createFacilityInputReference({ ...reference(), revisionEtag: opaqueToken }).revisionEtag, opaqueToken);
});

test('unchanged source compares normalized identity while preserving opaque token semantics', () => {
  const original = { ...reference(), containerId: anotherId };
  const current = { ...original, containerId: anotherId.toUpperCase() };
  assert.deepEqual(assessFacilityInput(original, current), { status: 'UNCHANGED', changedFields: [] });
});

test('a changed upstream revision token marks the reference stale', () => {
  for (const revisionEtag of ['synthetic-facility-etag-v2', fixture.facilityInput.revisionEtag.toUpperCase()]) {
    assert.deepEqual(assessFacilityInput(reference(), { ...reference(), revisionEtag }), {
      status: 'STALE', changedFields: ['revisionEtag'],
    });
  }
});

test('matching tokens cannot disguise a changed project, scenario, revision or room', () => {
  for (const field of ['projectId', 'scenarioId', 'revisionId', 'containerId']) {
    assert.deepEqual(assessFacilityInput(reference(), { ...reference(), [field]: anotherId }), {
      status: 'DIFFERENT_SOURCE', changedFields: [field],
    });
  }
});

test('source changes take precedence over token changes and list all changed identity fields', () => {
  const current = { ...reference(), revisionId: anotherId, containerId: anotherId, revisionEtag: 'new' };
  assert.deepEqual(assessFacilityInput(reference(), current), {
    status: 'DIFFERENT_SOURCE', changedFields: ['revisionId', 'containerId'],
  });
});

test('source comparison validates both arguments and returns deeply immutable diagnostics', () => {
  invalidField(() => assessFacilityInput({}, reference()), 'facilityInput.projectId');
  invalidField(() => assessFacilityInput(reference(), {}), 'facilityInput.projectId');
  const result = assessFacilityInput(reference(), { ...reference(), revisionEtag: 'new' });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.changedFields));
  assert.throws(() => result.changedFields.push('projectId'), TypeError);
});

test('plan output is JSON data, with no fabricated timestamp or automatic persistence', () => {
  const plan = createRackPlan(input());
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.equal(Object.hasOwn(plan, 'createdAt'), false);
  assert.equal(Object.hasOwn(plan, 'savedAt'), false);
});
