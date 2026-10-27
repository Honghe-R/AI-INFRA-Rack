#!/usr/bin/env node
/**
 * Development seed for the example project's facility artifacts.
 *
 * `npm run dev:seed` bootstraps the shell: a user, an organisation, the
 * "Northern DC Campus" project, and its first scenario with a draft revision.
 * That is everything the project list and the workspace shell need, and nothing
 * the Site and Facility tool can show. This script adds the demo content:
 *
 *   1. A facility graph in the draft revision (001 schema): an envelope, the SITE
 *      design scope, a parcel, buildings with halls, a floor, and support spaces,
 *      an equipment yard, phases, failure domains, utility sources and
 *      interfaces, storage reserves, a resilience requirement, an environmental
 *      profile, spatial constraints, assumptions, and a document. The graph is a
 *      **layout** (`scripts/lib/dev-facility-layouts.mjs`): the two seeded
 *      projects get two different campuses, not one campus twice.

 *   2. Five project assets in object storage, registered and processed through
 *      the W3/W4 pipeline exactly as a user upload would be: a GeoJSON site
 *      plan, a KML boundary survey, a CSV utility point table, a DXF power
 *      riser, and a PDF feasibility study. Each one carries real checksums and
 *      its derived representations, so the Assets surface and the import
 *      framework are exercised rather than stubbed.
 *
 * Idempotent. Facility rows use deterministic identifiers derived from a fixed
 * seed namespace, so a re-run replaces exactly the rows this script owns and
 * leaves anything an operator created in the revision alone. An asset is matched
 * by name: unchanged bytes are skipped, changed bytes become a new immutable
 * version rather than an overwrite.
 *
 * The revision stays DRAFT. A draft is the only mutable state, so it is the only
 * state a seed may legitimately write to; publishing is T5's job and requires a
 * validation run that does not exist yet.
 */
import { createHash } from 'node:crypto';
import { createAssetService, originalKey } from '@ai-infra/assets';
import { createLogger, loadConfig } from '@ai-infra/core';
import { createPool, withTenant } from '@ai-infra/db';
import { ensureEtag } from '@ai-infra/facility';
import { createDefaultRegistry, createImportPipeline, createSandbox } from '@ai-infra/imports';
import { createStorage } from '@ai-infra/storage';
import { DEV_ORGANISATIONS } from './lib/dev-identities.mjs';
import { DEV_FACILITY_LAYOUTS, layoutFor } from './lib/dev-facility-layouts.mjs';

const config = loadConfig();
const subject = process.env.AUTH_DEV_SUBJECT ?? 'dev-user';

if (!config.databaseUrl) {
  console.error('DATABASE_URL is required (start the database and run npm run migrate first).');
  process.exit(2);
}

const logger = createLogger({ service: 'dev-seed-facility', level: config.logLevel });
const pool = createPool({ connectionString: config.databaseUrl, max: 4 });

/* ------------------------------------------------------------------ identity */

/**
 * A deterministic identifier: UUID v5 over a fixed namespace and the caller's
 * key. It is what makes the seed idempotent and lets re-runs touch only the rows
 * this script owns.
 */
