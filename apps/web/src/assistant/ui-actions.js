/**
 * The client half of the UI-action protocol (chatbox blueprint §3.5 and §4.6,
 * assistant-integration.md "UI-Action Type Registry").
 *
 * This module is DOM-free and dependency-free on purpose. `apps/web` may not
 * import an `@ai-infra/*` package (see `tests/import-boundaries.test.js`), so the
 * registry is mirrored here as a local literal whose shapes are identical to the
 * server's descriptors. The two registries are compared by a contract test
 * elsewhere; what matters here is that the browser refuses anything the server
 * would not have emitted, and that it refuses it before a handler runs.
 *
 * Three rules the dispatcher encodes, straight from §3.5:
 *  * validate the envelope (type, version, payload shape) before dispatch;
 *  * reject a stale action whose embedded workspace scope no longer matches;
 *  * be idempotent — an applied action id is recorded and re-application is a
 *    no-op — and on failure emit a short system notice rather than throwing into
 *    the transcript.
 */

const ENTITY_TYPES = Object.freeze([
  'SITE',
  'PARCEL',
  'BUILDING',
  'FLOOR',
  'HALL',
  'SUPPORT_SPACE',
  'EQUIPMENT_YARD',
  'RESERVED_AREA',
  'UTILITY_SOURCE',
  'UTILITY_INTERFACE',
  'UTILITY_ROUTE',
  'SPATIAL_CONSTRAINT',
  'ENVIRONMENTAL_PROFILE',
  'ENVIRONMENTAL_CONSTRAINT',
  'FACILITY_PHASE',
  'FAILURE_DOMAIN',
  'RESILIENCE_REQUIREMENT',
  'FUEL_STORAGE',
  'WATER_STORAGE',
  'CAPACITY_BUDGET',
  'ASSUMPTION',
  'WAIVER',
  'DOCUMENT',
]);

const GEOMETRY_ROLES = Object.freeze([
  'BOUNDARY',
  'FOOTPRINT',
  'FLOOR_BOUNDARY',
  'ROOM_BOUNDARY',
  'ROUTE',
  'CONNECTION_POINT',
  'CONSTRAINT_AREA',
  'REFERENCE_POINT',
]);

export const INSPECTOR_TABS = Object.freeze([
  'OVERVIEW',
  'UTILITIES',
  'ENVIRONMENT',
  'PHASING',
  'ASSUMPTIONS',
  'DOCUMENTS',
]);

export const LAYER_KINDS = Object.freeze([
  'FACILITIES',
  'UTILITIES',
  'HAZARDS',
  'PHASES',
  'DIAGNOSTICS',
  'IMPORT_SOURCE',
]);

const SEVERITIES = Object.freeze(['ERROR', 'WARNING', 'INFO']);

/**
 * The entity fields `open_inspector.field_path` may name.
 *
 * The client cannot introspect a revision's schema, so this is the conservative
 * allowlist of fields the inspector actually renders and can scroll to. A path
 * outside it is rejected rather than silently focused on nothing. The server
 * remains the authority: an item that is not a field of the selected entity is a
 * server-side rejection too.
 */
