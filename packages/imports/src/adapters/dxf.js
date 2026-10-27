/**
 * DXF adapter.
 *
 * Parses ASCII DXF (doc/workspace/import-adapters.md, "CAD: DXF and DWG") into
 * the normalized import feature records defined by `adapter-contract.js`.
 *
 * DXF carries no CRS, so `geojson` is always null and every feature keeps its
 * source-unit coordinates in `localGeometry`; units come from the HEADER
 * `$INSUNITS` variable. Nothing is dropped silently: unsupported content ends in
 * `REFERENCE_ONLY` with `import.feature.unsupported`, a limit breach marks the
 * excess reference-only and adds `import.conversion.incomplete`, and an absent or
 * unmappable `$INSUNITS` raises `import.units.unconfirmed`.
 *
 * `limits.maxBytes` is intentionally not enforced here; the core pipeline owns
 * document-size rejection before extraction.
 */

import { readFile } from 'node:fs/promises';
import { defineAdapter, emptyResult, reconcileCounts } from '../adapter-contract.js';

const DEFAULT_MAX_FEATURES = 1_000_000;
const DEFAULT_MAX_VERTICES_PER_GEOMETRY = 100_000;
const DEFAULT_BLOCK_NESTING_DEPTH = 16;

/** Chord count used to approximate a full circle; arcs are scaled by sweep. */
const CIRCLE_SEGMENTS = 64;
const MIN_CURVE_SEGMENTS = 4;

/** DXF `$INSUNITS` codes the adapter can report (AutoCAD INSUNITS enumeration). */
const UNIT_BY_INSUNITS = Object.freeze({ 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 21: 'US_ft' });
const MEASUREMENT_BY_CODE = Object.freeze({ 0: 'IMPERIAL', 1: 'METRIC' });

const FEATURE_UNSUPPORTED = 'import.feature.unsupported';
const CONVERSION_INCOMPLETE = 'import.conversion.incomplete';
const UNITS_UNCONFIRMED = 'import.units.unconfirmed';

