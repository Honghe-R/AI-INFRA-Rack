/**
 * KML / KMZ adapter tests.
 *
 * Covers geometry mapping, folder grouping, ExtendedData, reference-only
 * content, the XML scanner edges, folder-depth flattening, KMZ safety and
 * limits, and count reconciliation.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import kmlAdapter, { descriptor, extract } from '../adapters/kml.js';
import {
  ADAPTER_STATUSES,
  CAPABILITY_LEVELS,
  EXTRACTION_CAPABILITIES,
  FEATURE_DISPOSITIONS,
  FIDELITY_LEVELS,
  ISOLATION_LEVELS,
  RELEASE_LEVELS,
} from '../adapter-contract.js';
import { IMPORT_DIAGNOSTIC_IDS, isImportDiagnostic } from '../diagnostics.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const KML_TYPE = 'application/vnd.google-earth.kml+xml';
const KMZ_TYPE = 'application/vnd.google-earth.kmz';

const tempRoot = await mkdtemp(join(tmpdir(), 'kml-adapter-test-'));
after(() => rm(tempRoot, { recursive: true, force: true }));

let tempSeq = 0;
async function parseKml(xml, limits) {
  tempSeq += 1;
  const path = join(tempRoot, `doc-${tempSeq}.kml`);
  await writeFile(path, xml);
  return extract({ path, mediaType: KML_TYPE, limits });
}

async function parseArchive(buffer, limits, name = `archive-${(tempSeq += 1)}.kmz`) {
  const path = join(tempRoot, name);
  await writeFile(path, buffer);
  return extract({ path, mediaType: KMZ_TYPE, limits });
}

async function parseFixture(name, options = {}) {
  const path = filePath(name);
  return extract({ path, mediaType: name.endsWith('.kmz') ? KMZ_TYPE : KML_TYPE, ...options });
}

function filePath(name) {
  // `fileURLToPath`, not `URL.pathname`: a pathname is percent-encoded, so a checkout under
  // a directory with a space in it — "AI Network Infra Simulator" is one — hands the adapter
  // a literal `%20` and every fixture read fails with ENOENT.
  return fileURLToPath(new URL(name, FIXTURES));
}

function wrap(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">${body}</kml>`;
}

function featureBySelector(result, selector) {
  const feature = result.features.find((entry) => entry.sourceSelector === selector);
  assert.ok(feature, `expected a feature with selector ${selector}`);
  return feature;
}

/* ------------------------------------------------------------------ */
/* Descriptor                                                          */
/* ------------------------------------------------------------------ */

test('descriptor declares every contract field truthfully', async () => {
  assert.equal(descriptor.adapter_id, 'kml');
  assert.equal(descriptor.adapter_version, '1.0.0');
  assert.deepEqual(descriptor.media_types, [
    'application/vnd.google-earth.kml+xml',
    'application/vnd.google-earth.kmz',
    'application/xml',
    'text/xml',
  ]);
  assert.deepEqual(descriptor.extensions, ['.kml', '.kmz']);
  assert.deepEqual(descriptor.source_crs_declarations, ['EPSG:4326']);
  assert.deepEqual(descriptor.source_unit_declarations, ['deg', 'm']);
  assert.ok(FIDELITY_LEVELS.includes(descriptor.fidelity_level));
  assert.equal(descriptor.fidelity_level, 'PARTIAL');
  assert.equal(descriptor.converter_dependency, undefined);

  assert.deepEqual(descriptor.supported_range, {
    min_version: '2.2',
    max_version: '2.3',
    tested_versions: ['2.2', '2.3'],
  });
  assert.ok(RELEASE_LEVELS.includes(descriptor.release_level));
  assert.equal(descriptor.release_level, 'R1');
  assert.ok(ADAPTER_STATUSES.includes(descriptor.status));
  assert.equal(descriptor.status, 'ACTIVE');
  assert.ok(ISOLATION_LEVELS.includes(descriptor.isolation));
  assert.equal(descriptor.isolation, 'WORKER_SANDBOX');
  assert.equal(descriptor.entry_point, new URL('../adapters/kml.js', import.meta.url).href);

  assert.ok(descriptor.extraction_capabilities.length > 0);
  for (const capability of descriptor.extraction_capabilities) {
    assert.ok(EXTRACTION_CAPABILITIES.includes(capability.name), `unknown capability ${capability.name}`);
    assert.ok(CAPABILITY_LEVELS.includes(capability.level), `unknown level ${capability.level}`);
  }

  assert.deepEqual([...descriptor.required_diagnostics].sort(), [
    'import.conversion.incomplete',
    'import.feature.unsupported',
  ]);
  for (const id of descriptor.required_diagnostics) {
    assert.ok(IMPORT_DIAGNOSTIC_IDS.includes(id), `${id} is not registered`);
    assert.ok(isImportDiagnostic(id));
  }

  assert.equal(descriptor.conformance_fixtures.length, 2);
  const repositoryRoot = new URL('../../../../', import.meta.url);
  for (const fixture of descriptor.conformance_fixtures) {
    assert.match(fixture, /\.(kml|kmz)$/);
    const bytes = await readFile(new URL(fixture, repositoryRoot));
    assert.ok(bytes.length > 0, `${fixture} must exist and be non-empty`);
  }

  assert.equal(typeof extract, 'function');
  assert.equal(typeof kmlAdapter.extract, 'function');
  assert.equal(kmlAdapter.descriptor.adapter_id, 'kml');
});

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

