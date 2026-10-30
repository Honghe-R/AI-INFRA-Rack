import { record, fail, text, uuid } from './input.js';
import { assertCatalogDevice } from './catalog.js';
import { normalizeRoomBudget, checkRoomBudget } from './room-budget.js';
import { MAX_EQUIPMENT_DEVICES, MAX_EQUIPMENT_RACK_LIMITS } from './limits.js';

export const EMPTY_EQUIPMENT = Object.freeze({
  coverage: 'UNKNOWN',
  source: Object.freeze({
    kind: 'ASSUMED',
    reference: 'Equipment planning inputs not recorded.',
  }),
  devices: Object.freeze([]),
  rackLimits: Object.freeze([]),
});
export const CAPACITY_DIMENSIONS = Object.freeze([
  ['weightKg', 'maxWeightKg', 'kg'],
  ['powerKw', 'maxPowerKw', 'kW'],
  ['coolingKw', 'maxCoolingKw', 'kW'],
]);
function integer(value, field, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    fail(field, `must be an integer from 1 to ${max}`);
  return value;
}
function quantity(value, field) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000)
    fail(field, 'must be null (unknown), or a finite number from 0 to 1000000');
  return value;
}

/** Plan-local inventory, never a claim about a global physical asset registry. */
export function normalizeEquipment(input, placements) {
  record(input, 'equipment', new Set(['coverage', 'source', 'devices', 'rackLimits', 'roomBudget']));
  if (!['UNKNOWN', 'DECLARED_COMPLETE'].includes(input.coverage))
    fail('equipment.coverage', 'must be UNKNOWN or DECLARED_COMPLETE');
  record(input.source, 'equipment.source', new Set(['kind', 'reference']));
  if (input.source.kind !== 'ASSUMED') fail('equipment.source.kind', 'must be ASSUMED');
  const source = Object.freeze({
    kind: 'ASSUMED',
    reference: text(input.source.reference, 'equipment.source.reference', 512),
  });
  if (!Array.isArray(input.devices) || input.devices.length > MAX_EQUIPMENT_DEVICES)
    fail('equipment.devices', `must be an array of at most ${MAX_EQUIPMENT_DEVICES} devices`);
  if (!Array.isArray(input.rackLimits) || input.rackLimits.length > MAX_EQUIPMENT_RACK_LIMITS)
    fail('equipment.rackLimits', `must be an array of at most ${MAX_EQUIPMENT_RACK_LIMITS} rack limits`);
  const racks = new Set(placements.map((p) => p.rackId));
  const ids = new Set();
  const devices = Array.from(input.devices, (d) => {
    record(
      d,
      'device',
      new Set(['deviceId', 'name', 'heightU', 'weightKg', 'powerKw', 'coolingKw', 'rackId', 'startU', 'catalogRef']),
    );
    const deviceId = uuid(d.deviceId, 'deviceId');
    if (ids.has(deviceId)) fail('deviceId', 'must be unique within this plan inventory');
    ids.add(deviceId);
    const rackId = d.rackId === null ? null : uuid(d.rackId, 'device.rackId');
    if (rackId && !racks.has(rackId))
      fail('device.rackId', 'must reference a rack in this layout; unassign devices before deleting a rack');
    if (rackId === null && d.startU !== null) fail('device.startU', 'must be null for an unassigned device');
    return Object.freeze({
      deviceId,
      name: text(d.name, 'device.name'),
      heightU: integer(d.heightU, 'device.heightU', 100),
      weightKg: quantity(d.weightKg, 'device.weightKg'),
      powerKw: quantity(d.powerKw, 'device.powerKw'),
      coolingKw: quantity(d.coolingKw, 'device.coolingKw'),
      ...(Object.hasOwn(d, 'catalogRef') ? { catalogRef: assertCatalogDevice(d) } : {}),
      rackId,
      startU: rackId === null ? null : integer(d.startU, 'device.startU', 10000),
    });
  });
  const limitIds = new Set();
  const rackLimits = Array.from(input.rackLimits, (l) => {
    record(l, 'rackLimit', new Set(['rackId', 'maxWeightKg', 'maxPowerKw', 'maxCoolingKw']));
    const rackId = uuid(l.rackId, 'rackLimit.rackId');
    if (!racks.has(rackId))
      fail(
        'rackLimit.rackId',
        'must reference a rack in this layout; remove its limit before deleting a rack',
      );
    if (limitIds.has(rackId)) fail('rackLimit.rackId', 'must be unique');
    limitIds.add(rackId);
    return Object.freeze({
      rackId,
      ...Object.fromEntries(CAPACITY_DIMENSIONS.map(([, key]) => [key, quantity(l[key], key)])),
    });
  });
  return Object.freeze({
    coverage: input.coverage,
    source,
    devices: Object.freeze(devices),
    rackLimits: Object.freeze(rackLimits),
    ...(Object.hasOwn(input, 'roomBudget') ? { roomBudget: normalizeRoomBudget(input.roomBudget) } : {}),
  });
}