export const descriptor = {
  adapter_id: 'dxf',
  adapter_version: '1.0.0',
  media_types: ['image/vnd.dxf', 'application/dxf', 'application/octet-stream'],
  extensions: ['.dxf'],
  // Claimed levels are limited to what `extract` actually produces. Layer and
  // block metadata is retained before normalization, geometry is converted for a
  // documented entity subset, and curves are chord approximations.
  extraction_capabilities: [
    { name: 'layers', level: 'FULL' },
    { name: 'blocks', level: 'PARTIAL' },
    { name: 'block_attributes', level: 'PARTIAL' },
    { name: 'text', level: 'PARTIAL' },
    { name: 'dimensions', level: 'PARTIAL' },
    { name: 'hatches', level: 'PARTIAL' },
    { name: 'feature_groups', level: 'NONE' },
    { name: 'styles', level: 'PARTIAL' },
    { name: 'georeferencing', level: 'PARTIAL' },
    { name: 'attributes', level: 'FULL' },
    { name: 'spatial_structure', level: 'NONE' },
    { name: 'property_sets', level: 'NONE' },
    { name: 'quantities', level: 'NONE' },
  ],
  source_crs_declarations: ['LOCAL', 'EPSG'],
  source_unit_declarations: ['m', 'mm', 'cm', 'in', 'ft', 'US_ft'],
  fidelity_level: 'PARTIAL',
  supported_range: {
    min_version: 'R12',
    max_version: 'AC1032',
    tested_versions: ['AC1009', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'],
  },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./dxf.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  // Paths are relative to the repository root; one conformance fixture per tested
  // version, as required by the registry contract.
  conformance_fixtures: [
    'packages/imports/src/tests/fixtures/dxf-ac1009-r12.dxf',
    'packages/imports/src/tests/fixtures/dxf-ac1015-r2000.dxf',
    'packages/imports/src/tests/fixtures/dxf-ac1018-r2004.dxf',
    'packages/imports/src/tests/fixtures/dxf-ac1021-r2007.dxf',
    'packages/imports/src/tests/fixtures/dxf-ac1024-r2010.dxf',
    'packages/imports/src/tests/fixtures/dxf-ac1027-r2013.dxf',
    'packages/imports/src/tests/fixtures/dxf-ac1032-r2018.dxf',
  ],
  required_diagnostics: [UNITS_UNCONFIRMED, FEATURE_UNSUPPORTED, CONVERSION_INCOMPLETE],
};

export async function extract({ path, mediaType, limits = {} } = {}) {
  void mediaType; // resolved by the pipeline before the adapter is invoked
  const normalizedLimits = normalizeLimits(limits);
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');

  if (text.startsWith('AutoCAD Binary DXF')) {
    const result = emptyResult({ sourceCrs: null, sourceUnits: null, confidence: 'LOW', evidence: ['DXF binary sentinel'] });
    result.diagnostics.push(diagnostic(FEATURE_UNSUPPORTED, 'Binary DXF is not supported; export an ASCII DXF file.'));
    return result;
  }

  const records = toRecords(tokenize(text));
  const document = parseDocument(records);
  const { header, layers, blocks, entities } = document;

  const insunits = header.insunits;
  const sourceUnits = insunits !== null && insunits !== 0 ? (UNIT_BY_INSUNITS[insunits] ?? null) : null;
  const measurement = header.measurement !== null ? (MEASUREMENT_BY_CODE[header.measurement] ?? null) : null;

  const evidence = [];
  if (header.version) evidence.push(`HEADER.$ACADVER=${header.version}`);
  evidence.push(insunits === null ? 'HEADER.$INSUNITS missing' : `HEADER.$INSUNITS=${insunits}`);
  if (header.measurement !== null) evidence.push(`HEADER.$MEASUREMENT=${header.measurement}${measurement ? ` (${measurement})` : ''}`);
  if (header.lunits !== null) evidence.push(`HEADER.$LUNITS=${header.lunits}`);
  if (header.aunits !== null) evidence.push(`HEADER.$AUNITS=${header.aunits}`);

  const result = emptyResult({ sourceCrs: null, sourceUnits, confidence: 'LOW', evidence });

  if (sourceUnits === null) {
    const detail = insunits === null
      ? 'HEADER.$INSUNITS is missing'
      : insunits === 0
        ? 'HEADER.$INSUNITS is 0 (unitless)'
        : `HEADER.$INSUNITS=${insunits} is not a supported unit code`;
    result.diagnostics.push(diagnostic(UNITS_UNCONFIRMED, `Source units are unconfirmed: ${detail}.`));
  }

  const built = buildFeatures({ entities, blocks, limits: normalizedLimits });

  // Layer and block metadata are retained before geometric normalization.
  result.layers = layers;
  result.blocks = [...blocks.values()].map((block) => ({
    name: block.name,
    handle: block.handle,
    externalReference: block.isXref,
    entityCount: block.entities.length,
  }));
  result.features = built.features;
  result.diagnostics.push(...built.diagnostics);
  result.counts = reconcileCounts(built.features);
  return result;
}

export default defineAdapter({ descriptor, extract });

/* ------------------------------------------------------------------ limits */

function normalizeLimits(limits) {
  const source = limits && typeof limits === 'object' ? limits : {};
  return {
    maxFeatures: positiveInt(source.maxFeatures, DEFAULT_MAX_FEATURES),
    maxVerticesPerGeometry: positiveInt(source.maxVerticesPerGeometry, DEFAULT_MAX_VERTICES_PER_GEOMETRY),
    blockNestingDepth: positiveInt(source.blockNestingDepth, DEFAULT_BLOCK_NESTING_DEPTH),
  };
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/* ------------------------------------------------------------------ DXF I/O */

/**
 * A DXF file is a flat sequence of group-code/value line pairs. A missing or
 * malformed code line is skipped so padded files still tokenize; value lines are
 * taken verbatim, because a legitimately empty value is meaningful (for example
 * an empty `$INSUNITS` or text override).
 */
function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  let index = 0;
  while (index < lines.length) {
    const rawCode = lines[index];
    if (!/^[+-]?\d+$/.test(rawCode.trim())) {
      index += 1;
      continue;
    }
    if (index + 1 >= lines.length) break;
    pairs.push({ code: Number.parseInt(rawCode.trim(), 10), value: lines[index + 1] });
    index += 2;
  }
  return pairs;
}

/** Split a pair stream into `0`-delimited records. */
function toRecords(pairs) {
  const records = [];
  let current = null;
  for (const pair of pairs) {
    if (pair.code === 0) {
      current = { type: String(pair.value).trim().toUpperCase(), pairs: [] };
      records.push(current);
    } else if (current) {
      current.pairs.push(pair);
    }
  }
  return records;
}

function parseDocument(records) {
  const headerPairs = [];
  const layers = [];
  const blocks = new Map();
  const entities = [];
  let section = null;
  let currentBlock = null;

  for (const record of records) {
    if (record.type === 'SECTION') {
      section = String(firstValue(record, 2) ?? '').trim().toUpperCase() || null;
      if (section === 'HEADER') headerPairs.push(...record.pairs);
      currentBlock = null;
      continue;
    }
    if (record.type === 'ENDSEC') {
      section = null;
      currentBlock = null;
      continue;
    }
    if (section === 'HEADER') {
      headerPairs.push(...record.pairs);
      continue;
    }
    if (section === 'TABLES') {
      if (record.type === 'LAYER') layers.push(parseLayer(record));
      continue;
    }
    if (section === 'BLOCKS') {
      if (record.type === 'BLOCK') {
        const name = String(firstValue(record, 2) ?? '').trim();
        const flags = parseIntOrNull(firstValue(record, 70)) ?? 0;
        const xrefPath = firstValue(record, 1);
        currentBlock = {
          name,
          handle: firstValue(record, 5),
          isXref: (flags & 4) !== 0 || (xrefPath !== null && String(xrefPath).trim().length > 0),
          xrefPath: xrefPath === null ? null : String(xrefPath).trim(),
          entities: [],
        };
        blocks.set(name.toUpperCase(), currentBlock);
      } else if (record.type === 'ENDBLK') {
        currentBlock = null;
      } else if (currentBlock) {
        currentBlock.entities.push(record);
      }
      continue;
    }
    if (section === 'ENTITIES') entities.push(record);
  }

  return { header: parseHeader(headerPairs), layers, blocks, entities };
}

function parseHeader(pairs) {
  const version = readHeaderVariable(pairs, '$ACADVER');
  return {
    version: version === null ? null : String(version).trim(),
    insunits: parseIntOrNull(readHeaderVariable(pairs, '$INSUNITS')),
    measurement: parseIntOrNull(readHeaderVariable(pairs, '$MEASUREMENT')),
    lunits: parseIntOrNull(readHeaderVariable(pairs, '$LUNITS')),
    aunits: parseIntOrNull(readHeaderVariable(pairs, '$AUNITS')),
  };
}

function readHeaderVariable(pairs, name) {
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index].code === 9 && String(pairs[index].value).trim() === name) {
      return pairs[index + 1] ? pairs[index + 1].value : null;
    }
  }
  return null;
}

