import { randomUUID } from 'node:crypto';
import { ApiError } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { applyTransform, fitAffine2D, fitSimilarity2D, matchesSelector, unitFactor } from '@ai-infra/imports';
import { applyChangeSet, MAX_CHANGES } from './changes.js';
import { requireDraft } from './etags.js';

/**
 * Import apply: the one place an import becomes authoritative design data.
 *
 * The mapping layer is provisional until this command runs. It reads the binding's
 * `FEATURES` representation from object storage, matches every extracted feature to a
 * reviewed mapping, and projects the matched features into **one typed change set**
 * committed through `applyChangeSet`. That is what makes apply advance the draft ETag
 * and emit `facility.revision.changed.v1` exactly once (import-adapters.md, "Facility
 * Mapping Rules"); it never creates a child revision and never publishes.
 *
 * Three rules decide the shape of this module:
 *
 *   1. **Nothing user-authored is overwritten silently.** A mapping names a target
 *      entity *type*, not a target entity, so identity is the pair
 *      `(target_entity_type, display_name)` derived from the feature. When an entity
 *      with that identity already exists — and it is not the entity a previous apply
 *      of the same source feature produced — the merge is a conflict and apply refuses
 *      with `409` and `facility.import.conflict` unless the caller resolved it.
 *   2. **Preview and apply share the resolution.** `previewImportMerge` returns what
 *      apply will do because both call the same resolver; a preview that could
 *      disagree with the commit would be worse than no preview.
 *   3. **The report is the evidence.** Every extracted feature is written to
 *      `import_features` with the matching mapping's selector, so the existing
 *      `facility.import.*` checks can fire on a later validation, and one
 *      `import_reports` row records the counts and the ids.
 *
 * The projection uses the change kinds that already exist ([D1]): `create_container`
 * and `set_geometry` for facilities, `update_entity` for a re-apply, and the authored
 * kinds for constraints, utilities, capacity, and the environment. No new mutation
 * path is invented here.
 *
 * [D1]: ../../doc/tools/site-and-facility/decisions.md
 */

/** Entity types apply currently knows how to normalize, and through which kind. */
const CONTAINER_TARGETS = Object.freeze([
  'PARCEL', 'BUILDING', 'FLOOR', 'HALL', 'SUPPORT_SPACE', 'EQUIPMENT_YARD', 'RESERVED_AREA',
]);

const PROJECTABLE_TARGETS = Object.freeze([
  ...CONTAINER_TARGETS,
  'SPATIAL_CONSTRAINT',
  'ENVIRONMENTAL_CONSTRAINT',
  'UTILITY_SOURCE',
  'UTILITY_INTERFACE',
  'CAPACITY_BUDGET',
]);

/** Resource kind to the capacity basis a utility source is measured on. */
const RESOURCE_BASIS = Object.freeze({
  POWER: 'IT_LOAD',
  COOLING: 'HEAT_REJECTION',
  WATER: 'WATER_FLOW',
  FUEL: 'FUEL_VOLUME',
  NETWORK_ENTRY: 'NETWORK_ENTRY_COUNT',
});

const RESOURCE_UNITS = Object.freeze({
  POWER: 'kW',
  COOLING: 'kW',
  WATER: 'm3/h',
  FUEL: 'L',
  NETWORK_ENTRY: 'count',
});

function inTenant(providedClient, pool, projectId, fn) {
  if (!providedClient && !pool) throw new Error('An import apply command requires a database pool or client.');
  return providedClient ? fn(providedClient) : withTenant(pool, projectId, fn);
}

function refused(code, message, details) {
  return new ApiError(code, message, { status: 422, details });
}

function conflicting(message, details) {
  return new ApiError('IMPORT_CONFLICT', message, { status: 409, details });
}

/* ------------------------------------------------------------------ store reads */

async function loadBinding({ client, projectId, revisionId, bindingId }) {
  const { rows } = await client.query(
    `SELECT binding_id, asset_version_id, representation_id, transform_id, role, status, mapping_ids
       FROM asset_bindings
      WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3`,
    [projectId, revisionId, bindingId],
  );
  if (!rows[0]) throw refused('IMPORT_BINDING_NOT_FOUND', 'The binding does not exist in this revision.', [{ field: 'binding_id', reason: 'not_found' }]);
  return rows[0];
}

async function loadTransform({ client, projectId, revisionId, bindingId, transformId }) {
  const { rows } = await client.query(
    `SELECT transform_id, binding_id, asset_version_id, source_units, target_units, source_crs, target_crs,
            vertical_crs, method, control_points, residual_error_m, review_state
       FROM spatial_transforms
      WHERE project_id = $1 AND revision_id = $2 AND ($3::uuid IS NULL OR transform_id = $3)
      ORDER BY created_at DESC, transform_id LIMIT 1`,
    [projectId, revisionId, transformId ?? null],
  );
  const transform = rows[0];
  if (!transform) throw refused('IMPORT_TRANSFORM_NOT_FOUND', 'The transform does not exist in this revision.', [{ field: 'transform_id', reason: 'not_found' }]);
  if (transform.binding_id !== bindingId) {
    throw refused('IMPORT_TRANSFORM_NOT_FOUND', 'The transform does not belong to this binding.', [{ field: 'transform_id', reason: 'not_of_binding' }]);
  }
  return transform;
}

