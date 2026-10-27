import { useEffect, useState } from 'react';
import { withDevIdentity } from '../app/dev-identity.js';

/**
 * The caller's effective permission keys for a scope, fetched from the API.
 *
 * The shell uses these only to hide tools and commands it knows the caller cannot
 * use. A failure to load them is **not** a denial: the key set stays `null`, and
 * every consumer treats `null` as "unknown, show it" rather than "hide it". The
 * server refuses the call either way, so an optimistic shell cannot grant
 * anything — it can only avoid showing a control that would fail.
 */
// `withDevIdentity()` is memoised, so this default is the same function on every render and
// the effect below does not re-run because of it. It is an effect dependency, and a
// default parameter is evaluated per render — which is what made this an infinite loop.
export function useEffectiveKeys({ projectId = null, organisationId = null, baseUrl = '', fetchImpl = withDevIdentity() } = {}) {
  const [keys, setKeys] = useState(null);
  const [pending, setPending] = useState(Boolean(projectId || organisationId));

  useEffect(() => {
    if (!projectId && !organisationId) {
      setKeys(null);
      setPending(false);
      return undefined;
    }

    let active = true;
    setPending(true);

    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (organisationId) params.set('organisation_id', organisationId);

    fetchImpl(`${baseUrl}/api/v1/me/permissions?${params.toString()}`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json();
        return new Set(body?.data?.keys ?? []);
      })
      .catch(() => null)
      .then((resolved) => {
        if (!active) return;
        setKeys(resolved);
        setPending(false);
      });

    return () => {
      active = false;
    };
  }, [projectId, organisationId, baseUrl, fetchImpl]);

  return { keys, pending };
}
