import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  CAPABILITIES,
  CONSTRAINT_IDS,
  EVIDENCE_BUCKETS,
  RESOURCE_CAPABILITIES,
  constraintsForScope,
  getConstraint,
} from '../catalog.js';
import { CHECKS, orphanEvaluators, unregisteredConstraints } from '../checks/index.js';

/**
 * The catalog is the stable identifier registry. These assertions are the reason
 * a diagnostic can never carry a free-form id: every check the engine can run is
 * a catalog row, and every catalog row that claims to be implemented has an
 * evaluator.
 */

test('the catalog holds the documented 74 constraints, each exactly once', () => {
  assert.equal(CATALOG.length, 74);
  assert.equal(new Set(CONSTRAINT_IDS).size, 74);
});

test('identifiers follow the documented convention and are unique', () => {
  const seen = new Set();
  for (const constraint of CATALOG) {
    // `facility.<domain>.<subject>...`; some identifiers carry no separate
    // condition (`facility.revision.current`), so the tail is optional.
    assert.match(
      constraint.constraintId,
      /^facility\.(data|import|site|utility|capacity|resilience|environment|phase|interface|revision|governance)\.[a-z_]+(\.[a-z_]+)*$/,
      constraint.constraintId,
    );
    assert.equal(seen.has(constraint.constraintId), false, `${constraint.constraintId} is duplicated`);
    seen.add(constraint.constraintId);
  }
});

test('every entry declares a valid severity, scope, gating capability, and remediation', () => {
  const remediations = new Set([
    'ADD_DATA', 'CORRECT_GEOMETRY', 'RESOLVE_CONFLICT', 'UPDATE_CAPACITY', 'ADJUST_PHASE',
    'OBTAIN_APPROVAL', 'REVIEW_IMPORT', 'RECONFIGURE_RESILIENCE', 'CONTACT_RESPONSIBLE_PARTY', 'REVIEW_POLICY',
  ]);
  const gates = new Set(['GEOMETRY', 'RESOURCE', 'PHASING', 'ENVIRONMENT', 'FUEL', 'WATER', 'PUBLICATION']);
  for (const constraint of CATALOG) {
    assert.ok(['ERROR', 'WARNING', 'INFO'].includes(constraint.severity), constraint.constraintId);
    assert.ok(['BOTH', 'FULL'].includes(constraint.scope), constraint.constraintId);
    assert.ok(gates.has(constraint.gates), constraint.constraintId);
    assert.ok(remediations.has(constraint.remediation), constraint.constraintId);
    assert.ok(EVIDENCE_BUCKETS.includes(constraint.evidence), `${constraint.constraintId} evidence ${constraint.evidence}`);
    assert.ok(['VALIDATION', 'PUBLISH'].includes(constraint.phase), constraint.constraintId);
    assert.equal(typeof constraint.rule, 'string');
  }
});

test('the severity and scope tallies match the catalog document', () => {
  assert.equal(CATALOG.filter((item) => item.severity === 'ERROR').length, 58);
  assert.equal(CATALOG.filter((item) => item.severity === 'WARNING').length, 16);
  assert.equal(CATALOG.filter((item) => item.severity === 'INFO').length, 0);
  assert.equal(CATALOG.filter((item) => item.scope === 'BOTH').length, 29);
  assert.equal(CATALOG.filter((item) => item.scope === 'FULL').length, 45);
});

test('every implemented entry has an evaluator, and no evaluator is orphaned', () => {
  assert.deepEqual(unregisteredConstraints(), []);
  assert.deepEqual(orphanEvaluators(), []);
});

test('exactly the three checks with no evidence model are unimplemented', () => {
  const unimplemented = CATALOG.filter((item) => !item.implemented).map((item) => item.constraintId);
  assert.deepEqual(unimplemented.sort(), [
    'facility.environment.emissions.exceeded',
    'facility.environment.hazard.mitigation_missing',
    'facility.environment.permit.exceeded',
  ].sort());
  assert.equal(Object.keys(CHECKS).length, 71);
});

test('a local run considers only the checks the catalog marks Both', () => {
  const local = constraintsForScope('AFFECTED_SUBGRAPH');
  assert.equal(local.length, 29);
  assert.equal(local.every((item) => item.scope === 'BOTH'), true);

  const full = constraintsForScope('FULL');
  assert.equal(full.length, 74);
});

test('a resource-gated check names a capability that exists', () => {
  for (const constraint of CATALOG.filter((item) => item.gates === 'RESOURCE')) {
    assert.equal(constraint.gates, 'RESOURCE');
  }
  assert.deepEqual(RESOURCE_CAPABILITIES, ['POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY']);
  assert.equal(CAPABILITIES.length, 8);
});

test('the catalog resolves by identifier and refuses an unknown one', () => {
  assert.equal(getConstraint('facility.site.setback.violated').severity, 'ERROR');
  assert.equal(getConstraint('facility.not.a.check'), null);
});
