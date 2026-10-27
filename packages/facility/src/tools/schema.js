import { ApiError } from '@ai-infra/core';

/**
 * Argument validation for the tool surface.
 *
 * The published contract caps every argument before a handler runs, and a tool
 * that silently ignores an unknown property is worse than one that refuses it:
 * the caller believes it narrowed a read when it did not. So validation is
 * strict — unknown properties are rejected, types are not coerced, and every
 * failure names the offending field.
 *
 * This is deliberately not a general schema language. The surface is a fixed set
 * of operations, so the validator only needs the handful of shapes those
 * operations use, and a smaller validator is one that cannot surprise a caller.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serialized-argument cap from the surface contract. */
export const MAX_ARGUMENT_BYTES = 8192;
export const MAX_STRING_LENGTH = 256;
export const MAX_ARRAY_ITEMS = 200;

export const field = Object.freeze({
  uuid: (options = {}) => ({ type: 'uuid', ...options }),
  string: (options = {}) => ({ type: 'string', ...options }),
  enum: (values, options = {}) => ({ type: 'enum', values, ...options }),
  int: (options = {}) => ({ type: 'int', ...options }),
  number: (options = {}) => ({ type: 'number', ...options }),
  bool: (options = {}) => ({ type: 'bool', ...options }),
  array: (items, options = {}) => ({ type: 'array', items, ...options }),
  object: (options = {}) => ({ type: 'object', ...options }),
  bbox: (options = {}) => ({ type: 'bbox', ...options }),
  timestamp: (options = {}) => ({ type: 'timestamp', ...options }),
});

/**
 * Identity arguments that every read accepts and that must agree with the
 * resolved context. A mismatch is a 403, never a silent rewrite, because
 * rewriting it would answer about a revision the caller did not name.
 */
export const CONTEXT_ARGUMENTS = Object.freeze({
  project_id: field.uuid(),
  scenario_id: field.uuid(),
});

export function validateArguments(schema, args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw invalid('Arguments must be an object.', [{ field: 'arguments' }]);
  }

  const declared = { ...CONTEXT_ARGUMENTS, ...schema };
  const details = [];
  const value = {};

  for (const key of Object.keys(args)) {
    if (!(key in declared)) details.push({ field: key, reason: 'unknown_property' });
  }

  for (const [key, spec] of Object.entries(declared)) {
    const raw = args[key];
    if (raw === undefined || raw === null || raw === '') {
      if (spec.required && !spec.optionalWhen) {
        details.push({ field: key, reason: 'required' });
        continue;
      }
      if (spec.default !== undefined) value[key] = spec.default;
      continue;
    }
    const problem = checkField(key, raw, spec);
    if (problem) details.push(problem);
    else value[key] = raw;
  }

  if (details.length === 0 && typeof schema.when === 'function') {
    const cross = schema.when(value);
    if (cross) details.push(cross);
  }

  if (details.length > 0) throw invalid('The arguments are not valid for this tool.', details);

  const serialized = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (serialized > MAX_ARGUMENT_BYTES) {
    throw invalid('The arguments exceed the serialized size cap.', [
      { field: 'arguments', reason: 'over_budget', limit_bytes: MAX_ARGUMENT_BYTES, actual_bytes: serialized },
    ]);
  }

  return value;
}

function checkField(key, raw, spec) {
  switch (spec.type) {
    case 'uuid':
      return typeof raw === 'string' && UUID.test(raw) ? null : { field: key, reason: 'not_a_uuid' };
    case 'string': {
      if (typeof raw !== 'string') return { field: key, reason: 'not_a_string' };
      const max = spec.maxLength ?? MAX_STRING_LENGTH;
      return raw.length <= max ? null : { field: key, reason: 'too_long', max_length: max };
    }
    case 'enum':
      return spec.values.includes(raw) ? null : { field: key, reason: 'not_allowed', allowed: spec.values };
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return { field: key, reason: 'not_an_integer' };
      if (spec.min !== undefined && raw < spec.min) return { field: key, reason: 'below_minimum', min: spec.min };
      if (spec.max !== undefined && raw > spec.max) return { field: key, reason: 'above_maximum', max: spec.max };
      return null;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? null : { field: key, reason: 'not_a_number' };
    case 'bool':
      return typeof raw === 'boolean' ? null : { field: key, reason: 'not_a_boolean' };
    case 'array': {
      if (!Array.isArray(raw)) return { field: key, reason: 'not_an_array' };
      const max = spec.maxItems ?? MAX_ARRAY_ITEMS;
      if (raw.length > max) return { field: key, reason: 'too_many_items', max_items: max };
      if (spec.items) {
        for (const [index, item] of raw.entries()) {
          const problem = checkField(`${key}[${index}]`, item, spec.items);
          if (problem) return problem;
        }
      }
      return null;
    }
    case 'object': {
      if (typeof raw !== 'object' || Array.isArray(raw)) return { field: key, reason: 'not_an_object' };
      if (spec.fields) {
        for (const [subKey, subSpec] of Object.entries(spec.fields)) {
          const item = raw[subKey];
          if (item === undefined || item === null) {
            if (subSpec.required) return { field: `${key}.${subKey}`, reason: 'required' };
            continue;
          }
          const problem = checkField(`${key}.${subKey}`, item, subSpec);
          if (problem) return problem;
        }
      }
      return null;
    }
    case 'bbox': {
      if (!Array.isArray(raw) || raw.length !== 4) return { field: key, reason: 'not_a_bbox' };
      if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return { field: key, reason: 'bbox_not_finite' };
      }
      const [minX, minY, maxX, maxY] = raw;
      if (minX > maxX || minY > maxY) return { field: key, reason: 'bbox_inverted' };
      return null;
    }
    case 'timestamp':
      return typeof raw === 'string' && !Number.isNaN(Date.parse(raw))
        ? null
        : { field: key, reason: 'not_a_timestamp' };
    default:
      return { field: key, reason: 'unsupported_schema' };
  }
}

function invalid(message, details) {
  return new ApiError('VALIDATION_FAILED', message, { status: 400, details });
}
