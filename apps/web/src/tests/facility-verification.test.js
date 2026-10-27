import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createApiClient } from '../api/client.js';
import {
  DIAGNOSTIC_LIMIT,
  canWaive,
  coverageRows,
  coverageSummary,
  diagnosticEvidence,
  draftTokenFor,
  gates,
  runFreshness,
  runNotice,
  sortDiagnostics,
  isHistory,
  splitDiagnostics,
  summarizeDiagnostics,
  waiverCoversDiagnostic,
  waiverIsExpired,
} from '../facility/verification-state.js';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

/* --------------------------------------------------- coverage is derived only */

test('a capability with no coverage row is NOT_PROVIDED, never a pass', () => {
  const rows = coverageRows([]);
  assert.equal(rows.length, 8, 'every capability is listed, not just the derived ones');
  assert.equal(
    rows.every((row) => row.status === 'NOT_PROVIDED' && row.derived === false),
    true,
  );
  assert.match(rows[0].reasons.join(' '), /not derived by any validation run/);
});

test('coverage counts separate derived rows from the rest', () => {
  const summary = coverageSummary([
    { capability: 'GEOMETRY', status: 'VALIDATED', reasons: [] },
    { capability: 'POWER', status: 'PROVISIONAL', reasons: ['x ERROR'] },
    { capability: 'PHASING', status: 'NOT_PROVIDED', reasons: ['no evidence'] },
  ]);
  assert.equal(summary.total, 8);
  assert.equal(summary.derived, 3);
  assert.equal(summary.VALIDATED, 1);
  assert.equal(summary.PROVISIONAL, 1);
  assert.equal(summary.NOT_PROVIDED, 6, 'the five underived capabilities count as NOT_PROVIDED');
});

test('an unknown coverage status degrades to NOT_PROVIDED rather than a pass', () => {
  const [row] = coverageRows([{ capability: 'GEOMETRY', status: 'SOMETHING_ELSE' }]);
  assert.equal(row.status, 'NOT_PROVIDED');
});

/* ------------------------------------------------ severity and status differ */

test('an ERROR gates only while it is open or acknowledged', () => {
  assert.equal(gates({ severity: 'ERROR', status: 'OPEN' }), true);
  assert.equal(gates({ severity: 'ERROR', status: 'ACKNOWLEDGED' }), true);
  assert.equal(gates({ severity: 'ERROR', status: 'WAIVED' }), false, 'a waiver removes the gate');
  assert.equal(gates({ severity: 'ERROR', status: 'RESOLVED' }), false);
  assert.equal(gates({ severity: 'ERROR', status: 'SUPERSEDED' }), false);
  assert.equal(gates({ severity: 'INFO', status: 'OPEN' }), false, 'INFO never gates');
});

