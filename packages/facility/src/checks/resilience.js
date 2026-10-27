import { finding } from './shared.js';

/** Domain ancestors, nearest first, including the domain itself. */
function ancestorSet(domainId, byId) {
  const set = new Set();
  let current = byId.get(domainId);
  let guard = 0;
  while (current && guard < 256) {
    set.add(current.failure_domain_id);
    if (!current.parent_failure_domain_id) break;
    current = byId.get(current.parent_failure_domain_id);
    guard += 1;
  }
  return set;
}

/** Supply paths for one resource kind: the sources that declare it. */
function pathsFor(sources, resourceKind) {
  return sources.filter((source) => source.kind === resourceKind);
}

function sharesAny(left, right) {
  for (const id of left) if (right.has(id)) return true;
  return false;
}

/**
 * The largest failure-domain-independent subset of `items`, by weight.
 *
 * Independence is **disjoint ancestor sets**, not distinct leaf domains: two
 * domains that share a parent are both lost when the parent fails, so counting
 * them as two independent paths overstates redundancy. `failure_domain.shared`
 * already treats a common ancestor as non-independent, and this is the same rule
 * applied to counting rather than to a pair.
 *
 * A small set is enumerated exactly. A set too large to enumerate falls back to a
 * deterministic smallest-ancestor-set-first greedy pass, so the check stays bounded
 * on a pathological revision rather than becoming exponential. The order is stable,
 * so two callers reading the same state reach the same number.
 */
function maxIndependentWeight(items, { domainIdOf, weightOf, domainById }) {
  const candidates = items
    .map((item, index) => ({ index, weight: Number(weightOf(item)) || 0, ancestors: ancestorSet(domainIdOf(item), domainById) }))
    .filter((candidate) => candidate.ancestors.size > 0);
  if (candidates.length === 0) return { weight: 0, count: 0 };

  if (candidates.length <= 16) {
    let best = { weight: 0, count: 0 };
    const chosen = [];
    const search = (index, weight, count) => {
      if (index === candidates.length) {
        if (weight > best.weight) best = { weight, count };
        return;
      }
      const candidate = candidates[index];
      if (chosen.every((other) => !sharesAny(other.ancestors, candidate.ancestors))) {
        chosen.push(candidate);
        search(index + 1, weight + candidate.weight, count + 1);
        chosen.pop();
      }
      search(index + 1, weight, count);
    };
    search(0, 0, 0);
    return best;
  }

  let weight = 0;
  let count = 0;
  const chosen = [];
  for (const candidate of [...candidates].sort((left, right) => left.ancestors.size - right.ancestors.size || left.index - right.index)) {
    if (chosen.every((other) => !sharesAny(other.ancestors, candidate.ancestors))) {
      chosen.push(candidate);
      weight += candidate.weight;
      count += 1;
    }
  }
  return { weight, count };
}

