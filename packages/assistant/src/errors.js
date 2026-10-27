/**
 * Provider errors and credential redaction.
 *
 * A provider failure becomes one error type carrying `{ code, status, provider,
 * retryable, details }`, so a caller never parses a vendor message
 * (chatbox blueprint §4.2). Redaction removes configured credential values from
 * anything a client can see, and the same redactor runs over any provider text a
 * surface renders (§4.12).
 */
export class LlmError extends Error {
  constructor(code, message, { status = 502, provider = null, retryable = false, details = [] } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
    this.details = details;
  }
}

/** Error codes that prove the request never reached the provider. */
export const RETRYABLE_CAUSES = Object.freeze([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function normalizeProviderError(error, { provider = null } = {}) {
  if (error instanceof LlmError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new LlmError('LLM_CANCELLED', 'The request was cancelled.', { status: 499, provider });
  }
  if (error?.code === 'LLM_TIMEOUT') {
    return new LlmError('LLM_TIMEOUT', 'The provider did not answer in time.', { status: 504, provider });
  }
  const cause = firstCauseCode(error);
  if (RETRYABLE_CAUSES.includes(cause)) {
    return new LlmError('LLM_UNREACHABLE', 'The provider could not be reached.', { status: 503, provider, retryable: true, details: [{ cause }] });
  }
  if (error?.status === 401 || error?.status === 403) {
    return new LlmError('LLM_PROVIDER_UNSUPPORTED', 'The provider refused the configured credential.', { status: 503, provider });
  }
  if (error?.status === 429) {
    // What the gateway said is kept, because it is the only thing that says what to do.
    //
    // A 429 from this deployment's gateway names its own window — "Try again in 5 seconds" — and
    // the turn path was discarding the body: the operator saw "The provider is rate limiting"
    // with no interval, no reason, and no way to tell a burst limit from an exhausted quota from
    // a model with no deployment available. `scripts/test-models.mjs` has read the same sentence
    // since the gateway was first measured, for exactly this reason.
    //
    // The text is the provider's, so it is bounded here and redacted downstream like every other
    // detail: the API passes the credential's own value to `createRedactor`, so a gateway that
    // echoes the key cannot put it in a stored turn.
    const providerMessage = readProviderMessage(error.body);
    const retryAfterMs = readRetryAfterMs(providerMessage);
    return new LlmError('LLM_RATE_LIMITED', 'The provider is rate limiting.', {
      status: 429,
      provider,
      retryable: false,
      details: [{ provider_status: 429, provider_message: providerMessage, retry_after_ms: retryAfterMs }],
    });
  }
  if (error?.status >= 500) {
    return new LlmError('LLM_PROVIDER_ERROR', 'The provider failed.', { status: 502, provider, details: [{ provider_status: error.status }] });
  }
  return new LlmError('LLM_PROVIDER_ERROR', 'The provider failed.', { status: 502, provider, details: [{ message: error?.message ?? null }] });
}

/**
 * What the provider said, as a sentence, from whatever shape it answered in.
 *
 * The body arrives as raw text from the transport (`response.text()`) and may be JSON with an
 * `error.message`, JSON with a `message`, or prose. Bounded, because this ends up in a stored
 * turn and a provider is free to answer with a page of HTML.
 */
export function readProviderMessage(body, limit = 300) {
  if (body === null || body === undefined) return null;
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }
  const message = typeof parsed === 'string' ? parsed : parsed?.error?.message ?? parsed?.message ?? null;
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed.slice(0, limit) : null;
}

/**
 * The interval the gateway named, or null when it named none.
 *
 * The same reading `scripts/test-models.mjs` has always done: the gateway's own interval is
 * authoritative, and a shorter guess just spends another attempt against the same window.
 */
export function readRetryAfterMs(providerMessage) {
  const match = /try again in (\d+)\s*second/i.exec(providerMessage ?? '');
  return match ? Number(match[1]) * 1000 + 500 : null;
}

/**
 * Finds a socket-level failure code through the wrapping `fetch` applies. A
 * refused connection arrives as a `TypeError` whose cause is an `AggregateError`
 * of per-address failures, so a single `cause.code` lookup is not enough to tell
 * "the request never left" from "the provider answered".
 */
function firstCauseCode(error) {
  let node = error?.cause ?? error;
  for (let depth = 0; node && depth < 5; depth += 1) {
    if (typeof node.code === 'string') return node.code;
    if (Array.isArray(node.errors) && node.errors.length > 0) {
      node = node.errors[0];
      continue;
    }
    node = node.cause;
  }
  return null;
}

/**
 * Builds a redactor over the configured credential values. Every value is
 * replaced wherever it appears, so a leaked key cannot survive in an error body.
 */
export function createRedactor(values = []) {
  const secrets = values.filter((value) => typeof value === 'string' && value.length >= 4).sort((a, b) => b.length - a.length);
  return function redact(text) {
    if (typeof text !== 'string' || secrets.length === 0) return text;
    let output = text;
    for (const secret of secrets) output = output.split(secret).join('[redacted]');
    return output;
  };
}

export function redactDeep(value, redact, depth = 0) {
  if (depth > 12) return '[depth-limit]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = redactDeep(entry, redact, depth + 1);
    return output;
  }
  return value;
}