async function loadMappings({ client, projectId, revisionId, bindingId, mappingIds }) {
  const ids = Array.isArray(mappingIds) && mappingIds.length > 0 ? mappingIds : null;
  const { rows } = await client.query(
    `SELECT mapping_id, binding_id, asset_version_id, transform_id, source_selector, target_entity_type,
            target_geometry_role, attribute_mapping, cardinality, required, review_state
       FROM import_mappings
      WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3
        AND ($4::uuid[] IS NULL OR mapping_id = ANY($4::uuid[]))
      ORDER BY created_at, mapping_id`,
    [projectId, revisionId, bindingId, ids],
  );
  return rows.map((row) => ({
    mappingId: row.mapping_id,
    bindingId: row.binding_id,
    assetVersionId: row.asset_version_id,
    transformId: row.transform_id,
    sourceSelector: row.source_selector,
    targetEntityType: row.target_entity_type,
    targetGeometryRole: row.target_geometry_role,
    attributeMapping: row.attribute_mapping ?? {},
    cardinality: row.cardinality,
    required: row.required,
    reviewState: row.review_state,
  }));
}

/**
 * The binding's extracted features, read from the `FEATURES` representation object.
 *
 * The binding may pin the representation directly or leave it implicit, in which case
 * the newest usable `FEATURES` representation of the pinned asset version is used.
 * The object store is the only reader: this tool never stored the bytes and never
 * copies them.
 */
async function loadFeatures({ client, projectId, binding, storage }) {
  const { rows } = await client.query(
    `SELECT representation_id, kind, storage_key, status, producer_id
       FROM asset_representations
      WHERE project_id = $1 AND asset_version_id = $2
        AND ($3::uuid IS NULL OR representation_id = $3)
        AND kind = 'FEATURES' AND status <> 'FAILED'
      ORDER BY (representation_id = $3) DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [projectId, binding.asset_version_id, binding.representation_id ?? null],
  );
  const representation = rows[0];
  if (!representation) {
    throw conflicting('The binding has no FEATURES representation to read.', [
      { constraint_id: 'import.conversion.incomplete', field: 'representation_id', reason: 'features_representation_missing' },
    ]);
  }
  if (!representation.storage_key) {
    throw conflicting('The FEATURES representation has no stored object to read.', [
      { constraint_id: 'import.conversion.incomplete', field: 'storage_key', reason: 'representation_not_stored' },
    ]);
  }
  if (!storage?.getObject) throw new ApiError('IMPORT_STORAGE_UNAVAILABLE', 'No object storage is configured for import.', { status: 503 });

  const object = await storage.getObject({ key: representation.storage_key });
  if (!object) {
    throw conflicting('The stored FEATURES object is missing.', [
      { constraint_id: 'import.conversion.incomplete', field: 'storage_key', reason: 'object_missing', value: representation.storage_key },
    ]);
  }
  const body = await readBody(object.body);
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  return { representation, features, counts: parsed?.counts ?? null, diagnostics: parsed?.diagnostics ?? [] };
}

/** Storage returns a stream; a test double may hand back bytes or a parsed body. */
async function readBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return typeof body === 'string' ? body : body.toString('utf8');
  if (typeof body === 'object' && (Array.isArray(body.features) || typeof body[Symbol.asyncIterator] !== 'function')) {
    if (typeof body.pipe === 'function' || typeof body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    }
    return body;
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ resolution */

function featureIdOf(feature) {
  return String(feature.featureId ?? feature.source_feature_id ?? feature.id ?? feature.sourceSelector ?? '');
}

function attributesOf(feature) {
  return feature.attributes ?? feature.rawAttributes ?? feature.raw_attributes ?? {};
}

function derivedName(feature, mapping) {
  const attributes = attributesOf(feature);
  const name = attributes.name ?? attributes.NAME ?? attributes.Name ?? feature.name ?? feature.displayName;
  return name === undefined || name === null || name === '' ? featureIdOf(feature) || mapping.targetEntityType : String(name);
}

function matchesMapping(mapping, feature) {
  // The stored per-feature selector is the exact provenance the adapter recorded, so
  // equality wins when the feature record itself does not carry the fields the
  // selector reads. That fallback is what keeps preview and apply stable across a
  // representation that only preserved the selector string.
  if (feature.sourceSelector && feature.sourceSelector === mapping.sourceSelector) return true;
  try {
    return matchesSelector(mapping.sourceSelector, feature);
  } catch {
    return false;
  }
}

function dispositionOf(feature) {
  return feature.disposition ?? feature.status ?? null;
}

/**
 * Turns extracted features into a per-feature plan. Pure over already-loaded rows:
 * the same function answers preview and apply, which is the only way the two can be
 * guaranteed to agree.
 */
function resolvePlans({ features, mappings, priorTargets, existingEntities, conflictResolutions }) {
  const resolutions = new Map();
  for (const resolution of conflictResolutions) {
    if (resolution?.mapping_id && resolution?.source_feature_id) {
      resolutions.set(`${resolution.mapping_id}:${resolution.source_feature_id}`, resolution);
    }
    if (resolution?.entity_id) resolutions.set(`entity:${resolution.entity_id}`, resolution);
  }

  const plans = [];
  const diagnostics = [];

  for (const feature of features) {
    const featureId = featureIdOf(feature);
    const matched = mappings.filter((mapping) => matchesMapping(mapping, feature));

    if (matched.length === 0) {
      plans.push({ feature, featureId, mapping: null, action: 'unmapped', reason: 'no_mapping', name: null, entityId: null });
      continue;
    }
    if (matched.length > 1) {
      const mapping = matched[0];
      plans.push({
        feature,
        featureId,
        mapping,
        action: 'conflicting',
        reason: 'multiple_mappings',
        name: derivedName(feature, mapping),
        entityId: null,
        candidates: matched.map((entry) => entry.mappingId),
      });
      diagnostics.push({
        constraintId: 'facility.import.conflict',
        message: `Source feature ${featureId} is claimed by more than one mapping.`,
        mappingIds: matched.map((entry) => entry.mappingId),
      });
      continue;
    }

    const mapping = matched[0];
    const name = derivedName(feature, mapping);
    if (!PROJECTABLE_TARGETS.includes(mapping.targetEntityType) || dispositionOf(feature) === 'REJECTED') {
      plans.push({ feature, featureId, mapping, action: 'unsupported', reason: 'unsupported_target', name, entityId: null });
      continue;
    }

    const prior = priorTargets.get(`${mapping.mappingId}:${featureId}`);
    if (prior?.normalized_entity_id) {
      const resolution = resolutions.get(`entity:${prior.normalized_entity_id}`);
      if (resolution?.resolution === 'SKIP') {
        plans.push({ feature, featureId, mapping, action: 'unmapped', reason: 'resolved_skip', name, entityId: null });
        continue;
      }
      plans.push({
        feature,
        featureId,
        mapping,
        action: 'updated',
        reason: 'prior_import',
        name,
        entityId: prior.normalized_entity_id,
      });
      continue;
    }

    const resolution = resolutions.get(`${mapping.mappingId}:${featureId}`);
    if (resolution?.resolution === 'SKIP') {
      plans.push({ feature, featureId, mapping, action: 'unmapped', reason: 'resolved_skip', name, entityId: null });
      continue;
    }

    const existing = existingEntities.get(entityKey(mapping.targetEntityType, name));
    if (existing) {
      if (resolution?.resolution === 'UPDATE' || resolutions.get(`entity:${existing.entityId}`)?.resolution === 'UPDATE') {
        plans.push({ feature, featureId, mapping, action: 'updated', reason: 'resolved_update', name, entityId: existing.entityId });
        continue;
      }
      plans.push({
        feature,
        featureId,
        mapping,
        action: 'conflicting',
        reason: 'user_authored_target',
        name,
        entityId: existing.entityId,
        entityType: mapping.targetEntityType,
      });
      diagnostics.push({
        constraintId: 'facility.import.conflict',
        message: `A ${mapping.targetEntityType} named "${name}" already exists in this revision.`,
        mappingIds: [mapping.mappingId],
      });
      continue;
    }

    plans.push({
      feature,
      featureId,
      mapping,
      action: 'created',
      reason: null,
      name,
      entityId: randomUUID(),
      entityType: mapping.targetEntityType,
    });
  }

  return { plans, diagnostics };
}

function entityKey(entityType, name) {
  return `${entityType}\u0000${name}`;
}

/** Loads the prior normalized targets of this binding, keyed mapping + source feature. */
async function loadPriorTargets({ client, projectId, revisionId, bindingId }) {
  const { rows } = await client.query(
    `SELECT import_mapping_id, source_feature_id, normalized_entity_id, status
       FROM import_features
      WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3 AND normalized_entity_id IS NOT NULL`,
    [projectId, revisionId, bindingId],
  );
  const prior = new Map();
  for (const row of rows) prior.set(`${row.import_mapping_id}:${row.source_feature_id}`, row);
  return prior;
}

/** One query for every `(type, display_name)` an incoming feature could collide with. */
async function loadExistingEntities({ client, projectId, revisionId, mappings }) {
  const types = [...new Set(mappings.map((mapping) => mapping.targetEntityType))];
  if (types.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT entity_id, entity_type, display_name
       FROM entity_registry
      WHERE project_id = $1 AND revision_id = $2 AND display_name IS NOT NULL
        AND entity_type = ANY($3::entity_type[])`,
    [projectId, revisionId, types],
  );
  const entities = new Map();
  for (const row of rows) {
    const key = entityKey(row.entity_type, row.display_name);
    if (!entities.has(key)) entities.set(key, { entityId: row.entity_id, entityType: row.entity_type, displayName: row.display_name });
  }
  return entities;
}

