import { mkdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { copySource, RACK_SOURCE, DEVELOPER_IMAGE } from '../apps/api/src/services/developer-workspace.js';

if (process.env.AI_INFRA_COMPOSE_FILE !== 'compose.rack.yaml') throw new Error('Run this command with the isolated Rack .env.');
const root = join(RACK_SOURCE, '.local-runtime/developer-build');
await mkdir(root, { recursive: true });
if ((await lstat(root)).isSymbolicLink()) throw new Error('Build directory must not be a link.');
const directory = await mkdtemp(join(root, 'image-'));
try {
  const copied = await copySource(RACK_SOURCE, directory);
  console.log(`Preparing filtered source (${copied.files} files); env, credentials, Git and runtime data are excluded.`);
  const status = await new Promise((done, reject) => {
    const child = spawn('docker', ['build', '--tag', DEVELOPER_IMAGE, '--file', join(RACK_SOURCE, 'scripts/developer/Dockerfile'), directory],
      { shell: false, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('close', done);
  });
  if (status !== 0) throw new Error('Sandbox image build failed. No host execution fallback is available.');
  console.log('Development sandbox ready. Runtime containers have no network; no model API was called.');
} finally {
  if (!resolve(directory).startsWith(resolve(root) + '\\') && !resolve(directory).startsWith(resolve(root) + '/')) throw new Error('Unsafe build cleanup target.');
  await rm(directory, { recursive: true, force: true });
}
