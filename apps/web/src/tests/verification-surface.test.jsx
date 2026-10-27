import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerificationSurface } from '../facility/VerificationSurface.jsx';
import { filterDiagnostics } from '../facility/verification-state.js';

const ERROR_FINDING = {
  diagnosticId: 'd-1',
  validationRunId: 'run-1',
  constraintId: 'facility.site.height.exceeded',
  severity: 'ERROR',
  status: 'OPEN',
  entityRefs: [{ entity_type: 'BUILDING', entity_id: 'abcdef0123456789' }],
  geometryRefs: ['g-1'],
  sourceValues: [{ field: 'limit_m', value: 40, unit: 'm' }],
  computed: { measured_m: 46 },
  remediationCategory: 'CORRECT_GEOMETRY',
  remediationHint: 'Lower the roof below the limit.',
  policyRef: null,
};

const WAIVED_FINDING = {
  diagnosticId: 'd-2',
  constraintId: 'facility.data.provenance.stale',
  severity: 'WARNING',
  status: 'WAIVED',
  entityRefs: [],
  sourceValues: [],
  computed: {},
  remediationCategory: 'ADD_DATA',
};

const COVERAGE = [
  { capability: 'GEOMETRY', status: 'PROVISIONAL', reasons: ['facility.site.height.exceeded ERROR'], validationRunId: 'run-1' },
  { capability: 'PHASING', status: 'VALIDATED', reasons: [], validationRunId: 'run-1' },
];

const WAIVER = {
  waiverId: 'w-1',
  revisionId: 'r-1',
  diagnosticIds: ['d-2'],
  scope: 'REVISION',
  policyId: 'corp-dc-standard@3',
  reason: 'Legacy wing, scheduled for demolition.',
  grantedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  status: 'GRANTED',
};

/** A replaced record: a later run superseded it, so it is history, not a finding. */
const SUPERSEDED_FINDING = {
  diagnosticId: 'd-3',
  constraintId: 'facility.data.geometry.role_missing',
  severity: 'ERROR',
  status: 'SUPERSEDED',
  entityRefs: [],
  sourceValues: [],
  computed: {},
  remediationCategory: 'ADD_DATA',
};

/**
 * A finding that was fixed and closed by the engine. Same shape and same severity as the one
 * above — which is exactly why it used to read as a live error.
 */
const RESOLVED_FINDING = {
  ...SUPERSEDED_FINDING,
  diagnosticId: 'd-4',
  status: 'RESOLVED',
};

function render(props = {}) {
  return renderToStaticMarkup(<VerificationSurface revisionId="r-1" lifecycleState="DRAFT" canRun canGrantWaiver {...props} />);
}

/* ------------------------------------------------------------------- coverage */

test('underived coverage is stated as not provided, capability by capability', () => {
  const html = render();
  assert.match(html, /No run has derived coverage for this revision/);
  assert.match(html, /data-capability="GEOMETRY"/);
  assert.match(html, /data-capability="PHASING"/);
  assert.match(html, /data-capability="NETWORK_ENTRY"/);
  assert.match(html, /not derived by any validation run/);
  assert.equal((html.match(/data-capability=/g) ?? []).length, 8, 'every capability is listed');
});

test('derived coverage renders its status and the reason behind it', () => {
  const html = render({ coverage: COVERAGE });
  assert.match(html, /badge--ok[^>]*>VALIDATED/);
  assert.match(html, /badge--warning[^>]*>PROVISIONAL/);
  assert.match(html, /facility\.site\.height\.exceeded ERROR/);
  assert.doesNotMatch(html, /No run has derived coverage for this revision/);
});

/* ------------------------------------------------------------------- findings */

test('a finding keeps its catalog id, severity, status, and evidence', () => {
  const html = render({ diagnostics: [ERROR_FINDING] });
  assert.match(html, /data-constraint-id="facility\.site\.height\.exceeded"/);
  assert.match(html, /badge--error[^>]*>ERROR/);
  assert.match(html, /CORRECT_GEOMETRY/);
  assert.match(html, /BUILDING abcdef01…/);
  assert.match(html, /limit_m: 40 m/);
  assert.match(html, /measured_m: 46/);
  assert.match(html, /Lower the roof below the limit\./);
  assert.match(html, /gating/, 'an open ERROR gates');
});

test('findings are counted by severity, and a waived one stays listed', () => {
  const html = render({ diagnostics: [ERROR_FINDING, WAIVED_FINDING], waivers: [WAIVER] });
  assert.match(html, /1 error/);
  assert.match(html, /1 warning/);
  assert.match(html, /1 waived/);
  assert.match(html, /data-constraint-id="facility\.data\.provenance\.stale"/, 'a waiver never removes a finding');
  assert.match(html, /Waived by w-1 under corp-dc-standard@3/);
  assert.match(html, /The finding stays listed/);
});

