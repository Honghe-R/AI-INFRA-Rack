import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RackPlanDetail, SourceStatus } from '../rack/RackSurface.jsx';
import { RackPlanActions } from '../rack/RackPlanActions.jsx';
import { planIntent, rackError, roomSource, samePlanScope, uncertainCreation } from '../rack/rack-plan-state.js';

const context = { projectId: 'p', scenarioId: 's', revisionId: 'r' };
const envelope = { ...context, lifecycleState: 'DRAFT', etag: 'token', designContext: { containers: [
  { kind: 'BUILDING', containerId: 'b', name: 'Building' }, { kind: 'HALL', containerId: 'h', name: 'Hall' },
] } };

test('plan management separates recovery and blocks writes with a draft or without permission', () => {
  const plan={planId:'plan',name:'Example',placements:[]};
  assert.equal(renderToStaticMarkup(<RackPlanActions plan={plan} canWrite={false}/>),'');
  const active=renderToStaticMarkup(<RackPlanActions plan={plan} canWrite blocked/>);
  assert.match(active,/disabled=""[^>]*>Delete plan/);
  assert.match(active,/Save or discard/);
  const trash=renderToStaticMarkup(<RackPlanActions plan={{...plan,deletedAt:'today'}} canWrite/>);
  assert.match(trash,/Restore plan/); assert.doesNotMatch(trash,/Delete plan|Rename plan/);
  const retry=renderToStaticMarkup(<RackPlanActions plan={plan} canWrite attempt={{operation:'rename',body:{name:'Exact retained name'}}}/>);
  const input=retry.match(/<input[^>]*>/)?.[0]??'';
  assert.match(input,/value="Exact retained name"/); assert.match(input,/disabled=""/);
  assert.match(retry,/Retry original operation/);
});

test('Rack creation binds only an actual HALL in the exact current source', () => {
  assert.deepEqual(roomSource(envelope, context).rooms.map(room => room.containerId), ['h']);
  const intent = planIntent({ name: '  My plan  ', hallId: 'h' }, context, envelope, 'key');
  assert.deepEqual(intent, { key: 'key', body: { contract_version: 1, name: 'My plan', scenario_id: 's',
    facility_input: { revision_id: 'r', container_id: 'h', revision_etag: 'token' } } });
  for (const source of [null, { ...envelope, projectId: 'other' }, { ...envelope, scenarioId: 'other' },
    { ...envelope, revisionId: 'other' }, { ...envelope, lifecycleState: 'FROZEN' }, { ...envelope, etag: null },
    { ...envelope, designContext: { containers: [] } }]) {
    assert.equal(roomSource(source, context).ready, false);
    assert.throws(() => planIntent({ name: 'Plan', hallId: 'h' }, context, source, 'key'));
  }
  assert.throws(() => planIntent({ name: 'Plan', hallId: 'b' }, context, envelope, 'key'));
  assert.throws(() => planIntent({ name: ' ', hallId: 'h' }, context, envelope, 'key'));
  assert.throws(() => planIntent({ name: 'x'.repeat(161), hallId: 'h' }, context, envelope, 'key'));
});

test('saved-plan scope checks reject another scenario or Facility revision', () => {
  const plan = { ...context, facilityInput: { revisionId: 'r' } };
  assert.equal(samePlanScope(plan, context), true);
  for (const override of [{ projectId: 'q' }, { scenarioId: 'q' }, { facilityInput: { revisionId: 'q' } }]) {
    assert.equal(samePlanScope({ ...plan, ...override }, context), false);
  }
});

test('uncertain creation responses retain the intent; known rejection allows corrections', () => {
  assert.equal(uncertainCreation(new TypeError('Failed to fetch')), true);
  for (const status of [408, 500, 502, 503]) assert.equal(uncertainCreation({ status }), true);
  for (const status of [400, 401, 403, 404, 409, 428]) assert.equal(uncertainCreation({ status }), false);
  assert.match(rackError({ code: 'RACK_SOURCE_STALE', correlationId: 'corr' }), /Refresh the Facility source.*corr/);
});

test('plan details distinguish source freshness, saved version, and unrun Rack validation', () => {
  const html = renderToStaticMarkup(<RackPlanDetail roomName="Hall A" plan={{
    name: 'Empty <plan>', planId: 'id', version: 1, state: 'DRAFT', validationState: 'NOT_RUN', placements: [],
    createdAt: '2026-10-28T00:00:00Z', createdBy: 'actor',
    facilityInput: { revisionId: 'r', containerId: 'h', revisionEtag: 'saved-token' },
    facilityInputStatus: { status: 'STALE', currentRevisionEtag: 'current-token', lifecycleState: 'DRAFT', reasons: ['ETAG_CHANGED'] },
  }} />);
  for (const text of ['Empty &lt;plan&gt;', 'NOT_RUN', 'Validation has not been run', 'Source changed', 'ETAG_CHANGED', 'saved-token', 'current-token', '0 saved']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Validated'));
  assert.match(renderToStaticMarkup(<SourceStatus status="UNAVAILABLE" />), /Source unavailable/);
  assert.match(renderToStaticMarkup(<SourceStatus />), /Source unknown/);
});
