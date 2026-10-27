import { useCallback, useEffect, useState } from 'react';

/**
 * Loads the project assets for the open workspace.
 *
 * Assets are project-scoped, so the read follows the workspace context rather than
 * a tool tab: every surface in the project sees the same list (project-assets.md,
 * "Principles"). `reload` is returned so a mutation (upload, archive, delete) can
 * refresh the list without a second source of truth in the shell.
 */
export function useAssets({ client = null, projectId = null }) {
  const [state, setState] = useState({ assets: [], pending: false, error: null });

  const reload = useCallback(async () => {
    if (!client || !projectId) return;
    try {
      const { data } = await client.listAssets(projectId);
      setState({ assets: data ?? [], pending: false, error: null });
    } catch (error) {
      setState({ assets: [], pending: false, error });
    }
  }, [client, projectId]);

  useEffect(() => {
    if (!client || !projectId) {
      setState({ assets: [], pending: false, error: null });
      return undefined;
    }

    let active = true;
    setState((previous) => ({ ...previous, pending: true, error: null }));

    client
      .listAssets(projectId)
      .then(({ data }) => {
        if (active) setState({ assets: data ?? [], pending: false, error: null });
      })
      .catch((error) => {
        if (active) setState({ assets: [], pending: false, error });
      });

    return () => {
      active = false;
    };
  }, [client, projectId]);

  return { ...state, reload };
}
