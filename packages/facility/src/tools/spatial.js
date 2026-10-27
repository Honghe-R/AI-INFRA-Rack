import { ApiError } from '@ai-infra/core';
import { field } from './schema.js';
import { defineTool } from './registry.js';
import { paginate } from './bounds.js';

/**
 * The spatial reads.
 *
 * These are the surface's only computed reads: they push a predicate into PostGIS
 * rather than filtering rows in process, because a containment or distance
 * question is decided by the spatial index under the revision's tenant GUC
 * ([D15](../../../../doc/tools/site-and-facility/decisions.md)) and not by
 * JavaScript re-implementing geodesy.
 *
 * A computed answer and a stored diagnostic are different things and are never
 * interchangeable: `spatial_query` reports a live measurement, `list_diagnostics`
 * reports what a run concluded. Nothing here writes a diagnostic, and nothing here
 * may be presented as one.
 */

const READ = 'facility.read';
const DEFAULT_CRS = 'EPSG:32618';

export const queryGeometry = defineTool({
  name: 'query_geometry',
  axis: 'STATE',
  access: 'read',
  description:
    'Query geometry records for a revision by entity, bounding box, entity type, or geometry role. Every record carries its vertex count and a WGS 84 bounding box, so where it is never depends on this call returning coordinates; pass include_geojson true for the coordinates themselves. Source bytes are never returned.',
  stores: ['geometry'],
  evidence: ['geometry', 'routes'],
  requiredFunctions: [READ],
  input: {
    revision_id: field.uuid({ required: true }),
    entity_id: field.uuid(),
    bbox: field.bbox(),
    entity_type: field.string(),
    geometry_role: field.enum([
      'BOUNDARY',
      'FOOTPRINT',
      'FLOOR_BOUNDARY',
      'ROOM_BOUNDARY',
      'ROUTE',
      'CONNECTION_POINT',
      'CONSTRAINT_AREA',
      'REFERENCE_POINT',
    ]),
    include_geojson: field.bool({ default: false }),
    limit: field.int({ min: 1, max: 200, default: 50 }),
    cursor: field.string(),
  },
  handler: async ({ client, args, context }) => {
    const bbox = args.bbox ?? [null, null, null, null];
    const { rows } = await client.query(QUERY_GEOMETRY_SQL, [
      context.projectId,
      context.revisionId,
      args.include_geojson === true,
      args.entity_id ?? null,
      args.entity_type ?? null,
      args.geometry_role ?? null,
      bbox[0],
      bbox[1],
      bbox[2],
      bbox[3],
    ]);
    const items = rows.map(mapGeometryRow);
    const page = paginate(items, { revisionId: context.revisionId, limit: args.limit, cursor: args.cursor });
    /*
     * The page says how to read the part it did not return.
     *
     * The description says it too, and the description was not enough: a model chose this tool,
     * read a null where the shape would have been, told the user coordinate data was "not exposed
     * in this environment", and abandoned the task. A description is read once, when the tool is
     * picked; the result is read every time. So a page that carries no coordinates names the
     * argument that would, in its own words.
     *
     * Deliberately not `notice`. That field is a truncation report — something the caller is
     * expected to relay to the reader — and "call me again with include_geojson" is an
     * instruction for the caller, which a reader has no use for.
     */
    return {
      ...page,
      coordinates_omitted: page.returned > 0 && args.include_geojson !== true
        ? 'Pass include_geojson: true to receive each record\'s coordinates.'
        : null,
    };
  },
});

/**
 * A record's position, in constant size.
 *
 * `bbox4326` and `vertexCount` are computed for every row, whether or not the coordinates are
 * asked for, and that is the point of them. A geometry record always has geometry, so a result
 * that carried no position at all was indistinguishable from one whose entity has none: a live
 * turn read `geojson4326: null`, told the user coordinate data was "not exposed in this
 * environment", spent six rounds re-asking, and abandoned the task it had been given.
 *
 * They are also what keeps a page bounded. Coordinates grow with the shape — a boundary of five
 * thousand vertices is 119 KB on its own, nearly four times the whole 32 KB result budget, and
 * the over-budget profile clips arrays at fifty items, so such a record came back as a shape
 * that is not the shape. These two are ~115 bytes whatever the geometry is.
 */
const QUERY_GEOMETRY_SQL = `
  SELECT geometry_id, entity_id, entity_type, role, ordinal, geometry_type, projected_crs, vertical_crs,
         parent_transform_id, elevation_base_m, elevation_top_m, height_m, provenance, created_at,
         ST_NPoints(geojson_4326) AS vertex_count,
         ARRAY[ST_XMin(geojson_4326), ST_YMin(geojson_4326), ST_XMax(geojson_4326), ST_YMax(geojson_4326)] AS bbox_4326,
         CASE WHEN $3 THEN ST_AsGeoJSON(geojson_4326)::json ELSE NULL END AS geojson_4326
    FROM geometry_records
   WHERE project_id = $1 AND revision_id = $2
     AND ($4::uuid IS NULL OR entity_id = $4)
     AND ($5::text IS NULL OR entity_type::text = $5)
     AND ($6::text IS NULL OR role::text = $6)
     AND ($7::float8 IS NULL OR ST_Intersects(geojson_4326, ST_MakeEnvelope($7, $8, $9, $10, 4326)))
   ORDER BY entity_type, role, ordinal, geometry_id`;

