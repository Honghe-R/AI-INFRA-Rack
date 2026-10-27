#!/usr/bin/env node
/**
 * A synthetic tile source for local development.
 *
 * This serves generated tiles on `/tiles/{z}/{x}/{y}.png`, which is the address the
 * `self-hosted` provider is configured with. Start this **and** set
 * `MAP_SELF_HOSTED_TILE_URL` to that address: the provider is only registered when the
 * setting is present, so that a deployment with no tile server is never offered an
 * option that fails on every tile. Without the setting the canvas correctly degrades to
 * the plan-only grid.
 *
 * These are **not** map tiles: each one is a flat colour with a border, chosen from
 * its coordinates, so a tile that failed to load or is repeated out of place is
 * obvious. Real basemaps come from a licensed provider through the W5 proxy.
 *
 * Usage: node scripts/dev-tiles.mjs [--port 8080]
 */
import { createServer } from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';

const port = Number(process.env.TILE_PORT ?? process.argv[process.argv.indexOf('--port') + 1]) || 8080;
const TILE_SIZE = 256;

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};

function tilePng(z, x, y) {
  const [r, g, b] = hsv(((x * 37 + y * 61 + z * 13) % 200) / 200, 0.25, 0.92);
  const rows = [];
  for (let py = 0; py < TILE_SIZE; py += 1) {
    const row = Buffer.alloc(1 + TILE_SIZE * 3);
    row[0] = 0; // filter: none
    for (let px = 0; px < TILE_SIZE; px += 1) {
      const edge = px < 2 || py < 2 || px > TILE_SIZE - 3 || py > TILE_SIZE - 3;
      const offset = 1 + px * 3;
      row[offset] = edge ? 90 : r;
      row[offset + 1] = edge ? 100 : g;
      row[offset + 2] = edge ? 110 : b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(TILE_SIZE, 0);
  ihdr.writeUInt32BE(TILE_SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const cache = new Map();

const server = createServer((request, response) => {
  const match = request.url.match(/^\/tiles\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
  if (!match) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not a tile path');
    return;
  }
  const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const count = 2 ** z;
  if (x >= count || y >= count) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('outside the world at this zoom');
    return;
  }
  const key = `${z}/${x}/${y}`;
  if (!cache.has(key)) cache.set(key, tilePng(z, x, y));
  const body = cache.get(key);
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': body.length,
    'cache-control': 'public, max-age=60',
  });
  response.end(body);
});

/**
 * "Address already in use" is not a failure here — it is the ordinary case of starting a
 * second copy, and the fix is to do nothing. A stack trace said the opposite and read as
 * a broken script, so the one likely cause is named and the process exits cleanly. The
 * handler is attached before `listen` so a synchronous bind failure cannot beat it.
 */
server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(
    `A tile server is already listening on 127.0.0.1:${port}.\n` +
      'Nothing to do: the self-hosted provider is already being served. Stop the other\n' +
      'process if you meant to restart it, or pass --port to run a second one.',
  );
  process.exit(0);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`synthetic tiles  http://127.0.0.1:${port}/tiles/{z}/{x}/{y}.png`);
  console.log('These are generated placeholders, not a basemap. The self-hosted provider template points here.');
});
