import { normalizeEquipment, checkEquipment, CAPACITY_DIMENSIONS } from './equipment.js';
import { fail } from './input.js';

export const ALLOCATION_LIMITS = Object.freeze({ unassignedDevices: 128, eligibleRacks: 64, rackHeightU: 100 });
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function subtotal(devices, key) {
  let sum = 0, correction = 0;
  for (const d of devices) { const y = d[key] - correction, t = sum + y; correction = t - sum - y; sum = t; }
  return sum;
}
function firstGap(devices, height, required) {
  const occupied = new Set();
  for (const d of devices) for (let u = d.startU; u < d.startU + d.heightU; u++) occupied.add(u);
  let run = 0;
  for (let u = 1; u <= height; u++) { run = occupied.has(u) ? 0 : run + 1; if (run === required) return u - required + 1; }
  return null;
}

/** First-fit decreasing for unassigned devices only. Preserves all installed
 * devices and every rack position; locked racks are excluded as target racks. */
export function allocateUnassignedEquipment({ equipment: input, placements, models }) {
  const equipment = normalizeEquipment(input, placements);
  const baseline = checkEquipment(equipment, placements, models);
  if (baseline.racks.some(r => !Number.isSafeInteger(r.heightU) || r.heightU < 1 || r.heightU > ALLOCATION_LIMITS.rackHeightU))
    fail('models.heightU', 'automatic allocation supports rack heights from 1 to 100 U');
  if (baseline.diagnostics.length) fail('equipment', 'resolve existing U-slot and capacity errors before automatic allocation');
  const pending = equipment.devices.filter(d => d.rackId === null).sort((a,b) => b.heightU - a.heightU || lexical(a.deviceId,b.deviceId));
  const racks = placements.filter(p => !p.locked).sort((a,b) => lexical(a.rackId,b.rackId));
  if (pending.length > ALLOCATION_LIMITS.unassignedDevices) fail('equipment.devices', 'automatic allocation supports at most 128 unassigned devices');
  if (racks.length > ALLOCATION_LIMITS.eligibleRacks) fail('placements', 'automatic allocation supports at most 64 unlocked target racks');
  const next = equipment.devices.map(d => ({ ...d }));
  const byId = new Map(next.map(d => [d.deviceId,d]));
  const states = racks.map(r => ({ rack: r, report: baseline.racks.find(s => s.rackId === r.rackId),
    devices: next.filter(d => d.rackId === r.rackId) }));
  const assignments = [], unassigned = [];
  for (const original of pending) {
    const device = byId.get(original.deviceId);
    const unknownDimensions = CAPACITY_DIMENSIONS.filter(([k]) => device[k] === null).map(([k]) => k);
    if (unknownDimensions.length) {
      unassigned.push({ deviceId: device.deviceId, code: 'UNKNOWN_DEVICE_RESOURCE', unknownDimensions }); continue;
    }
    let chosen = null;
    const rejectionCounts = {};
    const reject = code => { rejectionCounts[code] = (rejectionCounts[code] ?? 0) + 1; };
    for (const state of states) {
      const startU = firstGap(state.devices, state.report.heightU, device.heightU);
      if (startU === null) { reject('NO_CONTIGUOUS_U'); continue; }
      let reason = null;
      for (const [key] of CAPACITY_DIMENSIONS) {
        const resource = state.report.capacities[key];
        if (resource.limit === null || state.devices.some(d => d[key] === null)) { reason = 'UNKNOWN_RACK_CAPACITY'; break; }
        const total = subtotal([...state.devices, device], key);
        if (total - resource.limit > 4 * Number.EPSILON * Math.max(total,resource.limit)) { reason = 'CAPACITY_EXCEEDED'; break; }
      }
      if (reason) { reject(reason); continue; }
      chosen = { state, startU }; break;
    }
    if (!chosen) { unassigned.push({ deviceId: device.deviceId, code: states.length ? 'NO_ELIGIBLE_POSITION' : 'NO_UNLOCKED_RACK', rejectionCounts }); continue; }
    device.rackId = chosen.state.rack.rackId; device.startU = chosen.startU; chosen.state.devices.push(device);
    assignments.push({ deviceId: device.deviceId, rackId: device.rackId, startU: device.startU, endU: device.startU + device.heightU - 1 });
  }
  const output = normalizeEquipment({ ...equipment, devices: next }, placements);
  const report = checkEquipment(output, placements, models);
  if (report.diagnostics.length) fail('equipment', 'generated allocation failed the shared equipment checker');
  return { algorithmId: 'unassigned-first-fit-decreasing-v1', equipment: output, assignments, unassigned,
    baseline, equipmentReport: report, limits: ALLOCATION_LIMITS, scope: 'UNASSIGNED_DEVICES_ONLY',
    metrics: { attemptedDevices: pending.length, assignedDevices: assignments.length, remainingUnassigned: unassigned.length,
      eligibleRacks: racks.length, excludedLockedRacks: placements.filter(p => p.locked).length } };
}
