import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { databaseReady } from '../lib/probes.mjs';

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('database probe sends PostgreSQL SSLRequest before accepting a response', async () => {
  await withServer((socket) => {
    socket.once('data', (data) => {
      assert.equal(data.readInt32BE(0), 8);
      assert.equal(data.readInt32BE(4), 80877103);
      socket.end('N');
    });
  }, async (port) => assert.equal(await databaseReady(port), true));
});

test('a database closing during startup settles false instead of hanging', async () => {
  await withServer((socket) => socket.once('data', () => socket.end()), async (port) => {
    assert.equal(await databaseReady(port), false);
  });
});
