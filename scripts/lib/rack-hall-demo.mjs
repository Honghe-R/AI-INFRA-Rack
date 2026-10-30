import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const HALL_DEMO_NAME = 'Full Hall Demo · 32 Racks / Mixed Equipment Rows';
export function hallDemoId(seed, label) {
  const h = createHash('sha256').update(`rack-hall-demo-v1:${seed}:${label}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** Synthetic plan inputs only; the ordinary API must check the actual Polygon. */
export function createHallDemoBody(layout, catalog, seed) {
  const { width, height } = layout.snapshot.view.extentM;
  assert.ok(width >= 40 && height >= 40, 'This example needs at least a 40 × 40 m extent; Polygon feasibility is checked by the server.');
  const small = layout.models.find(m => m.widthM === .6 && m.depthM === 1.2 && m.heightU === 42);
  const wide = layout.models.find(m => m.widthM === .8 && m.depthM === 1.2 && m.heightU === 42);
  assert.ok(small && wide, 'Expected the local synthetic 42U rack models.');
  const id = label => hallDemoId(seed, label), cx = width / 2, cy = height / 2;
  const xs = [-4.9,-3.9,-2.9,-1.9,1.9,2.9,3.9,4.9], ys = [-5.1,-1.5,1.5,5.1];
  const placements = Array.from({length:32}, (_, i) => {
    const row = Math.floor(i / 8), name = `${'ABCD'[row]}${String(i % 8 + 1).padStart(2,'0')}`;
    return { rackId: id(name), name, modelId: row % 2 === 0 ? wide.modelId : small.modelId,
      xM: cx + xs[i % 8], yM: cy + ys[row], rotationDeg: row % 2 === 0 ? 180 : 0, locked: row < 3 };
  });
  const gpu = 'demo-gpu-4u', cpu = 'demo-compute-2u', tor = 'demo-tor-1u';
  const profiles = [
    [gpu,gpu,gpu,tor], [...Array(10).fill(cpu),tor], [gpu,...Array(4).fill(cpu),tor],
  ];
  const lastRow = [Array(12).fill(tor),Array(12).fill(tor),
    [...Array(6).fill(cpu),tor,tor],[...Array(6).fill(cpu),tor,tor],
    [gpu,gpu,cpu,cpu,tor],[gpu,gpu,cpu,cpu,tor],
    [...Array(8).fill(cpu),tor],[...Array(8).fill(cpu),tor]];
  function fromModel(key, label, rackId = null, startU = null) {
    const m = catalog.models.find(m => m.modelId === key && m.version === 1);
    assert.ok(m, `Missing pinned model ${key}@1`);
    return { deviceId: id(label), name: label, ...m.specification,
      catalogRef: { modelId: m.modelId, version: m.version }, rackId, startU };
  }
  const devices = placements.flatMap((rack, i) => {
    const row = Math.floor(i / 8), profile = row === 3 ? lastRow[i % 8] : profiles[row];
    let startU = 1;
    return profile.map((key, j) => {
      const label = `${rack.name} · ${key === gpu ? 'GPU Server' : key === cpu ? 'Compute Server' : 'Switch'} ${String(j+1).padStart(2,'0')}`;
      const d = fromModel(key, label, rack.rackId, startU); startU += d.heightU; return d;
    });
  });
  devices.push(fromModel(gpu, 'Unassigned · GPU Server 01'), fromModel(gpu, 'Unassigned · GPU Server 02'),
    ...Array.from({length:4}, (_, i) => fromModel(cpu, `Unassigned · Compute Server ${i+1}`)),
    { deviceId: id('oversized'), name: 'Unassigned · Oversized 100U Device (Rejection Example)', heightU: 100, weightKg: 10, powerKw: 1, coolingKw: 1, rackId: null, startU: null },
    fromModel('demo-unspecified-1u', 'Unassigned · Device with Unknown Specifications'));
  const powerLimits = [12,12,12,12,10,10,12,12, ...Array(8).fill(10), ...Array(8).fill(8), 4,6,8,10,8,12,10,12];
  const obstacle = (key, name, x, y, w, d) => ({ obstacleId: id(key), name, xM: cx+x, yM: cy+y, widthM: w, depthM: d });
  return { contract_version: 1, snapshot_id: layout.snapshot.snapshotId, placements,
    constraints: { obstacleCoverage: 'UNKNOWN',
      source: { kind: 'ASSUMED', reference: 'Synthetic local hall: A GPU, B compute, C mixed, D network/inference. Reserved corridors are no-placement rectangles, not verified access/egress paths. Actual Facility obstacles are unknown.' },
      clearance: { frontM: 1, rearM: .6 }, obstacles: [
        obstacle('main-aisle','Main Aisle Reservation',0,0,1.6,14.4),
        obstacle('south-aisle','South Aisle Reservation',0,-8,13,1.2),
        obstacle('north-aisle','North Aisle Reservation',0,8,13,1.2),
        obstacle('service-area','Equipment Staging Area',8.5,0,2,4),
      ] },
    equipment: { coverage: 'DECLARED_COMPLETE',
      source: { kind: 'ASSUMED', reference: 'Synthetic teaching scenario: 32 racks, 236 installed and 8 unassigned devices; all specifications are demo assumptions, not vendor or surveyed data.' },
      roomBudget: { maxPowerKw: 246, maxCoolingKw: 246,
        source: { kind: 'ASSUMED', reference: 'Synthetic installed-device budget: 240 kW baseline, 6 kW remaining. No shared Facility reservation, other plans, idle power or thermal certification.' } },
      devices, rackLimits: placements.map((p,i) => ({ rackId: p.rackId, maxWeightKg: 1000, maxPowerKw: powerLimits[i], maxCoolingKw: powerLimits[i] })) } };
}
