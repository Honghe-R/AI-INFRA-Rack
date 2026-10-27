import { ChangeRejected, ChangeConflict } from './change-kind-shared.js';
import { applyTransform, fitAffine2D, fitSimilarity2D, unitFactor } from '@ai-infra/imports';

/**
 * The `transform_geometry` change kind.
 *
 * This is the one kind PENDING_CHANGE_KINDS named as blocked by T3: a
 * `spatial_transforms` row needs an `asset_binding`, so the kind could not exist
 * before the binding and transform commands did. It re-projects an existing geometry
 * record through a reviewed transform and records the provenance the geometry now
 * carries — `parent_transform_id`, `binding_id`, and `asset_version_id` — which is
 * what lets a later validation ask "which reviewed transform produced this?".
 *
 * It is exported as its own registry rather than merged into `CHANGE_KINDS` so the
 * integrator can compose it in `change-kinds.js` without this module importing the
 * registry it is about to be part of (a cycle). Merge with:
 *
 *   import { IMPORT_CHANGE_KINDS, IMPORT_KIND_RANK } from './change-kinds-imports.js';
 *   export const CHANGE_KINDS = { ..., ...IMPORT_CHANGE_KINDS };
 *   export const KIND_RANK = { ..., ...IMPORT_KIND_RANK };
 *
 * Re-projection is deliberately honest about what it can do. A declared source and
 * target CRS in EPSG form is re-projected with PostGIS, which is the geodetic
 * provider the framework does not embed. A fit method is re-derived from the
 * transform's stored control points, because `spatial_transforms` has no parameters
 * column — the fitted coefficients are recomputed at apply time from the reviewed
 * control points rather than stored, and that is a recorded delta. A method that
 * needs a provider the deployment does not have is refused with a clear 422 rather
 * than approximated.
 */

/** The kind, composed. `permission` is the geometry key the contract names. */
const transformGeometry = {
  kind: 'transform_geometry',
  permission: 'facility.geometry.write',
  async apply({ client, projectId, revisionId, actorId, change }) {
    const payload = change.payload ?? {};
    const geometryId = payload.geometry_id;
    const transformId = payload.transform_id;
    if (!geometryId) throw new ChangeRejected('The change requires a geometry id.', { field: 'payload.geometry_id', reason: 'required' });
    if (!transformId) throw new ChangeRejected('The change requires a transform id.', { field: 'payload.transform_id', reason: 'required' });

    const geometry = (
      await client.query(
        `SELECT geometry_id, entity_id, entity_type, role, geometry_type, projected_crs,
                ST_AsGeoJSON(geojson_4326) AS geojson_4326,
                ST_AsGeoJSON(projected_geometry) AS projected_geojson
           FROM geometry_records
          WHERE project_id = $1 AND revision_id = $2 AND geometry_id = $3`,
        [projectId, revisionId, geometryId],
      )
    ).rows[0];
    if (!geometry) throw new ChangeRejected('The geometry does not exist in this revision.', { field: 'payload.geometry_id', reason: 'not_found' });

    const transform = (
      await client.query(
        `SELECT transform_id, binding_id, asset_version_id, source_units, target_units, source_crs, target_crs,
                method, control_points, review_state
           FROM spatial_transforms
          WHERE project_id = $1 AND revision_id = $2 AND transform_id = $3`,
        [projectId, revisionId, transformId],
      )
    ).rows[0];
    if (!transform) throw new ChangeRejected('The transform does not exist in this revision.', { field: 'payload.transform_id', reason: 'not_found' });
    if (transform.review_state !== 'REVIEWED') {
      throw new ChangeConflict('Only a reviewed transform may re-project authoritative geometry.', {
        reason: 'transform_not_reviewed',
        constraint_id: 'import.transform.unreviewed',
        transform_id: transformId,
        review_state: transform.review_state,
      });
    }

    const targetSrid = epsgSrid(transform.target_crs);
    const projectedSrid = epsgSrid(geometry.projected_crs);
    const canReproject = targetSrid !== null && targetSrid > 0;

    // The CRS path: a declared/projected/Helmert transform with an EPSG target is
    // exactly what PostGIS is for, so the WGS 84 geometry is re-projected directly.
    if (canReproject && CRS_METHODS.includes(transform.method)) {
      const { rows } = await client.query(
        `UPDATE geometry_records
            SET projected_geometry = ST_Transform(geojson_4326, $4::integer), projected_crs = $5,
                parent_transform_id = $6, binding_id = $7, asset_version_id = $8,
                updated_at = now(), updated_by = $9
          WHERE project_id = $1 AND revision_id = $2 AND geometry_id = $3
        RETURNING geometry_id`,
        [
          projectId, revisionId, geometryId, targetSrid, transform.target_crs,
          transformId, transform.binding_id, transform.asset_version_id, actorId,
        ],
      );
      return {
        entityRef: { entity_id: geometry.entity_id, entity_type: geometry.entity_type },
        geometryId: rows[0].geometry_id,
        transformId,
        projectedCrs: transform.target_crs,
        method: 'crs',
      };
    }

    const projected = reprojectInProcess({ geometry, transform });
    if (!projected) {
      throw new ChangeRejected('This transform cannot be applied without a geodetic provider.', {
        field: 'payload.transform_id',
        reason: 'provider_required',
        method: transform.method,
        source_crs: transform.source_crs,
        target_crs: transform.target_crs,
        note: 'Declare both CRS values in EPSG form, or use a control-point or unit-scale method.',
      });
    }
    const srid = projectedSrid ?? targetSrid;
    if (!srid || srid <= 0) {
      throw new ChangeRejected('The stored geometry has no SRID, so re-projection cannot be written.', {
        field: 'payload.geometry_id',
        reason: 'projected_crs_unknown',
        projected_crs: geometry.projected_crs,
      });
    }

    const { rows } = await client.query(
      `UPDATE geometry_records
          SET projected_geometry = ST_SetSRID(ST_GeomFromGeoJSON($4), $5::integer), projected_crs = $6,
              parent_transform_id = $7, binding_id = $8, asset_version_id = $9,
              updated_at = now(), updated_by = $10
        WHERE project_id = $1 AND revision_id = $2 AND geometry_id = $3
      RETURNING geometry_id`,
      [
        projectId, revisionId, geometryId, JSON.stringify(projected.geojson), srid,
        projected.projectedCrs ?? geometry.projected_crs,
        transformId, transform.binding_id, transform.asset_version_id, actorId,
      ],
    );

    return {
      entityRef: { entity_id: geometry.entity_id, entity_type: geometry.entity_type },
      geometryId: rows[0].geometry_id,
      transformId,
      projectedCrs: projected.projectedCrs ?? geometry.projected_crs,
      method: projected.method,
      residualErrorM: projected.residualErrorM ?? null,
    };
  },
};