function countPlans(plans) {
  const counts = { created: 0, updated: 0, conflicting: 0, unmapped: 0, unsupported: 0 };
  for (const plan of plans) {
    if (plan.action in counts) counts[plan.action] += 1;
  }
  return counts;
}

function conflictsOf(plans) {
  return plans
    .filter((plan) => plan.action === 'conflicting')
    .map((plan) => ({
      constraint_id: 'facility.import.conflict',
      reason: plan.reason,
      mapping_id: plan.mapping?.mappingId ?? null,
      source_feature_id: plan.featureId,
      target_entity_type: plan.mapping?.targetEntityType ?? null,
      entity_id: plan.entityId ?? null,
      entity_ref: plan.entityId ? { entity_id: plan.entityId, entity_type: plan.mapping?.targetEntityType ?? null } : null,
      candidates: plan.candidates ?? null,
      name: plan.name ?? null,
    }));
}

/* ------------------------------------------------------------------- preview */

/**
 * What apply would do, without writing anything.
 *
 * The counts answer "how much of this source is already in the draft", and the
 * conflicts are the merge decisions a caller must make before apply will proceed.
 * The command performs only reads, so it is safe to call on every keystroke in a
 * mapping editor.
 */
export async function previewImportMerge({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  bindingId,
  mappingIds = null,
  storage,
} = {}) {
  return inTenant(providedClient, pool, projectId, async (client) => {
    const binding = await loadBinding({ client, projectId, revisionId, bindingId });
    const mappings = (await loadMappings({ client, projectId, revisionId, bindingId, mappingIds }))
      .filter((mapping) => mapping.reviewState === 'REVIEWED');
    const { features, counts: sourceCounts, diagnostics: sourceDiagnostics } = await loadFeatures({
      client, projectId, binding, storage,
    });

    const [priorTargets, existingEntities] = await Promise.all([
      loadPriorTargets({ client, projectId, revisionId, bindingId }),
      loadExistingEntities({ client, projectId, revisionId, mappings }),
    ]);
    const { plans, diagnostics } = resolvePlans({
      features, mappings, priorTargets, existingEntities, conflictResolutions: [],
    });

    const counts = countPlans(plans);
    const requiredWithoutMatches = mappings
      .filter((mapping) => mapping.required)
      .filter((mapping) => !plans.some((plan) => plan.mapping?.mappingId === mapping.mappingId && plan.action !== 'unmapped'))
      .map((mapping) => ({
        constraint_id: 'facility.import.mapping.unresolved',
        mapping_id: mapping.mappingId,
        source_selector: mapping.sourceSelector,
      }));
    const ambiguous = mappings
      .filter((mapping) => mapping.cardinality === 'ONE_TO_ONE')
      .map((mapping) => ({
        mapping,
        matches: plans.filter((plan) => plan.mapping?.mappingId === mapping.mappingId && plan.action !== 'unmapped').length,
      }))
      .filter((entry) => entry.matches > 1)
      .map((entry) => ({
        constraint_id: 'facility.import.mapping.ambiguous',
        mapping_id: entry.mapping.mappingId,
        source_selector: entry.mapping.sourceSelector,
        matches: entry.matches,
      }));

    return {
      bindingId,
      revisionId,
      featureCount: features.length,
      sourceCounts,
      counts,
      conflicts: conflictsOf(plans),
      diagnostics: [...sourceDiagnostics, ...diagnostics],
      unresolvedRequiredMappings: requiredWithoutMatches,
      ambiguousMappings: ambiguous,
      effect:
        'Preview only: nothing was written. created counts features with no existing target, updated counts features a prior apply already normalized, and conflicting names the entities apply would not overwrite without a resolution.',
    };
  });
}

