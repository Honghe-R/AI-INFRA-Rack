/**
 * Placing the geometry an entity is required to have.
 *
 * `facility.data.geometry.role_missing` reports every entity whose required geometry role is
 * absent, and the only way to clear it used to be an import. This is the authoring path: a
 * selected entity that is missing its role can have that role drawn or placed on the map.
 *
 * The role is **derived, never chosen**. Both tables below mirror the validator's — see
 * `packages/facility/src/checks/data.js`, where `REQUIRED_ROLE` and `ROLE_TYPES` are
 * canonical. Duplicating them is deliberate and the reason `geometryPlacement` exists as one
 * function: it is the only client-side copy, it is asserted against a captured reading of
 * the server tables, and a tool that let the reader pick a role could place something that
 * satisfies nothing.
 */

/** Entity kinds that must carry a geometry role, and which one. Mirrors `REQUIRED_ROLE`. */
export const REQUIRED_GEOMETRY_ROLE = Object.freeze({
  SITE: 'BOUNDARY',
  PARCEL: 'BOUNDARY',
  BUILDING: 'FOOTPRINT',
  FLOOR: 'FLOOR_BOUNDARY',
  HALL: 'FLOOR_BOUNDARY',
  SUPPORT_SPACE: 'ROOM_BOUNDARY',
  EQUIPMENT_YARD: 'BOUNDARY',
  RESERVED_AREA: 'BOUNDARY',
  UTILITY_SOURCE: 'CONNECTION_POINT',
  UTILITY_INTERFACE: 'CONNECTION_POINT',
});

/**
 * What each role may be drawn as. Mirrors the validator's `ROLE_TYPES`.
 *
 * Only the roles reachable from `REQUIRED_GEOMETRY_ROLE` are listed. `ROUTE` is absent
 * because no required role is a line: a route is additional geometry, and this tool places
 * the required role only.
 */
export const ROLE_GEOMETRY = Object.freeze({
  BOUNDARY: 'POLYGON',
  FOOTPRINT: 'POLYGON',
  FLOOR_BOUNDARY: 'POLYGON',
  ROOM_BOUNDARY: 'POLYGON',
  CONNECTION_POINT: 'POINT',
});

/**
 * The entity kinds this surface can name a type for.
 *
 * A container's `kind` is its entity type; a utility source or interface is one by
 * collection, since neither carries a kind that names it. Kept as data so the caller does
 * not have to know where each type lives.
 */
export function entityTypeOf({ container = null, utilitySource = null, utilityInterface = null } = {}) {
  if (container?.kind) return container.kind;
  if (utilitySource) return 'UTILITY_SOURCE';
  if (utilityInterface) return 'UTILITY_INTERFACE';
  return null;
}

/**
 * Whether the selected entity can have its missing geometry placed, and as what.
 *
 * Returns one of:
 *
 *   `{ status: 'placeable', role, geometryType }` — draw or place this geometry type.
 *   `{ status: 'already-present', role }`         — the required role is there; nothing to do.
 *   `{ status: 'not-required', entityType }`      — this kind is not required to have geometry,
 *                                                   so a missing one is not a defect.
 *   `{ status: 'unknown-kind' }`                  — the type could not be resolved, so no claim
 *                                                   is made rather than guessing a role.
 *
 * `roles` is the set of roles the entity already has, from the revision's geometry records.
 */
export function geometryPlacement({ entityType = null, roles = [] } = {}) {
  const role = REQUIRED_GEOMETRY_ROLE[entityType] ?? null;
  if (!role) return { status: entityType ? 'not-required' : 'unknown-kind', entityType, role: null };

  const present = roles instanceof Set ? roles : new Set(roles ?? []);
  if (present.has(role)) return { status: 'already-present', entityType, role };

  const geometryType = ROLE_GEOMETRY[role];
  if (!geometryType) {
    // A required role with no placer would be a hole in this module rather than a fact about
    // the design, so it is stated instead of silently offering nothing.
    return { status: 'unsupported-role', entityType, role };
  }
  return { status: 'placeable', entityType, role, geometryType };
}

/** A phrase naming the geometry to place, for a control's label. */
export function placementLabel({ role, geometryType }) {
  if (!role) return 'Place geometry';
  const shape = geometryType === 'POINT' ? 'point' : 'outline';
  return `Place ${role.toLowerCase().replace(/_/g, ' ')} ${shape}`;
}

/**
 * The objects that are required to have geometry and do not.
 *
 * These are invisible on the canvas — a feature is built from a geometry record, so an entity
 * without one cannot be seen, selected, or fixed by clicking it. This is the only way to name
 * them, and it is why they need a bucket rather than an affordance on the map.
 *
 * Ordered by kind then name so the list is stable between renders: a palette that reordered
 * itself as the reader worked would move the next target under the pointer.
 */
export function unplacedObjects({ containers = [], utilitySources = [], utilityInterfaces = [], geometryRecords = [] } = {}) {
  // Which roles each entity already holds, from the revision's own geometry.
  const rolesByEntity = new Map();
  for (const record of geometryRecords) {
    if (!record?.entityId || !record.role) continue;
    if (!rolesByEntity.has(record.entityId)) rolesByEntity.set(record.entityId, new Set());
    rolesByEntity.get(record.entityId).add(record.role);
  }

  const candidates = [
    ...containers.map((container) => ({
      entityId: container.containerId,
      name: container.name ?? null,
      container,
    })),
    ...utilitySources.map((source) => ({
      entityId: source.utilitySourceId,
      name: source.displayName ?? source.name ?? null,
      utilitySource: source,
    })),
    ...utilityInterfaces.map((iface) => ({
      entityId: iface.interfaceId,
      name: iface.name ?? null,
      utilityInterface: iface,
    })),
  ];

  const unplaced = [];
  for (const candidate of candidates) {
    if (!candidate.entityId) continue;
    const entityType = entityTypeOf(candidate);
    const placement = geometryPlacement({
      entityType,
      roles: rolesByEntity.get(candidate.entityId) ?? [],
    });
    // Only what the validator is actually asking for, and only what this surface can draw:
    // a kind that is not required to have geometry is not a defect, and a role with no placer
    // would be an invitation to fail.
    if (placement.status !== 'placeable') continue;
    unplaced.push({
      entityId: candidate.entityId,
      entityType,
      name: candidate.name,
      role: placement.role,
      geometryType: placement.geometryType,
    });
  }

  return unplaced.sort((left, right) => {
    const byType = String(left.entityType).localeCompare(String(right.entityType));
    if (byType !== 0) return byType;
    return String(left.name ?? left.entityId).localeCompare(String(right.name ?? right.entityId));
  });
}
