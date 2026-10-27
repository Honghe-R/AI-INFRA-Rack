/**
 * Authoring state for the Site & Facility editor.
 *
 * A draft is edited through one typed change set, committed explicitly. That shape is
 * the specification's ([D1](../../../doc/tools/site-and-facility/decisions.md), "mutable
 * in place under optimistic concurrency"), and it is what makes the shell's existing
 * dirty-state machinery meaningful: edits accumulate client-side, the tab is dirty until
 * they are committed, and closing the tab asks before discarding them.
 *
 * Everything here is pure. Staging, un-staging, and the conflict decision are the parts
 * worth testing without a browser, so they live outside React and the network.
 *
 * Two staging rules matter more than they look:
 *
 *  * A change that supersedes an earlier pending one **replaces** it rather than
 *    stacking. Re-drawing a footprint twice must commit one geometry record, not two
 *    that fight over the same role.
 *  * Staging a removal **cancels** that entity's pending edits, because committing an
 *    update and a remove for one entity in the same set is a conflict the user did not
 *    ask for.
 */

/** A stable key for what a change affects, so a later change can replace it. */
export function changeKey(change) {
  const payload = change?.payload ?? {};
  const entityId = change?.entity_ref?.entity_id ?? null;
  switch (change?.kind) {
    case 'create_container':
      return `container:${payload.container_id ?? 'unnamed'}`;
    case 'update_entity':
      return `entity:${entityId}`;
    case 'set_geometry':
      return `geometry:${entityId}:${payload.role ?? '?'}:${payload.ordinal ?? 0}`;
    case 'remove_entity':
      return `remove:${entityId}`;
    case 'assign_phase':
      return `phase:${entityId}`;
    case 'set_utility_source':
      return `source:${payload.utility_source_id ?? 'new'}`;
    case 'set_utility_interface':
      return `interface:${payload.interface_id ?? 'new'}`;
    default:
      return `${change?.kind ?? 'unknown'}:${entityId ?? payload.id ?? JSON.stringify(payload)}`;
  }
}

export function emptyChangeSet({ revisionId = null, baseRevisionId = null, etag = null } = {}) {
  return { revisionId, baseRevisionId, etag, changes: [] };
}

/**
 * Points the pending set at the revision and token the surface is currently showing.
 *
 * Two rules, and the second is not an optimisation. A different revision starts a fresh set —
 * carrying edits across would apply them to a graph the user never saw. And an unchanged
 * binding returns the *identical* set, because this runs from an effect keyed on the envelope:
 * returning a fresh object every time would be a state update per render, which is a loop
 * rather than a re-bind.
 */
export function bindChangeSet(changeSet, { revisionId = null, envelope = null } = {}) {
  const etag = envelope?.etag ?? null;
  const baseRevisionId = envelope?.revisionId ?? revisionId ?? null;
  const current = changeSet ?? emptyChangeSet({ revisionId });
  if (current.revisionId !== revisionId) return emptyChangeSet({ revisionId, baseRevisionId, etag });
  if (current.baseRevisionId === baseRevisionId && current.etag === etag) return current;
  return { ...current, baseRevisionId, etag };
}

/**
 * Adds a change, replacing whatever pending change it supersedes.
 *
 * A removal also drops every pending change for that entity: the set would otherwise ask
 * the server to update and delete the same object, which is a conflict manufactured by
 * the client.
 */
export function stageChange(changeSet, change) {
  const changes = [...(changeSet?.changes ?? [])];
  const key = changeKey(change);
  const withoutSuperseded = changes.filter((existing) => {
    const existingKey = changeKey(existing);
    if (existingKey === key) return false;
    if (change.kind === 'remove_entity') {
      // Everything targeting the removed entity goes with it.
      const target = change.entity_ref?.entity_id;
      const existingTarget = existing.entity_ref?.entity_id ?? existing.payload?.container_id;
      if (target && existingTarget === target) return false;
    }
    return true;
  });
  withoutSuperseded.push(change);
  return { ...changeSet, changes: withoutSuperseded };
}

export function unstageChange(changeSet, index) {
  const changes = [...(changeSet?.changes ?? [])];
  if (index < 0 || index >= changes.length) return changeSet;
  changes.splice(index, 1);
  return { ...changeSet, changes };
}

export function isDirty(changeSet) {
  return (changeSet?.changes?.length ?? 0) > 0;
}

export function changeSetSummary(changeSet) {
  const summary = {};
  for (const change of changeSet?.changes ?? []) {
    summary[change.kind] = (summary[change.kind] ?? 0) + 1;
  }
  return { total: changeSet?.changes?.length ?? 0, byKind: summary };
}

/**
 * A human line for one pending change, so the list says what will happen rather than
 * naming a change kind at the user.
 */
