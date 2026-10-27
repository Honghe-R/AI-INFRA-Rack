/**
 * The one resolver behind every entity reference (chatbox blueprint §3.6,
 * assistant-integration.md "Entity-Reference Kinds").
 *
 * A reply names an object in prose; the browser lets the reader **preview** it on
 * hover and **pin** it on click. Both go through `resolveEntityReference` — there
 * is deliberately no second name→highlight path — and hover is a snapshot/restore
 * around the same effect calls the pin makes.
 *
 * There is no undo system in this surface, so the hover contract cannot be "stays
 * out of undo history" literally. A snapshot of the previous selection, route, and
 * viewport is captured immediately before the preview is applied and restored when
 * the pointer leaves, which is the honest substitute: the same observable outcome
 * (the map returns to where it was) without pretending to an undo stack that does
 * not exist.
 *
 * DOM-free: no `window`, no timer globals beyond the injectable scheduler.
 */

/** How long the pointer must rest on a reference before the preview begins. */
export const HOVER_PREVIEW_DELAY_MS = 120;

/** Kinds whose preview is just a highlight; the rest navigate and are pinned only. */
const PREVIEWABLE_KINDS = new Set(['facility.entity', 'facility.geometry']);

/**
 * The id fields the server's collection pass can read as a `facility.entity` identity.
 *
 * A mirror of `KIND_BY_FIELD` in `packages/assistant/src/entity-references.js` for the
 * entries that map to `facility.entity`. The web app has no dependency on the server
 * package, so the list is duplicated rather than imported — and it is asserted against
 * a captured server payload in `entity-resolver.test.js`, because a silent divergence
 * here is what broke hover and click to begin with.
 */
const ENTITY_KIND_ID_FIELDS = Object.freeze({
  'facility.entity': Object.freeze([
    'containerId',
    'scopeId',
    'utilitySourceId',
    'requirementId',
    'storageId',
    'failureDomainId',
    'profileId',
    'environmentalConstraintId',
    'assumptionId',
    'waiverId',
    // Last: the collection pass falls through to a bare `id`, which is what a plain
    // entity row actually carries. See `ID_FIELDS` in entity-references.js.
    'id',
  ]),
});

/** Whether a reference can be previewed in place rather than navigating. */
export function canPreviewEntityReference(entity) {
  const kind = entityIdentity(entity)?.kind ?? null;
  return PREVIEWABLE_KINDS.has(kind);
}

/**
 * Identity read from either wire spelling.
 *
 * The server's collection pass emits camelCase identity (`entityId`, `geometryId`)
 * while the spec writes snake_case (`entity_id`, `geometry_id`). Tolerating both
 * here is what keeps one resolver honest across a version skew, rather than a
 * second matcher per shape.
 */
export function entityIdentity(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = entity[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };

  /**
   * The id a reference of this kind names, when the server used a bare `id` for it.
   *
   * The collection pass (`packages/assistant/src/entity-references.js`) derives the
   * kind from **which id field it found** — `containerId` and `scopeId` both become
   * `facility.entity` — and emits `{ kind, id, label }`. So for a plain entity the
   * identity is the entity's own id, and reading only `entityId` silently dropped it:
   * the label rendered, the click and the hover reached the resolver, and the resolver
   * refused with "the reference names no entity id". Neither `entityId` nor
   * `entity_id` is present in that shape, which is the whole defect.
   *
   * Deliberately narrow. Kinds whose identity field is named for them (`asset`,
   * `facility.phase`, …) keep their own key, so an `id` column on those rows cannot be
   * mistaken for the entity they name. A kind absent from this map gets no `id`
   * fallback, exactly as before.
   */
  const idList = ENTITY_KIND_ID_FIELDS[entity.kind ?? entity.entityKind] ?? [];

  return {
    kind: pick('kind', 'entityKind'),
    entityId: pick('entityId', 'entity_id', ...idList),
    entityType: pick('entityType', 'entity_type'),
    geometryId: pick('geometryId', 'geometry_id'),
    geometryRole: pick('geometryRole', 'geometry_role'),
    revisionId: pick('revisionId', 'revision_id'),
    projectId: pick('projectId', 'project_id'),
    diagnosticId: pick('diagnosticId', 'diagnostic_id'),
    constraintId: pick('constraintId', 'constraint_id'),
    severity: pick('severity'),
    bindingId: pick('bindingId', 'binding_id'),
    mappingId: pick('mappingId', 'mapping_id'),
    assetId: pick('assetId', 'asset_id'),
    assetVersionId: pick('assetVersionId', 'asset_version_id'),
    representationId: pick('representationId', 'representation_id'),
    interfaceId: pick('interfaceId', 'interface_id', 'utilityInterfaceId', 'utility_interface_id'),
    utilitySourceId: pick('utilitySourceId', 'utility_source_id'),
    phaseId: pick('phaseId', 'phase_id'),
    budgetId: pick('budgetId', 'budget_id'),
    ownerEntityId: pick('ownerEntityId', 'owner_entity_id'),
    resourceKind: pick('resourceKind', 'resource_kind'),
    basis: pick('basis'),
    label: pick('label', 'name', 'displayLabel', 'display_label', 'title'),
  };
}

