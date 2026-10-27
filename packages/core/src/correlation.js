import { randomUUID } from 'node:crypto';

/**
 * Correlation ID handling.
 *
 * The edge mints a correlation ID per request and returns it in
 * `meta.correlation_id`, including on errors (Non-Functional Requirements,
 * "Observability"). An inbound ID is honoured so a caller can correlate its own
 * logs with ours, but it is validated first: an unvalidated header becomes a log
 * injection and cardinality problem.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function isCorrelationId(value) {
  return typeof value === 'string' && CORRELATION_ID.test(value);
}

export function resolveCorrelationId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isCorrelationId(candidate) ? candidate : randomUUID();
}
