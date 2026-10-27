/**
 * Moving a placed object.
 *
 * `set_geometry` upserts on `(entity_id, entity_type, revision_id, role, ordinal, project_id)`,
 * so a move is not a new operation to the server: it is the same change written with different
 * coordinates. That is why nothing here is a "move" endpoint — the caller stages `set_geometry`
 * per part, and the change set, the commit, and the audit trail are the ones placement already
 * uses.
 *
 * The one thing a move has to get right is that **every part of the entity moves together**. An
 * entity can hold more than one role — an equipment yard with a BOUNDARY and a footprint, an
 * interface with a CONNECTION_POINT and a route — and a footprint dragged to the other side of
 * the site while its boundary stayed put would be a corrupt design that the validator would not
 * catch. The heights ride along too, because they are not part of the position.
 *
 * `translateGeometry`, `placementPlan`, and `placementChanges` mirror
 * `packages/facility/src/geometry-move.js` exactly — the browser cannot import a server package,
 * so the composition is restated here rather than shared. One fixture
 * (`packages/facility/src/tests/fixtures/geometry-move-cases.json`) is run through both copies by
 * `move-geometry-parity.test.js`, so the two cannot drift. What this module adds is only the
 * screen-delta wrapper: turning a drag into a translation is the part that needs a viewport.
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
 * ordinal, and heights. `translate` maps the record's WGS 84 GeoJSON to where it should be.
 */
export function placementPlan(records, translate) {
  return (records ?? [])
    .filter((record) => record?.geojson4326)
    .map((record) => ({
      entityId: record.entityId,
      role: record.role,
      ordinal: record.ordinal ?? 0,
      // Not a position field, but the record's own values are what a move has to preserve, so
      // they are carried rather than defaulted.
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

/**
 * The world-space delta a screen drag is worth.
 *
 * Longitude and latitude do not scale together: a degree of longitude covers less ground the
 * further it is from the equator, so a pixel is worth `1/cos(latitude)` more longitude than
 * latitude. Unprojecting both corners of the drag gets this exactly, at whatever zoom, rather
 * than approximating it with a constant.
 */
export function movePlan({ records = [], unproject, fromPx, toPx }) {
  const from = unproject(fromPx);
  const to = unproject(toPx);
  const deltaLon = to[0] - from[0];
  const deltaLat = to[1] - from[1];

  return placementPlan(records, (geojson) => translateGeometry(geojson, { deltaLon, deltaLat }));
}