/**
 * Applies one entity reference to the workspace.
 *
 * Returns `{ handled, kind, ... }`. An unknown kind — or a kind with no identity to
 * act on — is `{ handled: false }` and the caller leaves the label as plain text.
 * A navigating kind is `handled: false` in transient (hover) mode: a preview that
 * switched routes and then switched back would be a worse experience than no
 * preview, and the pinned path is where navigation belongs.
 */
export function resolveEntityReference(entity, effects, { transient = false } = {}) {
  const identity = entityIdentity(entity);
  if (!identity?.kind) return { handled: false, kind: null, reason: 'the reference carries no kind' };
  const kind = identity.kind;

  if (transient && !PREVIEWABLE_KINDS.has(kind)) {
    return { handled: false, kind, reason: 'this reference needs navigation; it is panned to only on click' };
  }

  switch (kind) {
    case 'facility.entity': {
      if (!identity.entityId) return { handled: false, kind, reason: 'the reference names no entity id' };
      effects?.selectEntity?.({
        entityId: identity.entityId,
        entityType: identity.entityType,
        geometryId: identity.geometryId ?? undefined,
        geometryRole: identity.geometryRole ?? undefined,
      });
      effects?.highlightEntity?.({ entityId: identity.entityId, transient });
      return {
        handled: true,
        kind,
        action: 'select',
        target: { entityId: identity.entityId, entityType: identity.entityType, label: identity.label },
      };
    }

    case 'facility.geometry': {
      if (!identity.geometryId && !identity.entityId) {
        return { handled: false, kind, reason: 'the reference names no geometry or entity id' };
      }
      effects?.selectEntity?.({
        entityId: identity.entityId,
        entityType: identity.entityType,
        geometryId: identity.geometryId ?? undefined,
        geometryRole: identity.geometryRole ?? undefined,
      });
      effects?.focusGeometry?.({ geometryId: identity.geometryId ?? undefined });
      return {
        handled: true,
        kind,
        action: 'focus',
        target: { entityId: identity.entityId, geometryId: identity.geometryId, label: identity.label },
      };
    }

    case 'facility.diagnostic': {
      if (!identity.diagnosticId && !identity.constraintId) {
        return { handled: false, kind, reason: 'the reference names no diagnostic or constraint' };
      }
      effects?.showFinding?.({
        revisionId: identity.revisionId,
        diagnosticId: identity.diagnosticId ?? null,
        constraintId: identity.constraintId ?? null,
        severity: identity.severity ?? null,
      });
      return {
        handled: true,
        kind,
        route: 'validate',
        action: 'finding',
        target: { diagnosticId: identity.diagnosticId, constraintId: identity.constraintId, label: identity.label },
      };
    }

    case 'facility.asset_binding':
    case 'facility.import': {
      const mappingId = identity.mappingId;
      effects?.openRoute?.({
        functionId: 'import_map',
        bindingId: identity.bindingId ?? null,
        mappingId: mappingId ?? null,
        assetVersionId: identity.assetVersionId ?? null,
      });
      return {
        handled: true,
        kind,
        route: 'import_map',
        action: 'route',
        target: { bindingId: identity.bindingId, mappingId, label: identity.label },
      };
    }

    case 'facility.utility_interface': {
      const entityId = identity.interfaceId ?? identity.entityId;
      if (!entityId) return { handled: false, kind, reason: 'the reference names no interface id' };
      effects?.openRoute?.({ functionId: 'utilities', interfaceId: entityId });
      effects?.openInspector?.({
        entityId,
        entityType: identity.entityType ?? 'UTILITY_INTERFACE',
        tab: 'UTILITIES',
      });
      return { handled: true, kind, route: 'utilities', action: 'inspector', target: { entityId, label: identity.label } };
    }

    case 'facility.phase': {
      if (!identity.phaseId) return { handled: false, kind, reason: 'the reference names no phase id' };
      effects?.openRoute?.({ functionId: 'phasing', phaseId: identity.phaseId });
      effects?.openInspector?.({ entityId: identity.phaseId, entityType: 'FACILITY_PHASE', tab: 'PHASING' });
      return { handled: true, kind, route: 'phasing', action: 'inspector', target: { phaseId: identity.phaseId, label: identity.label } };
    }

    case 'facility.capacity_budget': {
      if (!identity.budgetId && !identity.ownerEntityId) {
        return { handled: false, kind, reason: 'the reference names no budget or owning entity' };
      }
      effects?.openRoute?.({ functionId: 'capacity', budgetId: identity.budgetId ?? null });
      // A budget is not an inspector entity. When it names an owner, that owner is
      // the addressable target; otherwise the route is the whole answer and the
      // delta says the budget itself could not be focused.
      if (identity.ownerEntityId) {
        effects?.openInspector?.({
          entityId: identity.ownerEntityId,
          entityType: identity.entityType ?? null,
          tab: 'OVERVIEW',
        });
        return { handled: true, kind, route: 'capacity', action: 'inspector', target: { entityId: identity.ownerEntityId, label: identity.label } };
      }
      return {
        handled: true,
        kind,
        route: 'capacity',
        action: 'route',
        target: { budgetId: identity.budgetId, label: identity.label },
        delta: ['a capacity budget has no inspector of its own; the Capacity route was opened instead'],
      };
    }

    case 'asset':
    case 'asset.version': {
      const assetId = identity.assetId ?? identity.entityId;
      effects?.openTool?.({ toolId: 'assets', assetId: assetId ?? null, assetVersionId: identity.assetVersionId ?? null });
      return {
        handled: true,
        kind,
        toolId: 'assets',
        action: 'tool',
        target: { assetId, assetVersionId: identity.assetVersionId, label: identity.label },
        delta: ['the asset is not focused yet; the Assets tool was opened'],
      };
    }

    default:
      return { handled: false, kind, reason: `unknown entity-reference kind "${kind}"` };
  }
}

