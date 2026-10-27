/**
 * Verification surface logic.
 *
 * The rules this module exists to keep in one place, from
 * verification-requirements.md and doc/tools/site-and-facility/ui-pattern.md:
 *
 *  * **Coverage is derived, never asserted.** A capability with no coverage row
 *    has not been derived, which is `NOT_PROVIDED` — reading an absent row as a
 *    pass is the "degrade the verdict" mistake the porting decisions forbid.
 *  * **Severity and status are different axes.** An `ERROR` that is `WAIVED` no
 *    longer gates, but it never disappears from the list; a waiver changes status
 *    and gating, never evidence.
 *  * **A local run can go stale.** Its `baseEtag` is the draft checksum it was
 *    computed against; when the draft moves on, the result must be shown as
 *    stale rather than merged into a later summary (acceptance criterion 7).
 *
 * Nothing here decides whether an action is permitted: permissions are the
 * shell's separate, three-state gate (`usePermission`), and the server refuses
 * regardless.
 */

/** The capabilities coverage is derived for, in catalog order. */
export const CAPABILITIES = Object.freeze([
  'GEOMETRY',
  'POWER',
  'COOLING',
  'WATER',
  'FUEL',
  'NETWORK_ENTRY',
  'ENVIRONMENT',
  'PHASING',
]);

export const COVERAGE_STATUSES = Object.freeze(['VALIDATED', 'PROVISIONAL', 'NOT_PROVIDED']);

export const SEVERITIES = Object.freeze(['ERROR', 'WARNING', 'INFO']);

export const DIAGNOSTIC_STATUSES = Object.freeze([
  'OPEN',
  'ACKNOWLEDGED',
  'WAIVED',
  'RESOLVED',
  'SUPERSEDED',
]);

/** Job states that will not change again, so polling stops. */
export const TERMINAL_JOB_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * The number of findings one read returns. The server caps a read at 1000, so the
 * surface can tell a truncated set from a complete one and say so rather than
 * presenting a prefix as the whole list.
 */
export const DIAGNOSTIC_LIMIT = 1000;

/**
 * The two execution paths. `advisory` is the load-bearing field: a local run
 * never sets lifecycle state, while a clean `FULL` run freezes the revision as
 * `VALIDATED`, which is why the surface states that consequence before running.
 */
export const VALIDATION_SCOPES = Object.freeze([
  Object.freeze({
    scope: 'AFFECTED_SUBGRAPH',
    label: 'Check local',
    advisory: true,
    description: 'Runs the checks that apply to both paths, inline. Advisory: it never changes the lifecycle state.',
  }),
  Object.freeze({
    scope: 'FULL',
    label: 'Run full validation',
    advisory: false,
    description: 'Runs every applicable catalog check. A clean run freezes this revision as VALIDATED and it can no longer be edited.',
  }),
]);

const SEVERITY_RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));

/** Statuses that still gate their capability; mirrors the engine's set. */
const GATING_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED']);

export function isTerminalJobState(state) {
  return TERMINAL_JOB_STATES.includes(state);
}

export function severityRank(severity) {
  return SEVERITY_RANK.get(severity) ?? SEVERITIES.length;
}

/**
 * Whether a record is history rather than a finding that still stands.
 *
 * Diagnostics are append-only, so the ledger holds more than the current state, and
 * the reads return all of it: the split is the client's job.
 *
 * Two statuses are history, for two different reasons.
 *
 * `SUPERSEDED` — a later run replaced this record for the same constraint and evidence. It is
 * not a finding at all, and counting it inflates every number on the surface.
 *
 * `RESOLVED` — the finding was fixed and the engine closed it. It *was* a finding, and it is
 * exactly the row this surface was misleading about: it stayed in the default list wearing the
 * severity badge of a problem that no longer exists, so a reader who had just fixed something
 * saw it reported as an ERROR. `RESOLVED` is what a clean report is made of — the server agrees,
 * skipping both statuses when it derives coverage (`coverage.js`) and when it decides what gates
 * publication (`publication.js`) — and a list that shows them is a list that cannot be read as
 * "what still needs doing".
 *
 * Both remain reachable: they are what the history control shows.
 */
export function isHistory(diagnostic) {
  return diagnostic?.status === 'SUPERSEDED' || diagnostic?.status === 'RESOLVED';
}

export function splitDiagnostics(diagnostics = []) {
  const live = [];
  const history = [];
  for (const diagnostic of diagnostics) {
    if (isHistory(diagnostic)) history.push(diagnostic);
    else live.push(diagnostic);
  }
  return { live, superseded: history };
}

/**
 * Applies the surface's finding filters.
 *
 * The capability filter matches the diagnostic's `capabilities` set, which the API
 * derives from the catalog. A resource-gated diagnostic can hold back more than one
 * capability at once, so this is a membership test on a set rather than an equality
 * test on a field — and it is exact, not a prefix guess over the constraint id.
 */
