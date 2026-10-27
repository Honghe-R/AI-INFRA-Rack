/**
 * Shared helpers for check evaluators.
 *
 * A check is `(ctx, constraint) => findings[]`. It reads the snapshot the context
 * loaded, or queries the store directly when the rule is spatial and PostGIS
 * should do the work. A finding carries only evidence: the catalog supplies the
 * severity, the gating capability, and the remediation category, so a check can
 * never invent an identifier or downgrade its own severity.
 */

/** Builds one finding. `resourceKind` gates a resource capability when present. */
export function finding(constraint, {
  entityRefs = [],
  geometryRefs = [],
  sourceValues = [],
  computed = {},
  remediationHint = null,
  policyRef = null,
  resourceKind = null,
} = {}) {
  return {
    constraintId: constraint.constraintId,
    severity: constraint.severity,
    gates: constraint.gates,
    remediationCategory: constraint.remediation,
    entityRefs,
    geometryRefs,
    sourceValues,
    computed,
    remediationHint,
    policyRef,
    resourceKind,
  };
}

/**
 * The identity of one finding, used to decide what a later run supersedes.
 *
 * The resource kind is part of it because a check can report the same constraint
 * against the same entity more than once — a resilience requirement is one row, and
 * `redundancy.path_count` names it while reporting two resource kinds that fall
 * short. Keyed on the entity refs alone, the second finding would supersede the
 * first and one of the two shortfalls would vanish.
 */
export function evidenceKey(findingValue) {
  const entities = [...findingValue.entityRefs]
    .map((ref) => `${ref.entity_type}:${ref.entity_id}`)
    .sort()
    .join(',');
  const geometry = [...findingValue.geometryRefs].sort().join(',');
  const kind = findingValue.resourceKind ?? '';
  return `${kind}|${entities}|${geometry}`;
}

/** `ST_IsValidReason` reasons that name a self-intersection. */
export const SELF_INTERSECTION = /self-intersection/i;
