import { useEffect, useRef, useState } from 'react';
import {
  CAPABILITIES,
  DIAGNOSTIC_LIMIT,
  DIAGNOSTIC_STATUSES,
  SEVERITIES,
  VALIDATION_SCOPES,
  canWaive,
  coverageLabel,
  coverageSummary,
  describeJob,
  diagnosticEvidence,
  filterDiagnostics,
  gates,
  runFreshness,
  shortenId,
  sortDiagnostics,
  splitDiagnostics,
  summarizeDiagnostics,
  waiverIsExpired,
} from './verification-state.js';

/**
 * The Verify surface for one revision (ui-pattern.md, "Validate" route;
 * verification-requirements.md).
 *
 * It is the read-and-run half of verification: coverage is shown as derived, each
 * finding keeps its catalog `constraint_id`, and a waiver is offered only on a
 * finding that still gates. Nothing on this surface can set coverage or edit
 * evidence — those are properties of the engine, and a surface that offered them
 * would be lying about where the verdict comes from.
 *
 * The component is presentational on purpose: every value arrives as a prop, so
 * the states that matter (stale, incomplete, job in flight, denied) are rendered
 * in tests without a network.
 */
export function VerificationSurface({
  coverage = [],
  diagnostics = [],
  waivers = [],
  run = null,
  job = null,
  draftEtag = null,
  lifecycleState = null,
  revisionId = null,
  pending = false,
  running = false,
  mutating = false,
  error = null,
  notice = null,
  canRun = false,
  canGrantWaiver = false,
  // A finding the assistant asked this route to focus (`show_finding@1`, or a
  // `facility.diagnostic` entity reference). The surface clears its own filters so a
  // finding it was asked for cannot be hidden behind a filter left from a past visit.
  focus = null,
  onRun = () => {},
  onGrantWaiver = () => {},
  onRevokeWaiver = () => {},
  onReload = () => {},
}) {
  const [severity, setSeverity] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [capability, setCapability] = useState('ALL');
  const [constraintPrefix, setConstraintPrefix] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [waiving, setWaiving] = useState(null);
  const rootRef = useRef(null);

  // A new request is a new nonce, so asking for the same finding twice re-focuses it.
  const focusKey = focus
    ? `${focus.diagnosticId ?? ''}|${focus.constraintId ?? ''}|${focus.nonce ?? 0}`
    : null;

  // Resolved at render, not only in the effect below, so the first paint already marks
  // the finding: a focus that arrives with the read must not flash past unfocused, and
  // a server render must show the same thing a browser would.
  const focusMatch = focus
    ? (Array.isArray(diagnostics) ? diagnostics : []).find(
        (item) =>
          (focus.diagnosticId && item.diagnosticId === focus.diagnosticId) ||
          (focus.constraintId && item.constraintId === focus.constraintId),
      ) ?? null
    : null;
  const focusedId = focusMatch?.diagnosticId ?? null;
  const focusNotice =
    focus && !focusMatch
      ? `No finding with ${
          focus.diagnosticId ? `diagnostic ${shortenId(focus.diagnosticId)}` : `constraint ${focus.constraintId}`
        } is recorded for this revision.`
      : null;

  useEffect(() => {
    if (!focus) return;
    // Clear the filters so a finding the assistant asked for cannot be hidden behind a
    // filter a past visit left set.
    setSeverity('ALL');
    setStatus('ALL');
    setCapability('ALL');
    setConstraintPrefix('');
    setShowHistory(true);
    // `diagnostics` is a dependency on purpose: a focus that arrives before the read
    // lands must resolve when the read does.
  }, [focusKey, diagnostics]);

  // Bring the focused finding into view once it is rendered. The element id is the
  // diagnostic id, which the contract types as a uuid.
  useEffect(() => {
    if (!focusedId) return;
    const node = rootRef.current?.querySelector?.(`#verify-finding-${focusedId}`) ?? null;
    node?.scrollIntoView?.({ block: 'center' });
  }, [focusedId]);

  // A superseded diagnostic is a replaced record, not a current finding. Counting
  // it would inflate every number here and put history in the way of the work.
  const { live, superseded } = splitDiagnostics(diagnostics);
  const summary = summarizeDiagnostics(live);
  const coverageTable = coverageSummary(coverage);
  const immutable = lifecycleState !== null && lifecycleState !== 'DRAFT';
  const freshness = runFreshness({ run, draftEtag, frozen: immutable || run?.validated === true });
  const truncated = diagnostics.length >= DIAGNOSTIC_LIMIT;

  const visible = sortDiagnostics(
    filterDiagnostics(diagnostics, { severity, status, capability, constraintPrefix, includeSuperseded: showHistory }),
  );

  return (
    <section className="verify" aria-label="Verification" ref={rootRef}>
      <div className="verify__head">
        <div>
          <h1 className="verify__title">Verify</h1>
          <p className="verify__subtitle">
            Coverage is derived from a validation run, never asserted here. Revision {shortenId(revisionId)} ·{' '}
            {lifecycleState ?? 'lifecycle unknown'}
          </p>
        </div>
        <div className="verify__controls">
          {VALIDATION_SCOPES.map((option) => (
            <button
              key={option.scope}
              type="button"
              className={`verify__run${option.advisory ? '' : ' verify__run--full'}`}
              data-scope={option.scope}
              // A run is refused server-side on a non-draft revision and without
              // the permission; the control states the same rule rather than
              // offering an action that can only fail.
              disabled={!canRun || running || immutable}
              title={option.description}
              onClick={() => onRun({ scope: option.scope })}
            >
              {running ? 'Running…' : option.label}
            </button>
          ))}
          <button type="button" className="verify__refresh" onClick={onReload} disabled={pending}>
            Refresh
          </button>
        </div>
      </div>

      {!canRun ? (
        <p className="verify__gate">
          Running a validation needs <code>facility.validate.run</code>, which your role does not hold. Findings and
          coverage stay readable.
        </p>
      ) : null}

      {immutable ? (
        <p className="verify__gate">
          This revision is {lifecycleState} and immutable: it cannot be revalidated. Branch a draft to make changes.
        </p>
      ) : null}

      {job ? (
        <p className="verify__job" role="status">
          {describeJob(job)} <span className="verify__muted">job {shortenId(job.jobId)}</span>
        </p>
      ) : null}

      {notice ? (
        <p className="verify__notice" role="status">
          {notice}
        </p>
      ) : null}

      {focusNotice ? (
        <p className="verify__focus-notice" role="status">
          {focusNotice}
        </p>
      ) : null}

      {error ? (
        <p className="verify__error" role="alert">
          {error.message}
          {error.correlationId ? <span className="verify__muted"> · correlation {error.correlationId}</span> : null}
        </p>
      ) : null}

      {pending ? <p role="status" className="verify__muted">Loading verification results…</p> : null}

      <RunSummary run={run} freshness={freshness} />

      <section className="verify__section" aria-label="Capability coverage">
        <h2 className="verify__heading">
          Coverage
          <span className="verify__counts">
            <span className="badge badge--ok">{coverageTable.VALIDATED} validated</span>
            <span className="badge badge--warning">{coverageTable.PROVISIONAL} provisional</span>
            <span className="badge">{coverageTable.NOT_PROVIDED} not provided</span>
          </span>
        </h2>

        {coverageTable.derived === 0 ? (
          <p className="verify__empty">
            No run has derived coverage for this revision, so every capability is <strong>NOT_PROVIDED</strong>. That is
            the absence of a verdict, not a passing one.
          </p>
        ) : null}

        <table className="verify__table">
          <caption className="visually-hidden">Derived capability coverage with the reasons behind each status</caption>
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Status</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {coverageTable.rows.map((row) => (
              <tr key={row.capability} data-capability={row.capability}>
                <th scope="row">{row.capability}</th>
                <td>
                  <span className={`badge ${coverageBadgeClass(row.status)}`} title={coverageLabel(row.status)}>
                    {row.status}
                  </span>
                </td>
                <td className="verify__reasons">
                  {row.reasons.length > 0 ? row.reasons.join('; ') : coverageLabel(row.status)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="verify__section" aria-label="Findings">
        <h2 className="verify__heading">
          Findings
          <span className="verify__counts">
            <span className="badge badge--error">{summary.ERROR} error</span>
            <span className="badge badge--warning">{summary.WARNING} warning</span>
            <span className="badge badge--info">{summary.INFO} info</span>
            <span className="badge">{summary.waived} waived</span>
          </span>
        </h2>

        <p className="verify__note">
          {summary.gating === 0
            ? 'No finding currently gates this revision.'
            : `${summary.gating} finding(s) gate this revision: an ERROR blocks VALIDATED coverage, a WARNING caps its capability at PROVISIONAL.`}
          {superseded.length > 0 && !showHistory
            ? ` ${superseded.length} historical record(s) are hidden: findings that were fixed, and records a later run replaced.`
            : ''}
        </p>

        <div className="verify__filters">
          <label className="verify__filter">
            <span>Severity</span>
            <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="ALL">All severities</option>
              {SEVERITIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="verify__filter">
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="ALL">All statuses</option>
              {DIAGNOSTIC_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="verify__filter">
            <span>Capability</span>
            <select value={capability} onChange={(event) => setCapability(event.target.value)}>
              <option value="ALL">All capabilities</option>
              {CAPABILITIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="verify__filter">
            <span>Constraint id</span>
            <input
              type="search"
              value={constraintPrefix}
              placeholder="facility.site."
              onChange={(event) => setConstraintPrefix(event.target.value.trim())}
            />
          </label>
          <label className="verify__filter verify__filter--check">
            <input
              type="checkbox"
              checked={showHistory}
              disabled={superseded.length === 0}
              onChange={(event) => setShowHistory(event.target.checked)}
            />
            <span>Show history ({superseded.length})</span>
          </label>
        </div>

        {truncated ? (
          <p className="verify__note">
            Showing the first {DIAGNOSTIC_LIMIT} findings; this revision has more findings than one read returns.
          </p>
        ) : null}

        {visible.length === 0 ? (
          <p className="verify__empty">
            {live.length === 0 && superseded.length > 0
              ? `Every recorded finding is superseded history (${superseded.length}); a later run replaced them, so none of them gates this revision now.`
              : live.length === 0
                ? 'No findings have been recorded for this revision. Coverage is only derived by a run, so this is not by itself a pass.'
                : 'No findings match the current filters.'}
          </p>
        ) : (
          <ul className="verify__findings">
            {visible.map((diagnostic) => (
              <Finding
                key={diagnostic.diagnosticId ?? `${diagnostic.constraintId}-${diagnostic.createdAt ?? ''}`}
                diagnostic={diagnostic}
                waivers={waivers}
                canGrantWaiver={canGrantWaiver}
                mutating={mutating}
                focused={focusedId !== null && diagnostic.diagnosticId === focusedId}
                waiving={waiving === diagnostic.diagnosticId}
                onWaive={() => setWaiving(waiving === diagnostic.diagnosticId ? null : diagnostic.diagnosticId)}
                onGrantWaiver={async (input) => {
                  await onGrantWaiver(input);
                  setWaiving(null);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <WaiverList waivers={waivers} canGrantWaiver={canGrantWaiver} mutating={mutating} onRevokeWaiver={onRevokeWaiver} />
    </section>
  );
}

/** The run's own summary: what it covered, what it could not, and whether it is stale. */
function RunSummary({ run, freshness }) {
  if (!run) {
    return (
      <p className="verify__empty">
        No validation run is loaded for this revision yet. Coverage and findings from earlier runs remain listed below.
      </p>
    );
  }

  return (
    <div className={`verify__run-summary${freshness.stale ? ' verify__run-summary--stale' : ''}`}>
      <span className={`badge ${run.incomplete ? 'badge--warning' : run.errorCount > 0 ? 'badge--error' : 'badge--ok'}`}>
        {run.scope}
      </span>
      <span className="badge">{run.status}</span>
      <span className="verify__muted">run {shortenId(run.validationRunId ?? run.runId)}</span>
      <span className="verify__muted">
        {run.errorCount} error · {run.warningCount} warning
      </span>
      {run.notCheckedCapabilities?.length > 0 ? (
        <span className="verify__muted">not checked: {run.notCheckedCapabilities.join(', ')}</span>
      ) : null}
      <span className={`verify__freshness verify__freshness--${freshness.state}`}>{freshness.reason}</span>
    </div>
  );
}

function Finding({ diagnostic, waivers, canGrantWaiver, mutating, focused = false, waiving, onWaive, onGrantWaiver }) {
  const evidence = diagnosticEvidence(diagnostic);
  const activeWaiver = waivers.find((waiver) => waiver.diagnosticIds?.includes(diagnostic.diagnosticId)) ?? null;
  const offered = canGrantWaiver && canWaive(diagnostic);

  return (
    <li
      id={diagnostic.diagnosticId ? `verify-finding-${diagnostic.diagnosticId}` : undefined}
      className={`finding finding--${String(diagnostic.severity).toLowerCase()}${focused ? ' finding--focused' : ''}`}
      data-constraint-id={diagnostic.constraintId}
      data-diagnostic-id={diagnostic.diagnosticId ?? undefined}
      data-focused={focused ? 'true' : undefined}
    >
      <div className="finding__head">
        <span className={`badge ${severityBadgeClass(diagnostic.severity)}`}>{diagnostic.severity}</span>
        <code className="finding__id">{diagnostic.constraintId}</code>
        <span className="badge">{diagnostic.status}</span>
        {gates(diagnostic) ? <span className="finding__gating">gating</span> : null}
        {offered ? (
          <button type="button" className="finding__waive" disabled={mutating} onClick={onWaive}>
            {waiving ? 'Cancel' : 'Waive'}
          </button>
        ) : null}
      </div>

      {diagnostic.remediationCategory ? (
        <p className="finding__remediation">
          Remediation: <strong>{diagnostic.remediationCategory}</strong>
          {diagnostic.policyRef ? <span className="verify__muted"> · policy {diagnostic.policyRef}</span> : null}
        </p>
      ) : null}

      {evidence.length > 0 ? (
        <ul className="finding__evidence">
          {evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {activeWaiver ? (
        <p className="finding__waived">
          Waived by {shortenId(activeWaiver.waiverId)} under {activeWaiver.policyId}
          {activeWaiver.expiresAt ? ` until ${activeWaiver.expiresAt}` : ''}. The finding stays listed.
        </p>
      ) : null}

      {waiving ? <WaiverForm diagnostic={diagnostic} mutating={mutating} onSubmit={onGrantWaiver} /> : null}
    </li>
  );
}

/**
 * The waiver form. A reason, a scope, and a pinned policy reference are required;
 * expiry is optional. The policy reference is free text because policy text is
 * never copied into tool state — only the pinned reference is stored.
 */
function WaiverForm({ diagnostic, mutating, onSubmit }) {
  const [policyId, setPolicyId] = useState('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState('REVISION');
  const [expiresAt, setExpiresAt] = useState('');

  const ready = policyId.trim() !== '' && reason.trim() !== '';

  return (
    <form
      className="waiver-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSubmit({
          diagnostic_ids: [diagnostic.diagnosticId],
          policy_id: policyId.trim(),
          reason: reason.trim(),
          scope,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        });
      }}
    >
      <label className="waiver-form__field">
        <span>Policy reference</span>
        <input
          type="text"
          value={policyId}
          placeholder="corp-dc-standard@3"
          onChange={(event) => setPolicyId(event.target.value)}
          aria-describedby="waiver-policy-hint"
        />
      </label>
      <p className="waiver-form__hint" id="waiver-policy-hint">
        A pinned <code>policy_id@version</code>. A bare name is not pinned and will not resolve.
      </p>

      <label className="waiver-form__field">
        <span>Reason</span>
        <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>

      <label className="waiver-form__field">
        <span>Scope</span>
        <select value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="REVISION">REVISION</option>
          <option value="DIAGNOSTIC">DIAGNOSTIC</option>
          <option value="ENTITY">ENTITY</option>
        </select>
      </label>

      <label className="waiver-form__field">
        <span>Expires (optional)</span>
        <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
      </label>

      <button type="submit" className="waiver-form__submit" disabled={!ready || mutating}>
        Grant waiver
      </button>
    </form>
  );
}

function WaiverList({ waivers, canGrantWaiver, mutating, onRevokeWaiver }) {
  const [revoking, setRevoking] = useState(null);
  const [reason, setReason] = useState('');

  return (
    <section className="verify__section" aria-label="Waivers">
      <h2 className="verify__heading">Waivers</h2>

      {waivers.length === 0 ? (
        <p className="verify__empty">No waivers have been recorded for this revision.</p>
      ) : (
        <table className="verify__table">
          <caption className="visually-hidden">Waivers recorded against this revision</caption>
          <thead>
            <tr>
              <th scope="col">Policy</th>
              <th scope="col">Scope</th>
              <th scope="col">Reason</th>
              <th scope="col">Findings</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {waivers.map((waiver) => {
              const expired = waiverIsExpired(waiver);
              return (
                <tr key={waiver.waiverId} data-waiver-id={waiver.waiverId}>
                  <th scope="row">{waiver.policyId ?? '—'}</th>
                  <td>{waiver.scope}</td>
                  <td>{waiver.reason ?? '—'}</td>
                  <td>{waiver.diagnosticIds?.length ?? 0}</td>
                  <td>
                    {waiver.expiresAt ? waiver.expiresAt : '—'}
                    {expired ? <span className="verify__muted"> · expired</span> : null}
                  </td>
                  <td>
                    <span className={`badge ${waiver.status === 'GRANTED' ? 'badge--ok' : 'badge--warning'}`}>
                      {waiver.status}
                    </span>
                  </td>
                  <td>
                    {canGrantWaiver && waiver.status === 'GRANTED' ? (
                      revoking === waiver.waiverId ? (
                        <span className="waiver-form__inline">
                          <input
                            type="text"
                            value={reason}
                            placeholder="Reason"
                            aria-label="Revocation reason"
                            onChange={(event) => setReason(event.target.value)}
                          />
                          <button
                            type="button"
                            disabled={mutating}
                            onClick={async () => {
                              await onRevokeWaiver({ waiverId: waiver.waiverId, reason: reason.trim() || null });
                              setRevoking(null);
                              setReason('');
                            }}
                          >
                            Confirm
                          </button>
                          <button type="button" onClick={() => setRevoking(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setRevoking(waiver.waiverId)}>
                          Revoke
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The capability filter reads the gating capability the API now returns on each
 * diagnostic, derived from the constraint catalog. It is an exact match on a set
 * rather than a prefix guess, because a resource-gated diagnostic can hold back
 * more than one capability at once.
 */

function severityBadgeClass(severity) {
  if (severity === 'ERROR') return 'badge--error';
  if (severity === 'WARNING') return 'badge--warning';
  return 'badge--info';
}

function coverageBadgeClass(status) {
  if (status === 'VALIDATED') return 'badge--ok';
  if (status === 'PROVISIONAL') return 'badge--warning';
  return '';
}
