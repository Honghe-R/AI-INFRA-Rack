#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, FACILITY_KEYS, PLATFORM_KEYS, RACK_KEYS, catalogKeys } from '../src/index.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CLIENT_CATALOG_PATH = resolve(REPO_ROOT, 'apps/web/src/generated/permission-keys.js');

/**
 * Renders the client-side catalog.
 *
 * The permission catalog has exactly one owner — `src/catalog.js` — and this
 * module is the mechanical copy that lets the client import identifiers instead
 * of retyping strings. A retyped literal drifts silently: a client typo hides
 * UI, a server rename denies everyone, and neither fails a build.
 *
 * The parity test regenerates this text in memory and compares it with the file
 * on disk, so a stale copy fails the build rather than shipping.
 */
export function renderClientKeys() {
  const render = (entries) => entries.map(([name, key]) => `  ${name}: '${key}',`).join('\n');

  return `// GENERATED FILE — do not edit by hand.
//
// Source of truth: packages/rbac/src/catalog.js
// Regenerate with: npm --workspace @ai-infra/rbac run generate:keys
//
// Import these identifiers instead of retyping key strings.

export const PLATFORM_KEYS = Object.freeze({
${render(Object.entries(PLATFORM_KEYS))}
});

export const FACILITY_KEYS = Object.freeze({
${render(Object.entries(FACILITY_KEYS))}
});

export const RACK_KEYS = Object.freeze({
${render(Object.entries(RACK_KEYS))}
});

/** Every registered key, for drift checks and administration surfaces. */
export const ALL_PERMISSION_KEYS = Object.freeze([
${catalogKeys().map((key) => `  '${key}',`).join('\n')}
]);
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(dirname(CLIENT_CATALOG_PATH), { recursive: true });
  await writeFile(CLIENT_CATALOG_PATH, renderClientKeys(), 'utf8');
  console.log(`Wrote ${CLIENT_CATALOG_PATH} (${CATALOG.length} keys).`);
}
