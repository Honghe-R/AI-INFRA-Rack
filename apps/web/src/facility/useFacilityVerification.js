import { useCallback, useEffect, useRef, useState } from 'react';
import { DIAGNOSTIC_LIMIT, isTerminalJobState, runNotice } from './verification-state.js';

/**
 * Reads every page of a revision's diagnostics, up to the surface's own ceiling.
 *
 * The server bounds a page by the result size cap as well as by the item limit, so
 * a single read is not guaranteed to be the whole set. Following the cursor is what
 * makes "show superseded" honest: without it the surface would quietly display a
 * prefix and present it as history.
 */
async function fetchAllDiagnostics({ client, projectId, revisionId }) {
  const collected = [];
  let cursor = null;
  let page = 0;
  do {
    // Sequential by necessity: each page's cursor comes from the previous page.
    // eslint-disable-next-line no-await-in-loop
    const { data } = await client.listFacilityDiagnostics(projectId, revisionId, {
      limit: 200,
      includeSuperseded: true,
      ...(cursor ? { cursor } : {}),
    });
    const items = data?.diagnostics ?? [];
    collected.push(...items);
    cursor = data?.next_cursor ?? null;
    page += 1;
  } while (cursor && collected.length < DIAGNOSTIC_LIMIT && page < 20);

  return { data: { diagnostics: collected, truncated: Boolean(cursor) } };
}

/**
 * The verification surface's data binding: findings, coverage, waivers, and the
 * run that produces them (backend-api-contracts.md, `facility.read` /
 * `facility.validate.run` / `facility.waiver.grant`).
 *
 * Three behaviours are deliberate rather than incidental:
 *
 *  * **The two run paths are not merged.** A `FULL` run is a job, so the hook
 *    returns a `jobId` and polls; it never presents a queued job as a verdict.
 *  * **A local run is pinned to the draft it saw.** The caller passes the current
 *    draft checksum, the hook sends it as `base_etag`, and the surface can then
 *    show the result as stale once the draft moves on.
 *  * **A governance write never edits evidence.** Granting or revoking a waiver
 *    changes a finding's status and gating only, so the reload re-reads the same
 *    diagnostics rather than mutating them locally.
 */