/** Methods whose whole job is a declared CRS relationship; PostGIS projects them. */
const CRS_METHODS = Object.freeze(['DECLARED_CRS', 'CONTROL_POINTS_HELMERT']);

export const IMPORT_CHANGE_KINDS = Object.freeze({ transform_geometry: transformGeometry });

/**
 * After `set_geometry` (rank 30): a set that creates or replaces a geometry and then
 * declares the transform behind it must write the geometry first.
 */
export const IMPORT_KIND_RANK = Object.freeze({ transform_geometry: 31 });

/**
 * Re-projects a geometry in process from the transform's stored evidence.
 *
 * Returns null when the method needs a geodetic provider this process does not
 * embed; the caller turns that into a `422` rather than guessing a reprojection.
 */
function reprojectInProcess({ geometry, transform }) {
  const projected = JSON.parse(geometry.projected_geojson);
  const points = Array.isArray(transform.control_points) ? transform.control_points : [];

  if (transform.method === 'DECLARED_CRS' || transform.method === 'MANUAL') {
    // No provider and no fit evidence: nothing this process can honestly do.
    return null;
  }

  if (transform.method === 'CONTROL_POINTS_HELMERT') return null;

  if (transform.method === 'UNIT_SCALE') {
    let factor;
    try {
      factor = unitFactor(transform.source_units, transform.target_units);
    } catch {
      return null;
    }
    return {
      geojson: mapGeometry(projected, (coordinate) => applyTransform('UNIT_SCALE', { factor }, coordinate)),
      method: 'unit_scale',
      projectedCrs: geometry.projected_crs,
    };
  }

  if (transform.method === 'CONTROL_POINTS_AFFINE') {
    if (points.length < 3) return null;
    const { parameters, residualErrorM } = fitAffine2D(points);
    return {
      geojson: mapGeometry(projected, (coordinate) => applyTransform('AFFINE_2D', parameters, coordinate)),
      method: 'affine_2d',
      projectedCrs: geometry.projected_crs,
      residualErrorM,
    };
  }

  if (transform.method === 'FITTED_RESIDUAL') {
    if (points.length >= 3) {
      const { parameters, residualErrorM } = fitAffine2D(points);
      return {
        geojson: mapGeometry(projected, (coordinate) => applyTransform('AFFINE_2D', parameters, coordinate)),
        method: 'affine_2d',
        projectedCrs: geometry.projected_crs,
        residualErrorM,
      };
    }
    if (points.length >= 2) {
      const { parameters, residualErrorM } = fitSimilarity2D(points);
      return {
        geojson: mapGeometry(projected, (coordinate) => applyTransform('SIMILARITY_2D', parameters, coordinate)),
        method: 'similarity_2d',
        projectedCrs: geometry.projected_crs,
        residualErrorM,
      };
    }
    return null;
  }

  return null;
}

function mapGeometry(geojson, fn) {
  switch (geojson?.type) {
    case 'Point':
      return { ...geojson, coordinates: fn(geojson.coordinates) };
    case 'MultiPoint':
      return { ...geojson, coordinates: geojson.coordinates.map(fn) };
    case 'LineString':
      return { ...geojson, coordinates: geojson.coordinates.map(fn) };
    case 'MultiLineString':
      return { ...geojson, coordinates: geojson.coordinates.map((line) => line.map(fn)) };
    case 'Polygon':
      return { ...geojson, coordinates: geojson.coordinates.map((ring) => ring.map(fn)) };
    case 'MultiPolygon':
      return { ...geojson, coordinates: geojson.coordinates.map((polygon) => polygon.map((ring) => ring.map(fn))) };
    default:
      throw new ChangeRejected('The stored geometry is not a shape this kind can re-project.', {
        reason: 'unsupported_geometry',
        geometry_type: geojson?.type ?? null,
      });
  }
}

/** `EPSG:32618` to 32618, or null when the CRS is absent or not EPSG-coded. */
function epsgSrid(crs) {
  const match = /^EPSG:(\d+)$/i.exec(String(crs ?? '').trim());
  return match ? Number(match[1]) : null;
}

export { ChangeConflict, ChangeRejected };