export const INSPECTOR_FIELD_PATHS = Object.freeze([
  'name',
  'level_number',
  'elevation_base_m',
  'elevation_top_m',
  'phase_id',
  'capacity_state',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The six `type@version` descriptors, exactly as the spec declares them:
 * snake_case payload properties, the documented bounds, and
 * `confirmation: 'none'` because none of them mutates a design.
 */
export const UI_ACTION_TYPES = Object.freeze([
  descriptor('highlight_entity', 1, 'Highlight one entity in the active revision.', {
    entity_id: { type: 'uuid', required: true },
    entity_type: { type: 'enum', values: ENTITY_TYPES, required: true },
    label: { type: 'string', maxLength: 256 },
  }),
  descriptor(
    'focus_geometry',
    1,
    'Focus the viewport on one geometry record or bounding box.',
    {
      entity_id: { type: 'uuid', required: true },
      geometry_id: { type: 'uuid' },
      geometry_role: { type: 'enum', values: GEOMETRY_ROLES },
      bbox: { type: 'bbox' },
    },
    { requireOneOf: ['geometry_id', 'bbox'] },
  ),
  descriptor('open_inspector', 1, 'Select one entity and open an inspector tab.', {
    entity_id: { type: 'uuid', required: true },
    entity_type: { type: 'enum', values: ENTITY_TYPES, required: true },
    tab: { type: 'enum', values: INSPECTOR_TABS, required: true },
    field_path: { type: 'field_path' },
  }),
  descriptor(
    'show_finding',
    1,
    'Open the validate route and focus a diagnostic or constraint.',
    {
      revision_id: { type: 'uuid', required: true },
      diagnostic_id: { type: 'uuid' },
      constraint_id: { type: 'string', maxLength: 256 },
      severity: { type: 'enum', values: SEVERITIES },
    },
    { requireOneOf: ['diagnostic_id', 'constraint_id'] },
  ),
  descriptor('reveal_asset_layer', 1, 'Show or hide an imported source layer.', {
    asset_version_id: { type: 'uuid', required: true },
    representation_id: { type: 'uuid' },
    layer_selector: { type: 'string', maxLength: 256 },
    visible: { type: 'boolean', required: true },
  }),
  descriptor('set_layer_visibility', 1, 'Show or hide one workspace layer.', {
    layer_kind: { type: 'enum', values: LAYER_KINDS, required: true },
    visible: { type: 'boolean', required: true },
    geometry_role: { type: 'enum', values: GEOMETRY_ROLES },
  }),
]);

function descriptor(type, version, description, inputSchema, rules = {}) {
  return Object.freeze({
    type,
    version,
    description,
    confirmation: 'none',
    requireOneOf: Object.freeze(rules.requireOneOf ?? []),
    inputSchema: Object.freeze(
      Object.fromEntries(Object.entries(inputSchema).map(([key, value]) => [key, Object.freeze(value)])),
    ),
  });
}
const DESCRIPTOR_BY_KEY = new Map(UI_ACTION_TYPES.map((item) => [`${item.type}@${item.version}`, item]));

/** The descriptor for a `type@version`, or null when the pair is not declared. */
export function uiActionTypeFor(type, version) {
  return DESCRIPTOR_BY_KEY.get(`${type}@${Number(version)}`) ?? null;
}

/**
 * An action's identity for a notice a person will read.
 *
 * A version that is not a number is simply not printed: joining one on anyway produces
 * `highlight_entity@NaN` or `...@undefined`, an identity that names nothing and hides which
 * action was refused.
 */
function describeAction(type, version) {
  const name = typeof type === 'string' && type.length > 0 ? type : 'unknown';
  return Number.isInteger(version) ? `${name}@${version}` : name;
}

/**
 * The registry as the model is told about it: `{ type, version, enabled,
 * disabled_reason }`. Every declared action is presentation-only, so every one is
 * enabled — including in a read-only scope, where §"Read-Only Behavior" keeps UI
 * actions permitted because they never mutate the design.
 */
export function describeAvailableActions() {
  return UI_ACTION_TYPES.map((item) => ({
    type: item.type,
    version: item.version,
    enabled: true,
    disabled_reason: null,
  }));
}

/**
 * Validates one action envelope.
 *
 * Returns `{ ok: true, action }` or `{ ok: false, reason }`, where `reason` is a
 * short user-facing phrase. The check order is deliberate: identity and version
 * first (an unknown type can never be dispatched), then the payload, then the
 * workspace scope, and only last the applied-id set — a stale action that was
 * already applied is still reported as stale.
 *
 * `currentContextKey` is the workspace context key the browser is looking at
 * (`project|scenario|revision`); its first segment is the workspace id, which is
 * what the envelope's `context.workspaceId` must match. A caller with the
 * workspace id separately may pass `currentWorkspaceId`.
 */
export function validateUiAction(action, { currentContextKey = null, currentWorkspaceId = null, appliedIds = null } = {}) {
  if (!action || typeof action !== 'object') return { ok: false, reason: 'the action is not an object' };

  const type = action.type;
  const version = Number(action.version);
  const descriptorForType = uiActionTypeFor(type, version);
  if (!descriptorForType) {
    return { ok: false, reason: `unknown action type "${describeAction(type, version)}"` };
  }

  if (action.confirmation !== undefined && action.confirmation !== 'none') {
    return { ok: false, reason: `${describeAction(type, version)} is presentation-only and must declare confirmation "none"` };
  }

  const payload = action.payload && typeof action.payload === 'object' ? action.payload : {};
  const payloadVerdict = validatePayload(descriptorForType, payload);
  if (!payloadVerdict.ok) return payloadVerdict;

  const scopeVerdict = validateScope(action, { currentContextKey, currentWorkspaceId });
  if (!scopeVerdict.ok) return scopeVerdict;

  const applied = appliedIds instanceof Set ? appliedIds : appliedIds ? new Set(appliedIds) : null;
  if (applied && action.id != null && applied.has(action.id)) {
    return { ok: false, reason: 'the action was already applied' };
  }

  return { ok: true, action };
}

function validatePayload(descriptorForType, payload) {
  for (const [key, field] of Object.entries(descriptorForType.inputSchema)) {
    const value = payload[key];
    if (value === undefined || value === null) {
      if (field.required) return { ok: false, reason: `${descriptorForType.type} is missing ${key}` };
      continue;
    }
    const verdict = validateField(`${descriptorForType.type}.${key}`, field, value);
    if (!verdict.ok) return verdict;
  }

  if (
    descriptorForType.requireOneOf.length > 0 &&
    !descriptorForType.requireOneOf.some((key) => payload[key] !== undefined && payload[key] !== null)
  ) {
    return { ok: false, reason: `${descriptorForType.type} requires one of ${descriptorForType.requireOneOf.join(', ')}` };
  }

  return { ok: true };
}

function validateField(path, field, value) {
  switch (field.type) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) return { ok: false, reason: `${path} must be a uuid` };
      return { ok: true };
    case 'string':
      if (typeof value !== 'string') return { ok: false, reason: `${path} must be a string` };
      if (field.maxLength && value.length > field.maxLength) {
        return { ok: false, reason: `${path} is longer than ${field.maxLength} characters` };
      }
      return { ok: true };
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, reason: `${path} must be a boolean` };
      return { ok: true };
    case 'enum':
      if (!field.values.includes(value)) return { ok: false, reason: `${path} has an unknown value "${value}"` };
      return { ok: true };
    case 'bbox':
      return validateBbox(path, value);
    case 'field_path':
      if (typeof value !== 'string' || !INSPECTOR_FIELD_PATHS.includes(value)) {
        return { ok: false, reason: `${path} does not name a field of the selected entity` };
      }
      return { ok: true };
    default:
      return { ok: false, reason: `${path} has an unsupported schema type` };
  }
}

