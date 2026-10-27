import { AdapterRegistrationError, compareVersions, validateDescriptor } from './descriptor.js';
import { IMPORT_DIAGNOSTICS } from './diagnostics.js';

/**
 * The adapter registry.
 *
 * Resolution is deterministic: the registry indexes descriptors by media type and
 * extension, prefers an ACTIVE adapter over a deprecated or retired one, and then
 * the highest adapter version. `application/octet-stream` resolves only when the
 * extension also matches (doc/workspace/import-adapters.md, "Adapter Registry
 * Contract").
 */
export class AdapterResolutionError extends Error {
  constructor(constraintId, message, details = []) {
    super(message);
    this.name = 'AdapterResolutionError';
    this.code = constraintId;
    this.constraintId = constraintId;
    this.details = details;
    Object.freeze(this);
  }
}

export function createAdapterRegistry({ adapters = [] } = {}) {
  const entries = new Map();
  const byMediaType = new Map();
  const byExtension = new Map();

  function register(adapter) {
    const descriptor = adapter?.descriptor ?? adapter;
    validateDescriptor(descriptor);
    const key = `${descriptor.adapter_id}@${descriptor.adapter_version}`;
    if (entries.has(key)) {
      throw new AdapterRegistrationError(`Adapter "${key}" is already registered.`, [{ adapter_id: descriptor.adapter_id }]);
    }
    entries.set(key, { adapter: typeof adapter?.extract === 'function' ? adapter : null, descriptor });
    for (const mediaType of descriptor.media_types) push(byMediaType, mediaType.toLowerCase(), key);
    for (const extension of descriptor.extensions) push(byExtension, extension.toLowerCase(), key);
    return descriptor;
  }

  for (const adapter of adapters) register(adapter);

  function all() {
    return [...entries.values()].map((entry) => entry.descriptor);
  }

  function get(adapterId, adapterVersion = null) {
    if (adapterVersion) return entries.get(`${adapterId}@${adapterVersion}`) ?? null;
    const candidates = [...entries.values()].filter((entry) => entry.descriptor.adapter_id === adapterId);
    if (candidates.length === 0) return null;
    return candidates.sort((left, right) => compareEntries(left, right))[0];
  }

  /** Adapters an operator may choose for a new import: ACTIVE, at the release. */
  function selectable({ releaseLevel = 'R1' } = {}) {
    return all()
      .filter((descriptor) => descriptor.status === 'ACTIVE' && descriptor.release_level === releaseLevel)
      .sort((left, right) => left.adapter_id.localeCompare(right.adapter_id));
  }

  /**
   * Rejects a source version outside `supported_range` with
   * `import.adapter.version_unsupported`. A version named in `tested_versions` is
   * always accepted; otherwise numeric ranges are compared, and an opaque version
   * (such as a DXF AC code) must be explicitly tested.
   */
  function assertSourceVersion(descriptor, sourceVersion) {
    if (!sourceVersion) return null;
    const range = descriptor.supported_range;
    if (range.tested_versions.includes(sourceVersion)) return null;
    const numeric = [range.min_version, range.max_version, sourceVersion].every((value) => /^\d+(\.\d+)*$/.test(value));
    if (numeric && compareVersions(sourceVersion, range.min_version) >= 0 && compareVersions(sourceVersion, range.max_version) <= 0) {
      return null;
    }
    throw new AdapterResolutionError(
      IMPORT_DIAGNOSTICS.ADAPTER_VERSION_UNSUPPORTED.constraintId,
      `Source version "${sourceVersion}" is outside ${range.min_version}..${range.max_version}.`,
      [{ adapter_id: descriptor.adapter_id, source_version: sourceVersion }],
    );
  }

  /**
   * Resolves to exactly one registered adapter, or throws with the diagnostic the
   * caller must surface. `notices` carries non-fatal diagnostics such as a
   * deprecated resolver.
   */
  function resolve({ mediaType = null, extension = null, adapterId = null, adapterVersion = null } = {}) {
    const notices = [];

    if (adapterId) {
      const entry = get(adapterId, adapterVersion);
      if (!entry) {
        throw new AdapterResolutionError(
          IMPORT_DIAGNOSTICS.ADAPTER_VERSION_UNSUPPORTED.constraintId,
          `No adapter "${adapterId}"${adapterVersion ? ` at version ${adapterVersion}` : ''} is registered.`,
          [{ adapter_id: adapterId, adapter_version: adapterVersion }],
        );
      }
      if (entry.descriptor.status === 'DEPRECATED') notices.push(IMPORT_DIAGNOSTICS.ADAPTER_DEPRECATED);
      return { ...entry, notices };
    }

    const normalizedType = normalizeMediaType(mediaType);
    const normalizedExtension = extension ? extension.toLowerCase() : null;
    const candidates = new Set();

    // A sniffed generic type is accepted only when the extension also matches.
    if (normalizedType && normalizedType !== 'application/octet-stream') {
      for (const key of byMediaType.get(normalizedType) ?? []) candidates.add(key);
    }
    if (normalizedExtension) {
      for (const key of byExtension.get(normalizedExtension) ?? []) candidates.add(key);
    }

    const viable = [...candidates]
      .map((key) => entries.get(key))
      .filter((entry) => entry && accepts(entry.descriptor, normalizedType, normalizedExtension))
      .filter((entry) => entry.descriptor.status !== 'RETIRED');

    if (viable.length === 0) {
      throw new AdapterResolutionError(
        IMPORT_DIAGNOSTICS.ADAPTER_UNSUPPORTED.constraintId,
        'No registered adapter resolves this media type and extension.',
        [{ media_type: mediaType, extension }],
      );
    }

    const chosen = viable.sort(compareEntries)[0];
    if (chosen.descriptor.status === 'DEPRECATED') notices.push(IMPORT_DIAGNOSTICS.ADAPTER_DEPRECATED);
    return { ...chosen, notices };
  }

  return { register, resolve, get, all, selectable, assertSourceVersion };
}

function accepts(descriptor, mediaType, extension) {
  const mediaTypes = descriptor.media_types.map((value) => value.toLowerCase());
  const extensions = descriptor.extensions.map((value) => value.toLowerCase());

  if (extension && !extensions.includes(extension)) return false;
  if (!mediaType) return true;
  if (!mediaTypes.includes(mediaType)) return false;
  if (mediaType === 'application/octet-stream') return Boolean(extension) && extensions.includes(extension);
  return true;
}

/** ACTIVE beats DEPRECATED beats RETIRED; then the higher adapter version wins. */
function compareEntries(left, right) {
  const rank = { ACTIVE: 0, DEPRECATED: 1, RETIRED: 2 };
  const byStatus = rank[left.descriptor.status] - rank[right.descriptor.status];
  if (byStatus !== 0) return byStatus;
  return compareVersions(right.descriptor.adapter_version, left.descriptor.adapter_version);
}

export function normalizeMediaType(mediaType) {
  if (typeof mediaType !== 'string') return null;
  const [type] = mediaType.split(';');
  return type.trim().toLowerCase() || null;
}

export function extensionOf(filename) {
  if (typeof filename !== 'string') return null;
  const index = filename.lastIndexOf('.');
  return index === -1 ? null : filename.slice(index).toLowerCase();
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