test('Point parses to a WGS 84 GeoJSON point with altitude', async () => {
  const result = await parseFixture('sample.kml');
  const yard = featureBySelector(result, 'group:Site/Yard');
  assert.equal(yard.disposition, 'MAPPED');
  assert.equal(yard.geometryType, 'POINT');
  assert.equal(yard.sourceSrid, 4326);
  assert.deepEqual(yard.geojson, { type: 'Point', coordinates: [-122.4194, 37.7749, 12.5] });
  assert.equal(yard.elevationM, 12.5);
  assert.equal(result.georeference.sourceCrs, 'EPSG:4326');
  assert.equal(result.georeference.sourceUnits, 'deg');
});

test('LineString parses every coordinate tuple in order', async () => {
  const result = await parseFixture('sample.kml');
  const route = featureBySelector(result, 'group:Route');
  assert.equal(route.geometryType, 'LINESTRING');
  assert.deepEqual(route.geojson.coordinates, [
    [-122.43, 37.76, 5],
    [-122.42, 37.75, 6],
  ]);
});

test('Polygon parses the outer ring and inner rings as holes', async () => {
  const result = await parseFixture('sample.kml');
  const parcel = featureBySelector(result, 'group:Site/Parcels/P-1');
  assert.equal(parcel.geometryType, 'POLYGON');
  const [outer, ...holes] = parcel.geojson.coordinates;
  assert.equal(holes.length, 1);
  assert.equal(outer.length, 5);
  assert.deepEqual(outer[0], outer[outer.length - 1], 'outer ring must stay closed');
  assert.deepEqual(holes[0][0], holes[0][holes[0].length - 1], 'hole ring must stay closed');
});

test('MultiGeometry emits one feature per child geometry', async () => {
  const result = await parseKml(
    wrap(
      '<Document><Placemark><name>Multi</name><MultiGeometry>' +
        '<Point><coordinates>1,2</coordinates></Point>' +
        '<LineString><coordinates>1,2 3,4</coordinates></LineString>' +
        '</MultiGeometry></Placemark></Document>',
    ),
  );
  const multi = result.features.filter((feature) => feature.sourceSelector.startsWith('group:Multi'));
  assert.equal(multi.length, 2);
  assert.deepEqual(multi.map((feature) => feature.geometryType), ['POINT', 'LINESTRING']);
  assert.deepEqual(multi.map((feature) => feature.sourceSelector), ['group:Multi#0', 'group:Multi#1']);
  assert.ok(multi.every((feature) => feature.disposition === 'MAPPED'));
});

/* ------------------------------------------------------------------ */
/* Hierarchy and attributes                                            */
/* ------------------------------------------------------------------ */

test('Folder path becomes attributes.group and the group: selector', async () => {
  const result = await parseFixture('sample.kml');
  const parcel = featureBySelector(result, 'group:Site/Parcels/P-1');
  assert.equal(parcel.attributes.group, 'Site/Parcels');
  const route = featureBySelector(result, 'group:Route');
  assert.equal(route.attributes.group, '');
});

test('ExtendedData becomes attributes, including CDATA and entity values', async () => {
  const result = await parseFixture('sample.kml');
  const yard = featureBySelector(result, 'group:Site/Yard');
  assert.equal(yard.attributes.use, 'utility');
  assert.equal(yard.attributes.capacity_mw, '120 & up');
  assert.equal(yard.attributes.altitudeMode, 'absolute');
});

