import { useEffect, useRef } from 'react';
import { usePermission } from '../permissions/usePermission.jsx';
import { useRouteRequest } from './workspace-effects.js';
import { draftTokenFor } from './verification-state.js';
import { useFacilityEnvelope } from './useFacilityEnvelope.js';
import { useFacilityVerification } from './useFacilityVerification.js';
import { VerificationSurface } from './VerificationSurface.jsx';

/**
 * The Verify route's container (ui-pattern.md, "Validate").
 *
 * It binds three independent gates and one read the surface cannot make for
 * itself:
 *
 *  * `facility.read` gates the whole surface, because a finding is design data.
 *  * `facility.validate.run` and `facility.waiver.grant` gate the two actions,
 *    separately — running a check and suppressing its gate are different acts.
 *  * The envelope read supplies the draft checksum a local run is pinned to, and
 *    the lifecycle state that decides whether a run is even possible.
 *
 * The toolbar's Validate command arrives as `runRequest`, a stamped intent rather
 * than a callback: the shell owns the button, and the surface owns the run.
 */
export function FacilityVerification({ client, projectId, revisionId = null, runRequest = null, focus = undefined, onRunRequestConsumed = null }) {
  const readPermission = usePermission('facility.read', { projectId });
  const canRead = readPermission.allowed === true;
  const runPermission = usePermission('facility.validate.run', { projectId });
  const waiverPermission = usePermission('facility.waiver.grant', { projectId });

  // A `show_finding` action publishes the finding it wants focused before the route
  // changes, because the surface that acts on it mounts only after the switch. A
  // caller-supplied focus wins, so the prop stays the documented entry point.
  const publishedFocus = useRouteRequest('validate');
  const activeFocus = focus !== undefined ? focus : publishedFocus;

  const envelope = useFacilityEnvelope({ client, projectId, revisionId, enabled: canRead });
  const draftEtag = draftTokenFor(envelope.envelope);
  const lifecycleState = envelope.envelope?.lifecycleState ?? null;

  const verification = useFacilityVerification({
    client,
    projectId,
    revisionId,
    enabled: canRead,
    draftEtag,
  });
  const { runValidation } = verification;

  // The toolbar's Validate command arrives as a stamped intent: the shell owns the
  // button, the surface owns the run. The intent is consumed exactly once — either
  // by running it or by deciding not to — so that navigating to this route later
  // never replays a run the user asked for somewhere else.
  const handledRef = useRef(null);
  const nonce = runRequest?.nonce ?? null;
  const requestedScope = runRequest?.scope ?? 'AFFECTED_SUBGRAPH';
  const undecided = readPermission.pending || runPermission.pending;
  useEffect(() => {
    if (!runRequest || undecided) return;
    if (nonce === handledRef.current) return;
    handledRef.current = nonce;
    if (canRead && runPermission.allowed === true && !(lifecycleState !== null && lifecycleState !== 'DRAFT')) {
      runValidation({ scope: requestedScope });
    }
    onRunRequestConsumed?.();
  }, [
    runRequest,
    nonce,
    requestedScope,
    undecided,
    canRead,
    runPermission.allowed,
    lifecycleState,
    runValidation,
    onRunRequestConsumed,
  ]);

  // A run can move the revision's lifecycle state and change its content checksum,
  // so the envelope that pinned this surface is re-read once a run lands.
  const landedRunId = verification.run?.validationRunId ?? verification.run?.runId ?? null;
  const reloadEnvelope = envelope.reload;
  useEffect(() => {
    if (landedRunId) reloadEnvelope();
  }, [landedRunId, reloadEnvelope]);

  if (!projectId) {
    return (
      <section className="verify verify--empty" aria-label="Verification">
        <p className="verify__empty">Open a project to verify its facility design.</p>
      </section>
    );
  }

  if (readPermission.pending) {
    return (
      <section className="verify verify--empty" aria-label="Verification">
        <p role="status" className="verify__muted">
          Checking permission…
        </p>
      </section>
    );
  }

  if (!canRead) {
    return (
      <section className="verify verify--empty" aria-label="Verification">
        <p className="verify__empty">Verification needs <code>facility.read</code>, which your role does not hold.</p>
      </section>
    );
  }

  return (
    <VerificationSurface
      coverage={verification.coverage}
      diagnostics={verification.diagnostics}
      waivers={verification.waivers}
      run={verification.run}
      job={verification.job}
      draftEtag={draftEtag}
      lifecycleState={lifecycleState}
      revisionId={revisionId}
      pending={verification.pending || envelope.pending}
      running={verification.running}
      mutating={verification.mutating}
      error={verification.error ?? envelope.error}
      notice={verification.notice}
      canRun={runPermission.allowed === true}
      canGrantWaiver={waiverPermission.allowed === true}
      focus={activeFocus}
      onRun={({ scope }) => runValidation({ scope })}
      onGrantWaiver={(input) => verification.grantWaiver(input)}
      onRevokeWaiver={({ waiverId, reason }) => verification.revokeWaiver(waiverId, reason ?? null)}
      onReload={verification.reload}
    />
  );
}
