import { readFile } from 'node:fs/promises';
import { defineAdapter, emptyResult, reconcileCounts } from '../adapter-contract.js';
import { IMPORT_DIAGNOSTICS } from '../diagnostics.js';
import { capAttributes } from './shared.js';

/**
 * CSV and point tables.
 *
 * A flat file carries no CRS, so coordinate columns become a point in source
 * units and units stay unconfirmed until a reviewer confirms them
 * (doc/workspace/import-adapters.md, "CSV and Point Tables"). Rows whose
 * coordinate columns do not parse are reference-only, never dropped.
 */
const LON = /^(lon|long|longitude|lng|x)$/i;
const LAT = /^(lat|latitude|y)$/i;

export const descriptor = {
  adapter_id: 'csv',
  adapter_version: '1.0.0',
  media_types: ['text/csv', 'text/plain'],
  extensions: ['.csv', '.tsv'],
  extraction_capabilities: [
    { name: 'georeferencing', level: 'PARTIAL' },
    { name: 'attributes', level: 'FULL' },
  ],
  source_crs_declarations: ['LOCAL'],
  source_unit_declarations: ['m', 'ft', 'deg', 'unknown'],
  fidelity_level: 'PARTIAL',
  supported_range: { min_version: '1', max_version: '1', tested_versions: ['1'] },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./csv.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  conformance_fixtures: ['packages/imports/src/tests/fixtures/points.csv'],
  required_diagnostics: [
    IMPORT_DIAGNOSTICS.UNITS_UNCONFIRMED.constraintId,
    IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId,
    IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId,
  ],
};

export async function extract({ path, limits = {} }) {
  const text = await readFile(path, 'utf8');
  const diagnostics = [];
  const rows = parseDelimited(text);
  if (rows.length === 0) throw new Error('The file contains no header row.');

  const header = rows[0].map((name) => name.trim());
  const delimiter = detectDelimiter(text);
  const lonIndex = header.findIndex((name) => LON.test(name));
  const latIndex = header.findIndex((name) => LAT.test(name));
  const maxColumns = limits.maxAttributeColumns ?? 512;

  const features = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const featureId = `csv-${index}`;

    const raw = {};
    header.forEach((name, column) => {
      if (column === lonIndex || column === latIndex) return;
      raw[name] = cells[column] ?? null;
    });
    const { attributes } = capAttributes(raw, maxColumns, diagnostics);

    // An empty cell is a missing coordinate, not zero: `Number('')` is 0, which
    // would silently place a broken row at the origin.
    const rawLon = lonIndex === -1 ? '' : String(cells[lonIndex] ?? '').trim();
    const rawLat = latIndex === -1 ? '' : String(cells[latIndex] ?? '').trim();
    const lon = rawLon === '' ? null : Number(rawLon);
    const lat = rawLat === '' ? null : Number(rawLat);
    if (lon === null || lat === null || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      diagnostics.push({
        constraintId: IMPORT_DIAGNOSTICS.FEATURE_UNSUPPORTED.constraintId,
        message: 'The row has no parsable coordinate pair and is reference-only.',
        entityRef: featureId,
      });
      features.push({
        featureId,
        sourceSelector: 'feature:Row',
        disposition: 'REFERENCE_ONLY',
        geometryType: null,
        geojson: null,
        localGeometry: null,
        attributes,
      });
      continue;
    }

    features.push({
      featureId,
      sourceSelector: 'feature:Point',
      disposition: 'MAPPED',
      geometryType: 'POINT',
      geojson: null,
      localGeometry: { type: 'Point', coordinates: [lon, lat] },
      attributes,
      sourceSrid: null,
    });
  }

  const result = emptyResult({ sourceCrs: null, sourceUnits: null, confidence: 'LOW', evidence: [`delimiter "${delimiter}"`] });
  result.features = features;
  result.counts = reconcileCounts(features);
  result.diagnostics = diagnostics;
  // A flat file carries no CRS and no declared unit, so every coordinate is
  // provisional until a reviewer confirms them.
  result.diagnostics.push({
    constraintId: IMPORT_DIAGNOSTICS.UNITS_UNCONFIRMED.constraintId,
    message: 'The file declares no coordinate reference system or unit.',
  });
  return result;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  for (const candidate of [',', ';', '\t', '|']) {
    if (firstLine.includes(candidate)) return candidate;
  }
  return ',';
}

/** Handles quoted cells, escaped quotes, and CRLF; no streaming, files are small. */
function parseDelimited(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (char === '\r') continue;
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export default defineAdapter({ descriptor, extract });
