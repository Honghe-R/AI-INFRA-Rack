import {
  ADAPTER_STATUSES,
  CAPABILITY_LEVELS,
  EXTRACTION_CAPABILITIES,
  FIDELITY_LEVELS,
  ISOLATION_LEVELS,
  RELEASE_LEVELS,
} from './adapter-contract.js';
import { isImportDiagnostic } from './diagnostics.js';

/**
 * Descriptor validation.
 *
 * Registration is the one place a malformed plugin is rejected. A descriptor that
 * is missing a field, claims a capability level that does not exist, declares a
 * diagnostic outside the shared registry, or asks to parse untrusted input
 * in-process is refused with `import.adapter.registration_invalid`
 * (doc/workspace/import-adapters.md, "Adapter Registry Contract").
 */
export class AdapterRegistrationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AdapterRegistrationError';
    this.code = 'import.adapter.registration_invalid';
    this.details = details;
    Object.freeze(this);
  }
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const EXTENSION = /^\.[a-z0-9][a-z0-9._-]*$/;
const LICENCE_CLASSES = ['PERMISSIVE', 'COMMERCIAL', 'PROPRIETARY', 'INTERNAL'];

export function validateDescriptor(descriptor) {
  const fail = (message, details = []) => {
    throw new AdapterRegistrationError(message, details);
  };

  if (!descriptor || typeof descriptor !== 'object') fail('An adapter descriptor must be an object.');

  for (const field of ['adapter_id', 'adapter_version', 'entry_point', 'release_level', 'status', 'fidelity_level', 'isolation']) {
    if (typeof descriptor[field] !== 'string' || descriptor[field].trim().length === 0) {
      fail(`The adapter descriptor requires a non-empty "${field}".`, [{ field }]);
    }
  }

  if (!SEMVER.test(descriptor.adapter_version)) {
    fail('adapter_version must be a semantic version such as "1.0.0".', [{ field: 'adapter_version' }]);
  }
  if (!RELEASE_LEVELS.includes(descriptor.release_level)) {
    fail(`release_level must be one of ${RELEASE_LEVELS.join(', ')}.`, [{ field: 'release_level' }]);
  }
  if (!ADAPTER_STATUSES.includes(descriptor.status)) {
    fail(`status must be one of ${ADAPTER_STATUSES.join(', ')}.`, [{ field: 'status' }]);
  }
  if (!FIDELITY_LEVELS.includes(descriptor.fidelity_level)) {
    fail(`fidelity_level must be one of ${FIDELITY_LEVELS.join(', ')}.`, [{ field: 'fidelity_level' }]);
  }
  if (!ISOLATION_LEVELS.includes(descriptor.isolation)) {
    fail(`isolation must be one of ${ISOLATION_LEVELS.join(', ')}.`, [{ field: 'isolation' }]);
  }
  // Every adapter parses untrusted input, and a converter or licence entitlement
  // is strictly more dangerous, so R1 registers only sandboxed adapters.
  if (descriptor.isolation !== 'WORKER_SANDBOX') {
    fail('An adapter that parses untrusted input must declare isolation "WORKER_SANDBOX".', [{ field: 'isolation' }]);
  }

  assertStringArray(descriptor.media_types, 'media_types', fail, (value) => MEDIA_TYPE.test(value));
  assertStringArray(descriptor.extensions, 'extensions', fail, (value) => EXTENSION.test(value));
  assertStringArray(descriptor.source_crs_declarations, 'source_crs_declarations', fail, () => true);
  assertStringArray(descriptor.source_unit_declarations, 'source_unit_declarations', fail, () => true);
  assertStringArray(descriptor.conformance_fixtures, 'conformance_fixtures', fail, () => true);
  assertStringArray(descriptor.required_diagnostics, 'required_diagnostics', fail, (value) => isImportDiagnostic(value));

  if (!Array.isArray(descriptor.extraction_capabilities) || descriptor.extraction_capabilities.length === 0) {
    fail('extraction_capabilities must declare at least one capability.', [{ field: 'extraction_capabilities' }]);
  }
  for (const capability of descriptor.extraction_capabilities) {
    if (!capability || typeof capability !== 'object') fail('Each extraction capability must be an object.');
    if (!EXTRACTION_CAPABILITIES.includes(capability.name)) {
      fail(`Unknown extraction capability "${capability.name}".`, [{ field: 'extraction_capabilities', value: capability.name }]);
    }
    if (!CAPABILITY_LEVELS.includes(capability.level)) {
      fail(`Capability level must be one of ${CAPABILITY_LEVELS.join(', ')}.`, [{ field: 'extraction_capabilities', value: capability.level }]);
    }
  }
  // A FULL overall fidelity requires FULL for every declared capability.
  if (descriptor.fidelity_level === 'FULL') {
    const partial = descriptor.extraction_capabilities.filter((capability) => capability.level !== 'FULL');
    if (partial.length > 0) {
      fail('fidelity_level "FULL" requires every declared capability to be FULL.', [{ field: 'fidelity_level' }]);
    }
  }

  const range = descriptor.supported_range;
  if (!range || typeof range !== 'object') fail('supported_range is required.', [{ field: 'supported_range' }]);
  for (const field of ['min_version', 'max_version']) {
    if (typeof range[field] !== 'string' || range[field].trim().length === 0) {
      fail(`supported_range.${field} is required.`, [{ field: `supported_range.${field}` }]);
    }
  }
  if (!Array.isArray(range.tested_versions) || range.tested_versions.length === 0) {
    fail('supported_range.tested_versions must name at least one version.', [{ field: 'supported_range.tested_versions' }]);
  }

  if (descriptor.converter_dependency !== undefined && descriptor.converter_dependency !== null) {
    const converter = descriptor.converter_dependency;
    for (const field of ['identity', 'version', 'licence', 'output_media_type', 'output_adapter_id']) {
      if (typeof converter[field] !== 'string' || converter[field].trim().length === 0) {
        fail(`converter_dependency.${field} is required when a converter is declared.`, [{ field: `converter_dependency.${field}` }]);
      }
    }
    if (!LICENCE_CLASSES.includes(converter.licence_class)) {
      fail(`converter_dependency.licence_class must be one of ${LICENCE_CLASSES.join(', ')}.`, [{ field: 'converter_dependency.licence_class' }]);
    }
    if (converter.licence_class === 'PROPRIETARY' && !converter.licence) {
      fail('A proprietary converter must record its licence entitlement.');
    }
  }

  return descriptor;
}

function assertStringArray(value, field, fail, predicate) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} must be a non-empty array.`, [{ field }]);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || !predicate(item)) {
      fail(`${field} contains an invalid value "${item}".`, [{ field, value: item }]);
    }
  }
}

/** Numeric-aware comparison so a newer adapter version wins resolution. */
export function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