function mapGeometryRow(row) {
  return {
    geometryId: row.geometry_id,
    entityId: row.entity_id,
    entityType: row.entity_type,
    role: row.role,
    ordinal: row.ordinal,
    geometryType: row.geometry_type,
    projectedCrs: row.projected_crs,
    verticalCrs: row.vertical_crs,
    parentTransformId: row.parent_transform_id,
    elevationBaseM: row.elevation_base_m,
    elevationTopM: row.elevation_top_m,
    heightM: row.height_m,
    provenance: row.provenance,
    createdAt: row.created_at,
    // Always present, so a reader never has to guess whether a missing position means "not asked"
    // or "there is none". A point's box is degenerate and still names where the point is.
    vertexCount: row.vertex_count ?? null,
    bbox4326: row.bbox_4326 ?? null,
    geojson4326: row.geojson_4326 ?? null,
  };
}

/**
 * The one wall-clock predicate this surface admits.
 *
 * `NEAREST` is deliberately absent. "Nearest to what, over which candidate set,
 * breaking ties how" has no answer the catalog asserts, and a ranking tool with a
 * made-up tie-break is a tool that returns a different answer than a reader
 * expects. Distance and containment are well defined; ranking is not, yet.
 */
const PREDICATES = Object.freeze(['WITHIN', 'CONTAINS', 'INTERSECTS', 'WITHIN_DISTANCE', 'DISTANCE']);

const selectorSchema = field.object({
  fields: {
    entity_id: field.uuid(),
    geometry_id: field.uuid(),
    bbox: field.bbox(),
  },
});

export const spatialQuery = defineTool({
  name: 'spatial_query',
  axis: 'COMPUTATION',
  access: 'read',
  description:
    'Compute a spatial relation between two subjects (an entity, a geometry record, or a bounding box) in the projected CRS. Returns live measurements, never a stored diagnostic.',
  stores: ['geometry'],
  requiredFunctions: [READ],
  input: {
    revision_id: field.uuid({ required: true }),
    predicate: field.enum(PREDICATES, { required: true }),
    subject: selectorSchema,
    target: selectorSchema,
    distance_m: field.number({ min: 0 }),
    crs: field.string({ default: DEFAULT_CRS }),
  },
  when: (value) => {
    if (!selectorOf(value.subject)) return { field: 'subject', reason: 'no_selector' };
    if (!selectorOf(value.target)) return { field: 'target', reason: 'no_selector' };
    if (value.predicate === 'WITHIN_DISTANCE' && typeof value.distance_m !== 'number') {
      return { field: 'distance_m', reason: 'required_for_within_distance' };
    }
    return null;
  },
  handler: async ({ client, args, context }) => {
    const params = [context.projectId, context.revisionId];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const subjectSql = selectorSql(args.subject, add);
    const targetSql = selectorSql(args.target, add);
    const distanceParam = args.predicate === 'WITHIN_DISTANCE' ? add(args.distance_m) : null;

    const { rows } = await client.query(
      `SELECT
         ST_Intersects(s.g, t.g) AS intersects,
         ST_Within(s.g, t.g) AS subject_within_target,
         ST_Contains(s.g, t.g) AS subject_contains_target,
         ST_Distance(s.g, t.g) AS distance_m,
         ${distanceParam ? `ST_DWithin(s.g, t.g, ${distanceParam})` : 'NULL'} AS within_distance
       FROM (SELECT ${subjectSql} AS g) s, (SELECT ${targetSql} AS g) t`,
      params,
    );

    const row = rows[0] ?? {};
    const subjectFound = row.distance_m !== null && row.distance_m !== undefined;
    const predicateResult = !subjectFound
      ? null
      : {
          WITHIN: row.subject_within_target,
          CONTAINS: row.subject_contains_target,
          INTERSECTS: row.intersects,
          WITHIN_DISTANCE: row.within_distance,
          DISTANCE: null,
        }[args.predicate];

    return {
      predicate: args.predicate,
      crs: args.crs ?? DEFAULT_CRS,
      subject: args.subject,
      target: args.target,
      satisfied: args.predicate === 'DISTANCE' ? null : predicateResult,
      distanceM: subjectFound ? Number(row.distance_m) : null,
      distanceLimitM: args.predicate === 'WITHIN_DISTANCE' ? args.distance_m : null,
      subjectResolved: subjectFound,
      note: subjectFound
        ? 'A computed measurement. It is not a validation diagnostic and does not change coverage.'
        : 'At least one selector resolved to no geometry in this revision, so no measurement exists.',
    };
  },
});

