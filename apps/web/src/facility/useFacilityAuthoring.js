import { useCallback, useRef, useState } from 'react';
import {
  bindChangeSet,
  conflictFrom,
  emptyChangeSet,
  isDirty,
  rebaseChangeSet,
  stageChange,
  unstageChange,
} from './authoring-state.js';

/**
 * The authoring binding: a pending change set, a commit, and a conflict the user decides.
 *
 * The set is held here rather than in the shell's view store because it is tool state
 * that belongs to a revision, and a revision switch must not carry edits across. What the
 * shell owns is the *fact* that this tab is dirty, which the caller wires through
 * `setDirty` — the shell already knows how to ask before discarding, and re-implementing
 * that here would be a second answer to the same question.
 *
 * A commit is never automatic and never retried. A `409` is surfaced with the server's
 * current token so the user can rebase and try again or discard, because re-basing
 * silently would commit an edit against a revision they never saw.
 */
export function useFacilityAuthoring({ client = null, projectId = null, revisionId = null, enabled = true } = {}) {
  const active = Boolean(client && projectId && revisionId && enabled);
  const [changeSet, setChangeSet] = useState(() => emptyChangeSet({ revisionId }));
  const [state, setState] = useState({ pending: false, error: null, conflict: null, result: null, notice: null });
  // Idempotency keys are minted per commit attempt and reused on retry of the same set,
  // so a lost response does not apply the edit twice.
  const keyRef = useRef(null);

  const stage = useCallback(
    (change) => {
      keyRef.current = null;
      setState((current) => ({ ...current, result: null, notice: null, error: null, conflict: null }));
      setChangeSet((current) => stageChange(current, change));
    },
    [],
  );

  const unstage = useCallback((index) => {
    keyRef.current = null;
    setChangeSet((current) => unstageChange(current, index));
  }, []);

  const discard = useCallback(() => {
    keyRef.current = null;
    setChangeSet((current) => ({ ...current, changes: [] }));
    setState({ pending: false, error: null, conflict: null, result: null, notice: 'Pending changes discarded.' });
  }, []);

  /** Points the set at the revision and token the surface is currently showing. */
  const bind = useCallback(
    ({ envelope = null } = {}) => {
      setChangeSet((current) => bindChangeSet(current, { revisionId, envelope }));
    },
    [revisionId],
  );

  const commit = useCallback(async () => {
    if (!active) return null;
    const changes = changeSet.changes ?? [];
    if (changes.length === 0) return null;

    if (!keyRef.current) {
      keyRef.current =
        typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `changeset-${Date.now()}`;
    }

    setState((current) => ({ ...current, pending: true, error: null, conflict: null, notice: null }));
    try {
      const { data } = await client.applyFacilityChangeSet(
        projectId,
        revisionId,
        {
          base_revision_id: changeSet.baseRevisionId,
          etag: changeSet.etag,
          changes,
          preview_diagnostics: true,
        },
        { idempotencyKey: keyRef.current },
      );
      keyRef.current = null;
      setChangeSet((current) => ({ ...current, changes: [], etag: data?.etag ?? current.etag }));
      setState({
        pending: false,
        error: null,
        conflict: null,
        result: data ?? null,
        notice: data?.effect ?? 'The change set was applied.',
      });
      return data ?? null;
    } catch (error) {
      const conflict = conflictFrom(error);
      setState((current) => ({
        ...current,
        pending: false,
        error: conflict ? null : error,
        conflict,
        notice: null,
      }));
      return null;
    }
  }, [active, changeSet, client, projectId, revisionId]);

  /** Re-bases onto the server's current token and keeps the pending changes. */
  const rebase = useCallback((etag) => {
    keyRef.current = null;
    setChangeSet((current) => rebaseChangeSet(current, etag));
    setState((current) => ({ ...current, conflict: null, notice: 'Re-based on the current draft. Commit again to apply.' }));
  }, []);

  return {
    changes: changeSet.changes ?? [],
    summary: changeSet,
    dirty: isDirty(changeSet),
    etag: changeSet.etag,
    baseRevisionId: changeSet.baseRevisionId,
    stage,
    unstage,
    discard,
    commit,
    rebase,
    bind,
    ...state,
  };
}
