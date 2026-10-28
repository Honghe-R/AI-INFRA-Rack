/**
 * The canonical permission catalog.
 *
 * This module is the single source of truth for permission keys. The database
 * catalog table is seeded from it and a drift test compares the two, because two
 * sources will diverge unless something checks them (RBAC blueprint §3, porting
 * decision R5 — one catalog owner).
 *
 * Keys are stable strings, never row ids, so they can be written in code, in
 * presets, and in client components.
 *
 * Scope naming: the blueprint's `workspace` scope is our `project` scope. The
 * seam is unchanged; only the label differs.
 */
export const KEY_SCOPE = Object.freeze({
  SYSTEM: 'system',
  ORGANISATION: 'organisation',
  PROJECT: 'project',
  GLOBAL: 'global',
});

const entry = (key, name, description, scope) => Object.freeze({ key, name, description, scope });

/** Keys every tool and the platform share. */
export const PLATFORM_KEYS = Object.freeze({
  PROJECT_READ: 'project.read',
  PROJECT_WRITE: 'project.write',
  PROJECT_MEMBER_MANAGE: 'project.member.manage',
  ASSET_READ: 'asset.read',
  ASSET_WRITE: 'asset.write',
  ASSET_DELETE: 'asset.delete',
  ORG_READ: 'org.read',
  ORG_ADMIN: 'org.admin',
  ORGANISATION_CREATE: 'organisation.create',
  SYSTEM_ADMIN: 'system.admin',
  SYSTEM_CATALOG_MANAGE: 'system.catalog.manage',
});

/** Keys owned by the workspace map platform (D16). */
export const MAP_KEYS = Object.freeze({
  READ: 'map.read',
  USAGE_READ: 'map.usage.read',
  MANAGE: 'map.manage',
});

/** Keys owned by the first tool tenant, the Site and Facility Editor. */
export const FACILITY_KEYS = Object.freeze({
  READ: 'facility.read',
  DRAFT_CREATE: 'facility.draft.create',
  ENTITY_WRITE: 'facility.entity.write',
  GEOMETRY_WRITE: 'facility.geometry.write',
  CONSTRAINT_WRITE: 'facility.constraint.write',
  UTILITY_WRITE: 'facility.utility.write',
  PHASE_WRITE: 'facility.phase.write',
  IMPORT_INITIATE: 'facility.import.initiate',
  IMPORT_MAP: 'facility.import.map',
  IMPORT_APPLY: 'facility.import.apply',
  VALIDATE_RUN: 'facility.validate.run',
  CAPACITY_REQUEST: 'facility.capacity.request',
  CAPACITY_ALLOCATE: 'facility.capacity.allocate',
  PUBLISH: 'facility.publish',
  APPROVE: 'facility.approve',
  WAIVER_GRANT: 'facility.waiver.grant',
  DOCUMENT_MANAGE: 'facility.document.manage',
  EXPORT: 'facility.export',
  SHARE: 'facility.share',
});

export const RACK_KEYS = Object.freeze({ READ: 'rack.read', WRITE: 'rack.write' });

const { SYSTEM, ORGANISATION, PROJECT, GLOBAL } = KEY_SCOPE;

