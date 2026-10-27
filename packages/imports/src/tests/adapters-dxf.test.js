import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import dxfAdapter, { descriptor, extract } from '../adapters/dxf.js';
import {
  CAPABILITY_LEVELS,
  EXTRACTION_CAPABILITIES,
  FEATURE_DISPOSITIONS,
} from '../adapter-contract.js';
import { IMPORT_DIAGNOSTIC_IDS, isImportDiagnostic } from '../diagnostics.js';
import { validateDescriptor } from '../descriptor.js';

const MEDIA_TYPE = 'image/vnd.dxf';
const REPO_ROOT = new URL('../../../../', import.meta.url);
const FIXTURE_DIR = 'packages/imports/src/tests/fixtures';

/** One hand-written conformance fixture per entry in tested_versions. */
const VERSION_FIXTURE = {
  AC1009: 'dxf-ac1009-r12.dxf',
  AC1015: 'dxf-ac1015-r2000.dxf',
  AC1018: 'dxf-ac1018-r2004.dxf',
  AC1021: 'dxf-ac1021-r2007.dxf',
  AC1024: 'dxf-ac1024-r2010.dxf',
  AC1027: 'dxf-ac1027-r2013.dxf',
  AC1032: 'dxf-ac1032-r2018.dxf',
};

const fixturePath = (name) => fileURLToPath(new URL(`${FIXTURE_DIR}/${name}`, REPO_ROOT));
const RICH = fixturePath(VERSION_FIXTURE.AC1032);
const R12 = fixturePath(VERSION_FIXTURE.AC1009);

async function load(path, limits = {}) {
  return extract({ path, mediaType: MEDIA_TYPE, limits });
}

function byHandle(result, handle) {
  return result.features.find((feature) => feature.attributes.handle === handle);
}

function constraintIds(result) {
  return result.diagnostics.map((entry) => entry.constraintId);
}

test('descriptor satisfies the adapter registry contract', () => {
  assert.equal(descriptor.adapter_id, 'dxf');
  assert.equal(descriptor.adapter_version, '1.0.0');
  assert.deepEqual(descriptor.media_types, ['image/vnd.dxf', 'application/dxf', 'application/octet-stream']);
  assert.deepEqual(descriptor.extensions, ['.dxf']);
  assert.deepEqual(descriptor.source_crs_declarations, ['LOCAL', 'EPSG']);
  assert.deepEqual(descriptor.source_unit_declarations, ['m', 'mm', 'cm', 'in', 'ft', 'US_ft']);
  assert.equal(descriptor.fidelity_level, 'PARTIAL');
  assert.equal(descriptor.release_level, 'R1');
  assert.equal(descriptor.status, 'ACTIVE');
  assert.equal(descriptor.isolation, 'WORKER_SANDBOX');
  assert.equal(descriptor.converter_dependency, undefined);
  assert.ok(descriptor.entry_point.endsWith('/dxf.js'));
  assert.deepEqual(descriptor.supported_range, {
    min_version: 'R12',
    max_version: 'AC1032',
    tested_versions: ['AC1009', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'],
  });

  // The package's own validator is the shape check for every required field.
  assert.doesNotThrow(() => validateDescriptor(descriptor));

  for (const capability of descriptor.extraction_capabilities) {
    assert.ok(EXTRACTION_CAPABILITIES.includes(capability.name), `${capability.name} is a shared capability`);
    assert.ok(CAPABILITY_LEVELS.includes(capability.level), `${capability.level} is a shared level`);
  }
  assert.equal(descriptor.fidelity_level === 'FULL', false, 'a documented subset is PARTIAL, never FULL');

  for (const constraintId of descriptor.required_diagnostics) {
    assert.ok(isImportDiagnostic(constraintId), `${constraintId} must be in the shared registry`);
    assert.ok(IMPORT_DIAGNOSTIC_IDS.includes(constraintId));
  }
  assert.deepEqual(
    new Set(descriptor.required_diagnostics),
    new Set(['import.units.unconfirmed', 'import.feature.unsupported', 'import.conversion.incomplete']),
  );

  // One conformance fixture per tested version, and every fixture exists on disk.
  for (const version of descriptor.supported_range.tested_versions) {
    const expected = `${FIXTURE_DIR}/${VERSION_FIXTURE[version]}`;
    assert.ok(descriptor.conformance_fixtures.includes(expected), `${expected} is declared`);
  }
  for (const fixture of descriptor.conformance_fixtures) {
    assert.ok(existsSync(fileURLToPath(new URL(fixture, REPO_ROOT))), `${fixture} must exist`);
  }

  // The default export is the frozen adapter object, not the raw descriptor.
  assert.equal(typeof dxfAdapter.extract, 'function');
  assert.equal(dxfAdapter.descriptor.adapter_id, 'dxf');
});

test('every tested version fixture extracts and returns JSON-serializable data', async () => {
  for (const version of descriptor.supported_range.tested_versions) {
    const result = await load(fixturePath(VERSION_FIXTURE[version]));
    assert.ok(result.features.length >= 1, `${version} should yield at least one feature`);
    assert.equal(result.counts.extracted, result.features.length);
    assert.equal(
      result.counts.mapped + result.counts.unmapped + result.counts.referenceOnly + result.counts.rejected,
      result.counts.extracted,
      `${version} counts must reconcile`,
    );
    assert.equal(result.georeference.sourceCrs, null);
    for (const feature of result.features) {
      assert.equal(feature.geojson, null);
      assert.ok(FEATURE_DISPOSITIONS.includes(feature.disposition));
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, `${version} result must be JSON-serializable`);
  }
});

test('LAYER table entries are reported with name and colour', async () => {
  const result = await load(RICH);
  assert.deepEqual(result.layers.map((layer) => layer.name), ['WALLS', 'ROADS', '0']);
  assert.equal(result.layers.find((layer) => layer.name === 'WALLS').colour, 7);
  assert.equal(result.layers.find((layer) => layer.name === 'ROADS').colour, 1);
});

test('a closed LWPOLYLINE becomes a POLYGON and an open one a LINESTRING', async () => {
  const result = await load(RICH);

  const closed = byHandle(result, '1A');
  assert.equal(closed.disposition, 'MAPPED');
  assert.equal(closed.geometryType, 'POLYGON');
  assert.equal(closed.localGeometry.type, 'POLYGON');
  assert.equal(closed.attributes.layer, 'WALLS');
  assert.equal(closed.attributes.closed, true);
  assert.equal(closed.attributes.vertexCount, 4);
  assert.equal(closed.localGeometry.coordinates.length, 1);
  const ring = closed.localGeometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[ring.length - 1]);

  const open = byHandle(result, '1B');
  assert.equal(open.geometryType, 'LINESTRING');
  assert.equal(open.attributes.closed, false);
  assert.deepEqual(open.localGeometry.coordinates, [[0, 0], [5, 2.5], [10, 0]]);
});

