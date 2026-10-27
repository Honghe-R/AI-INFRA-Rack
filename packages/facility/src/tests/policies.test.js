import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_REGISTRY_VERSION,
  TOLERANCES,
  createPolicyRegistry,
  defaultPolicyRegistry,
  parsePolicyRef,
} from '../policies.js';

test('a pinned reference carries a version; a bare name does not', () => {
  assert.deepEqual(parsePolicyRef('corp-dc-standard@3'), { policyId: 'corp-dc-standard', version: '3' });
  assert.deepEqual(parsePolicyRef('corp-dc-standard'), { policyId: 'corp-dc-standard', version: null });
  assert.equal(parsePolicyRef(''), null);
  assert.equal(parsePolicyRef(null), null);
  assert.equal(parsePolicyRef('@3'), null);
  assert.equal(parsePolicyRef('corp@'), null);
});

test('a version resolves its own numbers, and a version-less reference does not resolve', () => {
  assert.equal(defaultPolicyRegistry.resolve('corp-dc-standard', '3').availabilityPolicy, 'N_PLUS_1');
  assert.equal(defaultPolicyRegistry.resolve('corp-dc-standard', '2').availabilityPolicy, 'N');
  assert.equal(defaultPolicyRegistry.resolve('corp-dc-standard', null), null);
  assert.equal(defaultPolicyRegistry.resolve('nope', '1'), null);
});

test('resolveReference reports both the reference and the policy', () => {
  const resolved = defaultPolicyRegistry.resolveReference('corp-dc-standard@3');
  assert.deepEqual(resolved.reference, { policyId: 'corp-dc-standard', version: '3' });
  assert.equal(resolved.policy.autonomyDurationSeconds, 86400);
  assert.equal(defaultPolicyRegistry.resolveReference('corp-dc-standard').policy, null);
});

test('an availability policy maps to the independent paths it requires', () => {
  assert.equal(defaultPolicyRegistry.requiredPathCount('N'), 1);
  assert.equal(defaultPolicyRegistry.requiredPathCount('N_PLUS_1'), 2);
  assert.equal(defaultPolicyRegistry.requiredPathCount('TWO_N'), 2);
  assert.equal(defaultPolicyRegistry.requiredPathCount('TWO_N_PLUS_1'), 3);
  assert.equal(defaultPolicyRegistry.requiredPathCount('N_PLUS_2'), 3);
  assert.equal(defaultPolicyRegistry.requiredPathCount('SOMETHING'), null);
});

test('an override replaces one version and leaves the others alone', () => {
  const registry = createPolicyRegistry({
    overrides: [{ policyId: 'corp-dc-standard', version: '3', kind: 'AVAILABILITY', availabilityPolicy: 'TWO_N', reserveFraction: 0.2 }],
  });
  assert.equal(registry.resolve('corp-dc-standard', '3').availabilityPolicy, 'TWO_N');
  assert.equal(registry.resolve('corp-dc-standard', '3').reserveFraction, 0.2);
  assert.equal(registry.resolve('corp-dc-standard', '2').availabilityPolicy, 'N');
  // The built-in registry is untouched.
  assert.equal(defaultPolicyRegistry.resolve('corp-dc-standard', '3').availabilityPolicy, 'N_PLUS_1');
});

test('an override requires both a policy id and a version', () => {
  assert.throws(() => createPolicyRegistry({ overrides: [{ policyId: 'x' }] }), /requires policyId and version/);
});

test('the registry is versioned and the tolerances are the documented defaults', () => {
  assert.equal(POLICY_REGISTRY_VERSION, '2026.1');
  assert.deepEqual(TOLERANCES, {
    linearM: 0.01,
    arealM2: 0.01,
    residualM: 0.05,
    stalenessDays: 365,
    heightM: 0,
    capacityOvercommit: 0,
  });
});

test('a waiver policy declares whether it promotes coverage', () => {
  assert.equal(defaultPolicyRegistry.resolve('coverage-promoting-waiver', '1').coveragePromotingWaivers, true);
  assert.equal(defaultPolicyRegistry.resolve('corp-dc-standard', '3').coveragePromotingWaivers, false);
});
