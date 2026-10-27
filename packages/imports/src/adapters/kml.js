/**
 * KML and KMZ adapter.
 *
 * Parses OGC KML 2.2/2.3 with a hand-written XML scanner (no external parser)
 * and a minimal, self-contained ZIP reader built on `node:zlib`. Geometry is
 * WGS 84 (EPSG:4326); altitude is metres. Styles and StyleMaps, network links,
 * regions, `gx:` track and tour extensions, and 3D models are reference-only
 * metadata, never authoritative geometry.
 *
 * Contract: doc/workspace/import-adapters.md, "KML and KMZ", "Adapter Limits",
 * and "Shared Adapter Diagnostics"; `../adapter-contract.js` for the shape.
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { defineAdapter, emptyResult, reconcileCounts } from '../adapter-contract.js';

const KML_MEDIA_TYPE = 'application/vnd.google-earth.kml+xml';
const KMZ_MEDIA_TYPE = 'application/vnd.google-earth.kmz';

const DEFAULT_FOLDER_DEPTH = 32;
const HARD_FOLDER_DEPTH = 64;
const DEFAULT_ARCHIVE_ENTRIES = 10000;
const HARD_ARCHIVE_ENTRIES = 50000;
const DEFAULT_EXPANSION_RATIO = 10;
const HARD_EXPANSION_RATIO = 100;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const SYMLINK_FILE_TYPE = 0xa000;

const GEOREFERENCE_EVIDENCE = 'OGC KML geometry is WGS 84 (EPSG:4326); altitude is metres.';

const GEOMETRY_NAMES = new Set(['Point', 'LineString', 'Polygon']);
const REFERENCE_ONLY_NAMES = new Set(['Model', 'NetworkLink', 'Region', 'Track', 'MultiTrack', 'Tour']);

export const descriptor = {
  adapter_id: 'kml',
  adapter_version: '1.0.0',
  media_types: [KML_MEDIA_TYPE, KMZ_MEDIA_TYPE, 'application/xml', 'text/xml'],
  extensions: ['.kml', '.kmz'],
  extraction_capabilities: [
    { name: 'layers', level: 'PARTIAL' },
    { name: 'feature_groups', level: 'FULL' },
    { name: 'styles', level: 'PARTIAL' },
    { name: 'georeferencing', level: 'FULL' },
    { name: 'attributes', level: 'FULL' },
    { name: 'spatial_structure', level: 'PARTIAL' },
  ],
  source_crs_declarations: ['EPSG:4326'],
  source_unit_declarations: ['deg', 'm'],
  fidelity_level: 'PARTIAL',
  supported_range: { min_version: '2.2', max_version: '2.3', tested_versions: ['2.2', '2.3'] },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./kml.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  conformance_fixtures: [
    'packages/imports/src/tests/fixtures/sample.kml',
    'packages/imports/src/tests/fixtures/sample.kmz',
  ],
  required_diagnostics: ['import.feature.unsupported', 'import.conversion.incomplete'],
};

export async function extract({ path, mediaType, limits } = {}) {
  const buffer = await readFile(path);
  const xml = stripByteOrderMark(
    (isKmzSource(path, mediaType, buffer)
      ? readKmzEntry(buffer, limits)
      : buffer
    ).toString('utf8'),
  );

  const document = parseXml(xml);
  const root = firstElementChild(document);
  if (!root) throw new Error('KML document has no root element.');

  const state = {
    features: [],
    diagnostics: [],
    diagnosticKeys: new Set(),
    featureSeq: 0,
    maxFolderDepth: clampLimit(limits?.kmlFolderDepth, DEFAULT_FOLDER_DEPTH, HARD_FOLDER_DEPTH),
    flattenedFolders: new Set(),
  };

  walkElement(root, { path: [], depth: 0 }, state);

  const result = emptyResult({
    sourceCrs: 'EPSG:4326',
    sourceUnits: 'deg',
    confidence: 'HIGH',
    evidence: [GEOREFERENCE_EVIDENCE],
  });
  result.features = state.features;
  result.diagnostics = state.diagnostics;
  result.counts = reconcileCounts(state.features);
  return result;
}

export default defineAdapter({ descriptor, extract });

/* ------------------------------------------------------------------ */
/* Document walk                                                       */
/* ------------------------------------------------------------------ */