test('LINE becomes a two-point LINESTRING with layer metadata', async () => {
  const result = await load(RICH);
  const line = byHandle(result, '30');
  assert.equal(line.disposition, 'MAPPED');
  assert.equal(line.geometryType, 'LINESTRING');
  assert.deepEqual(line.localGeometry.coordinates, [[1, 1], [9, 1]]);
  assert.equal(line.attributes.layer, 'WALLS');
  assert.equal(line.geojson, null);
});

test('$INSUNITS is mapped to the source unit', async () => {
  const result = await load(RICH);
  assert.equal(result.georeference.sourceUnits, 'm');
  assert.equal(result.georeference.sourceCrs, null);
  assert.ok(!constraintIds(result).includes('import.units.unconfirmed'));
  assert.ok(result.georeference.evidence.some((entry) => entry.includes('$INSUNITS=6')));
});

test('missing $INSUNITS raises import.units.unconfirmed but keeps local geometry', async () => {
  const result = await load(R12);
  assert.equal(result.georeference.sourceUnits, null);
  assert.ok(constraintIds(result).includes('import.units.unconfirmed'));

  const line = byHandle(result, '30');
  assert.ok(line, 'geometry is still extracted without units');
  assert.equal(line.geojson, null);
  assert.ok(line.localGeometry, 'coordinates stay in source units');
});

test('unsupported geometry, text, dimensions and hatches stay reference-only', async () => {
  const result = await load(RICH);
  for (const entityType of ['SPLINE', '3DFACE', 'MESH', 'BODY', 'REGION', 'ACAD_PROXY_ENTITY', 'MLINE']) {
    const feature = result.features.find((entry) => entry.attributes.entityType === entityType);
    assert.ok(feature, `${entityType} is retained, never dropped`);
    assert.equal(feature.disposition, 'REFERENCE_ONLY');
    assert.equal(feature.localGeometry, null);
    assert.ok(
      result.diagnostics.some((entry) => entry.constraintId === 'import.feature.unsupported' && entry.entityRef === feature.featureId),
      `${entityType} raises import.feature.unsupported`,
    );
  }

  const text = byHandle(result, '34');
  assert.equal(text.disposition, 'REFERENCE_ONLY');
  assert.equal(text.attributes.text, 'PUMP ROOM');
  assert.equal(text.attributes.height, 0.25);
  assert.deepEqual(text.localGeometry.coordinates, [1, 6]);

  const mtext = byHandle(result, '35');
  assert.equal(mtext.disposition, 'REFERENCE_ONLY');
  assert.equal(mtext.attributes.text, 'LEVEL 2 FLOOR');

  const dimension = byHandle(result, '36');
  assert.equal(dimension.disposition, 'REFERENCE_ONLY');
  assert.equal(dimension.attributes.measurement, 10);

  const hatch = byHandle(result, '37');
  assert.equal(hatch.disposition, 'REFERENCE_ONLY');
  assert.equal(hatch.attributes.patternName, 'ANSI31');
});

