#!/usr/bin/env node
// Read-only, loopback-only preview of synthetic Rack examples. No DB or platform API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { checkRackLayout, rackFootprint } from '@ai-infra/rack';
import { createLayoutScenarios } from '../packages/rack/examples/layout-scenarios.mjs';

const port = Number(process.env.RACK_PREVIEW_PORT ?? 5183);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RACK_PREVIEW_PORT must be an integer from 1 to 65535.');
const metadata = [
  ['正常布局', '两台机柜位于机房内，与已知障碍及彼此均无占地冲突。'],
  ['柜间重叠', '移动 A02 的合成位置，让两台机柜的占地产生重叠。'],
  ['并排贴边', '两个机柜的边恰好相接；占地不重叠，维护净距尚未检查。'],
  ['混合问题', '同时展示机柜越界、障碍冲突和柜间重叠。'],
  ['清单不完整', '机柜清单声明为未知；没有已知问题也不能直接判通过。'],
  ['空方案', '没有提供机柜，显示未检查状态。'],
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
