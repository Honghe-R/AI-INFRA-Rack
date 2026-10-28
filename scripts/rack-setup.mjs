#!/usr/bin/env node
// Bootstrap only this copy's development data. Existing .env files are never overwritten.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = new URL('../.env', import.meta.url);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this helper using npm run rack:setup.');

try {
  let env;
  try {
    env = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    env = await readFile(new URL('../.env.rack.example', import.meta.url), 'utf8');
    for (const placeholder of ['CHANGE_ME_DB_PASSWORD', 'CHANGE_ME_STORAGE_SECRET', 'CHANGE_ME_AUTH_SECRET']) {
      env = env.replaceAll(placeholder, randomBytes(32).toString('hex'));
    }
    await writeFile(envPath, env, { flag: 'wx', mode: 0o600 });
    console.log('Created ignored .env with fresh local credentials.');
  }
  if (!/^AI_INFRA_COMPOSE_FILE=compose\.rack\.yaml\s*$/m.test(env)
      || !/^COMPOSE_PROJECT_NAME=ai-infra-rack-dev\s*$/m.test(env)) {
    throw new Error('Existing .env does not select the isolated Rack stack. See RACK_LOCAL_SETUP.md.');
  }
  if (/CHANGE_ME_/.test(env)) throw new Error('Replace all CHANGE_ME values in .env before setup.');
  const local = parseEnv(env);
  const database = new URL(local.DATABASE_URL);
  if (database.hostname !== '127.0.0.1' || database.port !== local.AI_INFRA_DB_PORT
      || database.pathname !== '/rack_facility' || local.POSTGRES_DB !== 'rack_facility'
      || local.STORAGE_DRIVER !== 's3'
      || local.STORAGE_ENDPOINT !== `http://127.0.0.1:${local.AI_INFRA_OBJECT_STORE_PORT}`
      || local.STORAGE_BUCKET !== 'rack-dev-assets') {
    throw new Error('Setup requires the local Rack database and bucket from .env.rack.example.');
  }
  // This process does not load .env: each existing npm script loads it for itself.
  // Refuse environment overrides that could send mutations to another stack/database.
  for (const key of ['DATABASE_URL', 'AI_INFRA_COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'POSTGRES_DB',
    'POSTGRES_USER', 'POSTGRES_PASSWORD', 'AI_INFRA_DB_PORT', 'STORAGE_DRIVER', 'STORAGE_ENDPOINT',
    'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY',
    'AI_INFRA_OBJECT_STORE_PORT', 'AI_INFRA_OBJECT_STORE_CONSOLE_PORT', 'AUTH_DEV_SUBJECT', 'COMPOSE_FILE']) {
    if (process.env[key] !== undefined) throw new Error(`Clear exported ${key} before using rack:setup; .env must own this setup.`);
  }
  for (const script of ['dev:up', 'migrate', 'dev:seed', 'dev:seed:facility']) {
    console.log(`\nRunning ${script}…`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npmCli, 'run', script], {
        cwd: root, stdio: 'inherit', windowsHide: true,
      });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${script} failed (${code}).`)));
    });
  }
  console.log('\nSetup complete. Run npm run dev, then open http://localhost:5193/.');
} catch (error) {
  console.error(`rack:setup: ${error.message}`);
  process.exitCode = 1;
}
