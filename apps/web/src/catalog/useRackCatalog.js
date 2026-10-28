import { useEffect, useState } from 'react';

export function useRackCatalog(client, projectId, enabled = true) {
  const [state, setState] = useState({ pending: true, data: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !client || !projectId) return undefined;
    const controller = new AbortController();
    setState({ pending: true, data: null, error: null });
    client.getRackCatalog(projectId, { signal: controller.signal }).then(({ data }) => {
      if (data.contractVersion !== 1 || data.projectId !== projectId || !Array.isArray(data.models) ||
          !Array.isArray(data.technologies) || !Array.isArray(data.examples))
        throw new Error('Catalog response does not match this project or contract.');
      if (!controller.signal.aborted) setState({ pending: false, data, error: null });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ pending: false, data: null, error });
    });
    return () => controller.abort();
  }, [client, projectId, enabled, retry]);
  // Do not expose the previous project's result during the render before the
  // effect resets state. Authorization remains enforced by the API as well.
  const current = state.data?.projectId === projectId;
  return { ...state, data: current && enabled ? state.data : null,
    pending: enabled && (state.pending || Boolean(state.data && !current)),
    retry: () => setRetry((n) => n + 1) };
}
