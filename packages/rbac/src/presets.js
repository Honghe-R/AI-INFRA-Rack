import { FACILITY_KEYS as F, MAP_KEYS as M, PLATFORM_KEYS as P, RACK_KEYS as R } from './catalog.js';

/**
 * Role presets: named, hardcoded bundles of permission keys (blueprint §4).
 *
 * Applying a preset is an idempotent insert-ignore that never removes a key the
 * role already holds. Roles themselves are data, seeded from these presets and
 * versioned through migrations, because changing a role changes every holder's
 * effective permissions.
 *
 * There is deliberately no all-keys super-role (blueprint invariant 6): the
 * system administrator holds the administration keys, not every content key.
 */
export const ROLE_PRESETS = Object.freeze({
  'system-admin': Object.freeze({
    name: 'System administrator',
    scopeHint: 'system',
    description: 'Administers roles, key mappings, and assignments. Holds no blanket content access by design.',
    keys: Object.freeze([P.SYSTEM_ADMIN, P.SYSTEM_CATALOG_MANAGE, P.ORG_READ, P.PROJECT_READ]),
  }),

  'organisation-admin': Object.freeze({
    name: 'Organisation administrator',
    scopeHint: 'organisation',
    description: 'Administers membership and project structure within one organisation.',
    keys: Object.freeze([
      P.ORG_READ, P.ORG_ADMIN, P.PROJECT_READ, P.PROJECT_WRITE, P.PROJECT_MEMBER_MANAGE,
      P.ASSET_READ, P.ASSET_WRITE, P.ASSET_DELETE, F.READ,
      R.READ,
      M.READ, M.USAGE_READ, M.MANAGE,
    ]),
  }),

  'project-admin': Object.freeze({
    name: 'Project administrator',
    scopeHint: 'project',
    description: 'Full authoring and governance authority within one project.',
    keys: Object.freeze([
      P.PROJECT_READ, P.PROJECT_WRITE, P.PROJECT_MEMBER_MANAGE,
      P.ASSET_READ, P.ASSET_WRITE, P.ASSET_DELETE,
      F.READ, F.DRAFT_CREATE, F.ENTITY_WRITE, F.GEOMETRY_WRITE, F.CONSTRAINT_WRITE,
      F.UTILITY_WRITE, F.PHASE_WRITE, F.IMPORT_INITIATE, F.IMPORT_MAP, F.IMPORT_APPLY,
      F.VALIDATE_RUN, F.CAPACITY_REQUEST, F.CAPACITY_ALLOCATE, F.PUBLISH, F.APPROVE,
      F.WAIVER_GRANT, F.DOCUMENT_MANAGE, F.EXPORT, F.SHARE,
      R.READ, R.WRITE,
      M.READ, M.USAGE_READ, M.MANAGE,
    ]),
  }),

  'project-editor': Object.freeze({
    name: 'Project editor',
    scopeHint: 'project',
    description: 'Authors and validates design content but cannot publish, approve, or grant waivers.',
    keys: Object.freeze([
      P.PROJECT_READ, P.ASSET_READ, P.ASSET_WRITE,
      F.READ, F.DRAFT_CREATE, F.ENTITY_WRITE, F.GEOMETRY_WRITE, F.CONSTRAINT_WRITE,
      F.UTILITY_WRITE, F.PHASE_WRITE, F.IMPORT_INITIATE, F.IMPORT_MAP, F.IMPORT_APPLY,
      F.VALIDATE_RUN, F.CAPACITY_REQUEST, F.EXPORT, F.SHARE,
      R.READ, R.WRITE,
      M.READ,
    ]),
  }),

  'project-viewer': Object.freeze({
    name: 'Project viewer',
    scopeHint: 'project',
    description: 'Read-only access to project content.',
    keys: Object.freeze([P.PROJECT_READ, P.ASSET_READ, F.READ, M.READ, R.READ]),
  }),
});

export const PRESET_KEYS = Object.freeze(Object.keys(ROLE_PRESETS));

export function getPreset(roleKey) {
  return ROLE_PRESETS[roleKey] ?? null;
}

/** Every key referenced by any preset. Used by the catalog drift test. */
export function presetKeys() {
  return [...new Set(Object.values(ROLE_PRESETS).flatMap((preset) => preset.keys))].sort();
}
