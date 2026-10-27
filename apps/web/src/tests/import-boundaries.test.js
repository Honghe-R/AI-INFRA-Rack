import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository import boundaries.
 *
 * The shell consumes one dependency-free predicate from its own tree and nothing
 * else from the backend. That boundary is easy to erode by accident — someone needs
 * a helper from `@ai-infra/db` and imports it, and the browser bundle quietly grows a
 * dependency on server code, which only fails later at build or, worse, at runtime in
 * a browser.
 *
 * The rule, checked here rather than assumed:
 *   * nothing under `apps/web` imports an `@ai-infra/*` package or reaches outside
 *     its own app directory;
 *   * nothing under `packages/` imports an app. A package is a lower layer, and the
 *     direction only goes one way.
 *
 * Only import specifiers are examined, never raw text: `packages/rbac`'s catalog
 * parity test legitimately *reads* files under `apps/web` as data, which is a check
 * across the boundary rather than a dependency through it.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Removes comments while leaving string contents alone.
 *
 * The first version of this test scanned raw text, and immediately failed on the
 * client's own doc comment: `distinguish "the server said no" from "we could not
 * ask"` reads as `from "we could not ask"`. Anchoring to line starts instead would
 * miss multi-line imports, so the scanner has to know the difference.
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  let quote = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

async function sourceFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      found.push(...(await sourceFiles(path)));
    } else if (/\.(js|jsx|mjs)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

async function importsIn(dir) {
  const imports = [];
  for (const file of await sourceFiles(dir)) {
    const source = stripComments(await readFile(file, 'utf8'));
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        imports.push({ file: relative(REPO_ROOT, file), specifier: match[1] });
      }
    }
  }
  return imports;
}

test('the workspace shell imports nothing from the backend', async () => {
  const imports = await importsIn(join(REPO_ROOT, 'apps/web/src'));

  const packages = imports.filter((entry) => entry.specifier.startsWith('@ai-infra/'));
  assert.deepEqual(
    packages,
    [],
    `apps/web must not import a backend package; move what it needs into the shell instead:\n${packages
      .map((entry) => `  ${entry.file}: ${entry.specifier}`)
      .join('\n')}`,
  );

  // A relative path that climbs out of the app is the same violation wearing a
  // different hat.
  const escapes = imports.filter(
    (entry) => entry.specifier.startsWith('..') && entry.specifier.includes('/apps/'),
  );
  assert.deepEqual(escapes, [], 'apps/web must not reach into a sibling app');
});

test('no package imports an application', async () => {
  const packagesDir = join(REPO_ROOT, 'packages');
  const offenders = [];

  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const imports = await importsIn(join(packagesDir, entry.name));
    for (const item of imports) {
      if (item.specifier.includes('/apps/') || /^@ai-infra\/(api|web)/.test(item.specifier)) {
        offenders.push(`${item.file}: ${item.specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, [], 'a package is a lower layer than an app; the arrow only goes one way');
});

test('the permission predicate lives in the shell and is dependency-free', async () => {
  // The reason this boundary is cheap to keep: the predicate is self-contained, so
  // the browser bundle carries no server code. If it ever gains an import, the
  // frontend would be dragging a backend package into the bundle.
  const source = stripComments(await readFile(join(REPO_ROOT, 'apps/web/src/rbac/client.js'), 'utf8'));
  const specifiers = SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]),
  );
  assert.deepEqual(specifiers, [], 'the client predicate must stay dependency-free');

  // And the package must not still offer it, or there would be two owners.
  const rbacPackage = JSON.parse(await readFile(join(REPO_ROOT, 'packages/rbac/package.json'), 'utf8'));
  assert.equal(rbacPackage.exports['./client'], undefined, 'the predicate has one home, not two');
});
