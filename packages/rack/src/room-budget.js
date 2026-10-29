import { record, fail, text } from './input.js';

export const ROOM_BUDGET_DIMENSIONS = Object.freeze([
  ['powerKw', 'maxPowerKw', 'kW'], ['coolingKw', 'maxCoolingKw', 'kW'],
]);
export function normalizeRoomBudget(input) {
  if (input === null) return null;
  record(input, 'roomBudget', new Set(['source', 'maxPowerKw', 'maxCoolingKw']));
  record(input.source, 'roomBudget.source', new Set(['kind', 'reference']));
  if (input.source.kind !== 'ASSUMED') fail('roomBudget.source.kind', 'must be ASSUMED; Facility budgets are not imported');
  const limits = {};
  for (const [, key] of ROOM_BUDGET_DIMENSIONS) {
    const n = input[key];
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000000))
      fail(`roomBudget.${key}`, 'must be null (unknown) or a finite number from 0 to 1000000');
    limits[key] = n;
  }
  return Object.freeze({ ...limits, source: Object.freeze({ kind: 'ASSUMED', reference: text(input.source.reference, 'roomBudget.source.reference', 512) }) });
}
export function resourceDemand(devices, key) {
  let knownSubtotal = 0, correction = 0;
  for (const d of devices) {
    const y = (d[key] ?? 0) - correction, t = knownSubtotal + y;
    correction = t - knownSubtotal - y; knownSubtotal = t;
  }
  const unknownDevices = devices.filter(d => d[key] === null).length;
  return { knownSubtotal, total: unknownDevices ? null : knownSubtotal, unknownDevices };
}
export function exceedsResource(total, limit) {
  return limit !== null && total - limit > 4 * Number.EPSILON * Math.max(total, limit);
}
/** This one Rack plan's installed device demand only. Never a shared Facility
 * allocation, floor load, PUE, electrical feed or thermal feasibility check. */
export function checkRoomBudget(equipment) {
  const budget = equipment.roomBudget ?? null;
  const installed = equipment.devices.filter(d => d.rackId !== null);
  const inventory = equipment.devices;
  const resources = Object.fromEntries(ROOM_BUDGET_DIMENSIONS.map(([key, maxKey, unit]) => {
    const demand = resourceDemand(installed, key), all = resourceDemand(inventory, key);
    const limit = budget ? budget[maxKey] : null;
    return [key, { unit, ...demand, limit,
      remaining: limit === null || demand.total === null ? null : limit - demand.total,
      status: exceedsResource(demand.knownSubtotal, limit) ? 'EXCEEDED' : demand.unknownDevices || limit === null ? 'UNKNOWN' : 'WITHIN_LIMIT',
      inventory: all, inventoryExceedsLimit: exceedsResource(all.knownSubtotal, limit),
    }];
  }));
  const diagnostics = Object.entries(resources).filter(([, r]) => r.status === 'EXCEEDED').map(([dimension, r]) => ({
    code: 'ROOM_BUDGET_EXCEEDED', ruleId: 'rack.capacity.room_budget', severity: 'ERROR', rackId: null,
    deviceIds: installed.map(d => d.deviceId), dimension, knownSubtotal: r.knownSubtotal, limit: r.limit, unit: r.unit,
    message: `Installed ${dimension} known subtotal exceeds this plan's assumed room budget.`,
  }));
  return { scope: 'PLAN_INSTALLED_DEVICE_DEMAND', budgetState: budget ? 'PLAN_ASSUMPTION' : 'NOT_RECORDED',
    source: budget?.source ?? null, installedDevices: installed.length, inventoryDevices: inventory.length,
    unassignedDevices: inventory.length - installed.length, coverage: equipment.coverage,
    status: diagnostics.length ? 'ISSUES_FOUND' : !budget || equipment.coverage === 'UNKNOWN' || Object.values(resources).some(r => r.status === 'UNKNOWN') ? 'INCOMPLETE' : 'CHECKED_SCOPE_CLEAR',
    resources, diagnostics,
    uncheckedRules: ['OTHER_PLANS_SHARED_ROOM', 'FACILITY_BUDGET_AUTHORITY', 'RACK_IDLE_POWER', 'POWER_FEEDS_REDUNDANCY', 'AIRFLOW_THERMAL_MODEL', 'FLOOR_LOAD'],
  };
}