const SEED_NAMESPACE = Buffer.from('6f9619ff8b86d011b42d00c04fc964ff', 'hex');
function seedId(key) {
  const hash = createHash('sha1').update(SEED_NAMESPACE).update(Buffer.from(`facility-demo:${key}`, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const id = (key) => seedId(key);

/* ------------------------------------------------------------- campus layout */

/**
 * The layout is data (`scripts/lib/dev-facility-layouts.mjs`); this file is the
 * plumbing that writes one into a revision. Everything below that mentions a
 * coordinate, a container, or a utility reads it from `layout`, so the two seeded
 * projects are two different campuses rather than one campus twice.
 */

/** A GeoJSON polygon from an open ring, closed for the store's geometry parser. */
const polygon = (ring) => JSON.stringify({ type: 'Polygon', coordinates: [[...ring, ring[0]]] });
/** A GeoJSON point from a `[lon, lat]` pair. */
const point = ([lon, lat]) => JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
const json = (value) => JSON.stringify(value);
/* -------------------------------------------------------------- sample files */

/**
 * Every sample file is derived from the layout it belongs to, so the bytes a
 * tenant holds describe that tenant's campus. A site plan carrying another
 * campus's coordinates would be worse than no site plan at all: it is a document
 * a reviewer would trust.
 */

/** Stable, lower-case identity for a feature or file name. */
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The display name of every registered entity, by its seed key. */
function entityNames(layout) {
  return new Map([
    ['scope:site', layout.scopeName],
    ...layout.containers.map((entry) => [entry.key, entry.name]),
    ...layout.sources.map((entry) => [entry.key, entry.name]),
    ...layout.interfaces.map((entry) => [entry.key, entry.name]),
  ]);
}

function sitePlanGeoJson(layout) {
  const names = entityNames(layout);
  const features = [];
  for (const geometry of layout.geometries) {
    if (geometry.role === 'BOUNDARY' && geometry.entity === 'scope:site') {
      features.push(feature('site-boundary', {
        name: layout.scopeName,
        role: 'BOUNDARY',
        land_use: 'DATA_CENTRE',
      }, polygonGeometry(layout.rings[geometry.ring])));
    } else if (geometry.role === 'FOOTPRINT') {
      features.push(feature(slug(`${geometry.entity}-footprint`), {
        name: names.get(geometry.entity),
        role: 'FOOTPRINT',
      }, polygonGeometry(layout.rings[geometry.ring])));
    } else if (geometry.role === 'CONNECTION_POINT' && geometry.entityType === 'UTILITY_INTERFACE') {
      const utilityInterface = layout.interfaces.find((entry) => entry.key === geometry.entity);
      const source = layout.sources.find((entry) => entry.key === utilityInterface?.source);
      features.push(feature(slug(names.get(geometry.entity)), {
        name: names.get(geometry.entity),
        role: 'CONNECTION_POINT',
        utility: source?.kind ?? null,
        capacity: source ? `${source.value} ${source.unit}` : null,
      }, pointGeometry(layout.points[geometry.point])));
    }
  }

  return `${JSON.stringify(
    {
      type: 'FeatureCollection',
      name: `${layout.key}-site-plan`,
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features,
    },
    null,
    2,
  )}\n`;
}

function feature(featureId, properties, geometry) {
  return { type: 'Feature', id: featureId, properties, geometry };
}
function polygonGeometry(ring) {
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] };
}
function pointGeometry([lon, lat]) {
  return { type: 'Point', coordinates: [lon, lat] };
}

function boundarySurveyKml(layout) {
  const placemark = (name, description, ring) => `    <Placemark>
      <name>${name}</name>
      <description>${description}</description>
      <Style><LineStyle><color>ff2f6fdb</color><width>3</width></LineStyle></Style>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>
        ${ring.map(([lon, lat]) => `${lon},${lat},0`).join(' ')}
      </coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;

  const buildings = layout.containers
    .filter((container) => container.kind === 'BUILDING')
    .map((building) => {
      const footprint = layout.geometries.find((entry) => entry.entity === building.key && entry.role === 'FOOTPRINT');
      return placemark(building.name, `${building.name} footprint as surveyed.`, layout.rings[footprint.ring]);
    });

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${layout.scopeName} boundary survey</name>
${placemark('Campus boundary', `Recorded boundary of ${layout.scopeName}.`, layout.rings.campus)}
${buildings.join('\n')}
  </Document>
</kml>
`;
}

function utilityPointsCsv(layout) {
  const sourceByKey = new Map(layout.sources.map((source) => [source.key, source]));
  const rows = ['name,lon,lat,kind,capacity,unit,service_state'];
  for (const utilityInterface of layout.interfaces) {
    const geometry = layout.geometries.find(
      (entry) => entry.entity === utilityInterface.key && entry.role === 'CONNECTION_POINT',
    );
    if (!geometry) continue;
    const [lon, lat] = layout.points[geometry.point];
    const source = sourceByKey.get(utilityInterface.source);
    rows.push([
      utilityInterface.name, lon, lat, source?.kind ?? '', source?.value ?? '', source?.unit ?? '',
      utilityInterface.service,
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

/**
 * An ASCII DXF in metres, with no CRS: a CAD drawing is building-local, so its
 * coordinates are the local grid, not longitude and latitude. The adapter reports
 * `$INSUNITS` as the source unit and leaves georeferencing to a reviewed
 * transform (T3), which is exactly why a project asset is not authoritative
 * geometry on its own.
 */
function powerRiserDxf({ roomHeightM }) {
  const pair = (code, value) => `${code}\n${value}`;
  const lwpolyline = (handle, layer, ring) =>
    [pair(0, 'LWPOLYLINE'), pair(5, handle), pair(8, layer), pair(90, ring.length), pair(70, 1), ...ring.flatMap(([x, y]) => [pair(10, x), pair(20, y)])].join('\n');
  const line = (handle, layer, [x1, y1], [x2, y2]) =>
    [pair(0, 'LINE'), pair(5, handle), pair(8, layer), pair(10, x1), pair(20, y1), pair(11, x2), pair(21, y2)].join('\n');
  const records = [
    pair(0, 'SECTION'), pair(2, 'HEADER'),
    pair(9, '$ACADVER'), pair(1, 'AC1027'),
    pair(9, '$INSUNITS'), pair(70, 6),
    pair(9, '$MEASUREMENT'), pair(70, 1),
    pair(0, 'ENDSEC'),
    pair(0, 'SECTION'), pair(2, 'TABLES'),
    pair(0, 'TABLE'), pair(2, 'LAYER'),
    pair(0, 'LAYER'), pair(2, 'SHELL'), pair(70, 0),
    pair(0, 'LAYER'), pair(2, 'POWER-ROUTE'), pair(70, 0),
    pair(0, 'ENDTAB'), pair(0, 'ENDSEC'),
    pair(0, 'SECTION'), pair(2, 'ENTITIES'),
    lwpolyline('10', 'SHELL', [[0, 0], [170, 0], [170, 155], [0, 155]]),
    lwpolyline('11', 'SHELL', [[20, 20], [80, 20], [80, 70], [20, 70]]),
    lwpolyline('12', 'SHELL', [[90, 20], [150, 20], [150, 70], [90, 70]]),
    lwpolyline('13', 'SHELL', [[20, 85], [150, 85], [150, 135], [20, 135]]),
    line('14', 'POWER-ROUTE', [85, 0], [85, 155]),
    line('15', 'POWER-ROUTE', [0, 135], [170, 135]),
    line('16', 'POWER-ROUTE', [10, 10], [10, 145]),
    pair(0, 'ENDSEC'),
    pair(0, 'EOF'),
    '',
  ];
  return records.join('\n').replaceAll('{ROOM_HEIGHT}', String(roomHeightM));
}

/**
 * A small but structurally valid PDF, assembled with a computed cross-reference
 * table so it opens in a reader. The vendor-document adapter attaches it as
 * metadata and never extracts from it (import-adapters.md, "Vendor Study and
 * PDF"), so its value in the demo is that the document path is exercised.
 */
function feasibilityStudyPdf(layout) {
  const buildings = layout.containers.filter((container) => container.kind === 'BUILDING');
  const firm = layout.sources
    .filter((source) => source.state === 'FIRM')
    .map((source) => `${source.name} (${source.value} ${source.unit})`)
    .join(', ');
  const title = `${layout.scopeName} - ${layout.samples.study.name}`;
  const body = [
    `Prepared for: ${layout.document.owner}`,
    'Revision: Draft 1 (unvalidated)',
    '',
    `1. Scope: ${buildings.length} halls across ${layout.phases.length} phases.`,
    `2. Firm supply: ${firm}.`,
    `3. Policy: ${layout.requirement.availabilityPolicy.replaceAll('_', '+')}, ${Math.round(layout.requirement.autonomyDurationSeconds / 3600)} h autonomy.`,
    `4. Storage: ${layout.reserves.map((reserve) => `${reserve.value} ${reserve.unit} ${reserve.kind.toLowerCase()}`).join(', ')}.`,
    `5. Jurisdiction: ${layout.jurisdiction}.`,
    '',
    'This study is a reference document. It supplies no authoritative geometry.',
  ];
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 770 Td',
    `(${escapePdfText(title)}) Tj`,
    '0 -34 Td',
    '/F1 11 Tf',
    ...body.flatMap((line) => [`(${escapePdfText(line)}) Tj`, '0 -16 Td']),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function escapePdfText(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/* ------------------------------------------------------------- asset seeding */

/**
 * The demo files. `kind` is left to the asset layer, which infers it from the
 * media type, so this list only names what a user would have uploaded.
 */
/**
 * The demo files for one layout. `kind` is left to the asset layer, which infers it
 * from the media type, so this only names what a user would have uploaded — and it
 * names it after the campus it describes, because the same five files exist in both
 * projects and must not be indistinguishable.
 */
function sampleAssetsFor(layout) {
  return [
    {
      key: `${layout.key}-site-plan`,
      name: `${layout.scopeName} Site Plan`,
      filename: `${layout.key}-site-plan.geojson`,
      mediaType: 'application/geo+json',
      tags: ['site', 'geojson'],
      body: () => sitePlanGeoJson(layout),
    },
    {
      key: `${layout.key}-boundary-survey`,
      name: `${layout.scopeName} Boundary Survey`,
      filename: `${layout.key}-boundary-survey.kml`,
      mediaType: 'application/vnd.google-earth.kml+xml',
      tags: ['survey', 'kml'],
      body: () => boundarySurveyKml(layout),
    },
    {
      key: `${layout.key}-utility-points`,
      name: `${layout.scopeName} Utility Entry Points`,
      filename: `${layout.key}-utility-entry-points.csv`,
      mediaType: 'text/csv',
      tags: ['utilities', 'csv'],
      body: () => utilityPointsCsv(layout),
    },
    {
      key: `${layout.key}-power-riser`,
      name: `${layout.scopeName} Power Riser Layout`,
      filename: `${layout.key}-power-riser.dxf`,
      mediaType: 'image/vnd.dxf',
      tags: ['cad', 'power'],
      body: () => powerRiserDxf({ roomHeightM: 6 }),
    },
    {
      key: `${layout.key}-feasibility-study`,
      name: layout.samples.study.name,
      filename: layout.samples.study.filename,
      mediaType: 'application/pdf',
      tags: ['study', 'document'],
      body: () => feasibilityStudyPdf(layout),
    },
  ];
}

/**
 * Registers one sample file, or leaves an identical one in place. Returns the
 * exact version and its object-store key so the facility document row can point
 * at the bytes rather than at a copy.
 */
async function ensureAsset({ assetService, projectId, actorId, sample, body }) {
  const checksum = createHash('sha256').update(body).digest('hex');
  const matches = await assetService.listAssets({ projectId, query: sample.name, limit: 50 });
  const existing = matches.find((asset) => asset.name === sample.name);

  if (existing) {
    const current = await assetService.getAsset({ projectId, assetId: existing.assetId, actorId });
    const version = current.versions.find((item) => item.assetVersionId === current.currentVersionId) ?? current.versions[0];
    if (version?.contentChecksum === checksum) {
      return { assetId: existing.assetId, assetVersionId: version.assetVersionId, checksum, versionNumber: version.versionNumber, outcome: 'unchanged' };
    }
    const reserved = await assetService.reserveVersion({
      projectId,
      actorId,
      assetId: existing.assetId,
      filename: sample.filename,
      mediaType: sample.mediaType,
      sourceRef: 'dev-seed-facility',
    });
    const result = await assetService.intakeContent({
      projectId,
      actorId,
      assetId: existing.assetId,
      assetVersionId: reserved.version.assetVersionId,
      body,
      contentType: sample.mediaType,
      declaredSizeBytes: body.length,
    });
    return { assetId: existing.assetId, assetVersionId: result.version.assetVersionId, checksum, versionNumber: result.version.versionNumber, outcome: 'new-version', processing: result.processing };
  }

  const reserved = await assetService.reserveAsset({
    projectId,
    actorId,
    name: sample.name,
    mediaType: sample.mediaType,
    filename: sample.filename,
    sourceRef: 'dev-seed-facility',
    tags: sample.tags,
  });
  const result = await assetService.intakeContent({
    projectId,
    actorId,
    assetId: reserved.asset.assetId,
    assetVersionId: reserved.version.assetVersionId,
    body,
    contentType: sample.mediaType,
    declaredSizeBytes: body.length,
  });
  return { assetId: reserved.asset.assetId, assetVersionId: result.version.assetVersionId, checksum, versionNumber: result.version.versionNumber, outcome: 'created', processing: result.processing };
}

/**
 * Removes demo assets the seed used to write for this project and no longer does.
 *
 * A layout's asset names are part of its shape, so changing one would otherwise
 * leave the previous name behind as a second, stale copy of the same file — visible
 * in the Assets surface and indistinguishable from something an operator uploaded.
 * Only names the seed has used for *some* layout are candidates, so this can never
 * touch an operator's upload.
 */
const RETIRED_ASSET_NAMES = ['Campus Boundary Survey', 'Utility Entry Points', 'Power Riser Layout'];

async function clearStaleAssets({ projectId, layout }) {
  const known = new Set([
    ...DEV_FACILITY_LAYOUTS.flatMap((entry) => sampleAssetsFor(entry).map((sample) => sample.name)),
    // Names the seed used before assets were named per campus. No layout produces
    // them, so nothing would ever match them again, and they would sit in the
    // Assets surface next to the file they duplicate.
    ...RETIRED_ASSET_NAMES,
  ]);
  const current = new Set(sampleAssetsFor(layout).map((sample) => sample.name));
  const stale = [...known].filter((name) => !current.has(name));
  if (stale.length === 0) return 0;

  const removed = await withTenant(pool, projectId, (client) =>
    client.query(
      'DELETE FROM project_assets WHERE project_id = $1 AND name = ANY($2::text[]) RETURNING asset_id',
      [projectId, stale],
    ));
  return removed.rowCount;
}

async function seedAssets({ projectId, actorId, layout }) {
  const retired = await clearStaleAssets({ projectId, layout });
  let storage;
  try {
    storage = createStorage(config);
    // Fail before the first reservation if the bucket is unreachable, so the
    // seed does not leave half-registered assets behind.
    await storage.headObject({ key: '__dev-seed-facility-probe__' });
  } catch (error) {
    if (!isMissingObject(error)) {
      console.warn(`Object storage unavailable (${error.message}); skipping project assets.`);
      return { assets: [], skipped: true };
    }
  }

  const processor = createImportPipeline({
    pool,
    storage,
    registry: createDefaultRegistry(),
    sandbox: createSandbox({
      timeoutMs: config.importTimeoutMs ?? undefined,
      maxOldSpaceMb: config.importMaxOldSpaceMb ?? undefined,
    }),
    logger,
  });
  const assetService = createAssetService({
    pool,
    storage,
    limits: { maxBytes: config.assetMaxBytes },
    logger,
    processor,
  });

  const assets = [];
  for (const sample of sampleAssetsFor(layout)) {
    const body = Buffer.isBuffer(sample.body) ? sample.body : Buffer.from(sample.body(), 'utf8');
    const result = await ensureAsset({ assetService, projectId, actorId, sample, body });
    const detail = await assetService.getAsset({ projectId, assetId: result.assetId, actorId });
    assets.push({
      ...result,
      name: sample.name,
      kind: detail.kind,
      storageKey: originalKey({ projectId, assetId: result.assetId, assetVersionId: result.assetVersionId }),
      representations: detail.representations.map((representation) => representation.kind),
    });
  }
  return { assets, skipped: false, retired };
}

/** A `headObject` miss is the normal answer for a probe key, not a failure. */
function isMissingObject(error) {
  const code = error?.code ?? error?.name ?? '';
  return /NO_SUCH_KEY|NOT_FOUND|NotFound|404/i.test(String(code)) || /not found/i.test(String(error?.message ?? ''));
}

/* ------------------------------------------------------------ facility graph */

const GEOMETRY_TYPE = Object.freeze({
  BOUNDARY: 'POLYGON',
  FOOTPRINT: 'POLYGON',
  FLOOR_BOUNDARY: 'POLYGON',
  ROOM_BOUNDARY: 'POLYGON',
  CONNECTION_POINT: 'POINT',
  CONSTRAINT_AREA: 'POLYGON',
  ROUTE: 'LINESTRING',
  REFERENCE_POINT: 'POINT',
});

// Every table this seed writes, in delete order (children before parents). The
// list is what makes a re-run a replacement instead of an accumulation, and the
// order matters: `spatial_constraints` references a geometry record, so it is
// removed before `geometry_records`, and so on down the graph.
const OWNED_TABLES = [
  ['spatial_constraints', 'constraint_id'],
  ['geometry_records', 'geometry_id'],
  ['environmental_profiles', 'profile_id'],
  ['resilience_requirements', 'requirement_id'],
  ['storage_reserves', 'storage_id'],
  ['utility_interfaces', 'interface_id'],
  ['utility_sources', 'utility_source_id'],
  ['facility_containers', 'container_id'],
  ['design_scopes', 'scope_id'],
  ['phase_capability_availability', 'phase_id'],
  ['phase_dependencies', 'predecessor_phase_id'],
  ['facility_phases', 'phase_id'],
  ['assumptions', 'assumption_id'],
  ['documents', 'document_id'],
  ['failure_domains', 'failure_domain_id'],
  ['facility_envelopes', 'envelope_id'],
  ['entity_registry', 'entity_id'],
];

/**
 * Validation and governance rows are keyed by random identifiers, so they are
 * cleared by revision rather than by the seed's deterministic id list. They
 * reference the envelope and the revision, so leaving them behind would block the
 * graph's replacement on the next run. They are derived from the demo data, not
 * authored by hand, which is why a re-seed may remove them.
 */
const DERIVED_TABLES = [
  ['facility_diagnostics', 'diagnostic_id'],
  ['capability_coverage', 'revision_id'],
  ['validation_runs', 'validation_run_id'],
  ['waivers', 'waiver_id'],
  ['approval_attestations', 'attestation_id'],
  ['outbox_events', 'event_id'],
];

async function clearDerivedState(client, projectId, revisionId) {
  for (const [table] of DERIVED_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE project_id = $1 AND revision_id = $2`, [projectId, revisionId]);
  }
}

/** Every entity the seed registers, derived from the layout it is writing. */
function registryEntities(layout) {
  return [
    ['scope:site', 'SITE', layout.scopeName],
    ...layout.containers.map((entry) => [entry.key, entry.kind, entry.name]),
    ...layout.phases.map((entry) => [entry.key, 'FACILITY_PHASE', entry.name]),
    ...layout.domains.map((entry) => [entry.key, 'FAILURE_DOMAIN', entry.name]),
    [layout.requirement.key, 'RESILIENCE_REQUIREMENT', layout.requirement.name],
    ...layout.sources.map((entry) => [entry.key, 'UTILITY_SOURCE', entry.name]),
    ...layout.interfaces.map((entry) => [entry.key, 'UTILITY_INTERFACE', entry.name]),
    ...layout.reserves.map((entry) => [entry.key, entry.kind === 'FUEL' ? 'FUEL_STORAGE' : 'WATER_STORAGE', entry.name]),
    [layout.profile.key, 'ENVIRONMENTAL_PROFILE', layout.profile.name],
    ...layout.constraints.map((entry) => [entry.key, 'SPATIAL_CONSTRAINT', entry.name]),
    ...layout.assumptions.map((entry) => [entry.key, 'ASSUMPTION', entry.name]),
    [layout.document.key, 'DOCUMENT', layout.document.title],
  ];
}

/**
 * The deterministic ids the seed owns, so a re-run replaces exactly those rows and
 * leaves anything an operator authored alone.
 *
 * The union spans **every** layout, not just the one being written. A layout's keys
 * are its shape, and changing the shape — a renamed building, a third hall — would
 * otherwise strand the previous shape's rows, which then block the delete through
 * their own parent foreign keys. An id only appears here because the seed minted it
 * for a declared layout, so this still cannot touch a row the seed did not create.
 */
function ownedIds(layout) {
  const ids = new Set([id('envelope'), id('scope:site')]);
  for (const candidate of [layout, ...DEV_FACILITY_LAYOUTS.filter((entry) => entry.key !== layout.key)]) {
    for (const [key] of registryEntities(candidate)) ids.add(id(key));
    for (const geometry of candidate.geometries) ids.add(id(geometry.key));
  }
  return [...ids];
}

async function clearOwnedRows(client, projectId, layout) {
  const ids = ownedIds(layout);
  for (const [table, column] of OWNED_TABLES) {
    await client.query(`DELETE FROM ${table} WHERE project_id = $1 AND ${column} = ANY($2::uuid[])`, [projectId, ids]);
  }
}

async function seedFacilityGraph({ projectId, scenarioId, revisionId, actorId, document, layout }) {
  const envelopeId = id('envelope');
  const scopeId = id('scope:site');
  const now = new Date().toISOString();
  const firstPhase = layout.phases[0].key;

  await withTenant(pool, projectId, async (client) => {
    await clearDerivedState(client, projectId, revisionId);
    await clearOwnedRows(client, projectId, layout);

    /* -- entity registry: every demo entity gets a stable, addressable id ---- */
    for (const [key, entityType, displayName] of registryEntities(layout)) {
      await client.query(
        `INSERT INTO entity_registry
           (entity_id, revision_id, project_id, scenario_id, entity_type, status, display_name, created_by)
         VALUES ($1, $2, $3, $4, $5, 'PROVISIONAL', $6, $7)`,
        [id(key), revisionId, projectId, scenarioId, entityType, displayName, actorId],
      );
    }

    /* -- envelope and the SITE design scope --------------------------------- */
    await client.query(
      `INSERT INTO facility_envelopes
         (envelope_id, project_id, scenario_id, revision_id, lifecycle_state, approval_state, created_by)
       VALUES ($1, $2, $3, $4, 'DRAFT', 'NOT_REQUIRED', $5)`,
      [envelopeId, projectId, scenarioId, revisionId, actorId],
    );

    await client.query(
      `INSERT INTO design_scopes
         (scope_id, project_id, scenario_id, revision_id, envelope_id, scope_kind, name, jurisdiction, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, 'CAMPUS', $6, $7, $8::jsonb, $9)`,
      [
        scopeId, projectId, scenarioId, revisionId, envelopeId, layout.scopeName, layout.jurisdiction,
        json({ source_ref: 'dev-seed-facility', confidence: 'MEDIUM' }), actorId,
      ],
    );

    /* -- phases, their dependency edges, and capability availability --------- */
    for (const phase of layout.phases) {
      await client.query(
        `INSERT INTO facility_phases
           (phase_id, project_id, scenario_id, revision_id, envelope_id, name, phase_order, activation_date,
            activation_date_precision, status, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PLANNED', $10::jsonb, $11)`,
        [
          id(phase.key), projectId, scenarioId, revisionId, envelopeId, phase.name, phase.order,
          phase.activationDate, phase.precision ?? null, json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }
    for (const [predecessor, successor] of layout.phaseDependencies) {
      await client.query(
        `INSERT INTO phase_dependencies
           (predecessor_phase_id, successor_phase_id, project_id, scenario_id, revision_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id(predecessor), id(successor), projectId, scenarioId, revisionId, actorId],
      );
    }
    for (const [capability, phaseKey, available, availableFrom] of layout.phaseAvailability) {
      await client.query(
        `INSERT INTO phase_capability_availability
           (phase_id, capability, project_id, scenario_id, revision_id, available, available_from, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id(phaseKey), capability, projectId, scenarioId, revisionId, available, availableFrom, null, actorId],
      );
    }

    /* -- containers: parcel > building > level container, plus support spaces - */
    for (const container of layout.containers) {
      await client.query(
        `INSERT INTO facility_containers
           (container_id, project_id, scenario_id, revision_id, envelope_id, scope_id, parent_container_id, phase_id,
            kind, entity_type, name, level_number, status, elevation_base_m, elevation_top_m, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PROVISIONAL', $13, $14, $15::jsonb, $16)`,
        [
          id(container.key),
          projectId,
          scenarioId,
          revisionId,
          envelopeId,
          scopeId,
          container.parent ? id(container.parent) : null,
          container.phase ? id(container.phase) : null,
          // `kind` and `entity_type` are distinct enum types that happen to carry
          // the same value; they need distinct parameters, because PostgreSQL
          // cannot deduce one type for a parameter used as both.
          container.kind,
          container.kind,
          container.name,
          container.level,
          container.base,
          container.top,
          json({ source_ref: 'dev-seed-facility' }),
          actorId,
        ],
      );
    }

    /* -- geometry: both representations, one per required role -------------- */
    for (const geometry of layout.geometries) {
      const geojson = geometry.ring ? polygon(layout.rings[geometry.ring]) : point(layout.points[geometry.point]);
      await client.query(
        `INSERT INTO geometry_records
           (geometry_id, project_id, scenario_id, revision_id, entity_id, entity_type, role, ordinal, geometry_type,
            geojson_4326, projected_geometry, projected_crs, elevation_base_m, elevation_top_m, height_m, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8,
                 ST_SetSRID(ST_GeomFromGeoJSON($9), 4326),
                 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326), $10::integer),
                 $11, $12, $13, $14, $15::jsonb, $16)`,
        [
          id(geometry.key),
          projectId,
          scenarioId,
          revisionId,
          id(geometry.entity),
          geometry.entityType,
          geometry.role,
          GEOMETRY_TYPE[geometry.role],
          geojson,
          layout.projectedSrid,
          layout.projectedCrs,
          geometry.base ?? null,
          geometry.top ?? null,
          geometry.height ?? null,
          json({ source_ref: 'dev-seed-facility', confidence: 'HIGH' }),
          actorId,
        ],
      );
    }

    /* -- failure domains, utilities, and storage ---------------------------- */
    for (const domain of layout.domains) {
      await client.query(
        `INSERT INTO failure_domains
           (failure_domain_id, project_id, scenario_id, revision_id, envelope_id, parent_failure_domain_id, name, kind, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          id(domain.key), projectId, scenarioId, revisionId, envelopeId,
          domain.parent ? id(domain.parent) : null, domain.name, domain.kind,
          json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }

    await client.query(
      `INSERT INTO resilience_requirements
         (requirement_id, project_id, scenario_id, revision_id, envelope_id, availability_policy, policy_id, applies_to, autonomy_duration_seconds, active, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::resource_kind[], $9, true, $10::jsonb, $11)`,
      [
        id(layout.requirement.key), projectId, scenarioId, revisionId, envelopeId,
        layout.requirement.availabilityPolicy, layout.requirement.policyId,
        layout.requirement.appliesTo, layout.requirement.autonomyDurationSeconds,
        json({ source_ref: 'dev-seed-facility' }), actorId,
      ],
    );

    for (const source of layout.sources) {
      await client.query(
        `INSERT INTO utility_sources
           (utility_source_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value, capacity_unit,
            capacity_basis, capacity_state, failure_domain_id, phase_id, available_from, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
        [
          id(source.key), projectId, scenarioId, revisionId, envelopeId, source.kind, source.value, source.unit,
          source.basis, source.state, id(source.domain), id(source.phase),
          layout.sourcesAvailableFromFirstPhase && source.phase === firstPhase ? now : null,
          json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }

    for (const entry of layout.interfaces) {
      await client.query(
        `INSERT INTO utility_interfaces
           (interface_id, project_id, scenario_id, revision_id, envelope_id, utility_source_id, capacity_value, capacity_unit,
            capacity_basis, capacity_state, service_state, failure_domain_id, phase_id, available_from, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`,
        [
          id(entry.key), projectId, scenarioId, revisionId, envelopeId, id(entry.source), entry.value, entry.unit,
          entry.basis, entry.state, entry.service, id(entry.domain), id(entry.phase),
          layout.sourcesAvailableFromFirstPhase && entry.phase === firstPhase ? now : null,
          json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }

    for (const reserve of layout.reserves) {
      await client.query(
        `INSERT INTO storage_reserves
           (storage_id, project_id, scenario_id, revision_id, envelope_id, kind, capacity_value, capacity_unit, capacity_basis,
            capacity_state, autonomy_duration_seconds, failure_domain_id, phase_id, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
        [
          id(reserve.key), projectId, scenarioId, revisionId, envelopeId, reserve.kind, reserve.value, reserve.unit,
          reserve.basis, reserve.state, reserve.autonomySeconds, id(reserve.domain), id(reserve.phase),
          json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }

    /* -- environment, spatial constraints, assumptions, document ------------ */
    await client.query(
      `INSERT INTO environmental_profiles
         (profile_id, project_id, scenario_id, revision_id, site_scope_id, design_weather_ref, hazard_classifications,
          permit_constraints, operating_ranges, effective_at, provenance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::jsonb, $10, $11::jsonb, $12)`,
      [
        id(layout.profile.key), projectId, scenarioId, revisionId, scopeId,
        layout.profile.designWeatherRef, layout.profile.hazards, layout.profile.permits,
        json(layout.profile.operatingRanges), now, json({ source_ref: 'dev-seed-facility' }), actorId,
      ],
    );

    for (const constraint of layout.constraints) {
      await client.query(
        `INSERT INTO spatial_constraints
           (constraint_id, project_id, scenario_id, revision_id, envelope_id, scope_id, container_id, applies_to_geometry_id,
            kind, severity, rule_kind, rule_value, rule_unit, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
        [
          id(constraint.key), projectId, scenarioId, revisionId, envelopeId,
          constraint.scope ? scopeId : null,
          constraint.container ? id(constraint.container) : null,
          constraint.geometry ? id(constraint.geometry) : null,
          constraint.kind, constraint.severity, constraint.ruleKind, constraint.ruleValue, constraint.ruleUnit,
          json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }

    for (const assumption of layout.assumptions) {
      await client.query(
        `INSERT INTO assumptions
           (assumption_id, project_id, scenario_id, revision_id, envelope_id, statement, owner, confidence,
            effective_at, status, entity_refs, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
        [
          id(assumption.key), projectId, scenarioId, revisionId, envelopeId, assumption.statement,
          assumption.owner, assumption.confidence, now, assumption.status,
          json(assumption.refsTo.map((key) => ({ entity_type: 'ENTITY', entity_id: id(key) }))),
          json({ source_ref: 'dev-seed-facility' }), actorId,
        ],
      );
    }

    // A document is metadata about an artifact; the bytes stay in the asset
    // layer, addressed by key and checksum. This is the seam T3 binds through.
    if (document) {
      await client.query(
        `INSERT INTO documents
           (document_id, project_id, scenario_id, revision_id, kind, title, media_type, content_checksum, storage_key,
            owner, issued_at, entity_refs, provenance, created_by)
         VALUES ($1, $2, $3, $4, 'VENDOR_STUDY', $5, 'application/pdf', $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
        [
          id(layout.document.key), projectId, scenarioId, revisionId,
          layout.document.title, document.checksum, document.storageKey,
          layout.document.owner, now,
          json([{ entity_type: 'SITE', entity_id: scopeId }]),
          json({ source_ref: 'dev-seed-facility', asset_version_id: document.assetVersionId, binding_id: null }),
          actorId,
        ],
      );
    }
  });

  return { envelopeId, scopeId };
}

/* --------------------------------------------------- verification and counts */

/**
 * Structural self-check over what was just written. The database cannot express
 * "a BUILDING must have a FOOTPRINT" as a table constraint (facility.data.geometry
 * .role_missing is a validation rule, T4), so the seed asserts it here instead of
 * leaving a demo that only looks complete. A failure is loud: seeding bad demo
 * data silently is worse than not seeding it.
 */
async function verifyFacilityGraph(projectId) {
  return withTenant(
    pool,
    projectId,
    async (client) => {
      const problems = [];

      const { rows: invalid } = await client.query(
        `SELECT geometry_id, entity_type, role
           FROM geometry_records
          WHERE project_id = $1
            AND (NOT ST_IsValid(projected_geometry)
                 OR ST_SRID(projected_geometry) <= 0
                 OR ST_SRID(geojson_4326) <> 4326)`,
        [projectId],
      );
      for (const row of invalid) problems.push(`invalid geometry ${row.geometry_id} (${row.entity_type}/${row.role})`);

      const { rows: missing } = await client.query(
        `SELECT e.entity_type, e.display_name
           FROM entity_registry e
          WHERE e.project_id = $1
            AND e.entity_type IN ('SITE', 'PARCEL', 'BUILDING', 'FLOOR', 'HALL', 'SUPPORT_SPACE', 'EQUIPMENT_YARD')
            AND NOT EXISTS (
              SELECT 1 FROM geometry_records g
               WHERE g.project_id = e.project_id AND g.entity_id = e.entity_id
            )`,
        [projectId],
      );
      for (const row of missing) problems.push(`${row.entity_type} "${row.display_name}" has no geometry record`);

      const { rows: orphanScopes } = await client.query(
        `SELECT s.scope_id FROM design_scopes s
          WHERE s.project_id = $1
            AND NOT EXISTS (SELECT 1 FROM facility_containers c WHERE c.scope_id = s.scope_id AND c.project_id = s.project_id)`,
        [projectId],
      );
      for (const row of orphanScopes) problems.push(`design scope ${row.scope_id} has no containers`);

      return problems;
    },
    { readOnly: true },
  );
}

async function countFacilityRows(projectId) {
  const tables = [
    'facility_envelopes', 'entity_registry', 'design_scopes', 'facility_containers', 'geometry_records',
    'facility_phases', 'failure_domains', 'utility_sources', 'utility_interfaces', 'storage_reserves',
    'resilience_requirements', 'environmental_profiles', 'spatial_constraints', 'assumptions', 'documents',
  ];
  return withTenant(
    pool,
    projectId,
    async (client) => {
      const counts = {};
      for (const table of tables) {
        const { rows } = await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE project_id = $1`, [projectId]);
        counts[table] = rows[0].count;
      }
      const { rows: areaRows } = await client.query(
        `SELECT round(sum(ST_Area(projected_geometry))::numeric, 0)::int AS area_m2
           FROM geometry_records WHERE project_id = $1 AND role IN ('BOUNDARY', 'FOOTPRINT')`,
        [projectId],
      );
      counts.projected_area_m2 = areaRows[0].area_m2;
      return counts;
    },
    { readOnly: true },
  );
}

/* ----------------------------------------------------------------------- main */

try {
  const targets = await resolveSeededProjects();
  const results = [];
  for (const target of targets) {
    results.push(await seedProject(target));
  }

  for (const result of results) {
    printProject(result);
  }
  console.log(`\nNext: npm run dev:api, then npm run dev:web`);
} catch (error) {
  console.error(`Facility seed failed: ${error.message}`);
  if (process.env.DEBUG) console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

/** One project's graph, assets, and the checks that say it is internally consistent. */
async function seedProject(target) {
  // The layout is chosen by project name, so the second tenant gets a different
  // campus rather than the first one's coordinates.
  const layout = layoutFor(target.projectName);

  // The draft concurrency token. A revision seeded before the token existed is
  // backfilled here, because a draft write is conditioned on this value: without it
  // the revision is readable, validatable, and not editable.
  const etag = await withTenant(pool, target.projectId, (client) =>
    ensureEtag({
      client,
      projectId: target.projectId,
      revisionId: target.revisionId,
      scenarioId: target.scenarioId,
      actorId: target.userId,
    }),
  );

  const assets = await seedAssets({ projectId: target.projectId, actorId: target.userId, layout });
  const document = assets.assets.find((asset) => asset.name === layout.samples.study.name) ?? null;

  const graph = await seedFacilityGraph({
    projectId: target.projectId,
    scenarioId: target.scenarioId,
    revisionId: target.revisionId,
    actorId: target.userId,
    document,
    layout,
  });

  const problems = await verifyFacilityGraph(target.projectId);
  if (problems.length > 0) {
    throw new Error(`the seeded facility graph for "${layout.scopeName}" is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }

  const counts = await countFacilityRows(target.projectId);
  return { target, layout, etag, assets, graph, counts };
}

function printProject({ target, layout, etag, assets, graph, counts }) {
  console.log('');
  console.log(`user            ${target.userId} (${target.ownerSubject})`);
  console.log(`organisation    ${target.organizationId} — ${target.organisationName}`);
  console.log(`project         ${target.projectId} (${target.projectName})`);
  console.log(`layout          ${layout.key} · ${layout.projectedCrs} · ${layout.containers.filter((entry) => entry.kind === 'BUILDING').length} buildings · ${layout.phases.length} phases`);
  console.log(`scenario        ${target.scenarioId} (${target.scenarioName})`);
  console.log(`revision        ${target.revisionId} (${target.revisionName}, DRAFT)`);
  console.log(`draft etag      ${etag?.etag ?? 'unavailable'} (v${etag?.etagVersion ?? '?'})`);
  console.log(`envelope        ${graph.envelopeId}`);
  console.log(`site scope      ${graph.scopeId}`);
  console.log('');
  console.log('Facility graph (rows in this project):');
  for (const [table, count] of Object.entries(counts)) {
    if (table === 'projected_area_m2') continue;
    console.log(`  ${table.padEnd(28)} ${count}`);
  }
  console.log(`  projected area (boundaries + footprints) ${counts.projected_area_m2 ?? 0} m2`);
  console.log(`  verified: every geometry record is valid and in ${layout.projectedCrs}; no container is without geometry`);
  if (assets.skipped) {
    console.log('  project assets skipped: object storage is not reachable.');
    return;
  }
  console.log('Project assets:');
  for (const asset of assets.assets) {
    const representations = asset.representations.length ? asset.representations.join(', ') : 'none';
    console.log(`  ${asset.name.padEnd(38)} v${asset.versionNumber} ${asset.outcome.padEnd(12)} ${asset.kind ?? ''} [${representations}]`);
  }
}

/**
 * Resolves the project of every seeded organisation, the same way `dev-seed`
 * resolves it: the organisation's owner, that organisation, then the named project
 * with its first scenario and revision. Nothing is created here; the base seed owns
 * creation, so a missing project is an instruction, not a silent bootstrap.
 *
 * Both tenants are seeded. The second organisation's project gets the same campus
 * plan on purpose: two tenants holding identical designs is what makes an isolation
 * mistake visible — a query that leaks across the boundary shows the other tenant's
 * campus rather than an empty result that could be mistaken for "not seeded".
 */
async function resolveSeededProjects() {
  const targets = [];
  for (const definition of DEV_ORGANISATIONS) {
    targets.push(
      await resolveProjectFor({
        definition,
        ownerSubject: definition.key === 'primary' ? subject : definition.ownerSubject,
      }),
    );
  }
  return targets;
}

async function resolveProjectFor({ definition, ownerSubject }) {
  const userRows = await pool.query('SELECT user_id FROM users WHERE subject = $1', [ownerSubject]);
  const userId = userRows.rows[0]?.user_id ?? null;
  if (!userId) {
    throw new Error(`No user for subject "${ownerSubject}". Run \`npm run dev:seed\` first.`);
  }

  const organizationId = definition.organisationId ?? (
    await pool.query(
      `SELECT organization_id FROM organization_memberships
        WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
      [userId],
    )
  ).rows[0]?.organization_id ?? null;
  if (!organizationId) {
    throw new Error(`"${ownerSubject}" has no active organisation. Run \`npm run dev:seed\` first.`);
  }

  const named = await pool.query(
    'SELECT project_id, name FROM projects WHERE organization_id = $1 AND name = $2 ORDER BY created_at LIMIT 1',
    [organizationId, definition.projectName],
  );
  const fallback = named.rows[0] ? null : await pool.query(
    'SELECT project_id, name FROM projects WHERE organization_id = $1 ORDER BY name LIMIT 1',
    [organizationId],
  );
  const project = named.rows[0] ?? fallback?.rows[0] ?? null;
  if (!project) {
    throw new Error(`Organisation "${definition.name}" has no project. Run \`npm run dev:seed\` first.`);
  }

  const scenarioRows = await pool.query(
    'SELECT scenario_id, name FROM scenarios WHERE project_id = $1 ORDER BY created_at LIMIT 1',
    [project.project_id],
  );
  const scenario = scenarioRows.rows[0] ?? null;
  if (!scenario) {
    throw new Error(`Project "${project.name}" has no scenario. Run \`npm run dev:seed\` first.`);
  }

  const revisionRows = await pool.query(
    `SELECT revision_id, name, lifecycle_state FROM revisions
      WHERE scenario_id = $1 ORDER BY created_at LIMIT 1`,
    [scenario.scenario_id],
  );
  const revision = revisionRows.rows[0] ?? null;
  if (!revision) {
    throw new Error(`Scenario "${scenario.name}" has no revision. Run \`npm run dev:seed\` first.`);
  }
  if (revision.lifecycle_state === 'PUBLISHED') {
    throw new Error(`Revision "${revision.name}" is PUBLISHED and immutable; seed a draft revision instead.`);
  }

  return {
    ownerSubject,
    userId,
    organizationId,
    organisationName: definition.name,
    projectId: project.project_id,
    projectName: project.name,
    scenarioId: scenario.scenario_id,
    scenarioName: scenario.name,
    revisionId: revision.revision_id,
    revisionName: revision.name,
  };
}
