// Shared synthetic inputs for the CLI demonstration and local visual preview.
import { readFile } from 'node:fs/promises';

const room = JSON.parse(await readFile(new URL('./rectangular-room.json', import.meta.url), 'utf8'));
const { model, placement } = JSON.parse(await readFile(new URL('./basic-rack.json', import.meta.url), 'utf8'));
const rackId = number => `abcdefab-0000-4000-8000-${String(number).padStart(12, '0')}`;
function base() {
  return {
    projectId: placement.projectId,
    planId: placement.planId,
    room: structuredClone(room),
    models: [{ ...structuredClone(model), name: 'Synthetic 1m test footprint', widthM: 1, depthM: 1 }],
    placementCoverage: 'COMPLETE',
    placements: [
      { ...placement, rackId: rackId(1), name: 'Rack A01', xM: 2, yM: 3 },
      { ...placement, rackId: rackId(2), name: 'Rack A02', xM: 6, yM: 3 },
    ],
  };
}

export function createLayoutScenarios() {
  const clear = base();
  const overlap = base();
  overlap.placements[1].xM = 2.5;
  const touching = base();
  touching.placements[1].xM = 3;
  const mixed = base();
  mixed.placements[0].xM = 0;
  mixed.placements[1].xM = 4.5;
  mixed.placements.push({ ...mixed.placements[1], rackId: rackId(3), name: 'Rack A03', xM: 4.8 });
  const partial = base();
  partial.placementCoverage = 'UNKNOWN';
  const empty = { ...base(), placements: [] };
  return [
    ['clear_known_scope', clear], ['rack_overlap', overlap], ['edge_contact', touching],
    ['mixed_findings', mixed], ['unknown_rack_inventory', partial], ['empty_inventory', empty],
  ];
}