export function useFacilityVerification({
  client = null,
  projectId = null,
  revisionId = null,
  enabled = true,
  draftEtag = null,
  pollIntervalMs = 1200,
} = {}) {
  const active = Boolean(client && projectId && revisionId && enabled);
  const [state, setState] = useState({
    diagnostics: [],
    coverage: [],
    waivers: [],
    run: null,
    job: null,
    pending: active,
    running: false,
    mutating: false,
    error: null,
    notice: null,
  });

  const timerRef = useRef(null);
  const mountedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const reload = useCallback(async () => {
    if (!active) {
      setState((current) => ({
        ...current,
        diagnostics: [],
        coverage: [],
        waivers: [],
        pending: false,
        error: null,
      }));
      return;
    }
    setState((current) => ({ ...current, pending: true, error: null }));
    try {
      const [diagnostics, coverage, waivers] = await Promise.all([
        // The surface shows history behind a toggle, so the read asks for
        // superseded records rather than letting the server's default hide them —
        // and follows the server's cursors, because a page is bounded by the result
        // size cap as well as by the item limit.
        fetchAllDiagnostics({ client, projectId, revisionId }),
        client.listFacilityCoverage(projectId, revisionId),
        client.listFacilityWaivers(projectId, revisionId),
      ]);
      if (!mountedRef.current) return;
      setState((current) => ({
        ...current,
        diagnostics: diagnostics.data?.diagnostics ?? [],
        coverage: coverage.data?.coverage ?? [],
        waivers: waivers.data?.waivers ?? [],
        pending: false,
        error: null,
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      setState((current) => ({ ...current, pending: false, error }));
    }
  }, [active, client, projectId, revisionId]);

  /** Re-reads the completed run, then the findings it produced. */
  const finishRun = useCallback(
    async (runId) => {
      let run = null;
      let failure = null;
      if (runId) {
        try {
          const { data } = await client.getFacilityValidationRun(projectId, revisionId, runId);
          run = data?.run ?? null;
        } catch (error) {
          failure = error;
        }
      }
      if (!mountedRef.current) return;
      setState((current) => ({
        ...current,
        run: run ?? current.run,
        running: false,
        error: failure,
        notice: run ? runNotice(run) : current.notice,
      }));
      await reload();
    },
    [client, projectId, revisionId, reload],
  );

  const pollJob = useCallback(
    (jobId, runId) => {
      stopPolling();
      const tick = async () => {
        let job = null;
        try {
          const { data } = await client.getJob(projectId, jobId);
          job = data ?? null;
        } catch (error) {
          if (!mountedRef.current) return;
          timerRef.current = null;
          setState((current) => ({ ...current, running: false, error }));
          return;
        }
        if (!mountedRef.current) return;
        setState((current) => ({ ...current, job }));
        if (job && isTerminalJobState(job.state)) {
          timerRef.current = null;
          await finishRun(runId);
          return;
        }
        timerRef.current = setTimeout(tick, pollIntervalMs);
      };
      timerRef.current = setTimeout(tick, pollIntervalMs);
    },
    [client, projectId, pollIntervalMs, stopPolling, finishRun],
  );

  /** Runs validation. `AFFECTED_SUBGRAPH` answers inline; `FULL` becomes a job. */
  const runValidation = useCallback(
    async ({ scope = 'AFFECTED_SUBGRAPH' } = {}) => {
      if (!active) return null;
      stopPolling();
      setState((current) => ({ ...current, running: true, error: null, notice: null }));
      try {
        const { data } = await client.requestFacilityValidation(projectId, revisionId, {
          scope,
          base_etag: draftEtag ?? null,
        });
        if (!mountedRef.current) return data ?? null;

        if (data?.mode === 'job') {
          setState((current) => ({
            ...current,
            run: null,
            job: { jobId: data.jobId, state: 'QUEUED', progressPct: null },
            running: true,
          }));
          pollJob(data.jobId, data.runId);
          return data;
        }

        // An inline run carries its own result; the etag it was computed against
        // is ours to attach, because an advisory run does not echo it back.
        const run = { ...data, baseEtag: draftEtag ?? null };
        setState((current) => ({ ...current, run, job: null, running: false, notice: runNotice(run) }));
        await reload();
        return data;
      } catch (error) {
        if (!mountedRef.current) return null;
        setState((current) => ({ ...current, running: false, error }));
        return null;
      }
    },
    [active, client, projectId, revisionId, draftEtag, pollJob, reload, stopPolling],
  );

  const grantWaiver = useCallback(
    async (input) => {
      if (!active) return null;
      setState((current) => ({ ...current, mutating: true, error: null, notice: null }));
      try {
        const { data } = await client.grantFacilityWaiver(projectId, revisionId, input);
        if (!mountedRef.current) return data ?? null;
        setState((current) => ({
          ...current,
          mutating: false,
          notice: 'Waiver recorded. It changes a finding’s status and gating; its evidence is unchanged.',
        }));
        await reload();
        return data;
      } catch (error) {
        if (!mountedRef.current) return null;
        setState((current) => ({ ...current, mutating: false, error }));
        return null;
      }
    },
    [active, client, projectId, revisionId, reload],
  );

  const revokeWaiver = useCallback(
    async (waiverId, reason = null) => {
      if (!active) return null;
      setState((current) => ({ ...current, mutating: true, error: null, notice: null }));
      try {
        const { data } = await client.revokeFacilityWaiver(projectId, waiverId, { reason });
        if (!mountedRef.current) return data ?? null;
        setState((current) => ({ ...current, mutating: false, notice: 'Waiver revoked; the gate it suppressed is restored.' }));
        await reload();
        return data;
      } catch (error) {
        if (!mountedRef.current) return null;
        setState((current) => ({ ...current, mutating: false, error }));
        return null;
      }
    },
    [active, client, projectId, reload],
  );

  return {
    ...state,
    reload,
    runValidation,
    grantWaiver,
    revokeWaiver,
  };
}