function walkElement(node, context, state) {
  for (const child of elementChildren(node)) {
    switch (child.localName) {
      case 'Placemark':
        emitPlacemark(child, context, state);
        break;
      case 'Folder':
        walkFolder(child, context, state);
        break;
      case 'NetworkLink':
        emitReferenceOnly(child, context, state, 'NetworkLink');
        break;
      case 'Region':
        emitReferenceOnly(child, context, state, 'Region');
        break;
      case 'Track':
      case 'MultiTrack':
      case 'Tour':
        emitReferenceOnly(child, context, state, `gx:${child.localName}`);
        break;
      case 'Model':
        emitReferenceOnly(child, context, state, 'Model');
        break;
      case 'Style':
      case 'StyleMap':
        emitStyle(child, context, state);
        break;
      default:
        walkElement(child, context, state);
        break;
    }
  }
}

function walkFolder(node, context, state) {
  const name = textOf(firstChild(node, 'name')).trim() || 'Folder';
  const depth = context.depth + 1;
  if (depth > state.maxFolderDepth) {
    const key = context.path.concat(name).join('/');
    if (!state.flattenedFolders.has(key)) {
      state.flattenedFolders.add(key);
      pushDiagnostic(
        state,
        'import.conversion.incomplete',
        `KML folder "${key}" exceeds the ${state.maxFolderDepth} level folder depth limit and was flattened.`,
        key,
      );
    }
    walkElement(node, context, state);
    return;
  }
  walkElement(node, { path: context.path.concat(name), depth }, state);
}

function emitPlacemark(node, context, state) {
  const name = textOf(firstChild(node, 'name')).trim() || 'Placemark';
  const group = context.path.join('/');
  const selector = selectorFor(context.path, name);
  const attributes = { group, ...extendedDataAttributes(node) };

  const styleUrl = textOf(firstChild(node, 'styleUrl')).trim();
  if (styleUrl) attributes.styleUrl = styleUrl;
  const placemarkAltitudeMode = textOf(firstChild(node, 'altitudeMode')).trim();
  if (placemarkAltitudeMode) attributes.altitudeMode = placemarkAltitudeMode;

  for (const child of elementChildren(node)) {
    if (child.localName !== 'Style' && child.localName !== 'StyleMap') continue;
    const styleId = attr(child, 'id');
    if (styleId && !attributes.styleId) attributes.styleId = styleId;
    emitStyle(child, context, state);
  }
  if (styleUrl) {
    pushDiagnostic(
      state,
      'import.feature.unsupported',
      `KML style reference "${styleUrl}" is reference-only metadata and was not applied.`,
      styleUrl,
    );
  }

  let emitted = 0;
  for (const child of elementChildren(node)) {
    if (child.localName === 'MultiGeometry') {
      const geometries = elementChildren(child).filter((entry) => GEOMETRY_NAMES.has(entry.localName));
      geometries.forEach((geometryNode, index) => {
        const built = buildGeometry(geometryNode);
        if (!built) return;
        const geometryAttributes = { ...attributes, ...altitudeModeAttribute(geometryNode), geometryIndex: index };
        state.features.push(
          makeFeature(state, {
            sourceSelector: `${selector}#${index}`,
            disposition: 'MAPPED',
            geometryType: built.geometryType,
            geojson: built.geojson,
            attributes: geometryAttributes,
            elevationM: built.elevationM,
          }),
        );
        emitted += 1;
      });
    } else if (GEOMETRY_NAMES.has(child.localName)) {
      const built = buildGeometry(child);
      if (!built) continue;
      state.features.push(
        makeFeature(state, {
          sourceSelector: selector,
          disposition: 'MAPPED',
          geometryType: built.geometryType,
          geojson: built.geojson,
          attributes: { ...attributes, ...altitudeModeAttribute(child) },
          elevationM: built.elevationM,
        }),
      );
      emitted += 1;
    } else if (REFERENCE_ONLY_NAMES.has(child.localName)) {
      const kind = child.localName === 'Track' || child.localName === 'MultiTrack' || child.localName === 'Tour'
        ? `gx:${child.localName}`
        : child.localName;
      emitReferenceOnly(child, context, state, kind);
      emitted += 1;
    }
  }

  if (emitted > 0) return;

  // Never drop a placemark: an unsupported or empty placemark stays visible and
  // ends in exactly one disposition.
  state.features.push(
    makeFeature(state, {
      sourceSelector: selector,
      disposition: 'UNMAPPED',
      geometryType: null,
      geojson: null,
      attributes,
    }),
  );
  const hasGeometryElement = elementChildren(node).some(
    (child) => GEOMETRY_NAMES.has(child.localName) || child.localName === 'MultiGeometry',
  );
  if (hasGeometryElement) {
    pushDiagnostic(
      state,
      'import.feature.unsupported',
      `Placemark "${name}" has no supported KML geometry.`,
      name,
    );
  }
}

