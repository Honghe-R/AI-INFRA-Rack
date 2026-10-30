import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { normalizeEquipment } from '@ai-infra/rack';
import { hallDemoId, createHallDemoBody } from './rack-hall-demo.mjs';

export const LARGE_HALL_DEMO_NAME = 'Large Hall Demo · 128 Racks / 8 Equipment Rows';
export const LARGE_HALL_BUDGET_KW = 966;

/** Exact round32 fixture, retained only to recognize an unedited upgrade source. */
export function createSparseLargeHallDemoBody(layout, catalog, seed) {
  const { width, height } = layout.snapshot.view.extentM;
  assert.ok(width >= 40 && height >= 40, 'This example needs at least a 40 × 40 m extent; the API checks Polygon feasibility.');
  const small = layout.models.find(m => m.widthM === .6 && m.depthM === 1.2 && m.heightU === 42);
  const wide = layout.models.find(m => m.widthM === .8 && m.depthM === 1.2 && m.heightU === 42);
  assert.ok(small && wide, 'Expected the local synthetic 42U rack models.');
  const id = label => hallDemoId(`${seed}:large-128-v1`, label);
  const cx = width / 2, cy = height / 2;
  const xs = Array.from({ length: 16 }, (_, col) => col < 8 ? -8.9 + col : 1.9 + col - 8);
  const ys = [-11.7, -8.1, -5.1, -1.5, 1.5, 5.1, 8.1, 11.7];
  const placements = Array.from({ length: 128 }, (_, i) => {
    const row = Math.floor(i / 16);
    const name = `${'ABCDEFGH'[row]}${String(i % 16 + 1).padStart(2, '0')}`;
    return { rackId: id(name), name, modelId: row % 2 ? small.modelId : wide.modelId,
      xM: cx + xs[i % 16], yM: cy + ys[row], rotationDeg: row % 2 ? 0 : 180, locked: row < 6 };
  });
  const gpu = 'demo-gpu-4u', cpu = 'demo-compute-2u', tor = 'demo-tor-1u';
  const profiles = [[gpu, tor, tor], [cpu, cpu, tor], [gpu, cpu, tor], [tor, tor, tor]];
  function fromModel(key, label, rackId = null, startU = null) {
    const model = catalog.models.find(m => m.modelId === key && m.version === 1);
    assert.ok(model, `Missing pinned model ${key}@1`);
    return { deviceId: id(label), name: label, ...model.specification,
      catalogRef: { modelId: model.modelId, version: model.version }, rackId, startU };
  }
  const devices = placements.flatMap((rack, i) => {
    let startU = 1;
    return profiles[Math.floor(i / 16) % 4].map((key, j) => {
      const label = `${rack.name} · ${key === gpu ? 'GPU Server' : key === cpu ? 'Compute Server' : 'Switch'} ${j + 1}`;
      const device = fromModel(key, label, rack.rackId, startU);
      startU += device.heightU;
      return device;
    });
  });
  devices.push(...Array.from({ length: 2 }, (_, i) => fromModel(gpu, `Unassigned · GPU Server ${i + 1}`)),
    ...Array.from({ length: 4 }, (_, i) => fromModel(cpu, `Unassigned · Compute Server ${i + 1}`)),
    { deviceId: id('oversized'), name: 'Unassigned · Oversized 100U Device (Rejection Example)',
      heightU: 100, weightKg: 10, powerKw: 1, coolingKw: 1, rackId: null, startU: null },
    fromModel('demo-unspecified-1u', 'Unassigned · Device with Unknown Specifications'));
  const obstacle = (key, name, x, y, w, d) => ({ obstacleId: id(key), name,
    xM: cx + x, yM: cy + y, widthM: w, depthM: d });
  return { contract_version: 1, snapshot_id: layout.snapshot.snapshotId, placements,
    constraints: { obstacleCoverage: 'UNKNOWN',
      source: { kind: 'ASSUMED', reference: 'Synthetic 8-row hall: GPU, compute, mixed and network rows repeated twice. Reservations are exclusions, not certified connected access paths. Actual Facility obstacles remain unknown.' },
      clearance: { frontM: 1, rearM: .6 }, obstacles: [
        obstacle('main-aisle', 'Main Aisle Reservation', 0, 0, 1.6, 29),
        obstacle('south-aisle', 'South Aisle Reservation', 0, -15, 22, 1.2),
        obstacle('north-aisle', 'North Aisle Reservation', 0, 15, 22, 1.2),
        obstacle('service-area', 'Equipment Staging Area', 12, 0, 2, 4),
      ] },
    equipment: { coverage: 'DECLARED_COMPLETE',
      source: { kind: 'ASSUMED', reference: 'Synthetic teaching scenario: 128 partially populated 42U racks, 384 installed and 8 unassigned devices. Demo specifications only; these are not fully loaded production racks.' },
      roomBudget: { maxPowerKw: 342, maxCoolingKw: 342,
        source: { kind: 'ASSUMED', reference: 'Synthetic installed-device budget: 336 kW baseline plus 6 kW margin. Excludes idle power, shared Facility reservations and thermal certification.' } },
      devices, rackLimits: placements.map((rack, i) => ({ rackId: rack.rackId, maxWeightKg: 1000,
        maxPowerKw: [8, 5, 10, 4][Math.floor(i / 16) % 4], maxCoolingKw: [8, 5, 10, 4][Math.floor(i / 16) % 4] })) } };
}