/* --------------------------------------------------------------------- apply */

/**
 * Applies reviewed mappings to the draft: one change set, one ETag advance, one
 * import report.
 *
 * The order inside the transaction matters. The change set commits first (with the
 * diagnostic preview off, because the `import_features` rows the import checks read
 * do not exist yet and previewing then would report every required mapping as
 * unresolved). Then every extracted feature is recorded, then the report, then the
 * binding's status and the `facility.asset-binding.applied.v1` event. All of it rolls
 * back together if anything refuses.
 */
export async function applyAssetBinding({
  pool = null,
  client: providedClient = null,
  projectId,
  revisionId,
  actorId = null,
  bindingId,
  transformId,
  mappingIds = null,
  targetRevisionId = null,
  etag = null,
  baseRevisionId = null,
  storage,
  correlationId = null,
  logger = null,
  conflictResolutions = [],
} = {}) {
  return inTenant(providedClient, pool, projectId, async (client) => {
    const target = targetRevisionId ?? revisionId;
    if (target !== revisionId) {
      // The binding, its transform, and its mappings are revision content, and the
      // existing `facility.import.*` checks join `import_features` on the mapping's
      // own revision. Applying into a different revision would need the binding
      // duplicated there, which the model does not express.
      throw refused('IMPORT_TARGET_REVISION_UNSUPPORTED', 'An import applies to the revision that holds its binding.', [
        { field: 'target_revision_id', reason: 'not_binding_revision', binding_revision_id: revisionId, target_revision_id: target },
      ]);
    }
    const revision = await requireDraft({ client, projectId, revisionId });

    const binding = await loadBinding({ client, projectId, revisionId, bindingId });
    const transform = await loadTransform({
      client, projectId, revisionId, bindingId, transformId: transformId ?? binding.transform_id,
    });
    if (transform.review_state !== 'REVIEWED') {
      throw conflicting('The transform must be REVIEWED before an import may be applied.', [
        { constraint_id: 'import.transform.unreviewed', transform_id: transform.transform_id, review_state: transform.review_state },
      ]);
    }

    const selected = await loadMappings({ client, projectId, revisionId, bindingId, mappingIds });
    if (selected.length === 0) {
      throw refused('IMPORT_MAPPING_REQUIRED', 'At least one mapping must be selected for apply.', [{ field: 'mapping_ids', reason: 'required' }]);
    }
    const unreviewed = selected.filter((mapping) => mapping.reviewState !== 'REVIEWED');
    if (unreviewed.length > 0) {
      throw conflicting('Every selected mapping must be REVIEWED before apply.', unreviewed.map((mapping) => ({
        constraint_id: 'facility.import.mapping.unreviewed',
        mapping_id: mapping.mappingId,
        review_state: mapping.reviewState,
      })));
    }
    const selectedIds = selected.map((mapping) => mapping.mappingId);

    const { features, counts: sourceCounts, diagnostics: sourceDiagnostics } = await loadFeatures({
      client, projectId, binding, storage,
    });
    const [priorTargets, existingEntities] = await Promise.all([
      loadPriorTargets({ client, projectId, revisionId, bindingId }),
      loadExistingEntities({ client, projectId, revisionId, mappings: selected }),
    ]);
    const { plans, diagnostics } = resolvePlans({
      features, mappings: selected, priorTargets, existingEntities, conflictResolutions,
    });

    // A required reviewed mapping that matched nothing blocks authoritative geometry
    // (import-adapters.md, "Facility Mapping Rules").
    const unresolved = selected
      .filter((mapping) => mapping.required)
      .filter((mapping) => !plans.some((plan) => plan.mapping?.mappingId === mapping.mappingId && plan.action !== 'unmapped'));
    if (unresolved.length > 0) {
      throw conflicting('A required mapping matched no source feature.', unresolved.map((mapping) => ({
        constraint_id: 'facility.import.mapping.unresolved',
        mapping_id: mapping.mappingId,
        source_selector: mapping.sourceSelector,
      })));
    }

    // A one-to-one mapping that matched more than one feature is ambiguous and must be
    // refined or explicitly widened before it may normalize anything.
    const ambiguous = selected
      .filter((mapping) => mapping.cardinality === 'ONE_TO_ONE')
      .map((mapping) => ({
        mapping,
        matches: plans.filter((plan) => plan.mapping?.mappingId === mapping.mappingId && plan.action !== 'unmapped').length,
      }))
      .filter((entry) => entry.matches > 1);
    if (ambiguous.length > 0) {
      throw conflicting('A one-to-one mapping matched more than one source feature.', ambiguous.map((entry) => ({
        constraint_id: 'facility.import.mapping.ambiguous',
        mapping_id: entry.mapping.mappingId,
        source_selector: entry.mapping.sourceSelector,
        matches: entry.matches,
      })));
    }

    const conflicts = conflictsOf(plans);
    if (conflicts.length > 0) {
      throw conflicting(
        'The import would overwrite entities that were not produced by this binding. Resolve each conflict before applying.',
        conflicts,
      );
    }

    const changes = await projectChangeSet({
      client, projectId, revisionId, transform, plans,
    });
    if (changes.length === 0) {
      throw refused('IMPORT_NOTHING_TO_APPLY', 'No feature matched a reviewed mapping, so there is nothing to apply.', [
        { field: 'mapping_ids', reason: 'no_matches' },
      ]);
    }
    if (changes.length > MAX_CHANGES) {
      throw refused('IMPORT_CHANGE_SET_TOO_LARGE', 'The import produces more changes than one change set may carry.', [
        { field: 'mapping_ids', reason: 'too_many_changes', max_items: MAX_CHANGES, actual: changes.length },
      ]);
    }

    const applied = await applyChangeSet({
      client,
      projectId,
      revisionId,
      scenarioId: revision.scenario_id,
      actorId,
      baseRevisionId,
      etag,
      changes,
      // The import checks read `import_features`, which this command writes after the
      // set commits. Previewing inside the commit would report every required mapping
      // as unresolved; the report below is the evidence, and a later validation run
      // evaluates the graph the set produced.
      previewDiagnostics: false,
      correlationId,
      logger,
    });

    const report = await recordImportFeatures({
      client, projectId, revisionId, scenarioId: revision.scenario_id, actorId, binding, plans,
    });

    const counts = countPlans(plans);
    const diagnosticIds = [...sourceDiagnostics, ...diagnostics].map((entry) => entry.constraintId).filter(Boolean);
    const importReportId = await issueImportReport({
      client,
      projectId,
      scenarioId: revision.scenario_id,
      revisionId,
      actorId,
      assetVersionIds: [binding.asset_version_id],
      bindingIds: [bindingId],
      transformIds: [transform.transform_id],
      mappingIds: selectedIds,
      counts: {
        mapped: counts.created + counts.updated,
        unmapped: counts.unmapped,
        unsupported: counts.unsupported,
      },
      diagnosticIds,
    });

    await client.query(
      `UPDATE asset_bindings
          SET status = 'REVIEWED', transform_id = $4, mapping_ids = $5::uuid[], updated_at = now(), updated_by = $6
        WHERE project_id = $1 AND revision_id = $2 AND binding_id = $3`,
      [projectId, revisionId, bindingId, transform.transform_id, selectedIds, actorId],
    );

    await client.query(
      `INSERT INTO outbox_events
         (event_id, project_id, scenario_id, revision_id, event_type, aggregate_type, aggregate_id, payload,
          correlation_id, created_by)
       VALUES ($1, $2, $3, $4, 'facility.asset-binding.applied.v1', 'asset_binding', $5, $6::jsonb, $7, $8)`,
      [
        randomUUID(), projectId, revision.scenario_id, revisionId, bindingId,
        JSON.stringify({
          binding_id: bindingId,
          transform_id: transform.transform_id,
          target_revision_id: target,
          import_report_id: importReportId,
          mapping_ids: selectedIds,
          counts: { mapped: counts.created + counts.updated, unmapped: counts.unmapped, unsupported: counts.unsupported },
          conflicts: 0,
          etag: applied.etag,
          etag_version: applied.etagVersion,
        }),
        correlationId, actorId,
      ],
    );

    logger?.info?.('import.binding.applied', {
      projectId, revisionId, bindingId, importReportId, changes: changes.length,
      mapped: counts.created + counts.updated, unmapped: counts.unmapped, unsupported: counts.unsupported,
    });

    return {
      bindingId,
      revisionId,
      targetRevisionId: target,
      transformId: transform.transform_id,
      mappingIds: selectedIds,
      applied: true,
      importReportId,
      counts,
      featureCount: features.length,
      changes: applied.applied,
      etag: applied.etag,
      etagVersion: applied.etagVersion,
      report,
      effect: `The import applied ${counts.created + counts.updated} mapped feature(s) as one change set. The draft ETag advanced and the import report records the evidence.`,
    };
  });
}