export const resilienceChecks = {
  /**
   * A path with no declared failure domain cannot be reasoned about. Sources and
   * interfaces carry a non-null domain, so the reachable case is a site route
   * whose provenance declares none.
   */
  'facility.resilience.failure_domain.missing': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `SELECT g.geometry_id, g.entity_id
         FROM geometry_records g
        WHERE g.project_id = $1 AND g.revision_id = $2 AND g.role = 'ROUTE'
          AND (g.provenance->>'failure_domain_id' IS NULL)`,
      [ctx.projectId, ctx.revisionId],
    );
    const findings = rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'UTILITY_ROUTE', entity_id: row.entity_id }],
      geometryRefs: [row.geometry_id],
      computed: { expression: 'failure domain declared', expected: true, actual: false },
    }));

    for (const requirement of ctx.requirements.filter((item) => item.active)) {
      for (const kind of requirement.applies_to ?? []) {
        const paths = pathsFor(ctx.sources, kind);
        if (paths.length === 0) continue;
        const withDomain = paths.filter((path) => path.failure_domain_id && ctx.domainById.has(path.failure_domain_id));
        if (withDomain.length === 0) {
          findings.push(finding(constraint, {
            entityRefs: [{ entity_type: 'RESILIENCE_REQUIREMENT', entity_id: requirement.requirement_id }],
            computed: { expression: 'declared failure domains among paths', expected: '>= 1', actual: 0 },
            resourceKind: kind,
          }));
        }
      }
    }
    return findings;
  },

  /** Paths required to be independent must not share any failure-domain ancestor. */
  'facility.resilience.failure_domain.shared': async (ctx, constraint) => {
    const findings = [];
    for (const requirement of ctx.requirements.filter((item) => item.active)) {
      for (const kind of requirement.applies_to ?? []) {
        const paths = pathsFor(ctx.sources, kind).filter((path) => path.failure_domain_id);
        for (let i = 0; i < paths.length; i += 1) {
          for (let j = i + 1; j < paths.length; j += 1) {
            const left = ancestorSet(paths[i].failure_domain_id, ctx.domainById);
            const right = ancestorSet(paths[j].failure_domain_id, ctx.domainById);
            const shared = [...left].filter((id) => right.has(id));
            if (shared.length > 0) {
              findings.push(finding(constraint, {
                entityRefs: [
                  { entity_type: 'UTILITY_SOURCE', entity_id: paths[i].utility_source_id },
                  { entity_type: 'UTILITY_SOURCE', entity_id: paths[j].utility_source_id },
                ],
                computed: {
                  expression: 'shared failure-domain ancestors',
                  expected: 0,
                  actual: shared.length,
                  shared_domains: shared,
                },
                resourceKind: kind,
              }));
            }
          }
        }
      }
    }
    return findings;
  },

  'facility.resilience.failure_domain.cycle': async (ctx, constraint) => {
    const { rows } = await ctx.client.query(
      `WITH RECURSIVE walk AS (
         SELECT failure_domain_id, parent_failure_domain_id, ARRAY[failure_domain_id] AS path, false AS cycle
           FROM failure_domains WHERE project_id = $1 AND revision_id = $2
         UNION ALL
         SELECT d.failure_domain_id, d.parent_failure_domain_id, w.path || d.failure_domain_id,
                (d.failure_domain_id = ANY(w.path))
           FROM failure_domains d
           JOIN walk w ON w.parent_failure_domain_id = d.failure_domain_id
          WHERE d.project_id = $1 AND d.revision_id = $2 AND NOT w.cycle
       )
       SELECT DISTINCT failure_domain_id FROM walk WHERE cycle`,
      [ctx.projectId, ctx.revisionId],
    );
    return rows.map((row) => finding(constraint, {
      entityRefs: [{ entity_type: 'FAILURE_DOMAIN', entity_id: row.failure_domain_id }],
      computed: { expression: 'failure-domain containment', expected: 'acyclic', actual: 'cycle' },
    }));
  },

  /** A resource kind the policy names with no supplying path cannot be met at all. */
  'facility.resilience.availability_policy.violated': async (ctx, constraint) => {
    const findings = [];
    for (const requirement of ctx.requirements.filter((item) => item.active)) {
      for (const kind of requirement.applies_to ?? []) {
        if (pathsFor(ctx.sources, kind).length === 0) {
          findings.push(finding(constraint, {
            entityRefs: [{ entity_type: 'RESILIENCE_REQUIREMENT', entity_id: requirement.requirement_id }],
            sourceValues: [{ field: 'applies_to', value: kind }],
            computed: { expression: 'supplying paths for named resource kind', expected: '>= 1', actual: 0 },
            policyRef: requirement.policy_id,
            resourceKind: kind,
          }));
        }
      }
    }
    return findings;
  },

  'facility.resilience.availability_policy.unresolved': async (ctx, constraint) => {
    const findings = [];
    for (const requirement of ctx.requirements.filter((item) => item.active)) {
      const resolved = ctx.policies.resolveReference(requirement.policy_id);
      if (!resolved || !resolved.policy) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'RESILIENCE_REQUIREMENT', entity_id: requirement.requirement_id }],
          sourceValues: [{ field: 'policy_id', value: requirement.policy_id }],
          computed: {
            expression: 'policy reference resolves',
            expected: 'policy_id@version in the registry',
            actual: requirement.policy_id ?? null,
          },
        }));
      }
    }
    return findings;
  },

  'facility.resilience.fuel_duration.insufficient': async (ctx, constraint) =>
    durationShortfall(ctx, constraint, 'FUEL'),

  'facility.resilience.water_duration.insufficient': async (ctx, constraint) =>
    durationShortfall(ctx, constraint, 'WATER'),

  /** Independent paths, counted by distinct failure domain, against the policy. */
  'facility.resilience.redundancy.path_count': async (ctx, constraint) => {
    const findings = [];
    for (const requirement of ctx.requirements.filter((item) => item.active)) {
      // The requirement's own `availability_policy` is the declared claim, and it
      // is what a reviewer reads; the pinned policy reference corroborates it. If
      // the two disagree, the declaration wins, because gating on the reference
      // would silently validate a policy the revision does not claim to meet. A
      // reference is consulted only when the declaration is not recognised.
      const resolved = ctx.policies.resolveReference(requirement.policy_id);
      const required = ctx.policies.requiredPathCount(requirement.availability_policy)
        ?? (resolved?.policy?.availabilityPolicy
          ? ctx.policies.requiredPathCount(resolved.policy.availabilityPolicy)
          : null);
      if (required === null) continue;

      for (const kind of requirement.applies_to ?? []) {
        const paths = pathsFor(ctx.sources, kind);
        if (paths.length === 0) continue;
        const independent = maxIndependentWeight(paths, {
          domainIdOf: (path) => path.failure_domain_id,
          weightOf: () => 1,
          domainById: ctx.domainById,
        });
        if (independent.count < required) {
          findings.push(finding(constraint, {
            entityRefs: [{ entity_type: 'RESILIENCE_REQUIREMENT', entity_id: requirement.requirement_id }],
            computed: {
              expression: 'failure-domain-independent paths',
              expected: `>= ${required} (${requirement.availability_policy})`,
              actual: independent.count,
            },
            policyRef: requirement.policy_id,
            remediationHint: `${kind} has ${independent.count} independent path(s); the policy requires ${required}.`,
            resourceKind: kind,
          }));
        }
      }
    }
    return findings;
  },
};

