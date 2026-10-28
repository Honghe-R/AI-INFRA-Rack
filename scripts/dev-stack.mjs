#!/usr/bin/env node
/**
 * The local development stack, from one command.
 *
 * Brings up the two services the deployment replaces with managed offerings — PostgreSQL
 * with PostGIS, and an S3-compatible object store — waits until both actually answer from
 * the host, and creates the bucket. Waiting matters: `docker compose up -d` returns once
 * containers are *started*, and a migration or an upload run two seconds later fails in a
 * way that looks like an application bug.
 *
 * The readiness probes come from `lib/probes.mjs`, shared with `dev.mjs`, so "ready" means
 * the same thing everywhere. They run from the host over the published ports, because that
 * is the path the application itself takes.
 *
 * Usage:
 *   node scripts/dev-stack.mjs up       start, wait, create the bucket
 *   node scripts/dev-stack.mjs down     stop, keeping data
 *   node scripts/dev-stack.mjs reset    stop and delete volumes
 *   node scripts/dev-stack.mjs status   report what is reachable
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStorage } from '@ai-infra/storage';
import { loadConfig } from '@ai-infra/core';
import { databaseReady, objectStoreReady } from './lib/probes.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE_FILE = resolve(REPO_ROOT, process.env.AI_INFRA_COMPOSE_FILE ?? 'compose.yaml');
const DB_PORT = process.env.AI_INFRA_DB_PORT ?? '55432';
const OBJECT_STORE_PORT = process.env.AI_INFRA_OBJECT_STORE_PORT ?? '59000';
const OBJECT_STORE_HOST = `127.0.0.1:${OBJECT_STORE_PORT}`;
const WAIT_TIMEOUT_MS = Number(process.env.AI_INFRA_WAIT_MS ?? 90_000);

function compose(args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`docker compose ${args.join(' ')} failed (exit ${code})${output ? `:\n${output}` : ''}`))));
  });
}

async function waitFor(label, probe) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  process.stdout.write(`  waiting for ${label} `);
  while (Date.now() < deadline) {
    if (await probe()) {
      process.stdout.write('ready\n');
      return;
    }
    process.stdout.write('.');
    await delay(1000);
  }
  process.stdout.write('\n');
  throw new Error(`${label} did not become ready within ${WAIT_TIMEOUT_MS}ms. Check: docker compose -f compose.yaml logs`);
}

async function up() {
  console.log('Starting the local stack (PostgreSQL + PostGIS, S3-compatible object store)…');
  await compose(['up', '-d']);
  await waitFor(`PostgreSQL on 127.0.0.1:${DB_PORT}`, () => databaseReady(DB_PORT));
  await waitFor(`object store on ${OBJECT_STORE_HOST}`, () => objectStoreReady(`http://${OBJECT_STORE_HOST}`));

  // The bucket is created through the same adapter the application uses, so a signing or
  // addressing bug shows up here rather than during the first upload.
  const config = loadConfig({
    ...process.env,
    STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? `http://${OBJECT_STORE_HOST}`,
    STORAGE_BUCKET: process.env.STORAGE_BUCKET ?? 'ai-infra-assets',
  });
  const storage = createStorage(config);
  const { created } = await storage.ensureBucket();
  console.log(`  bucket ${config.storageBucket} ${created ? 'created' : 'already present'}`);

  console.log(`
Stack ready. The npm scripts read the repository .env; keep credentials there.
Next: npm run migrate, npm run dev:seed, npm run dev:seed:facility, then npm run dev.
Object-store console: http://127.0.0.1:${process.env.AI_INFRA_OBJECT_STORE_CONSOLE_PORT ?? '59001'}`);
}

async function status() {
  const [db, objects] = [await databaseReady(DB_PORT), await objectStoreReady(`http://${OBJECT_STORE_HOST}`)];
  console.log(`PostgreSQL on 127.0.0.1:${DB_PORT}: ${db ? 'reachable' : 'not reachable'}`);
  console.log(`Object store on ${OBJECT_STORE_HOST}: ${objects ? 'reachable' : 'not reachable'}`);
  if (!db || !objects) process.exitCode = 1;
}

const command = process.argv[2] ?? 'up';

try {
  if (command === 'up') await up();
  else if (command === 'down') await compose(['down']);
  else if (command === 'reset') await compose(['down', '-v']);
  else if (command === 'status') await status();
  else {
    console.error(`Unknown command "${command}". Use up, down, reset, or status.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`dev-stack: ${error.message}`);
  process.exitCode = 1;
}