/**
 * Projects plans into the typed change set.
 *
 * Entity identities are passed in explicitly so the command knows the normalized
 * entity id before the set commits; that is what lets the same transaction write the
 * `import_features` rows that point at those entities.
 */
async function projectChangeSet({ client, projectId, revisionId, transform, plans }) {
  const changes = [];
  const context = await loadProjectionContext({ client, projectId, revisionId, plans });
  let ordinal = 0;

  for (const plan of plans) {
    if (plan.action !== 'created' && plan.action !== 'updated') continue;
    const mapping = plan.mapping;
    const attributes = attributesOf(plan.feature);
    const entityRef = { entity_id: plan.entityId, entity_type: mapping.targetEntityType };

    if (plan.action === 'created') {
      if (CONTAINER_TARGETS.includes(mapping.targetEntityType)) {
        const carriesLevel = mapping.targetEntityType === 'FLOOR' || mapping.targetEntityType === 'HALL';
        changes.push({
          kind: 'create_container',
          payload: {
            container_id: plan.entityId,
            container_kind: mapping.targetEntityType,
            name: plan.name,
            scope_id: attributes.scope_id ?? context.scopeId,
            ...(attributes.parent_container_id ? { parent_container_id: attributes.parent_container_id } : {}),
            ...(attributes.phase_id ? { phase_id: attributes.phase_id } : {}),
            ...(carriesLevel ? { level_number: attributes.level_number ?? context.nextLevel } : {}),
            ...(attributes.elevation_base_m !== undefined ? { elevation_base_m: attributes.elevation_base_m } : {}),
            ...(attributes.elevation_top_m !== undefined ? { elevation_top_m: attributes.elevation_top_m } : {}),
          },
        });
      } else {
        changes.push(createdEntityChange({ plan, attributes, context }));
      }
    } else {
      changes.push({ kind: 'update_entity', entity_ref: entityRef, payload: { patch: { display_name: plan.name } } });
    }

    const geometry = await geometryForPlan({ client, plan, transform });
    if (geometry) {
      ordinal += 1;
      changes.push({
        kind: 'set_geometry',
        entity_ref: entityRef,
        payload: {
          geometry_id: randomUUID(),
          role: mapping.targetGeometryRole,
          geojson_4326: geometry.geojson,
          ordinal,
          ...(attributes.elevation_base_m !== undefined ? { elevation_base_m: attributes.elevation_base_m } : {}),
          ...(attributes.elevation_top_m !== undefined ? { elevation_top_m: attributes.elevation_top_m } : {}),
          ...(attributes.height_m !== undefined ? { height_m: attributes.height_m } : {}),
        },
      });
    }
  }

  return changes;
}