test('the summary counts a waived finding without hiding it', () => {
  const summary = summarizeDiagnostics([
    { severity: 'ERROR', status: 'OPEN' },
    { severity: 'ERROR', status: 'WAIVED' },
    { severity: 'WARNING', status: 'OPEN' },
    { severity: 'INFO', status: 'OPEN' },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.ERROR, 2);
  assert.equal(summary.waived, 1);
  assert.equal(summary.gating, 2, 'the waived ERROR and the INFO do not gate');
});

test('findings sort by severity then catalog id, so the order is stable', () => {
  const sorted = sortDiagnostics([
    { severity: 'WARNING', constraintId: 'facility.site.b' },
    { severity: 'ERROR', constraintId: 'facility.site.z' },
    { severity: 'ERROR', constraintId: 'facility.site.a' },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.constraintId),
    ['facility.site.a', 'facility.site.z', 'facility.site.b'],
  );
});

test('records that are no longer current are split out of the live finding set', () => {
  const { live, superseded } = splitDiagnostics([
    { status: 'OPEN', constraintId: 'a' },
    { status: 'SUPERSEDED', constraintId: 'b' },
    { status: 'WAIVED', constraintId: 'c' },
    { status: 'RESOLVED', constraintId: 'd' },
    { status: 'SUPERSEDED', constraintId: 'e' },
  ]);
  assert.deepEqual(
    live.map((item) => item.constraintId),
    ['a', 'c'],
    'a waived finding is still live: a waiver changes gating, not existence',
  );
  // Both are history. `RESOLVED` is a finding that was fixed, and listing it as work is what made
  // a clean revision read as a broken one; the server skips both when it derives coverage.
  assert.deepEqual(
    superseded.map((item) => item.constraintId),
    ['b', 'd', 'e'],
  );
  assert.equal(isHistory({ status: 'RESOLVED' }), true);
  assert.equal(isHistory({ status: 'SUPERSEDED' }), true);
  assert.equal(isHistory({ status: 'OPEN' }), false);
  assert.equal(isHistory({ status: 'WAIVED' }), false);
  assert.equal(isHistory({ status: 'ACKNOWLEDGED' }), false);
});

/* ------------------------------------------------------------------ freshness */

test('the draft token is the ETag, not the content checksum', () => {
  // A draft has no content checksum, so using it as the token would make staleness
  // undetectable. The ETag advances on every commit and is what a run pins to.
  assert.equal(draftTokenFor({ etag: 'e-1', contentChecksum: 'c-1' }), 'e-1');
  assert.equal(draftTokenFor({ etag: null, contentChecksum: 'c-1' }), 'c-1', 'a frozen revision falls back');
  assert.equal(draftTokenFor({ contentChecksum: null }), null);
  assert.equal(draftTokenFor(null), null);
});

test('a local run goes stale when the draft checksum moves on', () => {
  assert.equal(runFreshness({}).state, 'NONE');
  assert.equal(runFreshness({ run: { baseEtag: null } }).state, 'UNPINNED');
  assert.equal(runFreshness({ run: { baseEtag: 'a' } }).state, 'UNKNOWN');

  const current = runFreshness({ run: { baseEtag: 'a' }, draftEtag: 'a' });
  assert.equal(current.state, 'CURRENT');
  assert.equal(current.stale, false);

  const stale = runFreshness({ run: { baseEtag: 'a' }, draftEtag: 'b' });
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.stale, true, 'a stale result must be shown as stale, never merged forward');
});

test('a frozen revision has nothing left to drift from', () => {
  const frozen = runFreshness({ run: { baseEtag: 'a' }, draftEtag: 'b', frozen: true });
  assert.equal(frozen.state, 'FROZEN');
  assert.equal(frozen.stale, false);
});

/* -------------------------------------------------------------------- notices */

test('an incomplete run is reported ahead of a clean-looking error count', () => {
  const notice = runNotice({
    incomplete: true,
    notCheckedCapabilities: ['PHASING'],
    errorCount: 0,
    scope: 'FULL',
  });
  assert.match(notice, /incomplete/);
  assert.match(notice, /PHASING/);
  assert.match(notice, /cannot validate/);
});

test('a validated run says the revision is frozen, and an advisory run says so', () => {
  assert.match(runNotice({ validated: true, errorCount: 0, scope: 'FULL' }), /VALIDATED/);
  assert.match(runNotice({ scope: 'AFFECTED_SUBGRAPH', errorCount: 0 }), /Advisory/);
  assert.match(runNotice({ scope: 'FULL', errorCount: 2 }), /2 ERROR/);
  assert.equal(runNotice(null), null);
});

/* --------------------------------------------------------------------- waivers */

test('a waiver is offered only on a finding that still gates and has an id', () => {
  assert.equal(canWaive({ diagnosticId: 'd-1', severity: 'ERROR', status: 'OPEN' }), true);
  assert.equal(canWaive({ diagnosticId: 'd-1', severity: 'ERROR', status: 'WAIVED' }), false);
  assert.equal(canWaive({ diagnosticId: 'd-1', severity: 'INFO', status: 'OPEN' }), false);
  assert.equal(canWaive({ severity: 'ERROR', status: 'OPEN' }), false, 'a waiver must name a diagnostic');
  assert.equal(canWaive(null), false);
});

