import { useCallback, useEffect, useState } from 'react';

/**
 * The facility graph for one revision (backend-api-contracts.md, `facility.read`).
 *
 * The canvas needs the geometry to draw and the containers to name it, so both
 * come from the one normalized read. A failed read is not fatal — the basemap and
 * its plan-only grid still render — but it is reported, because an empty map and
 * a graph that could not be read are different states.
 *
 * `capabilityCoverage` is deliberately not interpreted here. T4 derives it, and
 * an unvalidated draft returns an empty list; treating that as a positive verdict
 * is exactly the degrade-the-verdict mistake the porting decisions forbid.
 */
export function useFacilityEnvelope({ client, projectId = null, revisionId = null, enabled = true } = {}) {
  const active = Boolean(client && projectId && revisionId && enabled);
  const [state, setState] = useState({ envelope: null, pending: active, error: null });

  const load = useCallback(async () => {
    if (!active) {
      setState({ envelope: null, pending: false, error: null });
      return null;
    }
    setState((current) => ({ ...current, pending: true, error: null }));
    try {
      const { data } = await client.getFacilityEnvelope(projectId, revisionId);
      setState({ envelope: data ?? null, pending: false, error: null });
      return data ?? null;
    } catch (error) {
      setState({ envelope: null, pending: false, error });
      return null;
    }
  }, [client, projectId, revisionId, active]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    envelope: state.envelope,
    // Named for what the canvas draws; the rest of the envelope is available as
    // the surfaces grow into it (hierarchy, utilities, findings).
    features: state.envelope?.geometryRecords ?? [],
    containers: state.envelope?.designContext?.containers ?? [],
    scopes: state.envelope?.designContext?.scopes ?? [],
    utilitySources: state.envelope?.utilitySources ?? [],
    utilityInterfaces: state.envelope?.utilityInterfaces ?? [],
    spatialConstraints: state.envelope?.spatialConstraints ?? [],
    capabilityCoverage: state.envelope?.capabilityCoverage ?? [],
    pending: state.pending,
    error: state.error,
    reload: load,
  };
}