test('the waive action is offered only on a gating finding, and only with the permission', () => {
  const withPermission = render({ diagnostics: [ERROR_FINDING, WAIVED_FINDING] });
  assert.match(withPermission, /class="finding__waive"[^>]*>Waive/);
  assert.equal(
    (withPermission.match(/class="finding__waive"/g) ?? []).length,
    1,
    'the waived finding has nothing left to waive',
  );

  const withoutPermission = render({ diagnostics: [ERROR_FINDING], canGrantWaiver: false });
  assert.doesNotMatch(withoutPermission, /finding__waive/);
});

/* ------------------------------------------------------------------ run state */

test('a stale local result says so instead of passing as current', () => {
  const html = render({
    run: { validationRunId: 'run-1', scope: 'AFFECTED_SUBGRAPH', status: 'COMPLETED', errorCount: 0, warningCount: 0, baseEtag: 'old' },
    draftEtag: 'new',
  });
  assert.match(html, /verify__run-summary--stale/);
  assert.match(html, /The draft changed after this run/);
});

test('a queued job is narrated by state, never shown as a verdict', () => {
  const html = render({ job: { jobId: 'job-1', state: 'QUEUED', progressPct: null } });
  assert.match(html, /waiting for the validation worker to claim it/);
  assert.match(html, /job job-1/);
});

test('an incomplete run cannot read as a pass', () => {
  const html = render({
    run: { validationRunId: 'run-1', scope: 'FULL', status: 'COMPLETED', errorCount: 0, warningCount: 0, incomplete: true },
    notice: 'This run reported itself incomplete (PHASING); it cannot validate the revision or satisfy the publication gate.',
  });
  assert.match(html, /reported itself incomplete/);
  assert.match(html, /cannot validate the revision/);
});

/* -------------------------------------------------------------------- gating */