test('CIRCLE, ARC and ELLIPSE are approximated as LINESTRINGs with a recorded method', async () => {
  const result = await load(RICH);

  const circle = byHandle(result, '31');
  assert.equal(circle.geometryType, 'LINESTRING');
  assert.equal(circle.attributes.sourceRadius, 2.5);
  assert.equal(circle.attributes.approximation.method, 'CHORD');
  assert.ok(circle.attributes.approximation.segments >= 8);
  assert.ok(circle.attributes.approximation.tolerance > 0);
  const ring = circle.localGeometry.coordinates;
  assert.deepEqual(ring[0], ring[ring.length - 1], 'the circle ring closes');

  const arc = byHandle(result, '32');
  assert.equal(arc.geometryType, 'LINESTRING');
  assert.equal(arc.attributes.sweepDegrees, 90);
  assert.equal(arc.attributes.approximation.method, 'CHORD');
  assert.equal(arc.localGeometry.coordinates.length, arc.attributes.approximation.segments + 1);

  const ellipse = byHandle(result, '61');
  assert.equal(ellipse.geometryType, 'LINESTRING');
  assert.equal(ellipse.attributes.approximation.method, 'CHORD');
  assert.deepEqual(ellipse.attributes.majorAxis, [3, 0]);
});

test('INSERT expands block entities and carries ATTRIB tag/value pairs', async () => {
  const result = await load(RICH);

  const doorFeatures = result.features.filter((feature) => feature.attributes.block === 'DOOR');
  assert.deepEqual(doorFeatures.map((feature) => feature.attributes.handle).sort(), ['41', '42']);
  assert.ok(doorFeatures.every((feature) => feature.attributes.blockAttributes.DOOR_ID === 'D-101'));
  assert.ok(doorFeatures.every((feature) => feature.attributes.blockHandle === '50'));

  const nested = result.features.find((feature) => feature.attributes.block === 'HANDLE');
  assert.ok(nested, 'the nested block expands at the default depth');
  assert.equal(nested.disposition, 'MAPPED');
  assert.equal(nested.attributes.blockPath, 'DOOR/HANDLE');
  assert.equal(nested.attributes.layer, 'WALLS', 'layer inheritance walks up to the placement layer');
  assert.equal(nested.attributes.handle, '46');
});

test('external references are reference-only and are not followed', async () => {
  const result = await load(RICH);
  const xref = byHandle(result, '60');
  assert.ok(xref);
  assert.equal(xref.disposition, 'REFERENCE_ONLY');
  assert.equal(xref.attributes.externalReference, true);
  assert.equal(xref.attributes.xrefPath, '../xrefs/site.dwg');
  assert.equal(xref.localGeometry, null);
  assert.ok(result.diagnostics.some((entry) => entry.constraintId === 'import.feature.unsupported' && entry.entityRef === xref.featureId));
  assert.ok(constraintIds(result).includes('import.conversion.incomplete'));
});

test('block nesting depth limit marks deeper insertions reference-only', async () => {
  const shallow = await load(RICH, { blockNestingDepth: 1 });
  const limited = shallow.features.find((feature) => feature.attributes.block === 'HANDLE');
  assert.ok(limited, 'the deeper insertion is retained as a record');
  assert.equal(limited.disposition, 'REFERENCE_ONLY');
  assert.equal(limited.attributes.nestingDepth, 2);
  assert.equal(limited.attributes.blockNestingDepthLimit, 1);
  assert.ok(constraintIds(shallow).includes('import.conversion.incomplete'));

  const deep = await load(RICH, { blockNestingDepth: 16 });
  const nestedLine = deep.features.find((feature) => feature.attributes.block === 'HANDLE');
  assert.equal(nestedLine.disposition, 'MAPPED');
});

test('vertex limit marks excess geometry reference-only instead of dropping it', async () => {
  const result = await load(RICH, { maxVerticesPerGeometry: 3 });
  const closed = byHandle(result, '1A');
  assert.equal(closed.disposition, 'REFERENCE_ONLY');
  assert.equal(closed.attributes.referenceOnlyReason, 'VERTEX_LIMIT');
  assert.equal(closed.attributes.vertexCount, 4);
  assert.equal(closed.attributes.vertexLimit, 3);
  assert.equal(closed.attributes.truncated, true);
  assert.ok(closed.localGeometry, 'the feature keeps a bounded reference geometry');
  assert.ok(constraintIds(result).includes('import.conversion.incomplete'));
  assert.ok(byHandle(result, '1B'), 'unaffected features are still emitted');
});

test('feature limit keeps the excess as reference-only records', async () => {
  const result = await load(RICH, { maxFeatures: 5 });
  assert.ok(result.features.length > 5, 'excess features are retained, not dropped');
  assert.equal(result.counts.extracted, result.features.length);
  assert.ok(result.counts.referenceOnly >= 1);
  assert.ok(constraintIds(result).includes('import.conversion.incomplete'));
  const excess = result.features[5];
  assert.equal(excess.disposition, 'REFERENCE_ONLY');
  assert.equal(excess.attributes.referenceOnlyReason, 'FEATURE_LIMIT');
  assert.equal(excess.attributes.maxFeatures, 5);
});
