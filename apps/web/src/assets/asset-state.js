/**
 * Asset surface logic.
 *
 * Files are project assets, not tool documents (project-assets.md, and
 * ui-pattern.md "Project Assets and Import Entry Points"). The shell owns the
 * asset surface and the shared entry points; a tool consumes assets through
 * bindings and never stores bytes privately.
 */

/**
 * The declared import entry points.
 *
 * Every one of them produces the same intake request, so the rule "every entry
 * point uses the same intake API, checksum verification, malware scan, and
 * authorization" is a property of this table rather than of each call site.
 */
export const IMPORT_ENTRY_POINTS = Object.freeze([
  entry('project_add_files', 'Add files', 'PROJECT', 'asset.write', { binding: false }),
  entry('project_drop', 'Drop on the project workspace', 'PROJECT', 'asset.write', { binding: false, batch: true }),
  entry('assets_surface', 'Upload from Assets', 'ASSETS', 'asset.write', { binding: false, batch: true }),
  entry('tool_import', 'Tool Import command', 'TOOL', 'facility.import.initiate', { binding: true }),
  entry('tool_canvas_drop', 'Drop on a tool canvas', 'TOOL', 'facility.import.initiate', { binding: true }),
  entry('assistant_promotion', 'Promote an assistant attachment', 'ASSISTANT', 'asset.write', { binding: false, requiresConfirmation: true }),
  entry('api_client', 'API or integration client', 'API', 'asset.write', { binding: false }),
]);

function entry(entryPointId, label, surface, permission, options = {}) {
  return Object.freeze({
    entryPointId,
    label,
    surface,
    permission,
    binding: options.binding === true,
    batch: options.batch === true,
    requiresConfirmation: options.requiresConfirmation === true,
  });
}

export function getEntryPoint(entryPointId) {
  return IMPORT_ENTRY_POINTS.find((item) => item.entryPointId === entryPointId) ?? null;
}

/**
 * Builds the one intake request every entry point produces.
 *
 * Creating an asset and binding it are separate operations: a failed binding
 * leaves a valid, unbound asset, which is why `binding` is recorded as an intent
 * rather than performed here.
 */
export function createAssetIntent({ entryPointId, projectId, files = [], toolId = null }) {
  const point = getEntryPoint(entryPointId);
  if (!point) throw new Error(`Unknown import entry point "${entryPointId}".`);
  if (!projectId) throw new Error('An import requires a project.');
  if (!Array.isArray(files) || files.length === 0) throw new Error('An import requires at least one file.');
  if (point.binding && !toolId) throw new Error(`Entry point "${entryPointId}" binds to a tool and requires a tool id.`);

  return {
    projectId,
    entryPointId,
    surface: point.surface,
    files: [...files],
    binding: point.binding ? { toolId, representation: null } : null,
    requiresConfirmation: point.requiresConfirmation,
  };
}

/**
 * Whether an asset can be selected for a binding. A blocked asset stays visible
 * with a textual reason — quarantined, archived, and unauthorized assets are
 * never silently absent (ui-pattern.md, "Import Entry Points" 5).
 */
export function selectability(asset) {
  if (!asset) return { selectable: false, reason: 'the asset no longer exists' };
  if (asset.authorized === false) return { selectable: false, reason: 'you do not have access to this asset' };
  if (asset.quarantined === true) return { selectable: false, reason: 'quarantined until the scan clears' };
  if (asset.archived === true) return { selectable: false, reason: 'archived; restore it before binding' };
  if (asset.scanState && asset.scanState !== 'CLEAN') {
    return { selectable: false, reason: `scan state is ${scanStateLabel(asset.scanState).text.toLowerCase()}` };
  }
  return { selectable: true, reason: null };
}