function parseLayer(record) {
  const flags = parseIntOrNull(firstValue(record, 70)) ?? 0;
  return {
    name: String(firstValue(record, 2) ?? '').trim(),
    colour: parseIntOrNull(firstValue(record, 62)),
    linetype: firstValue(record, 6) === null ? null : String(firstValue(record, 6)).trim(),
    frozen: (flags & 1) !== 0,
    locked: (flags & 4) !== 0,
  };
}

/* ------------------------------------------------------- entity extraction */

function buildFeatures({ entities, blocks, limits }) {
  const maxFeatures = limits.maxFeatures;
  const maxVertices = limits.maxVerticesPerGeometry;
  const maxDepth = limits.blockNestingDepth;

  const features = [];
  const diagnostics = [];
  const noted = new Set();
  let anonymous = 0;
  const nextAnonymous = () => {
    anonymous += 1;
    return anonymous;
  };

  /** Aggregate limit diagnostics exactly once, so a big file does not spam them. */
  function note(constraintId, message) {
    const key = `${constraintId}\u0000${message}`;
    if (noted.has(key)) return;
    noted.add(key);
    diagnostics.push(diagnostic(constraintId, message));
  }

  function finalize(candidate) {
    const attributes = { ...(candidate.attributes ?? {}) };
    let disposition = candidate.disposition ?? 'MAPPED';
    let reason = candidate.reason ?? null;
    let localGeometry = candidate.localGeometry ?? null;
    const geometryType = candidate.geometryType ?? null;

    if (disposition === 'MAPPED' && features.length >= maxFeatures) {
      disposition = 'REFERENCE_ONLY';
      reason = `Feature limit ${maxFeatures} reached; the feature is reference-only.`;
      attributes.referenceOnlyReason = 'FEATURE_LIMIT';
      attributes.maxFeatures = maxFeatures;
      note(CONVERSION_INCOMPLETE, reason);
    }
    if (disposition === 'MAPPED' && (candidate.vertexCount ?? 0) > maxVertices) {
      disposition = 'REFERENCE_ONLY';
      reason = `Geometry exceeds the vertex limit of ${maxVertices}; it is reference-only and truncated.`;
      attributes.referenceOnlyReason = 'VERTEX_LIMIT';
      attributes.vertexCount = candidate.vertexCount;
      attributes.vertexLimit = maxVertices;
      attributes.truncated = true;
      localGeometry = truncateGeometry(localGeometry, maxVertices);
      note(CONVERSION_INCOMPLETE, reason);
    }

    const identity = featureIdentity(candidate.record, candidate.context, nextAnonymous);
    const feature = {
      featureId: `dxf:${identity}`,
      sourceSelector: identity,
      disposition,
      geometryType,
      geojson: null,
      localGeometry,
      attributes,
    };
    if (disposition !== 'MAPPED') {
      diagnostics.push(diagnostic(FEATURE_UNSUPPORTED, reason ?? 'Source content is reference-only.', feature.featureId));
    }
    features.push(feature);
    return feature;
  }

  function processEntityList(list, context) {
    let index = 0;
    while (index < list.length) {
      const record = list[index];

      if (record.type === 'POLYLINE') {
        const vertices = [];
        let cursor = index + 1;
        while (cursor < list.length && list[cursor].type === 'VERTEX') {
          vertices.push(pointFromRecord(list[cursor]));
          cursor += 1;
        }
        if (cursor < list.length && list[cursor].type === 'SEQEND') cursor += 1;
        index = cursor;
        emitPolyline(record, vertices, context);
        continue;
      }

      if (record.type === 'INSERT') {
        const blockAttributes = {};
        let cursor = index + 1;
        while (cursor < list.length && list[cursor].type === 'ATTRIB') {
          const tag = firstValue(list[cursor], 2);
          if (tag !== null) blockAttributes[String(tag).trim()] = String(firstValue(list[cursor], 1) ?? '');
          cursor += 1;
        }
        if (cursor < list.length && list[cursor].type === 'SEQEND') cursor += 1;
        index = cursor;
        handleInsert(record, blockAttributes, context);
        continue;
      }

      handleEntity(record, context);
      index += 1;
    }
  }

  function handleEntity(record, context) {
    switch (record.type) {
      case 'LWPOLYLINE':
        emitPolyline(record, lwpolylineVertices(record), context);
        return;
      case 'LINE':
        emitLine(record, context);
        return;
      case 'CIRCLE':
        emitCurve(record, context, 'CIRCLE');
        return;
      case 'ARC':
        emitCurve(record, context, 'ARC');
        return;
      case 'ELLIPSE':
        emitEllipse(record, context);
        return;
      case 'POINT':
        emitPoint(record, context);
        return;
      case 'TEXT':
      case 'MTEXT':
        emitText(record, context, record.type);
        return;
      case 'DIMENSION':
        emitDimension(record, context);
        return;
      case 'HATCH':
        emitHatch(record, context);
        return;
      case 'POLYLINE':
      case 'INSERT':
      case 'VERTEX':
      case 'SEQEND':
      case 'ATTRIB':
        return; // composites are consumed by their owner
      default:
        emitUnsupported(record, context);
    }
  }

  function handleInsert(record, blockAttributes, context) {
    const rawName = firstValue(record, 2);
    const name = rawName === null ? null : String(rawName).trim();
    const definition = name ? blocks.get(name.toUpperCase()) : undefined;

    const insertKey = firstValue(record, 5) ?? `anon:${nextAnonymous()}`;
    const instanceKey = context.instanceKey ? `${context.instanceKey}/${insertKey}` : insertKey;
    const instanceLayer = pickLayer(firstValue(record, 8), null, context.inheritedLayer ?? null);

    const attributes = attributesFor(record, context);
    attributes.block = name;
    attributes.blockPath = [...(context.blockPath ?? []), name ?? ''].filter(Boolean).join('/');
    attributes.insertionPoint = pointFromRecord(record);
    attributes.insertionTransform = insertTransform(record);
    if (Object.keys(blockAttributes).length > 0) attributes.blockAttributes = blockAttributes;

    if (!name || !definition) {
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: `Block "${name ?? ''}" is not defined in the BLOCKS section; the insertion is reference-only.`,
      });
    }

    if (definition.isXref) {
      attributes.externalReference = true;
      if (definition.xrefPath) attributes.xrefPath = definition.xrefPath;
      note(CONVERSION_INCOMPLETE, `External reference "${name}" was not followed; a resolved reference is a separate project asset.`);
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: `External reference "${name}" is not followed.`,
      });
    }

    const depth = (context.depth ?? 0) + 1;
    if (depth > maxDepth) {
      attributes.nestingDepth = depth;
      attributes.blockNestingDepthLimit = maxDepth;
      note(CONVERSION_INCOMPLETE, `Block nesting depth ${maxDepth} exceeded; deeper content is reference-only.`);
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: `Block "${name}" exceeds the block nesting depth limit of ${maxDepth}.`,
      });
    }

    if (definition.entities.length === 0) {
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: `Block "${name}" has no extractable entities.`,
      });
    }

    processEntityList(definition.entities, {
      blockName: name,
      blockPath: [...(context.blockPath ?? []), name],
      instanceKey,
      depth,
      insertRecord: record,
      blockAttributes,
      inheritedLayer: instanceLayer,
    });
    return undefined;
  }

  function emitLine(record, context) {
    const attributes = attributesFor(record, context);
    const elevation = numberValue(record, 30);
    if (elevation !== null) attributes.elevation = elevation;
    finalize({
      record,
      context,
      attributes,
      geometryType: 'LINESTRING',
      localGeometry: {
        type: 'LINESTRING',
        coordinates: [
          [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0],
          [numberValue(record, 11) ?? 0, numberValue(record, 21) ?? 0],
        ],
      },
      vertexCount: 2,
    });
  }

  function emitPolyline(record, vertices, context) {
    const attributes = attributesFor(record, context);
    const flags = parseIntOrNull(firstValue(record, 70)) ?? 0;
    const closed = (flags & 1) !== 0;
    attributes.vertexCount = vertices.length;
    attributes.closed = closed;
    const elevation = numberValue(record, 30);
    if (elevation !== null) attributes.elevation = elevation;

    if (vertices.length < 2) {
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: 'Polyline has fewer than two vertices and cannot become a line.',
      });
    }
    if (closed && vertices.length >= 3) {
      return finalize({
        record,
        context,
        attributes,
        geometryType: 'POLYGON',
        localGeometry: polygonFromVertices(vertices),
        vertexCount: vertices.length,
      });
    }
    return finalize({
      record,
      context,
      attributes,
      geometryType: 'LINESTRING',
      localGeometry: lineStringFromVertices(vertices),
      vertexCount: vertices.length,
    });
  }

  function emitCurve(record, context, kind) {
    const attributes = attributesFor(record, context);
    const centre = [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0];
    const radius = numberValue(record, 40);
    if (radius === null || radius <= 0) {
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: `${kind} has no usable radius.`,
      });
    }

    attributes.sourceRadius = radius;
    let coordinates;
    let segments;
    if (kind === 'CIRCLE') {
      segments = CIRCLE_SEGMENTS;
      coordinates = circleCoordinates(centre, radius, segments);
      attributes.closed = true;
    } else {
      const start = numberValue(record, 50) ?? 0;
      const end = numberValue(record, 51) ?? 0;
      const sweep = normalizeSweep(start, end);
      segments = Math.max(MIN_CURVE_SEGMENTS, Math.ceil((CIRCLE_SEGMENTS * sweep) / 360));
      coordinates = arcCoordinates(centre, radius, start, sweep, segments);
      attributes.startAngleDegrees = start;
      attributes.endAngleDegrees = end;
      attributes.sweepDegrees = sweep;
      attributes.closed = false;
    }
    attributes.approximation = { method: 'CHORD', segments, tolerance: sagitta(radius, segments) };
    return finalize({
      record,
      context,
      attributes,
      geometryType: 'LINESTRING',
      localGeometry: { type: 'LINESTRING', coordinates },
      vertexCount: coordinates.length,
    });
  }

  function emitEllipse(record, context) {
    const attributes = attributesFor(record, context);
    const centre = [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0];
    const majorX = numberValue(record, 11);
    const majorY = numberValue(record, 21);
    const ratio = numberValue(record, 40) ?? 1;
    if (majorX === null || majorY === null) {
      return finalize({
        record,
        context,
        disposition: 'REFERENCE_ONLY',
        attributes,
        reason: 'ELLIPSE major axis endpoint is missing.',
      });
    }

    const start = numberValue(record, 41) ?? 0;
    const rawEnd = numberValue(record, 42);
    const end = rawEnd === null ? start + 2 * Math.PI : rawEnd;
    let sweep = end - start;
    const full = Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-9;
    while (sweep <= 0) sweep += 2 * Math.PI;
    const segments = Math.max(MIN_CURVE_SEGMENTS, Math.ceil((CIRCLE_SEGMENTS * sweep) / (2 * Math.PI)));
    const coordinates = [];
    for (let index = 0; index <= segments; index += 1) {
      const angle = start + (sweep * index) / segments;
      coordinates.push([
        round(centre[0] + majorX * Math.cos(angle) - majorY * ratio * Math.sin(angle)),
        round(centre[1] + majorY * Math.cos(angle) + majorX * ratio * Math.sin(angle)),
      ]);
    }
    attributes.majorAxis = [majorX, majorY];
    attributes.axisRatio = ratio;
    attributes.closed = full;
    attributes.approximation = { method: 'CHORD', segments };
    return finalize({
      record,
      context,
      attributes,
      geometryType: 'LINESTRING',
      localGeometry: { type: 'LINESTRING', coordinates },
      vertexCount: coordinates.length,
    });
  }

  function emitPoint(record, context) {
    const attributes = attributesFor(record, context);
    const elevation = numberValue(record, 30);
    if (elevation !== null) attributes.elevation = elevation;
    finalize({
      record,
      context,
      attributes,
      geometryType: 'POINT',
      localGeometry: { type: 'POINT', coordinates: [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0] },
      vertexCount: 1,
    });
  }

  function emitText(record, context, kind) {
    const attributes = attributesFor(record, context);
    attributes.entityType = kind;
    attributes.text = textValue(record);
    const height = numberValue(record, 40);
    if (height !== null) attributes.height = height;
    const rotation = numberValue(record, 50);
    if (rotation !== null) attributes.rotationDegrees = rotation;
    const style = firstValue(record, 7);
    if (style !== null) attributes.styleName = String(style).trim();
    finalize({
      record,
      context,
      disposition: 'REFERENCE_ONLY',
      attributes,
      geometryType: 'POINT',
      localGeometry: { type: 'POINT', coordinates: [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0] },
      vertexCount: 1,
      reason: `${kind} is reference-only text; it is never an authoritative attribute until mapped.`,
    });
  }

  function emitDimension(record, context) {
    const attributes = attributesFor(record, context);
    attributes.entityType = 'DIMENSION';
    const measurement = numberValue(record, 42);
    if (measurement !== null) attributes.measurement = measurement;
    const text = firstValue(record, 1);
    if (text !== null && String(text).trim().length > 0) attributes.text = String(text).trim();
    const dimensionType = parseIntOrNull(firstValue(record, 70));
    if (dimensionType !== null) attributes.dimensionType = dimensionType;
    const style = firstValue(record, 3);
    if (style !== null) attributes.styleName = String(style).trim();
    const blockName = firstValue(record, 2);
    if (blockName !== null) attributes.blockName = String(blockName).trim();
    finalize({
      record,
      context,
      disposition: 'REFERENCE_ONLY',
      attributes,
      geometryType: 'POINT',
      localGeometry: { type: 'POINT', coordinates: [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0] },
      vertexCount: 1,
      reason: 'DIMENSION is reference-only; its measured value is retained but never authoritative.',
    });
  }

  function emitHatch(record, context) {
    const attributes = attributesFor(record, context);
    attributes.entityType = 'HATCH';
    const pattern = firstValue(record, 2);
    if (pattern !== null) attributes.patternName = String(pattern).trim();
    attributes.solidFill = (parseIntOrNull(firstValue(record, 70)) ?? 0) === 1;
    const paths = parseIntOrNull(firstValue(record, 91));
    if (paths !== null) attributes.boundaryPathCount = paths;
    const patternType = parseIntOrNull(firstValue(record, 76));
    if (patternType !== null) attributes.patternType = patternType;
    finalize({
      record,
      context,
      disposition: 'REFERENCE_ONLY',
      attributes,
      reason: 'HATCH pattern metadata is reference-only; a boundary seeds a constraint area only through an explicit REVIEWED mapping.',
    });
  }

  function emitUnsupported(record, context) {
    const attributes = attributesFor(record, context);
    attributes.entityType = record.type;
    for (const [key, code] of [['flags', 70], ['degree', 71], ['controlPointCount', 73], ['knotCount', 74]]) {
      const value = parseIntOrNull(firstValue(record, code));
      if (value !== null) attributes[key] = value;
    }
    const proxy = record.type.includes('PROXY');
    finalize({
      record,
      context,
      disposition: 'REFERENCE_ONLY',
      attributes,
      reason: proxy
        ? `Proxy or custom object "${record.type}" is reference-only.`
        : `Entity "${record.type}" is not converted; it is reference-only.`,
    });
  }

  function attributesFor(record, context) {
    const attributes = {
      layer: pickLayer(firstValue(record, 8), context.insertRecord ? firstValue(context.insertRecord, 8) : null, context.inheritedLayer ?? null),
      handle: firstValue(record, 5) ?? null,
    };
    const linetype = firstValue(record, 6);
    if (linetype !== null) attributes.linetype = String(linetype).trim();
    const colour = parseIntOrNull(firstValue(record, 62));
    if (colour !== null) attributes.colour = colour;

    if (context.blockName) {
      attributes.block = context.blockName;
      attributes.blockPath = (context.blockPath ?? []).join('/');
      if (context.insertRecord) {
        attributes.blockHandle = firstValue(context.insertRecord, 5) ?? null;
        attributes.insertionPoint = pointFromRecord(context.insertRecord);
      }
      if (context.blockAttributes && Object.keys(context.blockAttributes).length > 0) {
        attributes.blockAttributes = { ...context.blockAttributes };
      }
    }
    return attributes;
  }

  processEntityList(entities, {
    blockName: null,
    blockPath: [],
    instanceKey: null,
    depth: 0,
    insertRecord: null,
    blockAttributes: null,
    inheritedLayer: null,
  });

  return { features, diagnostics };
}

