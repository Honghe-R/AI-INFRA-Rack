/**
 * Entity references (chatbox blueprint §4.7).
 *
 * Plain names in prose become references the workspace resolves by identity.
 * Collection walks the **raw** tool results structurally — no per-tool schema, so
 * a new tool is linkable with no change here — and rewriting leaves code spans,
 * fenced blocks, and quoted text alone. The identifier lives in the link target only;
 * prose never shows an internal id.
 *
 * A model writes links too, and cannot write them correctly: a live turn cited
 * `entity://facility.entity/e6a9be8b-96f7-5a33-b838-55d241fbbfe1` for an entity whose id is
 * `…-988c-5b0e-a9f8-ceb1a0de9e72`. The client resolves a reference by kind and id against the
 * turn's entity list, and renders one that does not resolve as plain text — deliberately, so a
 * dead link is never clickable — so the citation appeared as unlinked prose while the same name
 * written plainly in the sentence beside it became a working link. A model can copy a *label*
 * reliably and an id not at all, so a link whose label names a collected entity is retargeted to
 * that entity's canonical identity, and only the target is replaced.
 */
// Identity fields, most specific first. The entity-bearing ids come before `phaseId`
// because almost every revision-scoped row also carries the phase it belongs to, and a
// container, source, or requirement whose phase was chosen as its identity would link to
// the wrong object entirely. `containerId` is a container's stable entity id, so it maps
// to `facility.entity` rather than to a kind of its own. `interfaceId` precedes
// `utilitySourceId` for the same reason: a utility-interface row carries both, and taking
// the source id as the row's identity pairs it with the *interface's* name — a link whose
// label and target name different objects. The source is reachable as the row's nested
// `source` object, which this pass walks on its own.
const ID_FIELDS = [
  'entityId',
  'containerId',
  'scopeId',
  'interfaceId',
  'utilitySourceId',
  'requirementId',
  'storageId',
  'failureDomainId',
  'profileId',
  'environmentalConstraintId',
  'assumptionId',
  'waiverId',
  'geometryId',
  'diagnosticId',
  'bindingId',
  'importId',
  'budgetId',
  'phaseId',
  'assetId',
  'assetVersionId',
  'documentId',
  'jobId',
  'sessionId',
  'userId',
  'id',
];
const LABEL_FIELDS = ['name', 'label', 'title', 'displayName', 'filename'];
const EXTRA_FIELDS = ['revisionId', 'entityType', 'constraintId', 'provider', 'toolId', 'assetId'];

const KIND_BY_FIELD = Object.freeze({
  entityId: 'facility.entity',
  containerId: 'facility.entity',
  scopeId: 'facility.entity',
  utilitySourceId: 'facility.entity',
  requirementId: 'facility.entity',
  storageId: 'facility.entity',
  failureDomainId: 'facility.entity',
  profileId: 'facility.entity',
  environmentalConstraintId: 'facility.entity',
  assumptionId: 'facility.entity',
  waiverId: 'facility.entity',
  geometryId: 'facility.geometry',
  diagnosticId: 'facility.diagnostic',
  assetId: 'asset',
  assetVersionId: 'asset.version',
  bindingId: 'facility.asset_binding',
  importId: 'facility.import',
  interfaceId: 'facility.utility_interface',
  phaseId: 'facility.phase',
  budgetId: 'facility.capacity_budget',
  documentId: 'document',
  jobId: 'job',
  sessionId: 'assistant.session',
  userId: 'user',
  id: 'entity',
});

const MIN_LABEL = 3;
const MAX_LABEL = 120;

export function collectEntities(values, { maxDepth = 6, maxVisited = 5_000, maxCount = 200 } = {}) {
  const found = [];
  const seen = new WeakSet();
  const queue = Array.isArray(values) ? [...values] : [values];
  let visited = 0;

  while (queue.length > 0 && visited < maxVisited && found.length < maxCount) {
    const node = queue.shift();
    visited += 1;
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === 'object') queue.push(item);
      continue;
    }

    const candidate = candidateFrom(node);
    if (candidate) found.push(candidate);

    const depth = queue.depth ?? 0;
    if (depth < maxDepth) {
      for (const entry of Object.values(node)) {
        if (entry && typeof entry === 'object') queue.push(entry);
      }
    }
  }

  return found;
}