/* ------------------------------------------------------------------ */
/* Reference-only content                                              */
/* ------------------------------------------------------------------ */

test('styles are reference-only metadata and never drop the placemark', async () => {
  const result = await parseFixture('sample.kml');
  const yard = featureBySelector(result, 'group:Site/Yard');
  assert.equal(yard.disposition, 'MAPPED');
  assert.equal(yard.attributes.styleUrl, '#siteStyle');

  const styles = result.features.filter((feature) => feature.attributes?.styleId);
  assert.ok(styles.length >= 2, 'Style and StyleMap each become a reference-only feature');
  assert.ok(styles.every((feature) => feature.disposition === 'REFERENCE_ONLY'));
  assert.ok(styles.every((feature) => feature.geojson === null));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.constraintId === 'import.feature.unsupported' && diagnostic.entityRef === 'siteStyle',
    ),
  );
});

test('NetworkLink and Region are reference-only features with a diagnostic', async () => {
  const result = await parseKml(
    wrap(
      '<Document>' +
        '<NetworkLink><name>Remote feed</name><Link><href>https://example.com/feed.kml</href></Link></NetworkLink>' +
        '<Placemark><name>Boxed</name><Point><coordinates>1,2</coordinates></Point>' +
        '<Region><LatLonAltBox><north>2</north><south>1</south></LatLonAltBox></Region></Placemark>' +
        '</Document>',
    ),
  );

  const netlink = result.features.find((feature) => feature.attributes.kind === 'NetworkLink');
  assert.equal(netlink.disposition, 'REFERENCE_ONLY');
  assert.equal(netlink.attributes.href, 'https://example.com/feed.kml');
  assert.equal(netlink.geojson, null);

  const region = result.features.find((feature) => feature.attributes.kind === 'Region');
  assert.equal(region.disposition, 'REFERENCE_ONLY');

  const placemark = featureBySelector(result, 'group:Boxed');
  assert.equal(placemark.disposition, 'MAPPED', 'a region must not drop its placemark');

  const unsupported = result.diagnostics.filter((d) => d.constraintId === 'import.feature.unsupported');
  assert.ok(unsupported.some((d) => d.message.includes('NetworkLink')));
  assert.ok(unsupported.some((d) => d.message.includes('Region')));
});

test('gx: track extensions and 3D models are reference-only features', async () => {
  const result = await parseKml(
    wrap(
      '<Document>' +
        '<Placemark><name>Track</name><gx:Track><when>2024-01-01T00:00:00Z</when>' +
        '<gx:coord>-122.4 37.7 10</gx:coord></gx:Track></Placemark>' +
        '<Placemark><name>Model</name><Model><Location><longitude>-122.4</longitude>' +
        '<latitude>37.7</latitude></Location></Model></Placemark>' +
        '</Document>',
    ),
  );

  const track = result.features.find((feature) => feature.attributes.kind === 'gx:Track');
  assert.equal(track.disposition, 'REFERENCE_ONLY');
  const model = result.features.find((feature) => feature.attributes.kind === 'Model');
  assert.equal(model.disposition, 'REFERENCE_ONLY');
  assert.ok(result.diagnostics.every((d) => isImportDiagnostic(d.constraintId)));
  assert.equal(result.counts.mapped, 0);
  assert.equal(result.counts.referenceOnly, 2);
});

/* ------------------------------------------------------------------ */
/* XML scanner                                                         */
/* ------------------------------------------------------------------ */

test('the scanner handles comments, self-closing tags, CDATA, and entities', async () => {
  const result = await parseKml(
    '<?xml version="1.0"?>\n' +
      '<!-- leading comment -->\n' +
      wrap(
        '<Document>' +
          '<Placemark>' +
          '<name>Alpha &amp; Beta &#65;</name>' +
          '<ExtendedData><Data name="a&amp;b"><value><![CDATA[c < d & e]]></value></Data></ExtendedData>' +
          '<!-- point below -->' +
          '<Point><coordinates>1.5,2.5</coordinates></Point>' +
          '</Placemark>' +
          '</Document>',
      ),
  );

  const placemark = featureBySelector(result, 'group:Alpha & Beta A');
  assert.equal(placemark.attributes['a&b'], 'c < d & e');
  assert.deepEqual(placemark.geojson.coordinates, [1.5, 2.5]);
});

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