export function describeChange(change, { nameOf = () => null } = {}) {
  const payload = change?.payload ?? {};
  const entityId = change?.entity_ref?.entity_id ?? null;
  const name = entityId ? nameOf(entityId) : null;
  const subject = name ?? (entityId ? `entity ${String(entityId).slice(0, 8)}…` : 'the revision');

  switch (change?.kind) {
    case 'create_container':
      return `Create ${payload.container_kind?.toLowerCase() ?? 'container'} “${payload.name ?? 'unnamed'}”`;
    case 'update_entity':
      return `Edit ${subject} (${Object.keys(payload.patch ?? {}).join(', ')})`;
    case 'set_geometry': {
      const points = countPositions(payload.geojson_4326);
      const role = String(payload.role ?? 'geometry').toLowerCase().replace(/_/g, ' ');
      // A point is placed, a ring is drawn, and a line is drawn: the verb follows the
      // verb the tool uses, so the pending list reads back the action the user took.
      const verb = payload.geojson_4326?.type === 'Point' ? 'Place' : 'Draw';
      // "1 vertex", not "1 vertices" — a connection point is a single vertex and the
      // list is read by someone deciding whether to commit it.
      const count = points === 1 ? '1 vertex' : `${points} vertices`;
      return `${verb} ${role} for ${subject}${points ? ` (${count})` : ''}`;
    }
    case 'remove_entity':
      return `Remove ${subject}${payload.cascade === 'CHILDREN' ? ' and its children' : ''}`;
    case 'assign_phase':
      return `Assign ${subject} to a phase`;
    case 'set_utility_source':
      return `Set utility source “${payload.name ?? subject}” to ${payload.capacity_state ?? 'a new state'}`;
    default:
      return String(change?.kind ?? 'change').replace(/_/g, ' ');
  }
}

/** The number of positions in a GeoJSON geometry, for a readable summary. */
export function countPositions(geometry) {
  if (!geometry) return 0;
  const walk = (node) => {
    if (!Array.isArray(node)) return 0;
    if (typeof node[0] === 'number') return 1;
    return node.reduce((total, child) => total + walk(child), 0);
  };
  return walk(geometry.coordinates);
}

/**
 * Why authoring is unavailable, or null when it is available.
 *
 * Stated rather than implied: a canvas that silently refuses to edit is worse than one
 * that says the revision is validated, or that the role cannot write.
 */
export function authoringBlockers({ envelope = null, canWrite = false, pending = false } = {}) {
  if (!canWrite) return 'Editing needs a facility write permission your role does not hold.';
  if (!envelope) return pending ? 'Reading the revision…' : 'The revision could not be read.';
  if (envelope.lifecycleState && envelope.lifecycleState !== 'DRAFT') {
    return `This revision is ${envelope.lifecycleState} and cannot be edited. Branch a draft to make changes.`;
  }
  if (!envelope.etag) return 'This revision has no draft ETag, so a change cannot be conditioned on its state.';
  return null;
}

/** A closed ring from the points the user clicked, or null when there is no polygon yet. */
export function polygonFromPoints(points = []) {
  if (points.length < 3) return null;
  const ring = [...points, points[0]];
  return { type: 'Polygon', coordinates: [ring] };
}

/** A rough area for the in-progress polygon, in square degrees, for a live hint. */
export function draftAreaHint(points = []) {
  if (points.length < 3) return 0;
  // Shoelace on lon/lat, then scaled to an approximate area in square metres at the
  // centroid latitude. Approximate on purpose: it is a hint while drawing, and the
  // authoritative area is measured in the projected CRS by PostGIS.
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  const squareDegrees = Math.abs(sum) / 2;
  const meanLat = points.reduce((total, point) => total + point[1], 0) / points.length;
  const metresPerDegreeLat = 111_320;
  const metresPerDegreeLon = 111_320 * Math.cos((meanLat * Math.PI) / 180);
  return squareDegrees * metresPerDegreeLat * metresPerDegreeLon;
}

/** A new container identity, minted here so its footprint can address it in the same set. */
/**
 * Mints the identity a new entity will have.
 *
 * The identity is minted on the client because a change set may need to address the new
 * entity in a second change before the server has created it — a footprint, or an
 * interface's connection point — and every change in the set is applied in one
 * transaction with no id to read back in between.
 */
export function newEntityId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Authoring needs crypto.randomUUID to mint an entity identity.');
  }
  return globalThis.crypto.randomUUID();
}

/**
 * The role each new entity's geometry takes, and the GeoJSON type the store will accept
 * for it. Declared here so the client cannot offer a pair the server would refuse with
 * "the geometry type does not match the declared role".
 */
export const ENTITY_GEOMETRY = Object.freeze({
  CONTAINER: { role: 'FOOTPRINT', type: 'Polygon' },
  UTILITY_INTERFACE: { role: 'CONNECTION_POINT', type: 'Point' },
});

