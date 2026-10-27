import { CAPABILITIES, RESOURCE_CAPABILITIES } from './catalog.js';

/**
 * Capability coverage derivation (D11).
 *
 * Coverage is never asserted; it is the shadow of the diagnostics a run produced
 * and the checks it could not run.
 *
 *   NOT_PROVIDED  no evidence for the capability exists at all
 *   PROVISIONAL   evidence exists, but a check could not run, an ERROR or WARNING
 *                 stands against it, or a waiver removed a gate without a
 *                 coverage-promoting policy
 *   VALIDATED     every applicable check ran, with no ERROR and no WARNING
 *
 * A waived diagnostic stops gating that revision, but it does not erase the fact
 * that something was found: only a waiver whose policy is `coverage_promoting`
 * lets the capability past PROVISIONAL.
 */

/** The capabilities a diagnostic gates. `PUBLICATION` gates none of them. */
export function gatedCapabilities(entry, resourceKind = null) {
  switch (entry.gates) {
    case 'GEOMETRY':
      return ['GEOMETRY'];
    case 'PHASING':
      return ['PHASING'];
    case 'ENVIRONMENT':
      return ['ENVIRONMENT'];
    case 'FUEL':
      return ['FUEL'];
    case 'WATER':
      return ['WATER'];
    case 'RESOURCE':
      return resourceKind ? [resourceKind] : [...RESOURCE_CAPABILITIES];
    default:
      return [];
  }
}

const GATING_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED']);

export function deriveCoverage({ diagnostics = [], notChecked = [], evidence = {}, policies = null, constraintsById = new Map() }) {
  /** Waivers that promote coverage let a waived diagnostic fall through. */
  const promotionCache = new Map();
  const promotes = (policyRef) => {
    if (!policyRef) return false;
    if (promotionCache.has(policyRef)) return promotionCache.get(policyRef);
    const resolved = policies?.resolveReference?.(policyRef);
    const value = resolved?.policy?.coveragePromotingWaivers === true;
    promotionCache.set(policyRef, value);
    return value;
  };

  const caps = new Map(CAPABILITIES.map((capability) => [capability, { reasons: [], blocked: false, warned: false, unrun: false, waived: false }]));

  const apply = (capability, mutate) => {
    const state = caps.get(capability);
    if (!state) return;
    mutate(state);
  };

  for (const diagnostic of diagnostics) {
    if (!['ERROR', 'WARNING'].includes(diagnostic.severity)) continue;
    if (diagnostic.status === 'RESOLVED' || diagnostic.status === 'SUPERSEDED') continue;
    const gating = diagnostic.severity === 'ERROR' && !GATING_STATUSES.has(diagnostic.status) ? false : true;
    for (const capability of diagnostic.capabilities ?? gatedCapabilities(constraintsById.get(diagnostic.constraintId) ?? {}, diagnostic.resourceKind)) {
      apply(capability, (state) => {
        if (diagnostic.status === 'WAIVED') {
          state.waived = true;
          if (!diagnostic.coveragePromoting) {
            state.reasons.push(`${diagnostic.constraintId} waived`);
            state.warned = true;
          }
          return;
        }
        if (diagnostic.severity === 'ERROR') {
          state.blocked = true;
          state.reasons.push(`${diagnostic.constraintId} ERROR`);
        } else if (gating) {
          state.warned = true;
          state.reasons.push(`${diagnostic.constraintId} WARNING`);
        }
      });
    }
  }

  for (const unrun of notChecked) {
    const entry = constraintsById.get(unrun.constraintId) ?? {};
    for (const capability of gatedCapabilities(entry, unrun.resourceKind ?? null)) {
      apply(capability, (state) => {
        state.unrun = true;
        state.reasons.push(`${unrun.constraintId} not checked`);
      });
    }
  }

  const result = {};
  for (const capability of CAPABILITIES) {
    const state = caps.get(capability);
    const hasEvidence = (evidence[capability] ?? evidenceByCapability(capability, evidence)) > 0;
    let status;
    if (!hasEvidence) status = 'NOT_PROVIDED';
    else if (state.blocked || state.warned || state.unrun || state.waived) status = 'PROVISIONAL';
    else status = 'VALIDATED';
    result[capability] = {
      capability,
      status,
      reasons: [...new Set(state.reasons)].slice(0, 20),
    };
  }
  return result;
}

/**
 * Evidence for a capability. Resource capabilities are evidenced by a source,
 * interface, reserve, or budget of that resource kind; the rest by their own
 * entities. `evidence` carries counts for non-resource buckets.
 */
export function evidenceByCapability(capability, evidence) {
  switch (capability) {
    case 'GEOMETRY':
      return evidence.geometry ?? 0;
    case 'ENVIRONMENT':
      return (evidence.profiles ?? 0) + (evidence.envConstraints ?? 0);
    case 'PHASING':
      return evidence.phases ?? 0;
    default:
      return 0;
  }
}

/** Resource-capability evidence, computed once from the loaded rows. */
export function resourceEvidence({ sources = [], interfaces = [], reserves = [], budgets = [] }) {
  const counts = {};
  for (const capability of RESOURCE_CAPABILITIES) counts[capability] = 0;
  const bump = (kind) => {
    if (kind && counts[kind] !== undefined) counts[kind] += 1;
  };
  for (const source of sources) bump(source.kind);
  for (const budget of budgets) bump(budget.resource_kind);
  for (const reserve of reserves) {
    if (reserve.kind === 'FUEL') bump('FUEL');
    if (reserve.kind === 'WATER') bump('WATER');
  }
  // An interface is evidence only through its source; interfaces without a source
  // are reported by their own check.
  const sourceKindById = new Map(sources.map((source) => [source.utility_source_id, source.kind]));
  for (const utilityInterface of interfaces) bump(sourceKindById.get(utilityInterface.utility_source_id));
  return counts;
}