function createdEntityChange({ plan, attributes, context }) {
  const mapping = plan.mapping;
  if (mapping.targetEntityType === 'SPATIAL_CONSTRAINT') {
    const kind = attributes.constraint_kind ?? attributes.kind ?? 'EXCLUSION_ZONE';
    const severity = attributes.severity ?? 'ERROR';
    const ruleValue = attributes.rule_value;
    if (ruleValue !== undefined && ruleValue !== null && (!attributes.rule_kind || !attributes.rule_unit)) {
      throw refused('IMPORT_MAPPING_ATTRIBUTES_INCOMPLETE', 'A numeric spatial constraint rule needs a kind and a unit.', [
        { field: 'attributes.rule_value', reason: 'incomplete_rule', source_feature_id: plan.featureId },
      ]);
    }
    return {
      kind: 'assign_constraint',
      payload: {
        constraint_id: plan.entityId,
        constraint_kind: kind,
        severity,
        scope_id: attributes.scope_id ?? context.scopeId,
        ...(attributes.rule_kind ? { rule_kind: attributes.rule_kind } : {}),
        ...(ruleValue !== undefined && ruleValue !== null ? { rule_value: ruleValue } : {}),
        ...(attributes.rule_unit ? { rule_unit: attributes.rule_unit } : {}),
      },
    };
  }

  if (mapping.targetEntityType === 'ENVIRONMENTAL_CONSTRAINT') {
    return {
      kind: 'set_environmental_constraint',
      payload: {
        profile_id: attributes.profile_id ?? context.profileId,
        constraint_kind: requiredAttribute(attributes, 'constraint_kind', plan),
        threshold_value: requiredAttribute(attributes, 'threshold_value', plan),
        threshold_unit: requiredAttribute(attributes, 'threshold_unit', plan),
        basis: attributes.basis ?? 'FACILITY_INPUT',
        ...(attributes.affected_entity_id ? { affected_entity_id: attributes.affected_entity_id } : {}),
        ...(attributes.effective_at ? { effective_at: attributes.effective_at } : {}),
        ...(attributes.effective_until ? { effective_until: attributes.effective_until } : {}),
      },
    };
  }

  if (mapping.targetEntityType === 'UTILITY_SOURCE') {
    const kind = requiredAttribute(attributes, 'kind', plan);
    return {
      kind: 'set_utility_source',
      payload: {
        utility_source_id: plan.entityId,
        kind,
        capacity_value: attributes.capacity_value ?? null,
        capacity_unit: attributes.capacity_unit ?? RESOURCE_UNITS[kind],
        capacity_basis: attributes.capacity_basis ?? RESOURCE_BASIS[kind] ?? 'FACILITY_INPUT',
        capacity_state: attributes.capacity_state ?? 'FIRM',
        failure_domain_id: attributes.failure_domain_id ?? context.failureDomainId,
        phase_id: attributes.phase_id ?? context.phaseId,
        name: plan.name,
        ...(attributes.available_from ? { available_from: attributes.available_from } : {}),
      },
    };
  }

  if (mapping.targetEntityType === 'UTILITY_INTERFACE') {
    return {
      kind: 'set_utility_interface',
      payload: {
        interface_id: plan.entityId,
        utility_source_id: requiredAttribute(attributes, 'utility_source_id', plan),
        service_state: attributes.service_state ?? 'AVAILABLE',
        failure_domain_id: attributes.failure_domain_id ?? context.failureDomainId,
        phase_id: attributes.phase_id ?? context.phaseId,
        name: plan.name,
        ...(attributes.capacity_value !== undefined && attributes.capacity_value !== null
          ? {
              capacity_value: attributes.capacity_value,
              capacity_unit: requiredAttribute(attributes, 'capacity_unit', plan),
              capacity_basis: requiredAttribute(attributes, 'capacity_basis', plan),
              capacity_state: attributes.capacity_state ?? 'FIRM',
            }
          : {}),
      },
    };
  }

  if (mapping.targetEntityType === 'CAPACITY_BUDGET') {
    const resourceKind = requiredAttribute(attributes, 'resource_kind', plan);
    return {
      kind: 'set_capacity_budget',
      payload: {
        owner_entity_id: requiredAttribute(attributes, 'owner_entity_id', plan),
        phase_id: attributes.phase_id ?? context.phaseId,
        resource_kind: resourceKind,
        basis: attributes.basis ?? RESOURCE_BASIS[resourceKind] ?? 'FACILITY_INPUT',
        unit: requiredAttribute(attributes, 'unit', plan),
        ...(attributes.commissioned_value !== undefined ? { commissioned_value: attributes.commissioned_value } : {}),
        ...(attributes.planned_value !== undefined ? { planned_value: attributes.planned_value } : {}),
        ...(attributes.reserved_value !== undefined ? { reserved_value: attributes.reserved_value } : {}),
        ...(attributes.derating_factor !== undefined ? { derating_factor: attributes.derating_factor } : {}),
      },
    };
  }

  throw refused('IMPORT_MAPPING_UNSUPPORTED_TARGET', `This tool cannot normalize ${mapping.targetEntityType} from an import yet.`, [
    { field: 'target_entity_type', reason: 'no_projection_path', value: mapping.targetEntityType },
  ]);
}

