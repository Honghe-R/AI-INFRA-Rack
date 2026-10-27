import { fail, record, uuid, text } from './input.js';
import { CONTRACT_VERSION } from './model.js';

const IDENTITY_FIELDS = Object.freeze(['projectId', 'scenarioId', 'revisionId', 'containerId']);
const REFERENCE_FIELDS = new Set([...IDENTITY_FIELDS, 'revisionEtag']);
const PLAN_FIELDS = new Set(['planId', 'projectId', 'scenarioId', 'name', 'facilityInput']);

/** A versioned pointer, not a geometry snapshot or evidence of authorized access. */
export function createFacilityInputReference(input) {
  record(input, 'facilityInput', REFERENCE_FIELDS);
  const identity = Object.fromEntries(IDENTITY_FIELDS.map(field => [field, uuid(input[field], `facilityInput.${field}`)]));
  // ETags are opaque and case-sensitive. Do not trim or interpret them as Rack versions.
  const token = input.revisionEtag;
  if (typeof token !== 'string' || token.length === 0 || token.length > 512 || token.trim() !== token || /[\u0000-\u001f\u007f]/.test(token)) {
    fail('facilityInput.revisionEtag', 'must be an opaque non-empty token of at most 512 characters without control characters or surrounding whitespace');
  }
  return Object.freeze({ ...identity, revisionEtag: token });
}

/** Only constructs an empty in-memory draft. No persistence or generated identity. */
export function createRackPlan(input) {
  record(input, 'plan', PLAN_FIELDS);
  const projectId = uuid(input.projectId, 'projectId');
  const scenarioId = uuid(input.scenarioId, 'scenarioId');
  const facilityInput = createFacilityInputReference(input.facilityInput);
  if (facilityInput.projectId !== projectId) fail('facilityInput.projectId', 'must match the plan project');
  if (facilityInput.scenarioId !== scenarioId) fail('facilityInput.scenarioId', 'must match the plan scenario');
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    planId: uuid(input.planId, 'planId'),
    projectId,
    scenarioId,
    name: text(input.name, 'name'),
    version: 1,
    state: 'DRAFT',
    validationState: 'NOT_RUN',
    facilityInput,
    placements: Object.freeze([]),
  });
}

/** Compare a stored pointer with a fresh authoritative read supplied by a future adapter. */
export function assessFacilityInput(previousInput, currentInput) {
  const previous = createFacilityInputReference(previousInput);
  const current = createFacilityInputReference(currentInput);
  const changedIdentity = IDENTITY_FIELDS.filter(field => previous[field] !== current[field]);
  if (changedIdentity.length > 0) {
    return Object.freeze({ status: 'DIFFERENT_SOURCE', changedFields: Object.freeze(changedIdentity) });
  }
  const stale = previous.revisionEtag !== current.revisionEtag;
  return Object.freeze({
    status: stale ? 'STALE' : 'UNCHANGED',
    changedFields: Object.freeze(stale ? ['revisionEtag'] : []),
  });
}