/**
 * Puts the selection back the way the snapshot found it.
 *
 * The effects handle may expose a first-class `restoreSnapshot` (the canvas does,
 * because only it can restore the map viewport); otherwise the restore is
 * reconstructed from the snapshot's selection refs, which is all a caller that
 * exposes only the documented effect vocabulary can do.
 */
export function restoreSelectionSnapshot(effects, snapshot) {
  if (!effects || !snapshot) return;
  if (typeof effects.restoreSnapshot === 'function') {
    effects.restoreSnapshot(snapshot);
    return;
  }

  const route = snapshot.routeState ?? {};
  const refs = snapshot.selectionRefs ?? [];
  effects.clearHighlight?.();

  if (route.selectedEntityId) {
    const ref = refs.find((item) => (item.entity_id ?? item.entityId) === route.selectedEntityId) ?? null;
    effects.selectEntity?.({
      entityId: route.selectedEntityId,
      entityType: ref?.entity_type ?? ref?.entityType ?? null,
      geometryId: route.selectedGeometryId ?? undefined,
    });
  } else {
    // No previous selection: clearing is a selection of nothing, not a missing call.
    effects.selectEntity?.({ entityId: null });
  }

  if (route.selectedGeometryId) effects.focusGeometry?.({ geometryId: route.selectedGeometryId });
}

/**
 * Hover preview: debounced, snapshotted, and restorable.
 *
 * The timer is injectable so the debounce can be asserted without waiting. The
 * snapshot is taken at the moment the preview actually fires — not on enter —
 * because that is the state the restore must return to, and a faster pointer may
 * have left before the delay elapsed.
 */
export function createEntityHoverPreview(getEffects, options = {}) {
  const delayMs = options.delayMs ?? HOVER_PREVIEW_DELAY_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let timer = null;
  let snapshot = null;
  let previewing = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    enter(entity) {
      cancel();
      // A kind that would navigate is never previewed, so no snapshot is taken for it:
      // nothing is applied, and a snapshot with nothing to restore is not state worth
      // holding.
      if (!canPreviewEntityReference(entity)) return;
      timer = setTimer(() => {
        timer = null;
        const effects = typeof getEffects === 'function' ? getEffects() : getEffects;
        // Captured before the preview is applied: this is the "previous" state.
        snapshot = effects?.snapshot?.() ?? null;
        const outcome = resolveEntityReference(entity, effects, { transient: true });
        previewing = outcome.handled === true;
        if (!previewing) snapshot = null;
      }, delayMs);
    },

    leave() {
      cancel();
      if (!previewing) {
        snapshot = null;
        return;
      }
      const effects = typeof getEffects === 'function' ? getEffects() : getEffects;
      restoreSelectionSnapshot(effects, snapshot);
      snapshot = null;
      previewing = false;
    },

    /** Drops a pending preview without restoring anything (the pointer never rested). */
    cancel,

    get pending() {
      return timer !== null;
    },

    get previewing() {
      return previewing;
    },

    get snapshot() {
      return snapshot;
    },
  };
}
