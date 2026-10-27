import { ApiError } from '@ai-infra/core';
import { applyAssetBinding, previewImportMerge } from '../import-apply.js';
import {
  createImportMapping,
  createSpatialTransform,
  reviewImportMapping,
  reviewSpatialTransform,
  updateImportMapping,
} from '../import-mappings.js';
import { defineTool } from './registry.js';
import { field } from './schema.js';

/**
 * The import action tools (T3).
 *
 * `apply_asset_binding` and `review_import_mapping` are the two operations the
 * contracts require. The transform and mapping authoring tools are here beside them
 * because a review has nothing to review without a draft transform or mapping, and a
 * route that wrote one directly would be the second mutation path this surface exists
 * to prevent.
 *
 * Applying is one typed change set: `applyAssetBinding` commits through the existing
 * change-set pipeline, so the draft token advances once and the revision-changed event
 * is the same one every other edit emits.
 */
const REVIEW_STATES = Object.freeze(['UNREVIEWED', 'IN_REVIEW', 'REVIEWED', 'REJECTED']);

const TRANSFORM_METHODS = Object.freeze([
  'DECLARED_CRS',
  'CONTROL_POINTS_HELMERT',
  'CONTROL_POINTS_AFFINE',
  'FITTED_RESIDUAL',
  'MANUAL',
]);

const ENTITY_TYPES = Object.freeze([
  'SITE', 'PARCEL', 'BUILDING', 'FLOOR', 'HALL', 'SUPPORT_SPACE', 'EQUIPMENT_YARD', 'RESERVED_AREA',
  'UTILITY_SOURCE', 'UTILITY_INTERFACE', 'UTILITY_ROUTE', 'SPATIAL_CONSTRAINT', 'ENVIRONMENTAL_PROFILE',
  'ENVIRONMENTAL_CONSTRAINT', 'FACILITY_PHASE', 'FAILURE_DOMAIN', 'RESILIENCE_REQUIREMENT', 'FUEL_STORAGE',
  'WATER_STORAGE', 'CAPACITY_BUDGET', 'ASSUMPTION', 'WAIVER', 'DOCUMENT',
]);

const GEOMETRY_ROLES = Object.freeze([
  'BOUNDARY', 'FOOTPRINT', 'FLOOR_BOUNDARY', 'ROOM_BOUNDARY', 'ROUTE', 'CONNECTION_POINT',
  'CONSTRAINT_AREA', 'REFERENCE_POINT',
]);

const CARDINALITIES = Object.freeze(['ONE_TO_ONE', 'ONE_TO_MANY']);

