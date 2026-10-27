/**
 * The edits that have been staged but not committed.
 *
 * A change set is a claim about what the revision *will* look like. Until it was rendered, the
 * map showed the revision as it currently is, so a move looked like it had been thrown away the
 * moment the pointer came up: the object snapped back to where it started and the only trace of
 * the edit was a line in a panel. An edit the author cannot see is an edit the author cannot
 * check.
 *
 * So a staged `set_geometry` is drawn at its intended coordinates, marked as pending. The map is
 * showing a revision-plus-change-set rather than the revision — the same thing the commit will
 * produce, which is what makes the preview worth looking at.
 *
 * Only the latest change per entity and role is kept, which is the same rule the change set
 * itself applies: `stageChange` drops the change a later one supersedes, so re-placing a
 * footprint or moving an object twice leaves one geometry in the set and one on the map.
 */

/** The key a geometry edit is addressed by: the entity and the role it fills. */
function editKey(entityId, role) {
  return `${entityId}|${role}`;
}

/**
 * A map from `entityId|role` to the geometry the change set intends.
 *
 * Deliberately tolerant of a change set whose envelope is not loaded: a change that does not name
 * an entity and a role is not one this surface can draw, and skipping it is better than drawing
 * a shape at the origin.
 */
export function stagedGeometry(changes = []) {
  const edits = new Map();
  for (const change of changes) {
    if (change?.kind !== 'set_geometry') continue;
    const entityId = change.entity_ref?.entity_id;
    const role = change.payload?.role;
    const geojson = change.payload?.geojson_4326;
    if (!entityId || !role || !geojson?.type) continue;
    edits.set(editKey(entityId, role), geojson);
  }
  return edits;
}

/** Whether a feature is one the change set has re-written, and with what. */
export function editFor(edits, feature) {
  if (!edits || edits.size === 0 || !feature?.entityId || !feature?.role) return null;
  return edits.get(editKey(feature.entityId, feature.role)) ?? null;
}