/** Scan and processing state as text plus an icon, never color alone. */
export function scanStateLabel(state) {
  switch (state) {
    case 'CLEAN':
      return { text: 'Scanned clean', icon: '✓' };
    case 'PENDING':
      return { text: 'Scanning', icon: '◐' };
    case 'INFECTED':
      return { text: 'Infected — quarantined', icon: '!' };
    case 'FAILED':
      return { text: 'Scan failed', icon: '!' };
    case 'NOT_SCANNED':
      return { text: 'Not scanned', icon: '!' };
    default:
      return { text: 'Scan state unknown', icon: '·' };
  }
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/**
 * The upgrade affordance. A newer version never changes an existing binding:
 * upgrading is explicit and re-enters the owning tool's review workflow.
 */
export function upgradeAffordance(binding, asset) {
  if (!binding || !asset) return null;
  if (!binding.assetVersionId || !asset.currentVersionId) return null;
  if (binding.assetVersionId === asset.currentVersionId) return null;
  return {
    bindingId: binding.bindingId,
    fromVersionId: binding.assetVersionId,
    toVersionId: asset.currentVersionId,
    label: `Version ${asset.currentVersionNumber ?? 'newer'} is available`,
    requiresReview: true,
  };
}

/** The exact version and representation a binding pins. */
export function describeBinding(binding) {
  if (!binding) return null;
  return {
    assetVersionId: binding.assetVersionId,
    representationId: binding.representationId ?? null,
    label: binding.representationId
      ? `${binding.assetVersionId} · ${binding.representationId}`
      : binding.assetVersionId,
  };
}

/**
 * The role a binding declares, from `AssetBinding.role` (project-assets.md).
 *
 * A role is required and has no canonical enum in the store, so the four values are
 * declared here once and every surface offers the same list rather than each
 * inventing its own vocabulary.
 */
export const BINDING_ROLES = Object.freeze([
  Object.freeze({ value: 'SOURCE', label: 'Source', hint: 'The design content this revision is drawn from.' }),
  Object.freeze({ value: 'EVIDENCE', label: 'Evidence', hint: 'Material that supports a value but is not the design itself.' }),
  Object.freeze({ value: 'REFERENCE', label: 'Reference', hint: 'Context only; claims nothing about the design.' }),
  Object.freeze({ value: 'ATTACHMENT', label: 'Attachment', hint: 'Carried with the revision for completeness.' }),
]);

/**
 * The role to offer first, from what the file is.
 *
 * Geometry-bearing assets are sources, tabular data is evidence, and everything
 * else — documents, imagery, anything unrecognized — defaults to `REFERENCE`,
 * which is the role that claims the least. A wrong default that under-claims is
 * recoverable; one that over-claims reads as authoritative before anyone has
 * reviewed it.
 */
export function defaultBindingRole(asset) {
  switch (asset?.kind) {
    case 'CAD':
    case 'BIM':
    case 'GIS':
      return 'SOURCE';
    case 'DATASET':
      return 'EVIDENCE';
    default:
      return 'REFERENCE';
  }
}

/**
 * Representations ordered so the one that answers the chosen role comes first.
 *
 * A file usually has several derivatives and they are not interchangeable. A role
 * that claims the content is design input wants the `FEATURES` extract, which is
 * what a facility mapping actually reads; a role that carries the file for context
 * wants `ORIGINAL`, the bytes as uploaded. Ordering rather than filtering keeps every
 * derivative reachable — an explicit choice is the user's, not the default's.
 */
export function orderRepresentations(representations = [], role = null) {
  const prefersOriginal = role === 'REFERENCE' || role === 'ATTACHMENT';
  const rank = (representation) => {
    const kind = representation.kind;
    if (prefersOriginal) {
      if (kind === 'ORIGINAL') return 0;
      if (kind === 'FEATURES') return 1;
      return 2;
    }
    if (kind === 'FEATURES') return 0;
    if (kind === 'GEOREFERENCE') return 1;
    if (kind === 'ORIGINAL') return 2;
    return 3;
  };
  return [...representations].sort((a, b) => rank(a) - rank(b));
}

/**
 * The producer is worth showing when it says something the kind does not.
 * `ORIGINAL · original` is the same word twice; `FEATURES · kml` is the adapter.
 */
export function representationLabel(representation) {
  if (!representation) return '';
  const producer = representation.producer ?? representation.producerId ?? null;
  if (!producer || producer.toLowerCase() === String(representation.kind).toLowerCase()) return representation.kind;
  return `${representation.kind} · ${producer}`;
}

/**
 * A binding as a planner reads it: the asset it names, the version it pinned, and
 * whether anything about it is authoritative yet.
 *
 * The asset list is the only place the name lives — a binding stores an id — so a
 * binding whose asset is no longer listed stays visible and says so rather than
 * disappearing from the revision's provenance.
 */
export function describeBindingAgainstAssets(binding, assets = []) {
  const asset = assets.find((item) => item.assetId === binding?.assetId) ?? null;
  const version = asset?.versions?.find((item) => item.assetVersionId === binding?.assetVersionId) ?? null;
  return {
    bindingId: binding?.bindingId ?? null,
    assetId: binding?.assetId ?? null,
    assetName: binding?.assetName ?? asset?.name ?? null,
    missingAsset: binding?.assetName ? false : !asset,
    filename: binding?.filename ?? version?.filename ?? null,
    versionNumber: binding?.versionNumber ?? version?.versionNumber ?? null,
    role: binding?.role ?? null,
    status: binding?.status ?? null,
    // A binding is authoritative exactly when it and all its mappings are reviewed
    // (the server derives this), so an unreviewed source never reads as a fact.
    authoritative: binding?.authoritative === true,
    mappingsInReview: binding?.mappingsInReview ?? 0,
  };
}

export function filterAssets(assets = [], { query = '', kind = 'ALL', scanState = 'ALL' } = {}) {
  const needle = query.trim().toLowerCase();
  return assets.filter((asset) => {
    const matchesKind = kind === 'ALL' || asset.kind === kind;
    const matchesScan = scanState === 'ALL' || (asset.scanState ?? 'NOT_SCANNED') === scanState;
    const matchesQuery =
      needle === '' ||
      (asset.name ?? '').toLowerCase().includes(needle) ||
      (asset.mediaType ?? '').toLowerCase().includes(needle);
    return matchesKind && matchesScan && matchesQuery;
  });
}

/** Tools that bind an asset, for the "bound tools" column. */
export function boundToolLabels(asset, toolLabels = {}) {
  return (asset?.boundToolIds ?? []).map((toolId) => toolLabels[toolId] ?? toolId);
}