test('a frozen revision cannot be run again, and says why', () => {
  const html = render({ lifecycleState: 'VALIDATED' });
  assert.match(html, /is VALIDATED and immutable/);
  assert.match(html, /Branch a draft/);
  assert.equal((html.match(/<button[^>]*data-scope="[^"]+"[^>]*disabled/g) ?? []).length, 2, 'both run controls are disabled');
});

test('without the run permission the controls are disabled and the reason is stated', () => {
  const html = render({ canRun: false });
  assert.match(html, /needs <code>facility\.validate\.run<\/code>/);
  assert.equal((html.match(/<button[^>]*data-scope="[^"]+"[^>]*disabled/g) ?? []).length, 2);
  assert.match(html, /Findings and coverage stay readable/);
});

test('both execution paths are offered, and the full one states its consequence', () => {
  const html = render();
  assert.match(html, /data-scope="AFFECTED_SUBGRAPH"[^>]*>Check local/);
  assert.match(html, /data-scope="FULL"[^>]*>Run full validation/);
  assert.match(html, /title="[^"]*Advisory: it never changes the lifecycle state\."/);
  assert.match(html, /title="[^"]*freezes this revision as VALIDATED[^"]*"/);
});

test('a failure carries the server correlation id for support', () => {
  const error = Object.assign(new Error('Validation is not permitted.'), { correlationId: 'corr-9' });
  const html = render({ error });
  assert.match(html, /role="alert"/);
  assert.match(html, /Validation is not permitted\./);
  assert.match(html, /correlation corr-9/);
});

/* -------------------------------------------------------------------- waivers */

test('recorded waivers are listed with their policy, scope, and reason', () => {
  const html = render({ waivers: [WAIVER] });
  assert.match(html, /data-waiver-id="w-1"/);
  assert.match(html, /corp-dc-standard@3/);
  assert.match(html, /Legacy wing, scheduled for demolition\./);
  assert.match(html, /REVISION/);
  assert.match(html, />Revoke</);
});

test('a revoked waiver cannot be revoked again, and an expired one is marked', () => {
  const html = render({
    waivers: [
      { ...WAIVER, status: 'REVOKED' },
      { ...WAIVER, waiverId: 'w-2', expiresAt: '2000-01-01T00:00:00Z' },
    ],
  });
  assert.match(html, /badge--warning[^>]*>REVOKED/);
  assert.match(html, /expired/);
  assert.equal((html.match(/>Revoke</g) ?? []).length, 1, 'only the still-granted waiver offers revoke');
});

test('revocation is withheld from a role without the waiver permission', () => {
  const html = render({ waivers: [WAIVER], canGrantWaiver: false });
  assert.doesNotMatch(html, />Revoke</);
  assert.match(html, /corp-dc-standard@3/, 'the waiver stays visible');
});

/* -------------------------------------------------------------------- filters */

test('the filters offered are exact, including the capability the catalog assigns', () => {
  const html = render();
  assert.match(html, /All severities/);
  assert.match(html, /All statuses/);
  assert.match(html, /Constraint id/);
  assert.match(html, /All capabilities/, 'the capability filter is available now that diagnostics carry it');
});

test('the capability filter matches the gating set the diagnostic carries', () => {
  // A resource-gated finding can hold back more than one capability, so the filter
  // is a membership test on a set rather than an equality test on a field.
  const multi = {
    ...ERROR_FINDING,
    diagnosticId: 'd-9',
    constraintId: 'facility.resilience.availability_policy.violated',
    capabilities: ['POWER', 'COOLING'],
    capabilityExact: false,
  };
  const other = { ...ERROR_FINDING, diagnosticId: 'd-10', capabilities: ['GEOMETRY'] };

  assert.deepEqual(
    filterDiagnostics([multi, other], { capability: 'COOLING' }).map((item) => item.diagnosticId),
    ['d-9'],
    'a multi-capability finding is selected by either capability',
  );
  assert.deepEqual(
    filterDiagnostics([multi, other], { capability: 'GEOMETRY' }).map((item) => item.diagnosticId),
    ['d-10'],
  );
  assert.equal(filterDiagnostics([multi, other], { capability: 'WATER' }).length, 0);
});

test('the finding filters compose, and history is opt-in', () => {
  const live = { ...ERROR_FINDING, diagnosticId: 'd-live', capabilities: ['GEOMETRY'] };
  const superseded = { ...SUPERSEDED_FINDING, capabilities: ['GEOMETRY'] };

  assert.deepEqual(
    filterDiagnostics([live, superseded], {}).map((item) => item.diagnosticId),
    ['d-live'],
    'history is excluded by default',
  );
  assert.equal(filterDiagnostics([live, superseded], { includeSuperseded: true }).length, 2);
  assert.equal(filterDiagnostics([live], { severity: 'WARNING' }).length, 0);
  assert.equal(filterDiagnostics([live], { constraintPrefix: 'facility.site.' }).length, 1);
  assert.equal(filterDiagnostics([live], { constraintPrefix: 'facility.data.' }).length, 0);
});

test('an empty finding list is not presented as a pass', () => {
  const html = render();
  assert.match(html, /No findings have been recorded for this revision/);
  assert.match(html, /this is not by itself a pass/);
});

/* ---------------------------------------------------- superseded are history */

test('a superseded record is not counted or listed as a current finding', () => {
  const html = render({ diagnostics: [ERROR_FINDING, SUPERSEDED_FINDING] });

  assert.match(html, /1 error/, 'only the live ERROR is counted');
  assert.doesNotMatch(html, /2 error/);
  assert.doesNotMatch(html, /data-constraint-id="facility\.data\.geometry\.role_missing"/, 'history stays out of the work list');
  assert.match(html, /1 historical record\(s\) are hidden/);
});

test('a finding that was fixed leaves the work list too', () => {
  // This is the case that had no test, and that the surface got wrong: a RESOLVED finding stayed
  // in the default list wearing its ERROR badge, so an author who had just fixed something read
  // a clean revision as a broken one. `RESOLVED` is what a passing report is made of.
  const html = render({ diagnostics: [ERROR_FINDING, RESOLVED_FINDING] });

  assert.match(html, /1 error/, 'only the finding that still stands is counted');
  assert.doesNotMatch(html, /2 error/);
  assert.doesNotMatch(html, /data-constraint-id="facility\.data\.geometry\.role_missing"/, 'a resolved finding is not work');
  assert.match(html, /1 historical record\(s\) are hidden/);
});

test('the history control states how much history there is', () => {
  const withHistory = render({ diagnostics: [ERROR_FINDING, SUPERSEDED_FINDING] });
  assert.match(withHistory, /Show history \(1\)/);
  // A fixed finding is history as well, so it is what the control counts and what it reveals.
  assert.match(render({ diagnostics: [ERROR_FINDING, RESOLVED_FINDING] }), /Show history \(1\)/);

  const withoutHistory = render({ diagnostics: [ERROR_FINDING] });
  assert.match(withoutHistory, /Show history \(0\)/);
  assert.match(withoutHistory, /<input type="checkbox" disabled=""/, 'nothing to show means the control is inert');
});

test('a revision whose findings are all superseded says exactly that, not "no findings"', () => {
  const html = render({ diagnostics: [SUPERSEDED_FINDING] });
  assert.match(html, /Every recorded finding is superseded history \(1\)/);
  assert.match(html, /none of them gates this revision now/);
  assert.doesNotMatch(html, /No findings have been recorded/);
});
