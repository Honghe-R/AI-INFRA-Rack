import { useCallback, useEffect, useState } from 'react';
import { selectProvider } from '../map/canvas-state.js';

/**
 * The project's basemap providers and its chosen provider (D16).
 *
 * Provider metadata comes from the server, never from a hard-coded list, because
 * the credential and the licence live there. A failed read is not fatal: the
 * canvas falls back to the plan-only grid, which is a valid state.
 */
export function useMapProviders({ client, projectId = null, enabled = true } = {}) {
  const [state, setState] = useState({ providers: [], settings: null, pending: Boolean(projectId) && enabled, error: null });

  const load = useCallback(async () => {
    if (!client || !projectId || !enabled) {
      setState({ providers: [], settings: null, pending: false, error: null });
      return null;
    }
    setState((current) => ({ ...current, pending: true, error: null }));
    try {
      const { data } = await client.listMapProviders(projectId);
      setState({ providers: data?.providers ?? [], settings: data?.settings ?? null, pending: false, error: null });
      return data;
    } catch (error) {
      // Reading providers is reporting; the canvas still renders, plan-only.
      setState({ providers: [], settings: null, pending: false, error });
      return null;
    }
  }, [client, projectId, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  /** Persists the project's provider choice and reflects it immediately. */
  const choose = useCallback(
    async (providerId, { style = null, tileQuota = null } = {}) => {
      if (!client || !projectId) return null;
      const { data } = await client.setMapProvider(projectId, { provider_id: providerId, style, tile_quota: tileQuota });
      setState((current) => ({ ...current, settings: data ?? current.settings }));
      return data;
    },
    [client, projectId],
  );

  return {
    ...state,
    provider: selectProvider(state.providers, state.settings),
    reload: load,
    choose,
  };
}