/** `[min-x, min-y, max-x, max-y]`, finite, with min <= max on both axes. */
function validateBbox(path, value) {
  if (!Array.isArray(value) || value.length !== 4) return { ok: false, reason: `${path} must be [min-x, min-y, max-x, max-y]` };
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return { ok: false, reason: `${path} must contain four finite numbers` };
  }
  if (value[0] > value[2] || value[1] > value[3]) {
    return { ok: false, reason: `${path} must have min <= max on both axes` };
  }
  return { ok: true };
}

/**
 * The stale-action rule: the envelope's embedded scope must still be the scope the
 * browser is looking at. An action with no embedded scope carries nothing to be
 * stale about and is accepted.
 */
function validateScope(action, { currentContextKey, currentWorkspaceId }) {
  const context = action.context;
  if (!context || typeof context !== 'object') return { ok: true };

  if (currentContextKey && context.contextKey && context.contextKey !== currentContextKey) {
    return { ok: false, reason: 'the action belongs to a different workspace context' };
  }

  const currentWorkspace = currentWorkspaceId ?? (typeof currentContextKey === 'string' ? currentContextKey.split('|')[0] : null);
  if (currentWorkspace && context.workspaceId && context.workspaceId !== currentWorkspace) {
    return { ok: false, reason: 'the action belongs to a different workspace' };
  }

  return { ok: true };
}

/** The user-facing line a browser effect emits, never an exception into the transcript. */
export function noticeFor(reason) {
  const detail = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'the action could not be applied.';
  return `Could not run the assistant's view action: ${detail}`;
}

/** How many times a handler marked `retryable` may be retried before it is reported. */
export const MAX_HANDLER_RETRIES = 2;

/**
 * The dispatcher.
 *
 * `handlers` is keyed by `type@version` (with a bare `type` accepted as a
 * fallback). A handler is either a function or `{ handler, failurePolicy,
 * retryable }`; `failurePolicy` is `stop` (the default) or `continue`, and only a
 * handler that opts in with `retryable: true` is retried, up to
 * `MAX_HANDLER_RETRIES`.
 *
 * `dispatch` is async because a handler may be: it awaits every result, so a
 * synchronous effects handle and a promise-returning one take the same path.
 * It returns `{ applied, notices, stopped }` and never throws — a failure is a
 * notice, because the transcript is not a stack trace.
 */