/** Four times the original 32-rack inventory, with the larger room arrangement. */
export function createLargeHallDemoBody(layout, catalog, seed) {
  const body = createSparseLargeHallDemoBody(layout, catalog, seed);
  const original = createHallDemoBody(layout, catalog, `${seed}:density-template`);
  const id = label => hallDemoId(`${seed}:large-128-dense-v2`, label);
  const installed = body.placements.flatMap((rack, i) => {
    const row = Math.floor(i / 16), col = i % 16;
    const template = original.placements[(row % 4) * 8 + col % 8];
    return original.equipment.devices.filter(d => d.rackId === template.rackId).map(d => {
      const name = rack.name + d.name.slice(template.name.length);
      return { ...d, deviceId: id(name), name, rackId: rack.rackId };
    });
  });
  const rackLimits = body.placements.map((rack, i) => {
    const template = original.equipment.rackLimits[(Math.floor(i / 16) % 4) * 8 + i % 8];
    return { ...template, rackId: rack.rackId };
  });
  body.equipment = { ...body.equipment, devices: [...installed, ...body.equipment.devices.filter(d => d.rackId === null)], rackLimits,
    source: { kind: 'ASSUMED', reference: 'Synthetic teaching scenario: 128 racks, 944 installed and 8 unassigned devices; four times the original 32-rack equipment density with varied power utilization. Demo specifications only, not vendor or surveyed data.' },
    roomBudget: { maxPowerKw: LARGE_HALL_BUDGET_KW, maxCoolingKw: LARGE_HALL_BUDGET_KW,
      source: { kind: 'ASSUMED', reference: 'Synthetic installed-device budget: 960 kW baseline plus 6 kW margin. Excludes idle power, shared Facility reservations and thermal certification.' } } };
  return body;
}

function canonicalEquipment(equipment, placements) {
  const value = normalizeEquipment(equipment, placements);
  return { ...value, devices: [...value.devices].sort((a,b) => a.deviceId.localeCompare(b.deviceId)),
    rackLimits: [...value.rackLimits].sort((a,b) => a.rackId.localeCompare(b.rackId)) };
}

/** Explicit equipment-only upgrade: refuse edited inventories and unknown fixtures. */
export function prepareLargeHallEquipmentUpgrade(layout, catalog, seed) {
  const sparse = createSparseLargeHallDemoBody(layout, catalog, seed);
  const dense = createLargeHallDemoBody(layout, catalog, seed);
  const identity = racks => racks.map(({rackId, modelId, name}) => ({rackId, modelId, name})).sort((a,b) => a.rackId.localeCompare(b.rackId));
  assert.deepEqual(identity(layout.placements), identity(sparse.placements), 'Rack identities/models changed; refuse automatic demo upgrade.');
  const current = canonicalEquipment(layout.equipment, layout.placements);
  const changed = !isDeepStrictEqual(current, canonicalEquipment(dense.equipment, layout.placements));
  if (changed) assert.deepEqual(current, canonicalEquipment(sparse.equipment, layout.placements), 'Equipment was edited; refuse automatic replacement.');
  return { changed, body: { contract_version: 1, snapshot_id: layout.snapshot.snapshotId,
    placements: structuredClone(layout.placements), constraints: structuredClone(layout.constraints),
    equipment: changed ? dense.equipment : structuredClone(layout.equipment) } };
}
