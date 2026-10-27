import { CATALOG } from '../catalog.js';
import { dataChecks } from './data.js';
import { siteChecks } from './site.js';
import { utilityChecks } from './utility.js';
import { capacityChecks } from './capacity.js';
import { resilienceChecks } from './resilience.js';
import { environmentChecks } from './environment.js';
import { phasingChecks } from './phasing.js';
import { importChecks } from './imports.js';
import { governanceChecks } from './governance.js';

/**
 * Every registered evaluator, keyed by catalog identifier. A catalog entry with
 * no evaluator must be marked `implemented: false`; the completeness test asserts
 * that, so a new catalog row cannot be added without deciding how it runs.
 */
export const CHECKS = Object.freeze({
  ...dataChecks,
  ...siteChecks,
  ...utilityChecks,
  ...capacityChecks,
  ...resilienceChecks,
  ...environmentChecks,
  ...phasingChecks,
  ...importChecks,
  ...governanceChecks,
});

export const EVALUATOR_IDS = Object.freeze(Object.keys(CHECKS));

/** Catalog entries with no evaluator and not explicitly marked unimplemented. */
export function unregisteredConstraints() {
  return CATALOG
    .filter((item) => item.implemented && typeof CHECKS[item.constraintId] !== 'function')
    .map((item) => item.constraintId);
}

/** Evaluators with no catalog entry: an identifier that would never be reported. */
export function orphanEvaluators() {
  const known = new Set(CATALOG.map((item) => item.constraintId));
  return EVALUATOR_IDS.filter((id) => !known.has(id));
}