export function filterDiagnostics(
  diagnostics = [],
  { severity = 'ALL', status = 'ALL', capability = 'ALL', constraintPrefix = '', includeSuperseded = false } = {},
) {
  const rows = includeSuperseded ? diagnostics : splitDiagnostics(diagnostics).live;
  return rows.filter(
    (diagnostic) =>
      (severity === 'ALL' || diagnostic.severity === severity) &&
      (status === 'ALL' || diagnostic.status === status) &&
      (capability === 'ALL' || (diagnostic.capabilities ?? []).includes(capability)) &&
      (constraintPrefix === '' || String(diagnostic.constraintId ?? '').startsWith(constraintPrefix)),
  );
}

/**
 * Severity first, then constraint id, so the order is stable across runs. The
 * server already orders by severity; re-sorting here is what makes the order a
 * property of the surface rather than of the query.
 */
export function sortDiagnostics(diagnostics = []) {
  return [...diagnostics].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return String(a.constraintId).localeCompare(String(b.constraintId));
  });
}

export function summarizeDiagnostics(diagnostics = []) {
  const summary = { total: diagnostics.length, ERROR: 0, WARNING: 0, INFO: 0, waived: 0, open: 0, gating: 0 };
  for (const diagnostic of diagnostics) {
    if (summary[diagnostic.severity] !== undefined) summary[diagnostic.severity] += 1;
    if (diagnostic.status === 'WAIVED') summary.waived += 1;
    if (diagnostic.status === 'OPEN') summary.open += 1;
    if (gates(diagnostic)) summary.gating += 1;
  }
  return summary;
}

/** Whether a diagnostic still blocks, which is severity *and* status together. */
export function gates(diagnostic) {
  if (!diagnostic) return false;
  if (!['ERROR', 'WARNING'].includes(diagnostic.severity)) return false;
  return GATING_STATUSES.has(diagnostic.status);
}

/**
 * Coverage as a complete table over every capability.
 *
 * A capability the run did not cover is listed as `NOT_PROVIDED` with the reason
 * that no run derived it, so the surface never shows a gap as an absence of rows.
 */
export function coverageRows(coverage = []) {
  const byCapability = new Map(coverage.map((entry) => [entry.capability, entry]));
  return CAPABILITIES.map((capability) => {
    const entry = byCapability.get(capability);
    if (entry) {
      return {
        capability,
        status: COVERAGE_STATUSES.includes(entry.status) ? entry.status : 'NOT_PROVIDED',
        reasons: entry.reasons ?? [],
        derived: true,
        validationRunId: entry.validationRunId ?? null,
      };
    }
    return {
      capability,
      status: 'NOT_PROVIDED',
      reasons: ['not derived by any validation run'],
      derived: false,
      validationRunId: null,
    };
  });
}

export function coverageSummary(coverage = []) {
  const rows = coverageRows(coverage);
  const counts = { VALIDATED: 0, PROVISIONAL: 0, NOT_PROVIDED: 0, derived: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.derived) counts.derived += 1;
  }
  return { ...counts, total: rows.length, rows };
}

/**
 * The token a local run is pinned to.
 *
 * A draft's concurrency token is what advances on every commit, so it is what a
 * local result is compared against. The content checksum is only a fallback for a
 * frozen revision, where there is no draft token to advance: the two are different
 * facts and a surface that used the checksum as its draft token could never detect
 * staleness at all, because a draft has no checksum.
 */
export function draftTokenFor(envelope) {
  return envelope?.etag ?? envelope?.contentChecksum ?? null;
}

/**
 * Whether a local result no longer describes the draft it was computed against.
 *
 * Only a run that pinned a `baseEtag` can go stale: a run with no etag makes no
 * claim about which draft state it saw, so it is reported as unpinned rather
 * than silently treated as current. A frozen revision is the exception — once a
 * run has moved it past `DRAFT` there is nothing left to drift from, so the run
 * that froze it is its summary.
 */
export function runFreshness({ run = null, draftEtag = null, frozen = false } = {}) {
  if (!run) return { state: 'NONE', stale: false, reason: 'No validation has been run for this revision.' };
  if (frozen) {
    return { state: 'FROZEN', stale: false, reason: 'The revision is frozen, so this run is its validation summary.' };
  }
  if (!run.baseEtag) {
    return { state: 'UNPINNED', stale: false, reason: 'The run did not pin a draft checksum, so it cannot be shown to match the current draft.' };
  }
  if (!draftEtag) {
    return { state: 'UNKNOWN', stale: false, reason: 'The run pinned a draft checksum, but the current draft checksum is not available to compare.' };
  }
  if (run.baseEtag !== draftEtag) {
    return { state: 'STALE', stale: true, reason: 'The draft changed after this run; its findings are stale and must not be merged into a later summary.' };
  }
  return { state: 'CURRENT', stale: false, reason: 'Computed against the current draft.' };
}

