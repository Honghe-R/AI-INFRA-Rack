const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RackInputError extends Error {
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name = 'RackInputError';
    this.code = 'RACK_INPUT_INVALID';
    this.details = [{ field, reason }];
  }
}

export function fail(field, reason) {
  throw new RackInputError(field, reason);
}

export function record(value, field, allowedFields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) fail(`${field}.${key}`, 'unknown field');
  }
}

export function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(field, 'must be a UUID');
  return value.toLowerCase();
}

export function text(value, field, maxLength = 160) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail(field, `must be non-empty text of at most ${maxLength} characters`);
  }
  return value.trim();
}
