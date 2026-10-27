export const REDACTED = '[REDACTED]';

/**
 * Keys whose values must never reach a log, trace, or error message. The
 * Non-Functional Requirements forbid writing secrets, licence keys, signed URLs,
 * asset contents, and full PII to logs or traces.
 */
const SENSITIVE_KEY =
  /(secret|password|passwd|token|credential|licen[cs]e|signature|signed_?url|authorization|cookie|api[-_]?key|private[-_]?key|x-amz)/i;

/** Signed-URL query parameters embedded in an otherwise ordinary string. */
const SIGNED_QUERY =
  /([?&](?:x-amz-signature|x-amz-credential|x-amz-security-token|sig|signature|token|key|access_token)=)[^&\s"']*/gi;

const MAX_DEPTH = 8;

export function redactValue(value) {
  if (typeof value === 'string') return value.replace(SIGNED_QUERY, `$1${REDACTED}`);
  return value;
}

/**
 * Returns a structurally-cloned value with credential-shaped keys and signed-URL
 * query parameters redacted. Cycles and excessive depth are cut rather than
 * recursed, so logging can never throw or hang.
 */
export function redact(input, depth = 0, seen = new WeakSet()) {
  if (input === null || typeof input !== 'object') return redactValue(input);
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(input)) return '[CIRCULAR]';
  seen.add(input);

  if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1, seen));

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(value, depth + 1, seen);
  }
  return output;
}