function requiredAttribute(attributes, field, plan) {
  const value = attributes[field];
  if (value === undefined || value === null || value === '') {
    throw refused('IMPORT_MAPPING_ATTRIBUTES_INCOMPLETE', `The mapping needs the attribute "${field}" to normalize this entity.`, [
      { field: `attributes.${field}`, reason: 'required', source_feature_id: plan.featureId, target_entity_type: plan.mapping?.targetEntityType ?? null },
    ]);
  }
  return value;
}

async function loadProjectionContext({ client, projectId, revisionId, plans }) {
  const scope = (
    await client.query(
      `SELECT scope_id FROM design_scopes WHERE project_id = $1 AND revision_id = $2 ORDER BY created_at, scope_id LIMIT 1`,
      [projectId, revisionId],
    )
  ).rows[0];
  const phase = (
    await client.query(
      `SELECT phase_id FROM facility_phases WHERE project_id = $1 AND revision_id = $2 ORDER BY phase_order, phase_id LIMIT 1`,
      [projectId, revisionId],
    )
  ).rows[0];
  const domain = (
    await client.query(
      `SELECT failure_domain_id FROM failure_domains WHERE project_id = $1 AND revision_id = $2 ORDER BY created_at, failure_domain_id LIMIT 1`,
      [projectId, revisionId],
    )
  ).rows[0];
  const profile = (
    await client.query(
      `SELECT profile_id FROM environmental_profiles WHERE project_id = $1 AND revision_id = $2 ORDER BY created_at, profile_id LIMIT 1`,
      [projectId, revisionId],
    )
  ).rows[0];
  const level = (
    await client.query(
      `SELECT COALESCE(max(level_number), -1) + 1 AS next FROM facility_containers WHERE project_id = $1 AND revision_id = $2`,
      [projectId, revisionId],
    )
  ).rows[0];

  const needsScope = plans.some((plan) => plan.action === 'created');
  if (needsScope && !scope) {
    throw refused('IMPORT_PROJECTION_CONTEXT_MISSING', 'The revision has no design scope to hang imported entities off.', [
      { field: 'scope_id', reason: 'no_design_scope' },
    ]);
  }
  return {
    scopeId: scope?.scope_id ?? null,
    phaseId: phase?.phase_id ?? null,
    failureDomainId: domain?.failure_domain_id ?? null,
    profileId: profile?.profile_id ?? null,
    nextLevel: level?.next ?? 0,
  };
}

/**
 * The WGS 84 geometry a plan writes.
 *
 * The `FEATURES` representation carries `geojson` in WGS 84 whenever the adapter knew
 * the source CRS; when only `localGeometry` exists, the reviewed transform is applied
 * and the result is converted to WGS 84 through PostGIS, which is the geodetic
 * provider the workspace framework does not embed. A method that neither of those can
 * serve is refused rather than approximated.
 */
async function geometryForPlan({ client, plan, transform }) {
  if (!plan.mapping?.targetGeometryRole) return null;
  const feature = plan.feature;
  if (feature.geojson && typeof feature.geojson === 'object') return { geojson: feature.geojson, crs: 'EPSG:4326' };

  const local = feature.localGeometry ?? feature.local_geometry ?? null;
  if (!local) {
    throw refused('IMPORT_FEATURE_GEOMETRY_MISSING', `Source feature ${plan.featureId} has no geometry to normalize.`, [
      { field: 'geojson', reason: 'required', source_feature_id: plan.featureId },
    ]);
  }
  const srid = epsgSrid(transform.target_crs);
  if (srid === null) {
    throw refused('IMPORT_GEOMETRY_PROJECTION_UNSUPPORTED', 'The target CRS is not in EPSG form, so local geometry cannot be normalized.', [
      { constraint_id: 'import.transform.unreviewed', field: 'target_crs', reason: 'not_epsg', value: transform.target_crs },
    ]);
  }
  const projected = applyLocalTransform({ localGeometry: local, transform });
  if (!projected) {
    throw refused('IMPORT_GEOMETRY_PROJECTION_UNSUPPORTED', 'This transform needs a geodetic provider, so local geometry cannot be normalized.', [
      { constraint_id: 'import.transform.unreviewed', field: 'method', reason: 'provider_required', value: transform.method },
    ]);
  }
  const { rows } = await client.query(
    `SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), $2::integer), 4326)) AS geojson`,
    [JSON.stringify(projected), srid],
  );
  return { geojson: JSON.parse(rows[0].geojson), crs: 'EPSG:4326' };
}

/**
 * In-process local-to-project projection, mirroring the `transform_geometry` kind.
 * The framework's own fitters are used rather than a second copy of the math, so the
 * geometry apply writes and the geometry the change kind re-projects cannot disagree.
 */