/** A waiver covers a diagnostic when it names it and has not been revoked. */
export function waiverCoversDiagnostic(waiver, diagnosticId) {
  if (!waiver || !diagnosticId) return false;
  if (waiver.status !== 'GRANTED') return false;
  return Array.isArray(waiver.diagnosticIds) && waiver.diagnosticIds.includes(diagnosticId);
}

export function waiverIsExpired(waiver, now = Date.now()) {
  if (!waiver?.expiresAt) return false;
  const expires = Date.parse(waiver.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires <= now;
}

/**
 * Whether the surface offers "Waive" on a finding.
 *
 * It is offered only for a diagnostic that currently gates: waiving a resolved,
 * superseded, or informational finding would record a governance act that
 * changes nothing. The permission check stays with the caller and the server —
 * this answers the catalog-and-status half of the question only.
 */
export function canWaive(diagnostic) {
  // A waiver references diagnostics by id, so a finding without one cannot be
  // named by a governance record.
  if (!diagnostic?.diagnosticId) return false;
  return gates(diagnostic);
}

/**
 * The evidence lines a planner reads under a finding.
 *
 * Only what the diagnostic carried is rendered: `sourceValues` are the inputs the
 * check read, and `computed` is what it calculated from them. Nothing is
 * re-derived here, because a second implementation of a check is a second answer.
 */
export function diagnosticEvidence(diagnostic) {
  const lines = [];

  for (const ref of diagnostic.entityRefs ?? []) {
    const label = ref?.entity_type ?? ref?.entityType ?? 'ENTITY';
    const id = ref?.entity_id ?? ref?.entityId ?? null;
    lines.push(`${label} ${shortenId(id)}`);
  }

  for (const value of diagnostic.sourceValues ?? []) {
    if (!value || typeof value !== 'object') continue;
    const unit = value.unit ? ` ${value.unit}` : '';
    lines.push(`${value.field ?? 'value'}: ${formatScalar(value.value)}${unit}`);
  }

  for (const [key, value] of Object.entries(diagnostic.computed ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    lines.push(`${key}: ${formatScalar(value)}`);
  }

  if (diagnostic.remediationHint) lines.push(diagnostic.remediationHint);
  return lines;
}

/** A short, stable label for an identifier: full ids are unreadable in a list. */
export function shortenId(id) {
  if (typeof id !== 'string' || id.length === 0) return '—';
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

function formatScalar(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** The human sentence for a coverage status; the status itself stays visible. */
export function coverageLabel(status) {
  switch (status) {
    case 'VALIDATED':
      return 'Every applicable check passed';
    case 'PROVISIONAL':
      return 'Evidence exists, but a check did not pass cleanly';
    case 'NOT_PROVIDED':
      return 'No evidence, or no run has derived it';
    default:
      return status;
  }
}

/**
 * What a completed run has to say for itself, in the order that matters.
 *
 * An incomplete run is reported first and loudest: it cannot produce `VALIDATED`
 * coverage or satisfy the publication gate, so a clean-looking error count on an
 * incomplete run would be the most misleading thing on the surface.
 */
export function runNotice(run) {
  if (!run) return null;
  if (run.incomplete) {
    const unrun = (run.notCheckedCapabilities ?? []).join(', ') || 'some';
    return `This run reported itself incomplete (${unrun}); it cannot validate the revision or satisfy the publication gate.`;
  }
  if (run.validated) {
    return 'The run was clean and full: the revision is now VALIDATED and can no longer be edited.';
  }
  const label = run.scope === 'FULL' ? 'full' : 'local';
  if (run.errorCount > 0) {
    // The run's own counts describe the run, not the revision: findings are
    // append-only, so a later run may have superseded some of these.
    return `This ${label} run produced ${run.errorCount} ERROR and ${run.warningCount} WARNING diagnostic(s). The findings listed are the revision's current set.`;
  }
  if (run.scope === 'AFFECTED_SUBGRAPH') {
    return 'Advisory local run: it never sets lifecycle state, and a full run is still required before publication.';
  }
  return null;
}

/** A job is narrated by state, and never reported as a verdict while it runs. */export function describeJob(job) {
  if (!job) return null;
  switch (job.state) {
    case 'QUEUED':
      return 'Queued: waiting for the validation worker to claim it.';
    case 'RUNNING':
      return `Running${job.progressPct ? ` (${job.progressPct}%)` : ''}…`;
    case 'SUCCEEDED':
      return 'Completed.';
    case 'FAILED':
      return `Failed: ${job.errorMessage ?? 'no reason recorded'}`;
    case 'CANCELLED':
      return 'Cancelled.';
    default:
      return String(job.state);
  }
}
