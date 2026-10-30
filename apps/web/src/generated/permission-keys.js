// GENERATED FILE — do not edit by hand.
//
// Source of truth: packages/rbac/src/catalog.js
// Regenerate with: npm --workspace @ai-infra/rbac run generate:keys
//
// Import these identifiers instead of retyping key strings.

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

export const RACK_KEYS = Object.freeze({
  READ: 'rack.read',
  WRITE: 'rack.write',
  DELETE: 'rack.delete',
  RESTORE: 'rack.restore',
});

/** Every registered key, for drift checks and administration surfaces. */
export const ALL_PERMISSION_KEYS = Object.freeze([
  'asset.delete',
  'asset.read',
  'asset.write',
  'facility.approve',
  'facility.capacity.allocate',
  'facility.capacity.request',
  'facility.constraint.write',
  'facility.document.manage',
  'facility.draft.create',
  'facility.entity.write',
  'facility.export',
  'facility.geometry.write',
  'facility.import.apply',
  'facility.import.initiate',
  'facility.import.map',
  'facility.phase.write',
  'facility.publish',
  'facility.read',
  'facility.share',
  'facility.utility.write',
  'facility.validate.run',
  'facility.waiver.grant',
  'map.manage',
  'map.read',
  'map.usage.read',
  'org.admin',
  'org.read',
  'organisation.create',
  'project.member.manage',
  'project.read',
  'project.write',
  'rack.delete',
  'rack.read',
  'rack.restore',
  'rack.write',
  'system.admin',
  'system.catalog.manage',
]);
