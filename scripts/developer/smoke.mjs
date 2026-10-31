// Optional local acceptance. No provider, model, live API, database or credentials.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDeveloperWorkspace, RACK_SOURCE } from '../../apps/api/src/services/developer-workspace.js';

const parent = join(RACK_SOURCE, '.local-runtime/developer-smoke');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'case-'));
const service = createDeveloperWorkspace({ root: join(directory, 'workspaces'), enabled: true, authorize: async () => true });
const ctx = { workspaceId: randomUUID(), initiatedBy: { userId: randomUUID() }, requestId: randomUUID() };
try {
  assert.equal((await service.status(ctx)).runtimeReady, true, 'Run npm run rack:developer:setup first.');
  await service.edit(ctx, { path: 'scripts/developer/sandbox-check.test.mjs', expected_hash: null, content: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
test('sandbox is non-root, offline and cannot write source mount/root or access credentials', async () => {
  assert.equal(process.getuid(), 1000);
  assert.ok(Object.values(networkInterfaces()).flat().every(i => i.internal));
  for (const path of ['/work/.env', '/input/.env', '/var/run/docker.sock']) await assert.rejects(access(path));
  await assert.rejects(writeFile('/input/README.md', 'forbidden'));
  await assert.rejects(writeFile('/opt/rack/README.md', 'forbidden'));
  await writeFile('/work/apps/disposable-smoke.js', 'temporary');
});
` });
  const result = await service.run(ctx, { command: 'node --test scripts/developer/sandbox-check.test.mjs packages/rack/src/tests/model.test.js' });
  process.stdout.write(result.output + '\n');
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0, 'Real Docker smoke failed.');
  await assert.rejects(service.read(ctx, { path: 'apps/disposable-smoke.js' }), e => e.code === 'ENOENT');
  const changes = await service.export(ctx);
  assert.deepEqual(changes.items.map(i => i.path), ['scripts/developer/sandbox-check.test.mjs']);
  assert.equal(changes.liveCheckoutChanged, false);
  console.log('Real sandbox passed: source edit, Rack tests, isolation, ephemeral terminal writes and patch export. No model API calls.');
} finally {
  if (!resolve(directory).startsWith(resolve(parent) + sep)) throw new Error('Unsafe smoke cleanup');
  await rm(directory, { recursive: true, force: true });
}