test('a revoked or unexpired waiver is read correctly', () => {
  const waiver = { status: 'GRANTED', diagnosticIds: ['d-1'], expiresAt: null };
  assert.equal(waiverCoversDiagnostic(waiver, 'd-1'), true);
  assert.equal(waiverCoversDiagnostic(waiver, 'd-2'), false);
  assert.equal(waiverCoversDiagnostic({ ...waiver, status: 'REVOKED' }, 'd-1'), false);
  assert.equal(waiverCoversDiagnostic(null, 'd-1'), false);

  assert.equal(waiverIsExpired({ expiresAt: null }), false);
  assert.equal(waiverIsExpired({ expiresAt: '2000-01-01T00:00:00Z' }), true);
  assert.equal(waiverIsExpired({ expiresAt: '2999-01-01T00:00:00Z' }), false);
});

/* -------------------------------------------------------------------- evidence */

test('evidence is rendered from the diagnostic, never re-derived', () => {
  const lines = diagnosticEvidence({
    entityRefs: [{ entity_type: 'BUILDING', entity_id: 'abcdef0123456789' }],
    sourceValues: [{ field: 'limit_m', value: 40, unit: 'm' }],
    computed: { measured_m: 46, nested: { ignored: true }, empty: null },
    remediationHint: 'Lower the roof.',
  });
  assert.equal(lines.some((line) => /BUILDING abcdef01…/.test(line)), true);
  assert.equal(lines.includes('limit_m: 40 m'), true);
  assert.equal(lines.includes('measured_m: 46'), true);
  assert.equal(lines.includes('Lower the roof.'), true);
  assert.equal(lines.some((line) => line.includes('nested')), false, 'objects are not flattened into a row');
  assert.equal(lines.some((line) => line.includes('empty')), false);
});

/* ----------------------------------------------------------------- the client */

test('the verification reads use the documented revision-scoped paths', async () => {
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method ?? 'GET', body: options?.body ?? null });
      return jsonResponse(200, { data: {} });
    },
  });

  await client.requestFacilityValidation('p-1', 'r-1', { scope: 'AFFECTED_SUBGRAPH', base_etag: 'sum' });
  await client.getFacilityValidationRun('p-1', 'r-1', 'run-1');
  await client.listFacilityDiagnostics('p-1', 'r-1', { severity: 'ERROR', limit: DIAGNOSTIC_LIMIT });
  await client.listFacilityCoverage('p-1', 'r-1');
  await client.listFacilityWaivers('p-1', 'r-1');
  await client.grantFacilityWaiver('p-1', 'r-1', { diagnostic_ids: ['d-1'], policy_id: 'corp-dc-standard@3' });
  await client.revokeFacilityWaiver('p-1', 'w-1', { reason: 'no longer needed' });
  await client.getJob('p-1', 'job-1');

  assert.equal(calls[0].url, '/api/v1/projects/p-1/facility/revisions/r-1/validate');
  assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.parse(calls[0].body).scope, 'AFFECTED_SUBGRAPH');
  assert.equal(calls[0].body.includes('base_etag'), true, 'a local run is pinned to the draft it saw');

  assert.equal(calls[1].url, '/api/v1/projects/p-1/facility/revisions/r-1/validation-runs/run-1');
  assert.match(calls[2].url, /\/facility\/revisions\/r-1\/diagnostics\?severity=ERROR&limit=1000$/);
  assert.equal(calls[3].url, '/api/v1/projects/p-1/facility/revisions/r-1/coverage');
  assert.equal(calls[4].url, '/api/v1/projects/p-1/facility/revisions/r-1/waivers');
  assert.equal(calls[5].method, 'POST');
  assert.equal(calls[6].url, '/api/v1/projects/p-1/facility/waivers/w-1/revoke');
  assert.equal(calls[7].url, '/api/v1/jobs/job-1?project_id=p-1', 'the job read is scoped by query');
});

test('a 202 job response is unwrapped like any other success', async () => {
  const client = createApiClient({
    fetchImpl: async () => jsonResponse(202, { data: { mode: 'job', jobId: 'job-1', runId: 'run-1', scope: 'FULL' } }),
  });
  const { data } = await client.requestFacilityValidation('p-1', 'r-1', { scope: 'FULL' });
  assert.equal(data.mode, 'job');
  assert.equal(data.jobId, 'job-1');
});