function emitReferenceOnly(node, context, state, kind) {
  const name = textOf(firstChild(node, 'name')).trim() || kind;
  const attributes = { group: context.path.join('/'), kind };
  const link = firstChild(node, 'Link');
  const href = link ? textOf(firstChild(link, 'href')).trim() : '';
  if (href) attributes.href = href;

  state.features.push(
    makeFeature(state, {
      sourceSelector: selectorFor(context.path, name),
      disposition: 'REFERENCE_ONLY',
      geometryType: null,
      geojson: null,
      attributes,
    }),
  );
  pushDiagnostic(
    state,
    'import.feature.unsupported',
    `${kind} content is reference-only in KML.`,
    href || name,
  );
}

function emitStyle(node, context, state) {
  const styleId = attr(node, 'id') || `${node.localName}@${context.path.join('/') || 'document'}`;
  state.features.push(
    makeFeature(state, {
      sourceSelector: `style:${styleId}`,
      disposition: 'REFERENCE_ONLY',
      geometryType: null,
      geojson: null,
      attributes: { group: context.path.join('/'), kind: node.localName, styleId },
    }),
  );
  pushDiagnostic(
    state,
    'import.feature.unsupported',
    `KML ${node.localName} "${styleId}" is reference-only metadata and was not applied.`,
    styleId,
  );
}

function makeFeature(state, { sourceSelector, disposition, geometryType, geojson, attributes, elevationM }) {
  state.featureSeq += 1;
  const feature = {
    featureId: `kml:${state.featureSeq}`,
    sourceSelector,
    disposition,
    geometryType,
    geojson,
    localGeometry: null,
    attributes,
  };
  if (geojson) feature.sourceSrid = 4326;
  if (typeof elevationM === 'number' && Number.isFinite(elevationM)) feature.elevationM = elevationM;
  return feature;
}

function pushDiagnostic(state, constraintId, message, entityRef) {
  const key = `${constraintId}|${entityRef ?? ''}|${message}`;
  if (state.diagnosticKeys.has(key)) return;
  state.diagnosticKeys.add(key);
  const diagnostic = { constraintId, message };
  if (entityRef !== undefined && entityRef !== null && entityRef !== '') {
    diagnostic.entityRef = String(entityRef);
  }
  state.diagnostics.push(diagnostic);
}

function selectorFor(path, name) {
  return path.length > 0 ? `group:${path.join('/')}/${name}` : `group:${name}`;
}

/** `altitudeMode` is a geometry property in KML; carry it onto the feature. */
function altitudeModeAttribute(geometryNode) {
  const altitudeMode = textOf(firstChild(geometryNode, 'altitudeMode')).trim();
  return altitudeMode ? { altitudeMode } : {};
}

function extendedDataAttributes(placemark) {
  const attributes = {};
  for (const extendedData of childrenOf(placemark, 'ExtendedData')) {
    for (const data of childrenOf(extendedData, 'Data')) {
      const name = attr(data, 'name');
      if (!name) continue;
      attributes[name] = textOf(firstChild(data, 'value')).trim();
    }
    for (const schemaData of childrenOf(extendedData, 'SchemaData')) {
      for (const simpleData of childrenOf(schemaData, 'SimpleData')) {
        const name = attr(simpleData, 'name');
        if (!name) continue;
        attributes[name] = textOf(simpleData).trim();
      }
    }
  }
  return attributes;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function buildGeometry(node) {
  switch (node.localName) {
    case 'Point':
      return buildPoint(node);
    case 'LineString':
      return buildLineString(node);
    case 'Polygon':
      return buildPolygon(node);
    default:
      return null;
  }
}

function buildPoint(node) {
  const positions = parseCoordinates(textOf(firstChild(node, 'coordinates')));
  if (positions.length === 0) return null;
  const position = positions[0];
  return {
    geometryType: 'POINT',
    geojson: { type: 'Point', coordinates: position },
    elevationM: position.length > 2 ? position[2] : null,
  };
}

function buildLineString(node) {
  const positions = parseCoordinates(textOf(firstChild(node, 'coordinates')));
  if (positions.length < 2) return null;
  return {
    geometryType: 'LINESTRING',
    geojson: { type: 'LineString', coordinates: positions },
    elevationM: positions[0].length > 2 ? positions[0][2] : null,
  };
}

function buildPolygon(node) {
  const outer = ringOf(firstChild(node, 'outerBoundaryIs'));
  if (outer.length < 3) return null;
  const rings = [closeRing(outer)];
  for (const inner of childrenOf(node, 'innerBoundaryIs')) {
    const ring = ringOf(inner);
    if (ring.length >= 3) rings.push(closeRing(ring));
  }
  const first = rings[0][0];
  return {
    geometryType: 'POLYGON',
    geojson: { type: 'Polygon', coordinates: rings },
    elevationM: first.length > 2 ? first[2] : null,
  };
}

function ringOf(boundary) {
  if (!boundary) return [];
  const linearRing = firstChild(boundary, 'LinearRing') ?? boundary;
  return parseCoordinates(textOf(firstChild(linearRing, 'coordinates')));
}

function closeRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = first.length === last.length && first.every((value, index) => value === last[index]);
  return closed ? ring : ring.concat([first.slice()]);
}