export function createImportTools({ storage = null, logger = null } = {}) {
  const createTransform = defineTool({
    name: 'create_spatial_transform',
    axis: 'ACTION',
    access: 'write',
    description:
      'Create an UNREVIEWED spatial transform for a bound asset version: source and target units and CRS, the transform method, and optional control points. Nothing may be mapped or applied until the transform is reviewed.',
    stores: ['spatial_transforms'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.map'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      binding_id: field.uuid({ required: true }),
      source_units: field.string({ required: true }),
      target_units: field.string({ required: true }),
      source_crs: field.string(),
      target_crs: field.string({ required: true }),
      vertical_crs: field.string(),
      method: field.enum(TRANSFORM_METHODS, { required: true }),
      control_points: field.array(field.object()),
    },
    handler: async ({ client, args, context }) =>
      createSpatialTransform({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        bindingId: args.binding_id,
        sourceUnits: args.source_units,
        targetUnits: args.target_units,
        sourceCrs: args.source_crs ?? null,
        targetCrs: args.target_crs,
        verticalCrs: args.vertical_crs ?? null,
        method: args.method,
        controlPoints: args.control_points ?? [],
      }),
  });

  const reviewTransform = defineTool({
    name: 'review_spatial_transform',
    axis: 'ACTION',
    access: 'write',
    description: 'Set the review state of one spatial transform. Only a reviewed transform may back a mapping or an applied import.',
    stores: ['spatial_transforms'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.map'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      transform_id: field.uuid({ required: true }),
      review_state: field.enum(REVIEW_STATES, { required: true }),
      comment: field.string({ maxLength: 2048 }),
    },
    handler: async ({ client, args, context }) =>
      reviewSpatialTransform({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        transformId: args.transform_id,
        reviewState: args.review_state,
        comment: args.comment ?? null,
      }),
  });

  const createMapping = defineTool({
    name: 'create_import_mapping',
    axis: 'ACTION',
    access: 'write',
    description:
      'Create an UNREVIEWED mapping from a source selector to a target entity type and geometry role, against a reviewed transform. The selector grammar and the entity-type/role pairing are validated before the row lands.',
    stores: ['import_mappings'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.map'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      binding_id: field.uuid({ required: true }),
      transform_id: field.uuid({ required: true }),
      source_selector: field.string({ required: true }),
      target_entity_type: field.enum(ENTITY_TYPES, { required: true }),
      target_geometry_role: field.enum(GEOMETRY_ROLES),
      attribute_mapping: field.object(),
      cardinality: field.enum(CARDINALITIES, { default: 'ONE_TO_ONE' }),
      required: field.bool({ default: false }),
    },
    handler: async ({ client, args, context }) =>
      createImportMapping({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        bindingId: args.binding_id,
        transformId: args.transform_id,
        sourceSelector: args.source_selector,
        targetEntityType: args.target_entity_type,
        targetGeometryRole: args.target_geometry_role ?? null,
        attributeMapping: args.attribute_mapping ?? {},
        cardinality: args.cardinality ?? 'ONE_TO_ONE',
        required: args.required === true,
      }),
  });

  const reviewMapping = defineTool({
    name: 'update_import_mapping',
    axis: 'ACTION',
    access: 'write',
    description: 'Edit a draft mapping. Any edit returns it to UNREVIEWED, because a reviewed decision about a selector that has since changed is not a review.',
    stores: ['import_mappings'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.map'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      mapping_id: field.uuid({ required: true }),
      source_selector: field.string(),
      target_entity_type: field.enum(ENTITY_TYPES),
      target_geometry_role: field.enum(GEOMETRY_ROLES),
      attribute_mapping: field.object(),
      cardinality: field.enum(CARDINALITIES),
      required: field.bool(),
    },
    handler: async ({ client, args, context }) =>
      updateImportMapping({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        mappingId: args.mapping_id,
        sourceSelector: args.source_selector,
        targetEntityType: args.target_entity_type,
        targetGeometryRole: args.target_geometry_role,
        attributeMapping: args.attribute_mapping,
        cardinality: args.cardinality,
        required: args.required,
      }),
  });

  const reviewMappingTool = defineTool({
    name: 'review_import_mapping',
    axis: 'ACTION',
    access: 'write',
    description: 'Set the review state of one import mapping. A validated import may have no unresolved required mapping.',
    stores: ['import_mappings'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.map'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      mapping_id: field.uuid({ required: true }),
      review_state: field.enum(REVIEW_STATES, { required: true }),
      comment: field.string({ maxLength: 2048 }),
    },
    handler: async ({ client, args, context }) =>
      reviewImportMapping({
        client,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        mappingId: args.mapping_id,
        reviewState: args.review_state,
        comment: args.comment ?? null,
      }),
  });

  const previewMerge = defineTool({
    name: 'preview_import_merge',
    axis: 'ACTION',
    access: 'read',
    description:
      'Preview what applying a binding would create, update, and conflict with, without writing anything. A conflict must be resolved explicitly before apply.',
    stores: ['bindings', 'mappings', 'features'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.apply'],
    input: {
      revision_id: field.uuid({ required: true }),
      binding_id: field.uuid({ required: true }),
      mapping_ids: field.array(field.uuid(), { maxItems: 100 }),
    },
    handler: async ({ client, args, context }) =>
      previewImportMerge({
        client,
        storage,
        projectId: context.projectId,
        revisionId: context.revisionId,
        bindingId: args.binding_id,
        mappingIds: args.mapping_ids ?? null,
      }),
  });

  const applyBinding = defineTool({
    name: 'apply_asset_binding',
    axis: 'ACTION',
    access: 'write',
    description:
      'Apply a reviewed transform and its reviewed mappings to the draft as ONE typed change set: the draft ETag advances once, the changed entities and the resulting findings come back together, and an import report records what was mapped. It never overwrites a user-authored entity without an explicit resolution.',
    stores: ['bindings', 'mappings', 'features', 'import_reports'],
    remediation: ['REVIEW_IMPORT'],
    requiredFunctions: ['facility.import.map', 'facility.import.apply'],
    confirmation: 'required',
    input: {
      revision_id: field.uuid({ required: true }),
      base_revision_id: field.uuid(),
      etag: field.string(),
      binding_id: field.uuid({ required: true }),
      transform_id: field.uuid({ required: true }),
      mapping_ids: field.array(field.uuid(), { maxItems: 100 }),
      target_revision_id: field.uuid(),
      conflict_resolutions: field.array(field.object()),
    },
    handler: async ({ client, args, context }) => {
      if (!storage) {
        throw new ApiError('STORAGE_UNAVAILABLE', 'Applying an import needs object storage to read the source features.', { status: 503 });
      }
      return applyAssetBinding({
        client,
        storage,
        projectId: context.projectId,
        revisionId: context.revisionId,
        actorId: context.userId ?? null,
        bindingId: args.binding_id,
        transformId: args.transform_id,
        mappingIds: args.mapping_ids ?? null,
        targetRevisionId: args.target_revision_id ?? context.revisionId,
        etag: args.etag ?? null,
        baseRevisionId: args.base_revision_id ?? null,
        conflictResolutions: args.conflict_resolutions ?? [],
        correlationId: context.correlationId ?? null,
        logger,
      });
    },
  });

  return [createTransform, reviewTransform, createMapping, reviewMapping, reviewMappingTool, previewMerge, applyBinding];
}