export const CATALOG = Object.freeze([
  entry(RACK_KEYS.READ, 'Read Rack plans', 'Read Rack plans and their facility source status.', PROJECT),
  entry(RACK_KEYS.WRITE, 'Write Rack plans', 'Create Rack plans within a project.', PROJECT),
  entry(PLATFORM_KEYS.PROJECT_READ, 'Read projects', 'Read project and scenario metadata.', PROJECT),
  entry(PLATFORM_KEYS.PROJECT_WRITE, 'Write projects', 'Create and edit projects and scenarios.', PROJECT),
  entry(PLATFORM_KEYS.PROJECT_MEMBER_MANAGE, 'Manage project members', 'Assign and revoke project-scoped roles.', PROJECT),
  entry(PLATFORM_KEYS.ASSET_READ, 'Read assets', 'Read project assets, versions, and representations.', PROJECT),
  entry(PLATFORM_KEYS.ASSET_WRITE, 'Write assets', 'Create asset versions, process, reclassify, and archive.', PROJECT),
  entry(PLATFORM_KEYS.ASSET_DELETE, 'Delete assets', 'Delete an asset under the reference and retention guards.', PROJECT),
  entry(PLATFORM_KEYS.ORG_READ, 'Read organisation', 'Read organisation metadata and its members.', ORGANISATION),
  entry(PLATFORM_KEYS.ORG_ADMIN, 'Administer organisation', 'Manage organisation membership and role mappings.', ORGANISATION),
  entry(PLATFORM_KEYS.ORGANISATION_CREATE, 'Create organisation', 'Bootstrap the first organisation for a new account.', GLOBAL),
  entry(PLATFORM_KEYS.SYSTEM_ADMIN, 'System administration', 'Administer roles, keys, and assignments across tenants.', SYSTEM),
  entry(PLATFORM_KEYS.SYSTEM_CATALOG_MANAGE, 'Manage permission catalog', 'Register permission keys and edit role mappings.', SYSTEM),

  entry(MAP_KEYS.READ, 'Read basemap', 'Request proxied basemap tiles and provider metadata for a project.', PROJECT),
  entry(MAP_KEYS.USAGE_READ, 'Read basemap usage', 'Read tile usage, quota, and provider health for a project.', PROJECT),
  entry(MAP_KEYS.MANAGE, 'Manage basemap', 'Select the project basemap provider, style, and tile quota.', PROJECT),

  entry(FACILITY_KEYS.READ, 'Read facility design', 'Read envelopes, entities, geometry, diagnostics, and jobs.', PROJECT),
  entry(FACILITY_KEYS.DRAFT_CREATE, 'Create facility draft', 'Create and branch facility revisions.', PROJECT),
  entry(FACILITY_KEYS.ENTITY_WRITE, 'Write facility entities', 'Create and update facility entities.', PROJECT),
  entry(FACILITY_KEYS.GEOMETRY_WRITE, 'Write facility geometry', 'Create and replace geometry records.', PROJECT),
  entry(FACILITY_KEYS.CONSTRAINT_WRITE, 'Write spatial constraints', 'Create and update spatial constraints.', PROJECT),
  entry(FACILITY_KEYS.UTILITY_WRITE, 'Write utility sources', 'Create and update utility sources and interfaces.', PROJECT),
  entry(FACILITY_KEYS.PHASE_WRITE, 'Write facility phases', 'Create and update phases and dependencies.', PROJECT),
  entry(FACILITY_KEYS.IMPORT_INITIATE, 'Initiate import', 'Bind a project asset version to a revision.', PROJECT),
  entry(FACILITY_KEYS.IMPORT_MAP, 'Map import content', 'Author and review import mappings and transforms.', PROJECT),
  entry(FACILITY_KEYS.IMPORT_APPLY, 'Apply import', 'Apply mapped content into the draft.', PROJECT),
  entry(FACILITY_KEYS.VALIDATE_RUN, 'Run validation', 'Run local or full validation.', PROJECT),
  entry(FACILITY_KEYS.CAPACITY_REQUEST, 'Request capacity', 'Submit a capacity demand request.', PROJECT),
  entry(FACILITY_KEYS.CAPACITY_ALLOCATE, 'Allocate capacity', 'Accept or reject capacity allocations.', PROJECT),
  entry(FACILITY_KEYS.PUBLISH, 'Publish revision', 'Publish a validated facility revision.', PROJECT),
  entry(FACILITY_KEYS.APPROVE, 'Approve revision', 'Record an approval attestation.', PROJECT),
  entry(FACILITY_KEYS.WAIVER_GRANT, 'Grant waiver', 'Grant a scoped waiver over named diagnostics.', PROJECT),
  entry(FACILITY_KEYS.DOCUMENT_MANAGE, 'Manage documents', 'Attach and detach document metadata.', PROJECT),
  entry(FACILITY_KEYS.EXPORT, 'Export design', 'Generate and download exports and reports.', PROJECT),
  entry(FACILITY_KEYS.SHARE, 'Share draft context', 'Share a draft read-only with a recipient or tool.', PROJECT),
]);

export const CATALOG_BY_KEY = new Map(CATALOG.map((item) => [item.key, item]));

export function isKnownKey(key) {
  return CATALOG_BY_KEY.has(key);
}

export function getCatalogEntry(key) {
  return CATALOG_BY_KEY.get(key) ?? null;
}

/**
 * System-level keys are evaluated with the scope forced to null, so no scoped
 * role can ever grant them (blueprint §5, invariant 5).
 */
export const SYSTEM_KEYS = Object.freeze(
  new Set(CATALOG.filter((item) => item.scope === KEY_SCOPE.SYSTEM).map((item) => item.key)),
);

/** The fixed read-only set a showcase project exposes (blueprint §5 step 7). */
export const SHOWCASE_READ_KEYS = Object.freeze(
  new Set([PLATFORM_KEYS.PROJECT_READ, PLATFORM_KEYS.ASSET_READ, FACILITY_KEYS.READ]),
);

/** Granted only to a user with no memberships, so a new account can bootstrap. */
export const ONBOARDING_KEYS = Object.freeze(new Set([PLATFORM_KEYS.ORGANISATION_CREATE]));

/** Every key as a sorted list, for seeding and for the drift test. */
export function catalogKeys() {
  return CATALOG.map((item) => item.key).sort();
}
