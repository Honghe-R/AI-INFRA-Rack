/**
 * The decision object and its two wrappers (blueprint §6).
 *
 * One evaluator, one shape. The non-throwing wrapper is for services and shared
 * code; the throwing wrapper is for domain code, where the service layer throws
 * and the HTTP layer translates the typed error.
 */
export const REASON = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FUNCTION_REQUIRED: 'FUNCTION_REQUIRED',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  UNKNOWN_FUNCTION: 'UNKNOWN_FUNCTION',
});

const REASON_STATUS = Object.freeze({
  [REASON.UNAUTHENTICATED]: 401,
  [REASON.FUNCTION_REQUIRED]: 403,
  [REASON.INSUFFICIENT_PERMISSION]: 403,
  [REASON.UNKNOWN_FUNCTION]: 403,
});

const REASON_MESSAGE = Object.freeze({
  [REASON.UNAUTHENTICATED]: 'Authentication is required.',
  [REASON.FUNCTION_REQUIRED]: 'A permission key is required.',
  [REASON.INSUFFICIENT_PERMISSION]: 'The caller is not permitted to perform this operation.',
  [REASON.UNKNOWN_FUNCTION]: 'The permission key is not registered.',
});

export function denied(reason, { projectId = null, organisationId = null } = {}) {
  return { allowed: false, grant: null, functionId: null, reason, projectId, organisationId };
}

export function allowed(grant, { functionId = null, projectId = null, organisationId = null, showcase = false, readOnly = false } = {}) {
  const decision = { allowed: true, grant, functionId, projectId, organisationId };
  if (showcase) decision.showcase = true;
  if (readOnly) decision.readOnly = true;
  return decision;
}

/** Non-throwing result: adds the key, echoes the scope, and states the reason. */
export function toResult(decision, functionKey) {
  const result = {
    allowed: decision.allowed,
    grant: decision.grant ?? null,
    functionId: decision.functionId ?? null,
    functionKey: functionKey ?? null,
    projectId: decision.projectId ?? null,
    organisationId: decision.organisationId ?? null,
  };
  if (decision.showcase) result.showcase = true;
  if (decision.readOnly) result.readOnly = true;
  if (!decision.allowed) result.reason = decision.reason ?? REASON.INSUFFICIENT_PERMISSION;
  return result;
}

export class PermissionError extends Error {
  constructor(decision, functionKey) {
    const reason = decision.reason ?? REASON.INSUFFICIENT_PERMISSION;
    super(REASON_MESSAGE[reason] ?? REASON_MESSAGE[REASON.INSUFFICIENT_PERMISSION]);
    this.name = 'PermissionError';
    this.code = reason;
    this.status = REASON_STATUS[reason] ?? 403;
    this.functionKey = functionKey ?? null;
    this.details = functionKey ? [{ function_key: functionKey }] : [];
  }
}

/** Throwing wrapper for domain code. Returns the decision when allowed. */
export function assertAllowed(decision, functionKey) {
  if (decision.allowed) return decision;
  throw new PermissionError(decision, functionKey);
}

export function httpStatusFor(decision) {
  if (decision.allowed) return 200;
  return REASON_STATUS[decision.reason] ?? 403;
}

export function messageFor(decision) {
  return REASON_MESSAGE[decision.reason] ?? REASON_MESSAGE[REASON.INSUFFICIENT_PERMISSION];
}