/** Caller supplies normalized layout/model catalog; report is derived, never persisted as validation. */
export function checkEquipment(equipment, placements, models) {
  const diagnostics = [];
  const add = (code, rackId, deviceIds, message, evidence = {}) =>
    diagnostics.push({
      code,
      severity: 'ERROR',
      rackId,
      deviceIds,
      message,
      ...evidence,
    });
  const byRack = new Map(placements.map((p) => [p.rackId, []]));
  for (const device of equipment.devices) if (device.rackId) byRack.get(device.rackId).push(device);
  const catalog = new Map(models.map((m) => [m.modelId, m]));
  const limitsByRack = new Map(equipment.rackLimits.map((l) => [l.rackId, l]));
  const racks = placements.map((p) => {
    const model = catalog.get(p.modelId);
    if (!model) fail('modelId', 'must reference the server catalog');
    const devices = byRack.get(p.rackId);
    const slots = new Set();
    const outside = devices.filter((d) => d.startU + d.heightU - 1 > model.heightU);
    for (const d of outside)
      add('DEVICE_U_OUT_OF_BOUNDS', p.rackId, [d.deviceId], 'Device exceeds the rack U range.', {
        startU: d.startU,
        endU: d.startU + d.heightU - 1,
        heightU: model.heightU,
      });
    let overlaps = 0;
    for (let i = 0; i < devices.length; i++) {
      const a = devices[i],
        end = a.startU + a.heightU - 1;
      for (let u = a.startU; u <= Math.min(end, model.heightU); u++) slots.add(u);
      for (let j = i + 1; j < devices.length; j++) {
        const b = devices[j];
        if (a.startU <= b.startU + b.heightU - 1 && b.startU <= end) {
          overlaps++;
          add('DEVICE_U_OVERLAP', p.rackId, [a.deviceId, b.deviceId], 'Devices occupy the same U positions.');
        }
      }
    }
    const limits = limitsByRack.get(p.rackId);
    const capacities = Object.fromEntries(
      CAPACITY_DIMENSIONS.map(([key, maxKey, unit]) => {
        // Compensated summation plus four machine epsilons handles binary addition
        // such as 0.1 + 0.2 at a 0.3 limit; this is not an engineering allowance.
        let knownSubtotal = 0,
          correction = 0;
        for (const d of devices) {
          const y = (d[key] ?? 0) - correction,
            t = knownSubtotal + y;
          correction = t - knownSubtotal - y;
          knownSubtotal = t;
        }
        const unknownDevices = devices.filter((d) => d[key] === null).length;
        const limit = limits ? limits[maxKey] : (model[maxKey] ?? null);
        const exceeds =
          limit !== null && knownSubtotal - limit > 4 * Number.EPSILON * Math.max(knownSubtotal, limit);
        const status = exceeds ? 'EXCEEDED' : unknownDevices || limit === null ? 'UNKNOWN' : 'WITHIN_LIMIT';
        if (status === 'EXCEEDED')
          add(
            'RACK_CAPACITY_EXCEEDED',
            p.rackId,
            devices.map((d) => d.deviceId),
            `${key} known subtotal exceeds the declared limit.`,
            { dimension: key, knownSubtotal, limit, unit },
          );
        return [
          key,
          {
            unit,
            knownSubtotal,
            total: unknownDevices ? null : knownSubtotal,
            unknownDevices,
            limit,
            status,
            limitSource: limits ? 'PLAN_ASSUMPTION' : 'MODEL',
          },
        ];
      }),
    );
    return {
      rackId: p.rackId,
      heightU: model.heightU,
      devicesInstalled: devices.length,
      requestedU: devices.reduce((sum, d) => sum + d.heightU, 0),
      occupiedU: slots.size,
      freeU: model.heightU - slots.size,
      uStatus: outside.length || overlaps ? 'ISSUES_FOUND' : 'CHECKED_SCOPE_CLEAR',
      capacities,
    };
  });
  const unassignedDeviceIds = equipment.devices.filter((d) => d.rackId === null).map((d) => d.deviceId);
  const roomCapacity = checkRoomBudget(equipment);
  diagnostics.push(...roomCapacity.diagnostics);
  const unknown = racks.some((r) => Object.values(r.capacities).some((c) => c.status === 'UNKNOWN'));
  return {
    status: diagnostics.length
      ? 'ISSUES_FOUND'
      : !equipment.devices.length
        ? 'NOT_CHECKED'
        : equipment.coverage === 'UNKNOWN' || unassignedDeviceIds.length || unknown || (equipment.roomBudget && roomCapacity.status === 'INCOMPLETE')
          ? 'INCOMPLETE'
          : 'CHECKED_SCOPE_CLEAR',
    coverage: equipment.coverage,
    planningSource: equipment.source,
    devicesChecked: equipment.devices.length,
    installedDevices: equipment.devices.length - unassignedDeviceIds.length,
    unassignedDeviceIds,
    roomCapacity,
    racks,
    diagnostics,
    uncheckedRules: [
      ...(!equipment.roomBudget ? ['ROOM_POWER_COOLING_BUDGET'] : []),
      'GLOBAL_ASSET_IDENTITY',
      'DEPTH_RAIL_COMPATIBILITY',
      'POWER_FEEDS_REDUNDANCY',
      'AIRFLOW_THERMAL_MODEL',
      'FLOOR_LOAD',
      'ENGINEERING_ACCURACY',
    ],
  };
}
