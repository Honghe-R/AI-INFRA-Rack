/**
 * Policy registry.
 *
 * The specification stores policy *references* and never policy text ("policy
 * text is never copied into tool state; only the pinned reference is stored").
 * Validation, however, has to compare against real numbers: the firm-availability
 * formula needs a derating factor and a reserve, and a resilience check needs the
 * independent-path count a policy demands.
 *
 * Those values live here, as a **versioned built-in registry**. A reference names
 * a policy id and a version, and a version is immutable: changing a number means
 * adding an entry, never editing one, so a revision validated last month still
 * resolves to the same numbers. A deployment may inject overrides (a project's
 * approved policy set), but it can never silently change what an existing
 * `policy_id@version` means.
 */

export const POLICY_REGISTRY_VERSION = '2026.1';

/** Tolerances from verification-requirements.md, "Tolerances and Thresholds". */
export const TOLERANCES = Object.freeze({
  linearM: 0.01,
  arealM2: 0.01,
  residualM: 0.05,
  stalenessDays: 365,
  // A limit is never rounded in the permissive direction, so the height and
  // capacity tolerances are exactly zero.
  heightM: 0,
  capacityOvercommit: 0,
});

/** The independent paths each availability policy requires. */
export const REQUIRED_PATH_COUNT = Object.freeze({
  N: 1,
  N_PLUS_1: 2,
  TWO_N: 2,
  TWO_N_PLUS_1: 3,
  N_PLUS_2: 3,
});

const builtInPolicies = [
  Object.freeze({
    policyId: 'corp-dc-standard',
    version: '3',
    kind: 'AVAILABILITY',
    availabilityPolicy: 'N_PLUS_1',
    autonomyDurationSeconds: 86400,
    deratingFactor: 0,
    reserveFraction: 0.1,
    approvalRequired: false,
    coveragePromotingWaivers: false,
    description: 'Campus N+1 with 24 h autonomy and a 10% operating reserve.',
  }),
  Object.freeze({
    policyId: 'corp-dc-standard',
    version: '2',
    kind: 'AVAILABILITY',
    availabilityPolicy: 'N',
    autonomyDurationSeconds: 43200,
    deratingFactor: 0,
    reserveFraction: 0.05,
    approvalRequired: false,
    coveragePromotingWaivers: false,
    description: 'Superseded campus policy, retained so a pinned version still resolves.',
  }),
  Object.freeze({
    policyId: 'campus-n-plus-2',
    version: '1',
    kind: 'AVAILABILITY',
    availabilityPolicy: 'N_PLUS_2',
    autonomyDurationSeconds: 172800,
    deratingFactor: 0,
    reserveFraction: 0.1,
    approvalRequired: false,
    coveragePromotingWaivers: false,
    description: 'Four-path campus with 48 h autonomy, for a tenant that claims N+2.',
  }),
  Object.freeze({
    policyId: 'deployment-approval',
    version: '1',
    kind: 'APPROVAL',
    approvalRequired: true,
    coveragePromotingWaivers: false,
    description: 'Deployment policy that requires an approval attestation before publication.',
  }),
  Object.freeze({
    policyId: 'derating-5pct',
    version: '1',
    kind: 'DERATING',
    deratingFactor: 0.05,
    coveragePromotingWaivers: false,
    description: 'Five percent firm-capacity derating for high-ambient sites.',
  }),
  Object.freeze({
    policyId: 'coverage-promoting-waiver',
    version: '1',
    kind: 'WAIVER',
    coveragePromotingWaivers: true,
    description: 'Waivers granted under this policy may promote capability coverage.',
  }),
];

const byKey = (policyId, version) => `${policyId}@${version}`;

/**
 * A pinned policy reference is `policy_id@version`. A bare name has no version,
 * which is exactly the unresolved case the catalog warns about: a policy that can
 * be re-pointed is not pinned.
 */
export function parsePolicyRef(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return { policyId: trimmed, version: null };
  // An empty name or an empty version is a malformed reference, not an unpinned
  // one: there is nothing to resolve either way.
  if (at === 0 || at === trimmed.length - 1) return null;
  return { policyId: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
}

/**
 * A registry instance. `overrides` replace a built-in entry of the same
 * `policy_id@version`; they never shadow a version silently, because the key
 * includes the version.
 */
export function createPolicyRegistry({ overrides = [] } = {}) {
  const table = new Map(builtInPolicies.map((policy) => [byKey(policy.policyId, policy.version), policy]));
  for (const policy of overrides) {
    if (!policy?.policyId || !policy?.version) throw new Error('A policy override requires policyId and version.');
    table.set(byKey(policy.policyId, policy.version), Object.freeze({ ...policy }));
  }

  /** Resolves `policyId@version`. A reference without a version does not resolve. */
  function resolve(policyId, version = null) {
    if (!policyId || !version) return null;
    return table.get(byKey(policyId, version)) ?? null;
  }

  /** Every version of one policy id, newest last by lexical version. */
  function versions(policyId) {
    return [...table.values()]
      .filter((policy) => policy.policyId === policyId)
      .sort((a, b) => String(a.version).localeCompare(String(b.version), undefined, { numeric: true }));
  }

  /** Resolves a pinned `policy_id@version` reference, or null. */
  function resolveReference(raw) {
    const reference = parsePolicyRef(raw);
    if (!reference) return null;
    return { reference, policy: resolve(reference.policyId, reference.version) };
  }

  return {
    version: POLICY_REGISTRY_VERSION,
    tolerances: TOLERANCES,
    resolve,
    resolveReference,
    versions,
    requiredPathCount: (availabilityPolicy) => REQUIRED_PATH_COUNT[availabilityPolicy] ?? null,
    entries: () => [...table.values()],
  };
}

export const defaultPolicyRegistry = createPolicyRegistry();

/** The policy reference the development seed pins on its resilience requirement. */
export const SEED_AVAILABILITY_POLICY = 'corp-dc-standard@3';