export function createUiActionDispatcher({ handlers = {}, appliedIds = new Set(), onNotice = () => {} } = {}) {
  const applied = appliedIds instanceof Set ? appliedIds : new Set(appliedIds ?? []);

  async function dispatch(actions, executionContext = null) {
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    const result = { applied: [], notices: [], stopped: false };

    const notice = (reason) => {
      const line = noticeFor(reason);
      result.notices.push(line);
      onNotice(line);
    };

    for (const action of list) {
      const verdict = validateUiAction(action, {
        currentContextKey: executionContext?.currentContextKey ?? null,
        currentWorkspaceId: executionContext?.currentWorkspaceId ?? null,
        appliedIds: applied,
      });
      if (!verdict.ok) {
        // A rejected action is skipped rather than aborting the rest: one stale
        // action must not swallow the actions that are still valid.
        notice(verdict.reason);
        continue;
      }

      const entry = handlers[`${action.type}@${Number(action.version)}`] ?? handlers[action.type] ?? null;
      const handler = normalizeHandler(entry);
      if (!handler) {
        notice(`no handler is registered for ${action.type}@${Number(action.version)}`);
        continue;
      }

      const outcome = await runHandler(handler, action, executionContext);
      if (outcome.failure) {
        notice(reasonOf(outcome.failure));
        if (handler.failurePolicy === 'continue') continue;
        result.stopped = true;
        break;
      }

      if (action.id != null) applied.add(action.id);
      result.applied.push(action.id ?? null);
      // A handler that could only partly act says so through `delta`; that is the
      // one place a no-op is made visible instead of being mistaken for success.
      for (const line of deltaNotices(outcome.value)) {
        result.notices.push(line);
        onNotice(line);
      }
    }

    return result;
  }

  return { dispatch, appliedIds: applied };
}

function normalizeHandler(entry) {
  if (typeof entry === 'function') return { run: entry, failurePolicy: 'stop', retryable: false };
  if (!entry || typeof entry !== 'object') return null;
  const run = entry.handler ?? entry.run;
  if (typeof run !== 'function') return null;
  return {
    run,
    failurePolicy: entry.failurePolicy === 'continue' ? 'continue' : 'stop',
    retryable: entry.retryable === true,
  };
}

async function runHandler(handler, action, executionContext) {
  let attempt = 0;
  for (;;) {
    try {
      const value = await handler.run(action, executionContext);
      if (value && value.ok === false) {
        const failure = new Error(value.reason ?? 'the handler refused the action');
        if (handler.retryable && attempt < MAX_HANDLER_RETRIES) {
          attempt += 1;
          continue;
        }
        return { failure, value: null };
      }
      return { failure: null, value };
    } catch (error) {
      if (handler.retryable && attempt < MAX_HANDLER_RETRIES) {
        attempt += 1;
        continue;
      }
      return { failure: error, value: null };
    }
  }
}

function reasonOf(error) {
  const message = error?.message ?? String(error ?? '');
  return message.length > 0 ? message : 'the handler failed';
}

/** A handler that could only partly act reports what it did not do; say so. */
function deltaNotices(value) {
  const delta = value?.delta;
  if (!delta) return [];
  const list = Array.isArray(delta) ? delta : [delta];
  return list.filter((line) => typeof line === 'string' && line.length > 0).map((line) => noticeFor(line));
}

/**
 * The handlers over a workspace-effects handle. Keeping the mapping here means the
 * action vocabulary has one owner: a new action type needs a descriptor and a line
 * in this table, not a change in the React layer.
 */
export function createEffectHandlers(effects) {
  if (!effects) return {};
  return {
    'highlight_entity@1': (action) =>
      effects.highlightEntity({ entityId: action.payload.entity_id, entityType: action.payload.entity_type, transient: false }),
    'focus_geometry@1': (action) => {
      effects.selectEntity?.({ entityId: action.payload.entity_id, geometryId: action.payload.geometry_id ?? undefined });
      return effects.focusGeometry({ geometryId: action.payload.geometry_id, bbox: action.payload.bbox });
    },
    'open_inspector@1': (action) =>
      effects.openInspector({
        entityId: action.payload.entity_id,
        entityType: action.payload.entity_type,
        tab: action.payload.tab,
        fieldPath: action.payload.field_path ?? null,
      }),
    'show_finding@1': (action) =>
      effects.showFinding({
        revisionId: action.payload.revision_id,
        diagnosticId: action.payload.diagnostic_id ?? null,
        constraintId: action.payload.constraint_id ?? null,
        severity: action.payload.severity ?? null,
      }),
    'reveal_asset_layer@1': (action) =>
      effects.revealAssetLayer({
        assetVersionId: action.payload.asset_version_id,
        representationId: action.payload.representation_id ?? null,
        layerSelector: action.payload.layer_selector ?? null,
        visible: action.payload.visible,
      }),
    'set_layer_visibility@1': (action) =>
      effects.setLayerVisible({
        layerKind: action.payload.layer_kind,
        visible: action.payload.visible,
        geometryRole: action.payload.geometry_role ?? null,
      }),
  };
}
