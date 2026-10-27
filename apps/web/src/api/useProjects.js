import { useEffect, useState } from 'react';

/**
 * Loads the project list for the signed-in user's organisation.
 *
 * With no organisation resolved the hook does not attempt a request and reports
 * `organisationMissing`, because the specification's information architecture has
 * no organisation selector: the active organisation is a session fact, supplied
 * by the account surface rather than chosen per screen.
 */
export function useProjects({ client, organisationId = null }) {
  const [state, setState] = useState({ projects: [], pending: Boolean(organisationId), error: null });

  useEffect(() => {
    if (!organisationId) {
      setState({ projects: [], pending: false, error: null });
      return undefined;
    }

    let active = true;
    setState((previous) => ({ ...previous, pending: true, error: null }));

    client
      .listProjects(organisationId)
      .then(({ data }) => {
        if (active) setState({ projects: data ?? [], pending: false, error: null });
      })
      .catch((error) => {
        if (active) setState({ projects: [], pending: false, error });
      });

    return () => {
      active = false;
    };
  }, [client, organisationId]);

  return { ...state, organisationMissing: !organisationId };
}
