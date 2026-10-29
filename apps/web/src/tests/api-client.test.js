import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/client.js';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test('Rack methods carry encoded scope, pagination, identity, cancellation and the creation key', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = createApiClient({ identity: () => 'test-editor', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return jsonResponse(200, { data: { items: [] } });
  } });
  await client.listRackPlans('p/one', { scenarioId: 's/one', revisionId: 'r/one', cursor: 'cursor', limit: 2, signal: controller.signal });
  const query = new URL(calls[0].url, 'http://localhost').searchParams;
  assert.ok(calls[0].url.startsWith('/api/v1/projects/p%2Fone/rack/plans?'));
  assert.equal(query.get('scenario_id'), 's/one');
  assert.equal(query.get('revision_id'), 'r/one');
  assert.equal(query.get('limit'), '2');
  assert.equal(query.get('cursor'), 'cursor');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.headers['x-dev-subject'], 'test-editor');
  await client.getRackPlan('p/one', 'plan/one', { signal: controller.signal });
  assert.equal(calls[1].url, '/api/v1/projects/p%2Fone/rack/plans/plan%2Fone');
  const body = { contract_version: 1, name: 'Test' };
  await client.createRackPlan('p/one', body, { idempotencyKey: 'key-1', signal: controller.signal });
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.headers['Idempotency-Key'], 'key-1');
  assert.deepEqual(JSON.parse(calls[2].options.body), body);
  assert.equal(calls[2].options.signal, controller.signal);
  await client.getRackRoomView('p/one', 'plan/one', { signal: controller.signal });
  assert.equal(calls[3].url, '/api/v1/projects/p%2Fone/rack/plans/plan%2Fone/room-view');
  assert.equal(calls[3].options.signal, controller.signal);
  assert.equal(calls[3].options.headers['x-dev-subject'], 'test-editor');
});

test('a success response is unwrapped from the documented envelope', async () => {
  const client = createApiClient({
    fetchImpl: async () => jsonResponse(200, { data: [{ projectId: 'p-1' }], meta: { correlation_id: 'corr-1' } }),
  });
  const result = await client.listProjects('o-1');
  assert.deepEqual(result.data, [{ projectId: 'p-1' }]);
  assert.equal(result.meta.correlation_id, 'corr-1');
});

test('the request carries the organisation scope', async () => {
  let requested = null;
  const client = createApiClient({
    fetchImpl: async (url) => {
      requested = url;
      return jsonResponse(200, { data: [] });
    },
  });
  await client.listProjects('o-1');
  assert.match(requested, /organisation_id=o-1/);
});

test('an error becomes a typed failure with code, status, details, and correlation id', async () => {
  const client = createApiClient({
    fetchImpl: async () =>
      jsonResponse(403, {
        error: { code: 'INSUFFICIENT_PERMISSION', message: 'nope', details: [{ function_key: 'project.read' }] },
        meta: { correlation_id: 'corr-9' },
      }),
  });

  await assert.rejects(
    () => client.listProjects('o-1'),
    (error) => {
      assert.equal(error.code, 'INSUFFICIENT_PERMISSION');
      assert.equal(error.status, 403);
      assert.deepEqual(error.details, [{ function_key: 'project.read' }]);
      assert.equal(error.correlationId, 'corr-9');
      assert.equal(error.message, 'nope');
      return true;
    },
  );
});

test('a non-JSON failure still produces a usable error', async () => {
  const client = createApiClient({
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() {
        throw new Error('not json');
      },
    }),
  });

  await assert.rejects(
    () => client.listProjects('o-1'),
    (error) => {
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test('the asset list carries its filters as query parameters', async () => {
  let requested = null;
  const client = createApiClient({
    fetchImpl: async (url) => {
      requested = url;
      return jsonResponse(200, { data: [] });
    },
  });

  await client.listAssets('p-1', { kind: 'CAD', q: 'plan' });
  assert.match(requested, /\/api\/v1\/projects\/p-1\/assets\?/);
  assert.match(requested, /kind=CAD/);
  assert.match(requested, /q=plan/);
});

test('asset content is streamed with PUT, not sent as JSON', async () => {
  let captured = null;
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse(201, { data: { deduplicated: false } });
    },
  });

  const file = new Blob(['DXF-BYTES'], { type: 'image/vnd.dxf' });
  const result = await client.uploadAssetContent('p-1', 'a-1', 'v-1', file);

  assert.equal(captured.options.method, 'PUT');
  assert.equal(captured.url, '/api/v1/projects/p-1/assets/a-1/versions/v-1/content');
  assert.equal(captured.options.headers['content-type'], 'image/vnd.dxf');
  assert.equal(captured.options.body, file, 'the file itself is the body');
  assert.equal(captured.options.duplex, 'half', 'fetch needs a half-duplex streaming body');
  assert.equal(result.data.deduplicated, false);
});