/** A selector is exactly one of the three addressing forms. */
function selectorOf(selector) {
  if (!selector || typeof selector !== 'object') return null;
  const present = ['entity_id', 'geometry_id', 'bbox'].filter((key) => selector[key] !== undefined && selector[key] !== null);
  return present.length === 1 ? present[0] : null;
}

function selectorSql(selector, add) {
  const kind = selectorOf(selector);
  if (kind === 'geometry_id') {
    return `(SELECT projected_geometry FROM geometry_records WHERE project_id = $1 AND revision_id = $2 AND geometry_id = ${add(
      selector.geometry_id,
    )})`;
  }
  if (kind === 'entity_id') {
    return `(SELECT ST_Union(projected_geometry) FROM geometry_records WHERE project_id = $1 AND revision_id = $2 AND entity_id = ${add(
      selector.entity_id,
    )})`;
  }
  if (kind === 'bbox') {
    const [minX, minY, maxX, maxY] = selector.bbox;
    // The box arrives in WGS 84 degrees and is measured in the projected CRS, so
    // it is transformed before any predicate touches it.
    return `ST_Transform(ST_MakeEnvelope(${add(minX)}, ${add(minY)}, ${add(maxX)}, ${add(maxY)}, 4326), 32618)`;
  }
  throw new ApiError('VALIDATION_FAILED', 'A spatial selector must name exactly one of entity_id, geometry_id, or bbox.', {
    status: 400,
    details: [{ field: 'selector', reason: 'ambiguous_selector' }],
  });
}

/**
 * A single point for a geometry: the interior of a polygon, the point itself, a line's midpoint.
 *
 * The surface could already read coordinates and ask whether two geometries relate, but nothing
 * could answer "a point inside that shape". That is the one question a caller needs in order to put
 * a connection point inside a yard, and without it a model has to invent a coordinate — which is
 * how a live turn ended up refusing, correctly, because it could not know an interior point.
 *
 * The answer is computed on the **projected** geometry and transformed back, because a centroid
 * taken in degrees is not the same point as a centroid taken in metres, and `ST_Centroid` is only
 * guaranteed to land inside a convex shape — over a concave yard the two can differ by much more
 * than the yard is wide. PostGIS is the authority here for the same reason `spatial_query` is a
 * tool rather than arithmetic in the handler.
 */
export const geometryPoint = defineTool({
  name: 'geometry_point',
  axis: 'COMPUTATION',
  access: 'read',
  description:
    'Return one point for an entity\'s geometry: the interior of a polygon, the point for a point, the midpoint of a line. WGS 84 GeoJSON, with the projected form alongside.',
  stores: ['geometry'],
  evidence: ['geometry'],
  requiredFunctions: [READ],
  input: {
    revision_id: field.uuid({ required: true }),
    entity_id: field.uuid({ required: true }),
    geometry_role: field.enum([
      'BOUNDARY',
      'FOOTPRINT',
      'FLOOR_BOUNDARY',
      'ROOM_BOUNDARY',
      'ROUTE',
      'CONNECTION_POINT',
      'CONSTRAINT_AREA',
      'REFERENCE_POINT',
    ], { required: true }),
    ordinal: field.int({ min: 0, default: 0 }),
  },
  handler: async ({ client, args, context }) => {
    const { rows } = await client.query(GEOMETRY_POINT_SQL, [
      context.projectId,
      context.revisionId,
      args.entity_id,
      args.geometry_role,
      args.ordinal ?? 0,
    ]);
    const row = rows[0];
    if (!row) {
      // A stated miss rather than an error: "this entity holds no geometry in that role" is an
      // answer to the question asked, and it is the same answer an unplaced object should get.
      return { entityId: args.entity_id, role: args.geometry_role, ordinal: args.ordinal ?? 0, geometryType: null, point: null };
    }
    return {
      entityId: row.entity_id,
      role: row.role,
      ordinal: row.ordinal,
      geometryType: row.geometry_type,
      point: {
        geojson4326: row.geojson_4326,
        projected: row.projected_point,
        projectedCrs: row.projected_crs,
      },
    };
  },
});

const GEOMETRY_POINT_SQL = `
  SELECT entity_id, role, ordinal, geometry_type, projected_crs,
         ST_AsGeoJSON(ST_Force2D(ST_Transform(pt.p, 4326)))::json AS geojson_4326,
         ST_AsGeoJSON(ST_Force2D(pt.p))::json AS projected_point
    FROM (
      SELECT g.*, ST_Centroid(g.projected_geometry) AS p
        FROM geometry_records g
       WHERE g.project_id = $1 AND g.revision_id = $2
         AND g.entity_id = $3 AND g.role::text = $4 AND g.ordinal = $5
    ) pt`;


export const SPATIAL_TOOLS = Object.freeze([queryGeometry, spatialQuery, geometryPoint]);
export { PREDICATES };