/* ---------------------------------------------------------------- geometry */

function lwpolylineVertices(record) {
  const vertices = [];
  let pendingX = null;
  for (const pair of record.pairs) {
    if (pair.code === 10) {
      if (pendingX !== null) vertices.push([pendingX, 0]);
      pendingX = parseNumber(pair.value) ?? 0;
    } else if (pair.code === 20) {
      vertices.push([pendingX ?? 0, parseNumber(pair.value) ?? 0]);
      pendingX = null;
    }
  }
  if (pendingX !== null) vertices.push([pendingX, 0]);
  return vertices;
}

function pointFromRecord(record) {
  return [numberValue(record, 10) ?? 0, numberValue(record, 20) ?? 0, numberValue(record, 30) ?? 0];
}

function polygonFromVertices(vertices) {
  const ring = vertices.map(([x, y]) => [x, y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return { type: 'POLYGON', coordinates: [ring] };
}

function lineStringFromVertices(vertices) {
  return { type: 'LINESTRING', coordinates: vertices.map(([x, y]) => [x, y]) };
}

function circleCoordinates(centre, radius, segments) {
  const coordinates = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = (2 * Math.PI * index) / segments;
    coordinates.push([round(centre[0] + radius * Math.cos(angle)), round(centre[1] + radius * Math.sin(angle))]);
  }
  return coordinates;
}

function arcCoordinates(centre, radius, startDegrees, sweepDegrees, segments) {
  const coordinates = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = ((startDegrees + (sweepDegrees * index) / segments) * Math.PI) / 180;
    coordinates.push([round(centre[0] + radius * Math.cos(angle)), round(centre[1] + radius * Math.sin(angle))]);
  }
  return coordinates;
}