/** A connection point as GeoJSON, from the one point placed on the map. */
export function pointFromCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
  const [lon, lat] = coordinates;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { type: 'Point', coordinates: [lon, lat] };
}

/**
 * Stages a new utility interface and its connection point.
 *
 * The failure domain and phase are the **source's**, not the user's to invent here. An
 * interface that declared its own would be `facility.utility.interface.redefines_source`,
 * which is an ERROR — an interface is a connection point on a supply, and the supply's
 * domain is what it is connected to. Capacity is likewise omitted rather than defaulted:
 * a capacity state that disagreed with the source would trip the same check, and the
 * inspector is where a deliberate override belongs.
 *
 * Returns the staged pair, so a caller can report what it did.
 */
export function stageUtilityInterface({ stage, source, coordinates, name = null, serviceState = 'AVAILABLE' }) {
  if (!source) throw new Error('An interface needs the source it connects to.');
  const geometry = pointFromCoordinates(coordinates);
  if (!geometry) throw new Error('An interface needs one connection point.');

  const interfaceId = newEntityId();
  stage({
    kind: 'set_utility_interface',
    payload: {
      interface_id: interfaceId,
      utility_source_id: source.utilitySourceId,
      service_state: serviceState,
      failure_domain_id: source.failureDomainId,
      phase_id: source.phaseId,
      name: name?.trim() ? name.trim() : `${source.kind} interface`,
    },
  });
  stage({
    kind: 'set_geometry',
    entity_ref: { entity_id: interfaceId },
    payload: { role: ENTITY_GEOMETRY.UTILITY_INTERFACE.role, geojson_4326: geometry },
  });
  return { interfaceId, sourceId: source.utilitySourceId };
}

/**
 * The conflict decision after a `409`.
 *
 * The server sends the current token with the refusal, so the user can either keep their
 * pending changes and re-commit against the new state, or throw them away. Silently
 * re-basing would commit an edit against a revision the user never saw.
 *
 * A change-set conflict carries the records that blocked it, which is the whole reason
 * the domain collects them: "conflicts with existing records" on its own leaves the user
 * with a commit button that refuses and no next step. The referrers are therefore named
 * here, in the user's words, instead of being passed up as data and dropped.
 *
 * A rejection (`422`) is the same problem one step earlier: the server refuses a change
 * with the rule it broke — "only a FLOOR or a HALL carries a level number" — and the
 * panel would otherwise show the bare "One or more changes are not valid."
 */
export function conflictFrom(error) {
  if (!error) return null;
  // A refused write is a decision to show: 409 for a precondition or a reference, and
  // 422 for a change the store will not accept.
  const refused = error.status === 409 || (error.status === 422 && error.code === 'CHANGE_SET_REJECTED');
  if (!refused) return null;
  if (error.code === 'REVISION_ETAG_STALE' || error.code === 'REVISION_ETAG_MISSING') {
    const detail = (error.details ?? []).find((entry) => entry.constraint_id === 'facility.revision.current') ?? {};
    return {
      kind: 'stale',
      currentEtag: detail.current_etag ?? null,
      currentEtagVersion: detail.current_etag_version ?? null,
      message: 'Someone else changed this draft. Review the current state before committing again.',
    };
  }
  if (error.code === 'REVISION_IMMUTABLE') {
    return { kind: 'immutable', message: error.message, currentEtag: null };
  }
  if (error.code === 'CHANGE_SET_REJECTED') {
    const details = error.details ?? [];
    const first = details[0] ?? {};
    const alsoRefused = details.length > 1 ? ` ${details.length} changes were refused in total.` : '';
    return {
      kind: 'rejected',
      currentEtag: null,
      message: `${first.message ?? 'The change set is not valid.'}${alsoRefused} Nothing was applied.`,
    };
  }
  if (error.code === 'CHANGE_SET_CONFLICT') {
    const detail = (error.details ?? [])[0] ?? {};
    if (detail.reason === 'has_children') {
      return {
        kind: 'referenced',
        currentEtag: null,
        message:
          'This object still has child containers. Stage the removal with “This entity and its children”, or remove the children first.',
      };
    }
    const referrers = describeReferrers(detail.referrers);
    return {
      kind: 'referenced',
      currentEtag: null,
      message: referrers
        ? `This object is still referenced by ${referrers}. Remove those references first, then commit again.`
        : 'This object is still referenced by other records. Remove those references first, then commit again.',
    };
  }
  return null;
}

/** The blocking records in words, counted by the label the domain gave them. */
function describeReferrers(referrers = []) {
  const counts = new Map();
  for (const entry of referrers) {
    const label = entry?.label ?? entry?.table;
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, count]) => (count === 1 ? `a ${label}` : `${count} ${label}s`));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Adopts the server's token so a re-commit is attempted against the current state. */
export function rebaseChangeSet(changeSet, etag) {
  return { ...changeSet, etag };
}
