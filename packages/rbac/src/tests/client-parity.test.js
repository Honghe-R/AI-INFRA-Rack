import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogKeys, isKnownKey } from '../index.js';
import { CLIENT_CATALOG_PATH, REPO_ROOT, renderClientKeys } from '../../scripts/generate-client-keys.js';

/**
 * Client/server catalog parity (blueprint §9, "Keeping client and server keys in
 * step"; porting decision R5 — one catalog owner).
 *
 * The generated client module lives beside the shell that consumes it
 * (`apps/web/src/generated`), and two independent checks keep it honest:
 *  1. it is byte-identical to what the server catalog would produce, so a stale
 *     copy cannot ship;
 *  2. no client source retypes a permission key in a permission-check position.
 *
 * The second check deliberately matches only *call positions* rather than every
 * dotted literal. Constraint identifiers such as
 * `facility.capacity.budget.overcommit` share the `facility.*` shape but are
 * diagnostics, not permissions — scanning all literals would drown the check in
 * false positives until someone disabled it.
 */

const PERMISSION_CALL_PATTERNS = [
  /\bcan\(\s*['"]([^'"]+)['"]/g,
  /\busePermission\(\s*['"]([^'"]+)['"]/g,
  /\bpermission=\{?['"]([^'"]+)['"]/g,
];

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (/\.(js|jsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('the generated client catalog is current', async () => {
  const onDisk = await readFile(CLIENT_CATALOG_PATH, 'utf8');
  assert.equal(
    onDisk,
    renderClientKeys(),
    'the client catalog has drifted from packages/rbac/src/catalog.js; run: npm --workspace @ai-infra/rbac run generate:keys',
  );
});

test('the generated client catalog carries every registered key', async () => {
  const client = await import(pathToFileURL(CLIENT_CATALOG_PATH).href);
  assert.deepEqual([...client.ALL_PERMISSION_KEYS].sort(), catalogKeys());
  assert.equal(client.PLATFORM_KEYS.SYSTEM_ADMIN, 'system.admin');
  assert.equal(client.FACILITY_KEYS.PUBLISH, 'facility.publish');
});

test('no client source retypes a permission key in a check position', async () => {
  // apps/web is the platform work surface. The retired prototype is gone, so
  // there is exactly one client tree to scan.
  const roots = ['apps/web/src'].map((relative) => resolve(REPO_ROOT, relative));
  const offenders = [];

  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, 'utf8');
      for (const pattern of PERMISSION_CALL_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          if (!isKnownKey(match[1])) offenders.push(`${file.replace(REPO_ROOT, '.')}: ${match[1]}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], 'a client references an unregistered permission key');
});

test('the client catalog is importable without server dependencies', async () => {
  const client = await import(pathToFileURL(CLIENT_CATALOG_PATH).href);
  assert.ok(Object.isFrozen(client.PLATFORM_KEYS));
  assert.ok(Object.isFrozen(client.ALL_PERMISSION_KEYS));
  assert.equal(typeof client.FACILITY_KEYS.READ, 'string');
});
