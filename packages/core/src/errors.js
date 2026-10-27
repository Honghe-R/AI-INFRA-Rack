/**
 * The standard response envelope and error contract.
 *
 * Shapes are fixed by the Backend API Contracts document, "Standard Response
 * Shapes". Error codes are the `SCREAMING_SNAKE_CASE` codes from the documented
 * error catalog plus the generic transport codes below.
 */
export class ApiError extends Error {
  constructor(code, message, { status = 400, details = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const errors = {
  malformedJson: () =>
    new ApiError('MALFORMED_JSON', 'The request body is not valid JSON.', { status: 400 }),
  payloadTooLarge: (limitBytes) =>
    new ApiError('PAYLOAD_TOO_LARGE', 'The request body exceeds the configured limit.', {
      status: 413,
      details: [{ limit_bytes: limitBytes }],
    }),
  notFound: (message = 'Route was not found.') =>
    new ApiError('NOT_FOUND', message, { status: 404 }),
  methodNotAllowed: (method, allowed) =>
    new ApiError('METHOD_NOT_ALLOWED', `${method} is not allowed on this route.`, {
      status: 405,
      details: [{ allowed_methods: allowed }],
    }),
  unsupportedContractVersion: (version) =>
    new ApiError('UNSUPPORTED_CONTRACT_VERSION', 'The contract version is not supported.', {
      status: 400,
      details: [{ contract_version: version ?? null }],
    }),
  unauthorized: (message = 'Authentication is required.') =>
    new ApiError('UNAUTHENTICATED', message, { status: 401 }),
  forbidden: (message = 'The caller is not permitted to perform this operation.') =>
    new ApiError('FORBIDDEN', message, { status: 403 }),
  serviceUnavailable: (message = 'The service is not ready to accept traffic.') =>
    new ApiError('SERVICE_UNAVAILABLE', message, { status: 503 }),
  internal: () =>
    new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.', { status: 500 }),
};

export function errorPayload(error, correlationId) {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? [],
    },
    meta: { correlation_id: correlationId },
  };
}

export function successPayload(data, { correlationId, meta = {} } = {}) {
  return { data, meta: { ...meta, correlation_id: correlationId } };
}