test('folders deeper than the limit are flattened with a diagnostic', async () => {
  const nested = wrap(
    '<Document><Folder><name>A</name><Folder><name>B</name><Folder><name>C</name>' +
      '<Placemark><name>P</name><Point><coordinates>1,2</coordinates></Point></Placemark>' +
      '</Folder></Folder></Folder></Document>',
  );

  const flattened = await parseKml(nested, { kmlFolderDepth: 2 });
  assert.equal(featureBySelector(flattened, 'group:A/B/P').attributes.group, 'A/B');
  const diagnostic = flattened.diagnostics.find((d) => d.constraintId === 'import.conversion.incomplete');
  assert.ok(diagnostic);
  assert.ok(diagnostic.message.includes('A/B/C'));

  const unflattened = await parseKml(nested);
  assert.equal(featureBySelector(unflattened, 'group:A/B/C/P').attributes.group, 'A/B/C');
  assert.equal(unflattened.diagnostics.length, 0);
});

/* ------------------------------------------------------------------ */
/* KMZ                                                                 */
/* ------------------------------------------------------------------ */

test('a deflated KMZ parses to the same placemarks as its KML', async () => {
  const kml = await parseFixture('sample.kml');
  const kmz = await parseFixture('sample.kmz');
  assert.ok(kmz.counts.mapped > 0);
  assert.equal(kmz.counts.mapped, kml.counts.mapped);
  assert.equal(kmz.counts.extracted, kml.counts.extracted);
  assert.deepEqual(
    kmz.features.map((feature) => feature.sourceSelector),
    kml.features.map((feature) => feature.sourceSelector),
  );
  assert.deepEqual(featureBySelector(kmz, 'group:Site/Yard').geojson, featureBySelector(kml, 'group:Site/Yard').geojson);
});

test('KMZ rejects traversal, absolute paths, and symlink entries', async () => {
  const kml = await readFile(filePath('sample.kml'));

  await assert.rejects(
    parseArchive(makeZip([{ name: '../evil.kml', data: kml, method: 8 }])),
    /escapes the archive root/,
  );
  await assert.rejects(
    parseArchive(makeZip([{ name: '/doc.kml', data: kml, method: 8 }])),
    /absolute path/,
  );
  await assert.rejects(
    parseArchive(makeZip([{ name: 'doc.kml', data: kml, method: 8, externalAttributes: 0xa1ff0000 }])),
    /symbolic link/,
  );
});

test('KMZ enforces the entry-count and expansion-ratio limits', async () => {
  const kml = await readFile(filePath('sample.kml'));
  const threeEntries = makeZip([
    { name: 'doc.kml', data: kml, method: 8 },
    { name: 'files/a.txt', data: 'a', method: 0 },
    { name: 'files/b.txt', data: 'b', method: 0 },
  ]);
  await assert.rejects(parseArchive(threeEntries, { archiveEntries: 2 }), /entry limit/);

  const bomb = wrap(`<Document><description>${'A'.repeat(200000)}</description></Document>`);
  const compressed = makeZip([{ name: 'doc.kml', data: Buffer.from(bomb), method: 8 }]);
  await assert.rejects(parseArchive(compressed), /expansion ratio/);
  await assert.rejects(parseArchive(compressed, { archiveExpansionRatio: 2 }), /expansion ratio/);
});

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

test('every element ends in one disposition and the counts reconcile', async () => {
  const result = await parseFixture('sample.kml');
  const { counts } = result;
  assert.equal(counts.extracted, result.features.length);
  assert.equal(counts.mapped + counts.unmapped + counts.referenceOnly + counts.rejected, counts.extracted);
  assert.ok(counts.mapped > 0);
  assert.ok(counts.referenceOnly > 0);

  const ids = new Set();
  for (const feature of result.features) {
    assert.ok(FEATURE_DISPOSITIONS.includes(feature.disposition), feature.disposition);
    assert.ok(feature.sourceSelector.length > 0);
    assert.ok(!ids.has(feature.featureId), `duplicate featureId ${feature.featureId}`);
    ids.add(feature.featureId);
    for (const diagnostic of result.diagnostics) assert.ok(isImportDiagnostic(diagnostic.constraintId));
  }

  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'result must be JSON-serializable');
});

/* ------------------------------------------------------------------ */
/* Minimal ZIP writer used only to build negative fixtures             */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const crc = crc32(raw);
    const compressed = entry.method === 8 ? deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.method, 10);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }

  const directoryBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directoryBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directoryBuffer, eocd]);
}