function applyLocalTransform({ localGeometry, transform }) {
  const points = Array.isArray(transform.control_points) ? transform.control_points : [];
  const map = (method, parameters) => mapGeometry(localGeometry, (coordinate) => applyTransform(method, parameters, coordinate));

  if (transform.method === 'DECLARED_CRS' || transform.method === 'MANUAL' || transform.method === 'CONTROL_POINTS_HELMERT') return null;
  if (transform.method === 'UNIT_SCALE') {
    try {
      return map('UNIT_SCALE', { factor: unitFactor(transform.source_units, transform.target_units) });
    } catch {
      return null;
    }
  }
  if (transform.method === 'CONTROL_POINTS_AFFINE' || (transform.method === 'FITTED_RESIDUAL' && points.length >= 3)) {
    if (points.length < 3) return null;
    return map('AFFINE_2D', fitAffine2D(points).parameters);
  }
  if (transform.method === 'FITTED_RESIDUAL' && points.length >= 2) {
    return map('SIMILARITY_2D', fitSimilarity2D(points).parameters);
  }
  return null;
}

/* -------------------------------------------------------------- the report */

/**
 * Records every extracted feature, mapped or not.
 *
 * `source_selector` is the *matching mapping's* normalized selector rather than the
 * feature's own string, because that is what the existing `facility.import.*` checks
 * join on. Unmatched features keep their own selector so they stay queryable and
 * reconcile in the report.
 */
async function recordImportFeatures({
  client, projectId, revisionId, scenarioId, actorId, binding, plans,
}) {
  let mapped = 0;
  let referenceOnly = 0;
  let unsupported = 0;
  const rows = [];

  for (const plan of plans) {
    const mappedFeature = plan.action === 'created' || plan.action === 'updated';
    let status;
    if (mappedFeature) status = 'MAPPED';
    else if (plan.action === 'unsupported') status = 'UNSUPPORTED';
    else status = 'REFERENCE_ONLY';

    if (mappedFeature) mapped += 1;
    else if (status === 'UNSUPPORTED') unsupported += 1;
    else referenceOnly += 1;

    const selector = plan.mapping?.sourceSelector ?? plan.feature.sourceSelector ?? `feature:${plan.featureId}`;
    const geometryType = plan.feature.geometryType ?? plan.feature.geometry_type ?? null;
    const attributes = attributesOf(plan.feature);
    const importFeatureId = randomUUID();
    await client.query(
      `INSERT INTO import_features
         (import_feature_id, project_id, scenario_id, revision_id, asset_version_id, binding_id, source_selector,
          source_feature_id, geometry_type, raw_attributes, vertex_count, status, import_mapping_id, normalized_entity_id,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)`,
      [
        importFeatureId, projectId, scenarioId, revisionId, binding.asset_version_id, binding.binding_id,
        selector, plan.featureId, geometryType, JSON.stringify(attributes), vertexCount(plan.feature),
        status, plan.mapping?.mappingId ?? null, mappedFeature ? plan.entityId : null, actorId,
      ],
    );
    rows.push({
      importFeatureId,
      sourceFeatureId: plan.featureId,
      sourceSelector: selector,
      status,
      importMappingId: plan.mapping?.mappingId ?? null,
      normalizedEntityId: mappedFeature ? plan.entityId : null,
    });
  }

  return { features: rows, mapped, referenceOnly, unsupported, total: plans.length };
}

/**
 * Writes one immutable `import_reports` row. Exported because a command that produced
 * an import result without an auditable report would be missing the evidence the
 * specification requires.
 */
export async function issueImportReport({
  client,
  projectId,
  scenarioId,
  revisionId,
  actorId = null,
  assetVersionIds = [],
  bindingIds = [],
  transformIds = [],
  mappingIds = [],
  counts = {},
  diagnosticIds = [],
  reviewState = 'REVIEWED',
} = {}) {
  const importReportId = randomUUID();
  await client.query(
    `INSERT INTO import_reports
       (import_report_id, project_id, scenario_id, revision_id, asset_version_ids, binding_ids, transform_ids,
        mapping_ids, diagnostic_ids, mapped_feature_count, unmapped_feature_count, unsupported_feature_count,
        review_state, created_by)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[], $9::uuid[], $10, $11, $12, $13, $14)`,
    [
      importReportId, projectId, scenarioId, revisionId, assetVersionIds, bindingIds, transformIds, mappingIds,
      // `diagnostic_ids` is a uuid[] in the store; the import diagnostics are catalog
      // identifiers, not diagnostic rows, so they travel in the payload and the report
      // records the numeric counts. Recording a fabricated uuid would be a lie.
      [],
      counts.mapped ?? 0, counts.unmapped ?? 0, counts.unsupported ?? 0, reviewState, actorId,
    ],
  );
  return importReportId;
}

/* ------------------------------------------------------------------ geometry */

function vertexCount(feature) {
  if (Number.isFinite(feature.vertexCount)) return feature.vertexCount;
  const geometry = feature.geojson ?? feature.localGeometry ?? null;
  if (!geometry?.coordinates) return 0;
  let total = 0;
  const walk = (value) => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      total += 1;
      return;
    }
    if (Array.isArray(value)) for (const entry of value) walk(entry);
  };
  walk(geometry.coordinates);
  return total;
}

function mapGeometry(geojson, fn) {
  switch (geojson?.type) {
    case 'Point':
      return { ...geojson, coordinates: fn(geojson.coordinates) };
    case 'MultiPoint':
    case 'LineString':
      return { ...geojson, coordinates: geojson.coordinates.map(fn) };
    case 'MultiLineString':
    case 'Polygon':
      return { ...geojson, coordinates: geojson.coordinates.map((line) => line.map(fn)) };
    case 'MultiPolygon':
      return { ...geojson, coordinates: geojson.coordinates.map((polygon) => polygon.map((ring) => ring.map(fn))) };
    default:
      throw refused('IMPORT_FEATURE_GEOMETRY_UNSUPPORTED', 'The source feature geometry is not a shape this tool can normalize.', [
        { field: 'localGeometry.type', reason: 'unsupported_geometry', value: geojson?.type ?? null },
      ]);
  }
}

function epsgSrid(crs) {
  const match = /^EPSG:(\d+)$/i.exec(String(crs ?? '').trim());
  return match ? Number(match[1]) : null;
}
