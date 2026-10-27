import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { r1Adapters } from '../adapters/index.js';
import { reconcileCounts } from '../adapter-contract.js';
import { isImportDiagnostic } from '../diagnostics.js';
import { validateDescriptor } from '../descriptor.js';
import { createDefaultRegistry } from '../index.js';

/**
 * Conformance for every registered adapter: the descriptor is valid, every
 * declared fixture exists, and the adapter runs to a reconciled result. This is
 * the acceptance criterion that a capability claim without a fixture is not
 * registrable (doc/workspace/import-adapters.md, criterion 23).
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

test('every registered adapter has a valid descriptor and existing fixtures', () => {
  for (const adapter of r1Adapters) {
    assert.doesNotThrow(() => validateDescriptor(adapter.descriptor), `${adapter.descriptor.adapter_id} validates`);
    assert.ok(adapter.descriptor.conformance_fixtures.length > 0);
    for (const fixture of adapter.descriptor.conformance_fixtures) {
      assert.ok(existsSync(join(repoRoot, fixture)), `${adapter.descriptor.adapter_id} fixture exists: ${fixture}`);
    }
    for (const diagnostic of adapter.descriptor.required_diagnostics) {
      assert.ok(isImportDiagnostic(diagnostic), `${diagnostic} is a shared import diagnostic`);
    }
  }
});

test('the default registry resolves every R1 media type the adapters claim', () => {
  const registry = createDefaultRegistry();
  const resolved = registry
    .selectable()
    .map((descriptor) => registry.resolve({ mediaType: descriptor.media_types[0], extension: descriptor.extensions[0] }).descriptor.adapter_id)
    .sort();
  assert.deepEqual(resolved, ['csv', 'dwg', 'dxf', 'geojson', 'geotiff', 'kml', 'vendor-document']);
});

test('each extractable fixture runs and every feature ends in one disposition', async () => {
  const cases = [
    { module: 'geojson', fixture: 'sample.geojson', mediaType: 'application/geo+json', expectedMapped: 2 },
    { module: 'csv', fixture: 'points.csv', mediaType: 'text/csv', expectedMapped: 2 },
    { module: 'kml', fixture: 'sample.kml', mediaType: 'application/vnd.google-earth.kml+xml' },
    { module: 'dxf', fixture: 'dxf-ac1032-r2018.dxf', mediaType: 'image/vnd.dxf' },
    { module: 'raster', fixture: 'tiny.tif', mediaType: 'image/tiff' },
    { module: 'document', fixture: 'tiny.pdf', mediaType: 'application/pdf' },
  ];

  for (const item of cases) {
    const module = await import(`../adapters/${item.module}.js`);
    const result = await module.extract({
      path: join(repoRoot, 'packages/imports/src/tests/fixtures', item.fixture),
      mediaType: item.mediaType,
      filename: item.fixture,
      limits: {},
    });

    assert.deepEqual(result.counts, reconcileCounts(result.features), `${item.module} counts reconcile`);
    assert.equal(result.counts.extracted, result.features.length, `${item.module} reports every feature`);
    for (const feature of result.features) {
      assert.ok(
        ['MAPPED', 'UNMAPPED', 'REFERENCE_ONLY', 'REJECTED'].includes(feature.disposition),
        `${item.module} feature disposition is canonical`,
      );
    }
    for (const diagnostic of result.diagnostics) {
      assert.ok(isImportDiagnostic(diagnostic.constraintId), `${item.module} emits only shared diagnostics`);
    }
    if (item.expectedMapped !== undefined) assert.equal(result.counts.mapped, item.expectedMapped);
    // The result must survive the sandbox boundary.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('the DWG adapter refuses without a licensed converter and declares the dependency', async () => {
  const module = await import('../adapters/dwg.js');
  assert.equal(module.descriptor.converter_dependency.output_adapter_id, 'dxf');
  await assert.rejects(
    module.extract({ path: join(repoRoot, 'packages/imports/src/tests/fixtures/unavailable.dwg'), mediaType: 'image/vnd.dwg', limits: {} }),
    (error) => error.code === 'import.adapter.unsupported',
  );
});
