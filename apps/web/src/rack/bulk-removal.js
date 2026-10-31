/** Draft-only transformations; the ordinary checked save remains authoritative. */
export function bulkRemoval({ kind, ids, placements, equipment, savedPlacements = placements }) {
  if (!['racks', 'devices'].includes(kind)) throw new Error('Unsupported removal type.');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw new Error('Select one or more distinct items.');
  const selected = new Set(ids);
  const items = kind === 'racks' ? placements : equipment.devices;
  const key = kind === 'racks' ? 'rackId' : 'deviceId';
  if (items.filter(item => selected.has(item[key])).length !== ids.length)
    throw new Error('The selected items changed. Select them again.');
  if (kind === 'devices') return {
    placements,
    equipment: { ...equipment, devices: equipment.devices.filter(d => !selected.has(d.deviceId)) },
    removedCount: ids.length, unassignedCount: 0,
  };
  if ([...placements, ...savedPlacements].some(r => selected.has(r.rackId) && r.locked))
    throw new Error('Unlock and save locked racks before removing them.');
  let unassignedCount = 0;
  const devices = equipment.devices.map(d => {
    if (!selected.has(d.rackId)) return d;
    unassignedCount++;
    return { ...d, rackId: null, startU: null };
  });
  return {
    placements: placements.filter(r => !selected.has(r.rackId)),
    equipment: { ...equipment, devices, rackLimits: equipment.rackLimits.filter(l => !selected.has(l.rackId)) },
    removedCount: ids.length, unassignedCount,
  };
}

export function removalItems(kind, placements, equipment, savedPlacements = placements) {
  const racks = new Map(placements.map(r => [r.rackId, r]));
  if (kind === 'devices') return equipment.devices.map(d => ({
    id: d.deviceId, name: d.name, rackId: d.rackId, blocked: false,
    detail: `${d.rackId === null ? 'Unassigned' : racks.get(d.rackId)?.name ?? 'Missing rack'} · ${d.heightU} U`,
    search: `${d.name} ${d.deviceId} ${d.catalogRef?.modelId ?? ''} ${racks.get(d.rackId)?.name ?? 'Unassigned'}`.toLowerCase(),
  }));
  const locked = new Set(savedPlacements.filter(r => r.locked).map(r => r.rackId));
  const counts = new Map();
  for (const d of equipment.devices) if (d.rackId !== null) counts.set(d.rackId, (counts.get(d.rackId) ?? 0) + 1);
  return placements.map(r => ({
    id: r.rackId, name: r.name, blocked: Boolean(r.locked || locked.has(r.rackId)),
    detail: `${counts.get(r.rackId) ?? 0} devices${r.locked || locked.has(r.rackId) ? ' · Locked' : ''}`,
    search: `${r.name} ${r.rackId}`.toLowerCase(),
  }));
}

export function filterRemovalItems(items, kind, query = '', filter = 'all') {
  const term = query.trim().toLowerCase();
  return items.filter(item => (!term || item.search.includes(term)) &&
    (filter === 'all' || (kind === 'racks' ? !item.blocked :
      filter === 'unassigned' ? item.rackId === null : item.rackId === filter)));
}