test('a refused upload surfaces the asset error code', async () => {
  const client = createApiClient({
    fetchImpl: async () =>
      jsonResponse(409, { error: { code: 'ASSET_QUARANTINED', message: 'quarantined' }, meta: { correlation_id: 'c-1' } }),
  });

  await assert.rejects(
    () => client.downloadAsset('p-1', 'a-1', 'v-1'),
    (error) => {
      assert.equal(error.code, 'ASSET_QUARANTINED');
      return true;
    },
  );
});

test('an assistant turn is posted with its scope, transcript, and abort signal', async () => {
  let captured = null;
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse(200, { data: { status: 'ok', sessionId: 's-1' } });
    },
  });

  const controller = new AbortController();
  const result = await client.sendAssistantTurn(
    { messages: [{ role: 'user', content: 'hi' }], context_key: 'p-1|s|r', context: { projectId: 'p-1' } },
    { signal: controller.signal },
  );

  assert.equal(captured.url, '/api/v1/assistant/chat');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.signal, controller.signal);
  assert.deepEqual(JSON.parse(captured.options.body).context, { projectId: 'p-1' });
  assert.equal(result.data.sessionId, 's-1');
});

test('assistant reads carry the context key and the history path is encoded', async () => {
  const requested = [];
  const client = createApiClient({
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse(200, { data: {} });
    },
  });

  await client.listAssistantSessions('p-1|s|r');
  await client.loadAssistantHistory('s-1', 'p-1|s|r');
  await client.getAssistantUsage();

  assert.equal(requested[0], '/api/v1/assistant/sessions?context_key=p-1%7Cs%7Cr');
  assert.equal(requested[1], '/api/v1/assistant/sessions/s-1/history?context_key=p-1%7Cs%7Cr');
  assert.equal(requested[2], '/api/v1/assistant/usage');
});

test('Rack lifecycle carries exact version and retry identity, and trash listing keeps scope filters', async () => {
  const calls=[];
  const client=createApiClient({fetchImpl:async(url,options)=>{
    calls.push({url,options}); return jsonResponse(200,{data:{}});
  }});
  const signal=new AbortController().signal;
  for(const operation of ['rename','delete','restore']) {
    const body={contract_version:1,...(operation==='rename'?{name:'A'}:{})};
    await client.manageRackPlan('project /','plan /',operation,body,{version:4,idempotencyKey:'same-key',signal});
    const call=calls.at(-1);
    assert.equal(call.options.method,{rename:'PATCH',delete:'DELETE',restore:'POST'}[operation]);
    assert.equal(call.url,`/api/v1/projects/project%20%2F/rack/plans/plan%20%2F${operation==='restore'?'/restore':''}`);
    assert.equal(call.options.headers['If-Match'],'"4"');
    assert.equal(call.options.headers['Idempotency-Key'],'same-key');
    assert.equal(call.options.signal,signal);
    assert.equal(call.options.cache,'no-store');
    assert.deepEqual(JSON.parse(call.options.body),body);
  }
  await client.listRackPlans('p',{scenarioId:'s',revisionId:'r',cursor:'c',deleted:true});
  const query=new URL(calls.at(-1).url,'http://localhost').searchParams;
  for(const [key,value] of Object.entries({scenario_id:'s',revision_id:'r',cursor:'c',deleted:'true',limit:'20'}))
    assert.equal(query.get(key),value);
});

test('the facility graph is read for one revision, with both identifiers encoded', async () => {
  let requested = null;
  const client = createApiClient({
    fetchImpl: async (url) => {
      requested = url;
      return jsonResponse(200, { data: { revisionId: 'r-1', geometryRecords: [] } });
    },
  });

  const result = await client.getFacilityEnvelope('p-1', 'r 1');
  assert.equal(requested, '/api/v1/projects/p-1/facility/revisions/r%201');
  assert.deepEqual(result.data.geometryRecords, []);
});

