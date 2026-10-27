import { r1Adapters } from './adapters/index.js';
import { createAdapterRegistry } from './registry.js';

export { IMPORT_DIAGNOSTICS, IMPORT_DIAGNOSTIC_IDS, getImportDiagnostic, isImportDiagnostic } from './diagnostics.js';
export {
  ADAPTER_STATUSES,
  CAPABILITY_LEVELS,
  EXTRACTION_CAPABILITIES,
  FEATURE_DISPOSITIONS,
  FIDELITY_LEVELS,
  ISOLATION_LEVELS,
  RELEASE_LEVELS,
  defineAdapter,
  emptyResult,
  reconcileCounts,
} from './adapter-contract.js';
export { AdapterRegistrationError, compareVersions, validateDescriptor } from './descriptor.js';
export { AdapterResolutionError, createAdapterRegistry, extensionOf, normalizeMediaType } from './registry.js';
export { AdapterLimitError, IMPORT_LIMITS, assertWithinLimit, effectiveLimits } from './limits.js';
export { SELECTOR_KEYS, SelectorError, matchesSelector, normalizeSelector, parseSelector } from './selector.js';
export {
  DEFAULT_RESIDUAL_TOLERANCE_M,
  TransformError,
  UNIT_TO_METRES,
  applyTransform,
  fitAffine2D,
  fitSimilarity2D,
  resolveTransform,
  unitFactor,
} from './transform.js';
export { SandboxError, createSandbox } from './sandbox.js';
export { createImportPipeline } from './pipeline.js';
export { r1Adapters } from './adapters/index.js';

/**
 * The registry with the R1 adapters registered. An operator adds a format by
 * registering one more descriptor and implementation; nothing here changes.
 */
export function createDefaultRegistry({ adapters = r1Adapters } = {}) {
  const registry = createAdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