/** Normalize a DXF arc sweep into (0, 360]; equal angles mean a full circle. */
function normalizeSweep(startDegrees, endDegrees) {
  let sweep = endDegrees - startDegrees;
  while (sweep <= 0) sweep += 360;
  while (sweep > 360) sweep -= 360;
  return sweep;
}

/** Chord-sagitta error for a circle of `radius` approximated by `segments` chords. */
function sagitta(radius, segments) {
  return round(radius * (1 - Math.cos(Math.PI / segments)));
}

function truncateGeometry(geometry, limit) {
  if (!geometry) return null;
  if (geometry.type === 'LINESTRING') {
    return { type: 'LINESTRING', coordinates: geometry.coordinates.slice(0, Math.max(2, limit)) };
  }
  if (geometry.type === 'POLYGON') {
    const positions = (geometry.coordinates[0] ?? []).slice(0, Math.max(3, limit));
    if (positions.length > 0) {
      const first = positions[0];
      const last = positions[positions.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) positions.push([first[0], first[1]]);
    }
    return { type: 'POLYGON', coordinates: [positions] };
  }
  return geometry;
}

function insertTransform(record) {
  const scale = [numberValue(record, 41), numberValue(record, 42), numberValue(record, 43)].map((value) => value ?? 1);
  return {
    scale,
    rotationDegrees: numberValue(record, 50) ?? 0,
  };
}