function candidateFrom(node) {
  const idField = ID_FIELDS.find((field) => typeof node[field] === 'string' && node[field].length > 0);
  if (!idField) return null;
  const labelField = LABEL_FIELDS.find((field) => typeof node[field] === 'string' && node[field].trim().length > 0);
  if (!labelField) return null;

  const entity = {
    kind: KIND_BY_FIELD[idField] ?? 'entity',
    id: node[idField],
    label: node[labelField],
  };
  for (const field of EXTRA_FIELDS) {
    if (field !== idField && typeof node[field] === 'string' && node[field].length > 0) entity[field] = node[field];
  }
  return entity;
}

/**
 * Keeps only labels that identify exactly one entity. An ambiguous label would
 * have to pick a winner, and linking the wrong object is worse than plain text.
 */
export function indexEntities(candidates) {
  const counts = new Map();
  for (const entity of candidates) {
    const label = entity.label.trim();
    if (label.length < MIN_LABEL || label.length > MAX_LABEL) continue;
    // A label that is just its identifier is not a human name.
    if (label === entity.id) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const unique = new Map();
  for (const entity of candidates) {
    const label = entity.label.trim();
    if (counts.get(label) === 1 && !unique.has(label)) unique.set(label, { ...entity, label });
  }
  return { entities: [...unique.values()], rewrite: unique };
}

/** Rewrites human-readable prose, protecting code spans and fenced blocks. */
export function rewriteReply(text, rewrite) {
  if (typeof text !== 'string' || rewrite.size === 0) return text;

  const asJson = tryParseEnvelope(text);
  if (asJson) {
    return JSON.stringify(
      mapHumanFields(asJson, (value) => rewriteProse(canonicalizeLinks(value, rewrite), rewrite)),
    );
  }

  return rewriteProse(canonicalizeLinks(text, rewrite), rewrite);
}

/**
 * The label of an `entity://` link, which is the reference's visible text.
 *
 * The label is what a model copies correctly. `[**Central Chiller Plant**](entity://…)` is the
 * shape this pass itself emits, and a model writing its own citation follows the same shape, so
 * the label sits between the closing bracket and the opening parenthesis.
 */
const ENTITY_LINK = /\[([^\]]*)\]\(entity:\/\/([^)\s]+)\)/g;

/** Strips the emphasis this pass adds, so a label compares equal to the collected one. */
const plainLabel = (label) => label.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Retargets a hand-written entity link to the identity the turn collected.
 *
 * Only the target changes; the label is left exactly as written, because it is the model's prose.
 * A link whose label names no collected entity is left alone: there is no identity to check it
 * against, and inventing one would be worse than showing it as text.
 */
export function canonicalizeLinks(text, rewrite) {
  if (typeof text !== 'string' || text.length === 0 || rewrite.size === 0) return text;
  return text.replace(ENTITY_LINK, (match, rawLabel, target) => {
    const entity = rewrite.get(plainLabel(rawLabel));
    if (!entity) return match;
    // Already correct — the common case, since the prose rewrite produces exactly this.
    if (target === `${entity.kind}/${entity.id}`) return match;
    return `[${rawLabel}](entity://${entity.kind}/${entity.id})`;
  });
}

function tryParseEnvelope(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function mapHumanFields(node, fn, depth = 0) {
  if (depth > 8) return node;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((item) => mapHumanFields(item, fn, depth + 1));
  if (!node || typeof node !== 'object') return node;
  const output = {};
  for (const [key, value] of Object.entries(node)) {
    output[key] = typeof value === 'string' && ['payload', 'content', 'message', 'text', 'summary'].includes(key)
      ? fn(value)
      : mapHumanFields(value, fn, depth + 1);
  }
  return output;
}

const PROTECTED = /(```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^)]*\))/g;

function rewriteProse(text, rewrite) {
  const labels = [...rewrite.keys()].sort((left, right) => right.length - left.length);
  const pattern = labels.map((label) => escapeRegExp(label)).join('|');
  if (pattern.length === 0) return text;
  const matcher = new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, 'g');

  return text
    .split(PROTECTED)
    .map((segment, index) => {
      // Odd segments are the protected captures.
      if (index % 2 === 1) return segment;
      return segment.replace(matcher, (match) => {
        const entity = rewrite.get(match);
        return entity ? `[**${entity.label}**](entity://${entity.kind}/${entity.id})` : match;
      });
    })
    .join('');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
