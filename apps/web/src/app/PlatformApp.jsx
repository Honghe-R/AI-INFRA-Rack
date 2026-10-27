import { useEffect, useMemo, useState } from 'react';
import { App } from '../App.jsx';
import { createApiClient } from '../api/client.js';
import { useProjects } from '../api/useProjects.js';
import { currentDevIdentity, resolveDevOrganisation } from './dev-identity.js';

/**
 * The data-connected root.
 *
 * `App` stays a pure presentational tree so it can be rendered in tests without a
 * network; this container supplies the live project list and the scenario read that
 * turns a clicked project into a workspace context. The active organisation is a
 * session fact — the specification's information architecture has no organisation
 * selector — so when none is resolved the shell says so instead of showing an empty
 * list that looks like "no projects".
 *
 * In development the session can act as an identity in a second organisation, so the
 * organisation follows the identity: the dev server declares which organisation an
 * identity belongs to, and the default identity (nothing chosen) keeps the organisation
 * the build was configured with. A production build has no such endpoint, resolves
 * nothing, and uses the configured organisation unchanged.
 */
export function PlatformApp({ client, organisationId: configuredOrganisationId = null, ...rest }) {
  const api = useMemo(() => client ?? createApiClient(), [client]);

  // A chosen identity may belong to another organisation, so its organisation is not
  // known until the dev server has been asked. Nothing chosen is the default identity,
  // whose organisation is the configured one — resolving it would be a round trip to
  // learn what the build already knows.
  const [chosenIdentity] = useState(() => currentDevIdentity());
  const [organisationId, setOrganisationId] = useState(() =>
    (chosenIdentity ? null : configuredOrganisationId));
  const [resolving, setResolving] = useState(Boolean(chosenIdentity));

  useEffect(() => {
    if (!chosenIdentity) return undefined;
    let active = true;
    resolveDevOrganisation({ fallback: configuredOrganisationId }).then((resolved) => {
      if (!active) return;
      setOrganisationId(resolved ?? null);
      setResolving(false);
    });
    return () => {
      active = false;
    };
  }, [chosenIdentity, configuredOrganisationId]);

  const { projects, pending, error, organisationMissing } = useProjects({ client: api, organisationId });

  return (
    <App
      projects={projects}
      projectsPending={pending}
      projectsError={error}
      projectsNotice={noticeFor({ resolving, organisationMissing })}
      loadProjectScenarios={api.listScenarios}
      assetClient={api}
      {...rest}
    />
  );
}

function noticeFor({ resolving, organisationMissing }) {
  if (resolving) return 'Resolving the organisation for the selected identity…';
  if (organisationMissing) return 'No organisation is selected for this session, so projects cannot be listed.';
  return null;
}