function round(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  // Normalize negative zero so a JSON round-trip is value-identical.
  return rounded === 0 ? 0 : rounded;
}

/* --------------------------------------------------------------- primitives */

function firstValue(record, code) {
  const pair = record.pairs.find((entry) => entry.code === code);
  return pair === undefined ? null : pair.value;
}

function numberValue(record, code) {
  return parseNumber(firstValue(record, code));
}

function parseIntOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number.parseFloat(String(raw).trim());
  return Number.isFinite(value) ? value : null;
}

function textValue(record) {
  return record.pairs
    .filter((entry) => entry.code === 3 || entry.code === 1)
    .map((entry) => String(entry.value))
    .join('');
}

/** DXF layer inheritance: entity layer, else insertion layer, else enclosing block layer. */
function pickLayer(innerLayer, insertLayer, inheritedLayer) {
  const inner = innerLayer === null || innerLayer === undefined ? null : String(innerLayer).trim();
  if (inner && inner !== '0') return inner;
  const insert = insertLayer === null || insertLayer === undefined ? null : String(insertLayer).trim();
  if (insert && insert !== '0') return insert;
  if (inheritedLayer) return inheritedLayer;
  return inner || insert || '0';
}

function featureIdentity(record, context, nextAnonymous) {
  const handle = firstValue(record, 5);
  const instance = context && context.instanceKey ? `${context.instanceKey}:` : '';
  const local = handle ? `entity:${handle}` : `entity:anon:${nextAnonymous()}`;
  return `${instance}${local}`;
}

function diagnostic(constraintId, message, entityRef) {
  const entry = { constraintId, message };
  if (entityRef !== undefined) entry.entityRef = entityRef;
  return entry;
}
