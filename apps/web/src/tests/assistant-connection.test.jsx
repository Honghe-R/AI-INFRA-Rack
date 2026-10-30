import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantComposer } from '../assistant/AssistantComposer.jsx';
import { createAssistantTransport, connectionSessionKey } from '../assistant/useAssistantSession.js';
import { createApiClient } from '../api/client.js';

test('first-time setup remains inside Ask about Rack and blocks sending until configured', () => {
  const html = renderToStaticMarkup(<AssistantComposer open toolLabel="Rack" draft="Show capacity"
    provider={{ configured: false }} connectionClient={{ getAssistantConnection() {} }} />);
  assert.match(html, /Set up AI connection/);
  assert.match(html, /Loading your connection/);
  assert.match(html, /disabled=""[^>]*title="Set up a model connection first"/);
});

test('configured connection keeps a compact settings entry with no key in markup', () => {
  const html = renderToStaticMarkup(<AssistantComposer open toolLabel="Rack" draft="Show capacity"
    provider={{ configured: true, host: 'models.example.com', model: 'test-model' }} connectionClient={{ getAssistantConnection() {} }} />);
  assert.match(html, /Model connection/);
  assert.match(html, /models.example.com/);
  assert.doesNotMatch(html, /Set up AI connection/);
  assert.doesNotMatch(html, /type="password"/);
});

test('connection and model changes isolate session identities; chat transport sends references without credentials', async () => {
  const connection = { connectionId: 'id-a', version: 3, model: 'model/one' };
  const key = connectionSessionKey('base', connection, null);
  assert.equal(key, 'base|connection:id-a:3|model:model%2Fone');
  assert.notEqual(key, connectionSessionKey('base', { ...connection, version: 4 }, null));
  assert.notEqual(key, connectionSessionKey('base', { ...connection, connectionId: 'id-b' }, null));
  assert.notEqual(key, connectionSessionKey('base', connection, 'model/two'));
  const requests = [];
  const transport = createAssistantTransport({ async sendAssistantTurn(body) { requests.push(body); return { data: {} }; } }, connection);
  await transport.sendTurn({ messages: [], contextKey: key, sessionId: null, context: {} });
  assert.equal(requests[0].connection_id, 'id-a'); assert.equal(requests[0].connection_version, 3);
  assert.equal(Object.hasOwn(requests[0], 'apiKey'), false); assert.equal(Object.hasOwn(requests[0], 'endpoint'), false);
});

test('connection management uses authenticated uncached cancellable API calls; only explicit save sends a key', async () => {
  const calls = [];
  const client = createApiClient({ identity: () => 'alice', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ data: {} }) };
  } });
  const controller = new AbortController();
  await client.getAssistantConnection({ signal: controller.signal });
  await client.saveAssistantConnection({ apiKey: 'synthetic-test-key', version: null });
  await client.testAssistantConnection('a', 1, { signal: controller.signal });
  await client.deleteAssistantConnection(1);
  assert.deepEqual(calls.map((entry) => entry.options.method), ['GET', 'PUT', 'POST', 'DELETE']);
  assert.ok(calls.every((entry) => entry.options.cache === 'no-store' && entry.options.headers['x-dev-subject'] === 'alice'));
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[2].options.signal, controller.signal);
  assert.equal(calls[2].options.body, '{"connectionId":"a","version":1}');
  assert.ok(!calls[3].options.body.includes('apiKey'));
});