/** Shared fuel/water autonomy comparison. */
function durationShortfall(ctx, constraint, resourceKind) {
  const findings = [];
  for (const requirement of ctx.requirements.filter((item) => item.active)) {
    if (!(requirement.applies_to ?? []).includes(resourceKind)) continue;
    const resolved = ctx.policies.resolveReference(requirement.policy_id);
    const requiredSeconds = requirement.autonomy_duration_seconds ?? resolved?.policy?.autonomyDurationSeconds ?? null;
    if (requiredSeconds === null) continue;

    const reserves = ctx.reserves.filter((reserve) => reserve.kind === resourceKind);
    // Autonomy is satisfied only by reserves in independent failure domains: two
    // tanks in one domain are one backup, not two, because a single failure takes
    // both. The requirement's own duration is the declaration; the pinned policy
    // corroborates it.
    const independent = maxIndependentWeight(reserves, {
      domainIdOf: (reserve) => reserve.failure_domain_id,
      weightOf: (reserve) => reserve.autonomy_duration_seconds,
      domainById: ctx.domainById,
    });
    const best = independent.weight;
    if (best < requiredSeconds) {
      findings.push(finding(constraint, {
        entityRefs: [{ entity_type: 'RESILIENCE_REQUIREMENT', entity_id: requirement.requirement_id }],
        computed: {
          expression: `${resourceKind} storage autonomy`,
          expected: `>= ${requiredSeconds} s`,
          actual: `${best} s`,
        },
        policyRef: requirement.policy_id,
        remediationHint: reserves.length === 0
          ? `No ${resourceKind} storage reserve is declared.`
          : `${resourceKind} autonomy is ${best} s against a ${requiredSeconds} s requirement.`,
        resourceKind,
      }));
    }
  }
  return findings;
}

export const resilienceCheckIds = Object.keys(resilienceChecks);
