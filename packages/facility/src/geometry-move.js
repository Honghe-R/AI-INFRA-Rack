/**
 * Moving a placed object, composed once.
 *
 * `set_geometry` upserts on `(entity_id, entity_type, revision_id, role, ordinal, project_id)`,
 * so a move is not its own operation: it is the same change written with different coordinates.
 * What a move *does* have to get right is that every part of the entity moves together — an
 * equipment yard with a boundary and a footprint, an interface with a connection point and a
 * route — and that each part keeps the heights that are not part of its position. A footprint
 * dragged to the other side of the site while its boundary stayed put would be a corrupt design
 * the validator does not catch, and a move that dropped a building's stored height would be a
 * quiet data loss.
 *
 * Both surfaces compose that the same way, and this module is where the composition is stated:
 * the drag on the canvas and an assistant placement are the same change set, reached from two
 * surfaces. It is pure and dependency-free because the browser cannot import a server package —
 * the client keeps its own copy of these three functions, and a shared fixture pins the two
 * implementations together (`apps/web/src/tests/move-geometry-parity.test.js`).
 */

/** Every position in a GeoJSON object, whatever its shape. */
function eachPosition(geojson, visit) {
  if (!geojson || !geojson.type) return true;
  const walk = (node) => {
    if (!Array.isArray(node)) return true;
    // A position is an array of numbers; anything else is a container to descend into.
    if (typeof node[0] === 'number') return visit(node);
    return node.every(walk);
  };
  return walk(geojson.coordinates);
}

/** The same GeoJSON, every position shifted by the same delta. */
export function translateGeometry(geojson, { deltaLon = 0, deltaLat = 0 } = {}) {
  if (!geojson || !geojson.type) return null;
  // Structured-cloned rather than mutated: the caller's record is the revision's own data, and
  // a draft must not write through to it.
  const moved = JSON.parse(JSON.stringify(geojson));
  eachPosition(moved, (position) => {
    position[0] = position[0] + deltaLon;
    position[1] = position[1] + deltaLat;
    return true;
  });
  return moved;
}

/**
 * The parts a placement rewrites: every geometry record given, each carrying its own role,
 * ordinal, and heights, so no part is moved without the metadata that belongs to it.
 *
 * `translate` maps the record's WGS 84 GeoJSON to where it should be — a screen delta for a
 * drag, a target for a placement — which is the one thing the two surfaces compute differently.
 */
export function placementPlan(records, translate) {
  return (records ?? [])
    .filter((record) => record?.geojson4326)
    .map((record) => ({
      entityId: record.entityId,
      role: record.role,
      ordinal: record.ordinal ?? 0,
      elevationBaseM: record.elevationBaseM ?? null,
      elevationTopM: record.elevationTopM ?? null,
      heightM: record.heightM ?? null,
      geojson: translate(record.geojson4326),
    }));
}

/** The `set_geometry` changes a plan commits, in the one payload shape both surfaces write. */
export function placementChanges(plan) {
  return (plan ?? []).map((part) => ({
    kind: 'set_geometry',
    entity_ref: { entity_id: part.entityId },
    payload: {
      role: part.role,
      ordinal: part.ordinal ?? 0,
      geojson_4326: part.geojson,
      elevation_base_m: part.elevationBaseM ?? null,
      elevation_top_m: part.elevationTopM ?? null,
      height_m: part.heightM ?? null,
    },
  }));
}
