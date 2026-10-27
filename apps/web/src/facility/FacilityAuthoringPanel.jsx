import { Watermark } from '../shell/Watermark.jsx';
import { describeChange } from './authoring-state.js';

/**
 * The authoring panel: what is staged, and the one place a commit happens.
 *
 * It is deliberately a panel rather than a per-edit save. The draft is edited through one
 * change set ([D1](../../../doc/tools/site-and-facility/decisions.md)), which is what
 * makes the shell's dirty-state machinery meaningful: edits accumulate here, the tab is
 * dirty until they are committed, and one commit either applies all of them or none.
 *
 * After a commit the panel reports **both halves** of the consequence — the findings the
 * edit produced and the findings it cleared — because an edit that appears to change
 * nothing is indistinguishable from one that did not apply.
 */
export function FacilityAuthoringPanel({
  changes = [],
  nameOf = () => null,
  dirty = false,
  pending = false,
  error = null,
  conflict = null,
  notice = null,
  result = null,
  blockedReason = null,
  onUnstage = () => {},
  onCommit = () => {},
  onDiscard = () => {},
  onRebase = () => {},
  onDismissResult = () => {},
}) {
  const findings = result?.diagnostics ?? null;
  const errors = (findings ?? []).filter((entry) => entry.severity === 'ERROR');
  const warnings = (findings ?? []).filter((entry) => entry.severity === 'WARNING');
  const cleared = result?.resolvedDiagnosticIds?.length ?? 0;

  return (
    // A `div`, not a `section`: it is one item of the map's left rail, whose host is the `aside`,
    // and a second region label there would be a heading for something that has no heading.
    <div className="canvas-pending" aria-label="Pending changes">
      <Watermark />
      {/* A title bar, and the actions under it. Beside the title they were two buttons and a
          count competing for one 240px line. */}
      <h2 className="authoring__title">
        Pending changes
        {dirty ? <span className="authoring__count">{changes.length}</span> : null}
      </h2>
      <div className="authoring__actions">
        <button
          type="button"
          className="authoring__commit"
          disabled={!dirty || pending || Boolean(blockedReason)}
          title={blockedReason ?? undefined}
          onClick={onCommit}
        >
          {pending ? 'Committing…' : 'Commit'}
        </button>
        <button type="button" className="authoring__discard" disabled={!dirty || pending} onClick={onDiscard}>
          Discard
        </button>
      </div>

      {blockedReason ? <p className="authoring__blocked">{blockedReason}</p> : null}

      {!dirty && !blockedReason ? (
        <p className="authoring__empty">
          No pending changes. Select something on the canvas to edit it, or draw a new footprint.
        </p>
      ) : null}

      {dirty ? (
        <ol className="authoring__list">
          {changes.map((change, index) => (
            // Two rows: what the change is, then what it is — the kind and the way to drop it.
            // One row of all three wrapped every description onto a second line and pushed the
            // kind and the button into the middle of the sentence.
            <li key={`${change.kind}-${index}`} className="authoring__item">
              <span className="authoring__item-text">{describeChange(change, { nameOf })}</span>
              <span className="authoring__item-meta">
                <span className="badge">{change.kind}</span>
                <button
                  type="button"
                  className="authoring__remove"
                  aria-label={`Remove pending change: ${describeChange(change, { nameOf })}`}
                  onClick={() => onUnstage(index)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {conflict ? (
        <div className="authoring__conflict" role="alert">
          <p className="authoring__conflict-text">{conflict.message}</p>
          {conflict.kind === 'stale' && conflict.currentEtag ? (
            <div className="authoring__conflict-actions">
              <button type="button" onClick={() => onRebase(conflict.currentEtag)}>
                Re-base on the current draft and keep my changes
              </button>
              <button type="button" onClick={onDiscard}>
                Discard my changes
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="authoring__error" role="alert">
          {error.message}
          {error.correlationId ? <span className="verify__muted"> · correlation {error.correlationId}</span> : null}
        </p>
      ) : null}

      {notice ? (
        <p className="authoring__notice" role="status">
          {notice}
        </p>
      ) : null}

      {result ? (
        <div className="authoring__result">
          <p className="authoring__result-line">
            Applied {result.applied?.length ?? 0} change(s) · draft now at v{result.etagVersion ?? '?'}
            {errors.length > 0 ? ` · ${errors.length} new ERROR` : ''}
            {warnings.length > 0 ? ` · ${warnings.length} new WARNING` : ''}
            {cleared > 0 ? ` · ${cleared} finding(s) cleared` : ''}
          </p>
          {findings && findings.length > 0 ? (
            <ul className="authoring__findings">
              {findings.slice(0, 8).map((finding) => (
                <li key={`${finding.constraintId}-${finding.entityRefs?.[0]?.entity_id ?? ''}`}>
                  <span className={`badge ${finding.severity === 'ERROR' ? 'badge--error' : 'badge--warning'}`}>
                    {finding.severity}
                  </span>{' '}
                  <code>{finding.constraintId}</code>
                  {finding.remediationHint ? <span className="verify__muted"> · {finding.remediationHint}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="authoring__result-line">No new findings.</p>
          )}
          <button type="button" className="authoring__dismiss" onClick={onDismissResult}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
