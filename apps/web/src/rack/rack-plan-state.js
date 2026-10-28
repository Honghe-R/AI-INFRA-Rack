// Facility remains authoritative. This slice binds an identity and ETag only;
// it does not infer room dimensions from GeoJSON or a bounding box.
export function roomSource(envelope, context) {
  if (!envelope || envelope.projectId !== context.projectId || envelope.scenarioId !== context.scenarioId
    || envelope.revisionId !== context.revisionId) {
    return { rooms: [], ready: false, reason: 'The Facility source does not match this workspace.' };
  }
  const rooms = (envelope.designContext?.containers ?? []).filter(room => room.kind === 'HALL');
  const reason = envelope.lifecycleState !== 'DRAFT' ? 'Creating a plan currently requires a DRAFT Facility revision.'
    : !envelope.etag ? 'The Facility source has no version token.'
      : rooms.length === 0 ? 'No HALL is available in this Facility revision.' : null;
  return { rooms, ready: !reason, reason };
}

export function planIntent(draft, context, envelope, key) {
  const source = roomSource(envelope, context);
  if (!source.ready || !source.rooms.some(room => room.containerId === draft.hallId)) {
    throw new Error(source.reason ?? 'Choose a HALL from the current Facility revision.');
  }
  const name = draft.name.trim();
  if (!name || draft.name.length > 160) throw new Error('Enter a plan name of 1–160 characters.');
  return { key, body: {
    contract_version: 1, name, scenario_id: context.scenarioId,
    facility_input: { revision_id: context.revisionId, container_id: draft.hallId, revision_etag: envelope.etag },
  } };
}

export function samePlanScope(plan, context) {
  return plan.projectId === context.projectId && plan.scenarioId === context.scenarioId
    && plan.facilityInput?.revisionId === context.revisionId;
}

export function rackError(error) {
  const message = error?.code === 'RACK_SOURCE_STALE'
    ? 'Facility changed. Refresh the Facility source, review the HALL, then create again.'
    : error?.message ?? 'The request failed.';
  return `${message}${error?.correlationId ? ` (Reference: ${error.correlationId})` : ''}`;
}

// A proxy timeout or lost response may happen after the database committed.
export function uncertainCreation(error) {
  return !error?.status || error.status >= 500 || error.status === 408;
}