function parseCoordinates(text) {
  const positions = [];
  if (!text) return positions;
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const parts = tuple.split(',');
    if (parts.length < 2) continue;
    const longitude = Number(parts[0]);
    const latitude = Number(parts[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const altitude = parts.length > 2 && parts[2] !== '' ? Number(parts[2]) : Number.NaN;
    positions.push(Number.isFinite(altitude) ? [longitude, latitude, altitude] : [longitude, latitude]);
  }
  return positions;
}

/* ------------------------------------------------------------------ */
/* XML scanner                                                         */
/* ------------------------------------------------------------------ */

/**
 * A tiny, self-contained XML scanner. It walks the source character by
 * character, so attributes may hold any quoting, CDATA is opaque, comments and
 * processing instructions never reach the tree, and entity references are
 * decoded once per text or attribute value.
 */
function parseXml(source) {
  const document = { name: '#document', localName: '#document', attributes: {}, children: [] };
  const stack = [document];

  for (const token of tokenize(source)) {
    if (token.type === 'start') {
      const node = {
        name: token.name,
        localName: localNameOf(token.name),
        attributes: token.attributes,
        children: [],
      };
      const parent = stack[stack.length - 1];
      parent.children.push(node);
      if (!token.selfClosing) stack.push(node);
      continue;
    }
    if (token.type === 'end') {
      for (let index = stack.length - 1; index >= 1; index -= 1) {
        if (stack[index].name === token.name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const parent = stack[stack.length - 1];
    parent.children.push({ name: '#text', localName: '#text', text: token.text, cdata: token.type === 'cdata' });
  }

  return document;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      pushText(tokens, source.slice(index));
      break;
    }
    if (open > index) pushText(tokens, source.slice(index, open));

    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      const stop = end === -1 ? source.length : end;
      tokens.push({ type: 'cdata', text: source.slice(open + 9, stop) });
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', open)) {
      const end = source.indexOf('>', open + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('</', open)) {
      const end = source.indexOf('>', open + 2);
      const stop = end === -1 ? source.length : end;
      tokens.push({ type: 'end', name: source.slice(open + 2, stop).trim() });
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const tag = readStartTag(source, open);
    tokens.push(tag.token);
    index = tag.next;
  }
  return tokens;
}

function pushText(tokens, text) {
  if (text) tokens.push({ type: 'text', text: decodeEntities(text) });
}

function readStartTag(source, start) {
  const length = source.length;
  let index = start + 1;
  let name = '';
  while (index < length && !/[\s/>]/.test(source[index])) {
    name += source[index];
    index += 1;
  }

  const attributes = {};
  let selfClosing = false;
  while (index < length) {
    while (index < length && /\s/.test(source[index])) index += 1;
    if (index >= length) break;
    if (source[index] === '/') {
      if (source[index + 1] === '>') {
        selfClosing = true;
        index += 2;
        break;
      }
      index += 1;
      continue;
    }
    if (source[index] === '>') {
      index += 1;
      break;
    }

    let attributeName = '';
    while (index < length && !/[\s=/>]/.test(source[index])) {
      attributeName += source[index];
      index += 1;
    }
    while (index < length && /\s/.test(source[index])) index += 1;

    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (index < length && /\s/.test(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const end = source.indexOf(quote, index);
        const stop = end === -1 ? length : end;
        value = decodeEntities(source.slice(index, stop));
        index = end === -1 ? length : end + 1;
      } else {
        let raw = '';
        while (index < length && !/[\s/>]/.test(source[index])) {
          raw += source[index];
          index += 1;
        }
        value = decodeEntities(raw);
      }
    }
    if (attributeName) attributes[attributeName] = value;
  }

  return { token: { type: 'start', name, attributes, selfClosing }, next: index };
}

function decodeEntities(value) {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    if (body[0] !== '#') return match;
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

function stripByteOrderMark(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function elementChildren(node) {
  return node.children.filter((child) => child.name !== '#text');
}

function firstElementChild(node) {
  return elementChildren(node)[0] ?? null;
}

function firstChild(node, name) {
  if (!node) return null;
  return elementChildren(node).find((child) => child.localName === name) ?? null;
}

function childrenOf(node, name) {
  if (!node) return [];
  return elementChildren(node).filter((child) => child.localName === name);
}

function textOf(node) {
  if (!node) return '';
  let text = '';
  for (const child of node.children) {
    if (child.name === '#text') text += child.text;
  }
  return text;
}

function attr(node, name) {
  if (!node) return '';
  if (node.attributes[name] !== undefined) return node.attributes[name];
  for (const key of Object.keys(node.attributes)) {
    if (localNameOf(key) === name) return node.attributes[key];
  }
  return '';
}

function localNameOf(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/* ------------------------------------------------------------------ */
/* KMZ: minimal ZIP reader                                             */
/* ------------------------------------------------------------------ */

function isKmzSource(path, mediaType, buffer) {
  const normalizedPath = String(path ?? '').toLowerCase();
  const normalizedMedia = String(mediaType ?? '').toLowerCase();
  if (normalizedMedia === KMZ_MEDIA_TYPE || normalizedPath.endsWith('.kmz')) return true;
  if (normalizedMedia === KML_MEDIA_TYPE || normalizedPath.endsWith('.kml')) return false;
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/** Reads and inflates the root KML entry, enforcing archive limits and safety. */
function readKmzEntry(buffer, limits) {
  const maxEntries = clampLimit(limits?.archiveEntries, DEFAULT_ARCHIVE_ENTRIES, HARD_ARCHIVE_ENTRIES);
  const maxRatio = clampLimit(limits?.archiveExpansionRatio, DEFAULT_EXPANSION_RATIO, HARD_EXPANSION_RATIO);
  const entries = readCentralDirectory(buffer, maxEntries);

  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (const entry of entries) {
    totalCompressed += entry.compressedSize;
    totalUncompressed += entry.uncompressedSize;
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > maxRatio) {
    throw new Error(
      `KMZ archive expansion ratio ${(totalUncompressed / totalCompressed).toFixed(1)}:1 exceeds the ${maxRatio}:1 limit.`,
    );
  }

  const kmlEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.kml'));
  if (kmlEntries.length === 0) throw new Error('KMZ archive contains no .kml entry.');
  const root =
    kmlEntries.find((entry) => entry.name.toLowerCase() === 'doc.kml') ??
    kmlEntries.find((entry) => entry.name.toLowerCase().endsWith('/doc.kml')) ??
    kmlEntries[0];

  return readEntryData(buffer, root);
}

function readCentralDirectory(buffer, maxEntries) {
  const eocd = findEndOfCentralDirectory(buffer);
  const declared = buffer.readUInt16LE(eocd + 10);
  if (declared > maxEntries) {
    throw new Error(`KMZ archive declares ${declared} entries, above the ${maxEntries} entry limit.`);
  }

  const entries = [];
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < declared; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('KMZ central directory is malformed.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    assertSafeEntryName(name);
    if (((externalAttributes >>> 16) & 0xf000) === SYMLINK_FILE_TYPE) {
      throw new Error(`KMZ archive entry "${name}" is a symbolic link.`);
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length > maxEntries) {
    throw new Error(`KMZ archive contains ${entries.length} entries, above the ${maxEntries} entry limit.`);
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('KMZ archive is missing its end-of-central-directory record.');
}

function readEntryData(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`KMZ local file header for "${entry.name}" is malformed.`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`KMZ entry "${entry.name}" uses unsupported compression method ${entry.method}.`);
}

function assertSafeEntryName(name) {
  if (!name) throw new Error('KMZ archive contains an entry with an empty name.');
  if (name.startsWith('/') || name.startsWith('\\') || name.startsWith('//') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new Error(`KMZ archive entry "${name}" uses an absolute path.`);
  }
  if (name.split(/[\\/]+/).includes('..')) {
    throw new Error(`KMZ archive entry "${name}" escapes the archive root.`);
  }
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Project policy may lower a default; it must never raise the hard ceiling. */
function clampLimit(value, fallback, hardCeiling) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), hardCeiling);
}
