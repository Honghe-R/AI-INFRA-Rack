#!/usr/bin/env node
// Read-only, loopback-only preview of synthetic Rack examples. No DB or platform API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { checkRackLayout, rackFootprint } from '@ai-infra/rack';
import { createLayoutScenarios } from '../packages/rack/examples/layout-scenarios.mjs';

const port = Number(process.env.RACK_PREVIEW_PORT ?? 5183);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RACK_PREVIEW_PORT must be an integer from 1 to 65535.');
const metadata = [
  ['Clear layout', 'Two racks are inside the room with no footprint conflicts with known obstacles or each other.'],
  ['Overlapping racks', 'Move the synthetic position of A02 to create a footprint overlap.'],
  ['Touching edges', 'Two racks share an edge without footprint overlap. Maintenance clearance has not been checked.'],
  ['Mixed issues', 'Show room boundary, obstacle and rack overlap conflicts together.'],
  ['Incomplete inventory', 'Inventory coverage is unknown; no known conflicts does not imply a complete pass.'],
  ['Empty plan', 'No racks are provided; the layout remains unchecked.'],
];
const payload = JSON.stringify({
  synthetic: true,
  cases: createLayoutScenarios().map(([id, input], index) => ({
    id, title: metadata[index][0], description: metadata[index][1], input,
    report: checkRackLayout(input),
    footprints: input.placements.map(placement => ({
      rackId: placement.rackId,
      ...rackFootprint(input.models.find(model => model.modelId === placement.modelId), placement),
    })),
  })),
});
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/preview.js', ['preview.js', 'text/javascript; charset=utf-8']],
  ['/preview.css', ['preview.css', 'text/css; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Read-only preview.');
    return;
  }
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (path === '/data.json') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : payload);
      return;
    }
    const file = staticFiles.get(path);
    if (!file) { response.writeHead(404); response.end('Not found.'); return; }
    const content = await readFile(new URL(`../apps/web/rack-preview/${file[0]}`, import.meta.url));
    response.setHeader('Content-Type', file[1]);
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500);
    response.end('Preview could not be loaded.');
  }
});
server.on('error', error => {
  console.error(`Rack preview: ${error.code === 'EADDRINUSE' ? `port ${port} is occupied; choose another RACK_PREVIEW_PORT` : error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Rack preview: http://127.0.0.1:${port}\nSynthetic examples only; no database, writes or persisted edits. Ctrl+C stops the preview.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
