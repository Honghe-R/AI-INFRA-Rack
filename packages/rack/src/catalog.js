import { record, fail } from './input.js';

// Append-only reference data. A released model/technology version must never be
// edited or removed: stored plans pin it. Changes require a new version.
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const source = {
  kind: 'ASSUMED',
  reference: 'Local Rack course examples. Synthetic planning assumptions, not teacher exports or vendor specifications.',
};
const technology = (technologyId, name, slotType, declares) => ({
  technologyId, version: 1, name, slotType, status: 'DEMO', manufacturer: 'Generic example', source, declares,
});
const technologies = [
  technology('demo-chassis-1u', '1U chassis', 'chassis', { heightU: 1 }),
  technology('demo-chassis-2u', '2U chassis', 'chassis', { heightU: 2 }),
  technology('demo-chassis-4u', '4U GPU chassis', 'chassis', { heightU: 4 }),
  technology('demo-psu-1600', '1600 W power supply', 'power', { ratedOutputW: 1600 }),
  technology('demo-psu-2000', '2000 W power supply', 'power', { ratedOutputW: 2000 }),
  technology('demo-cpu-32', '32-core processor', 'processor', { cores: 32 }),
  technology('demo-gpu', 'Accelerator module', 'accelerator', { accelerators: 1 }),
  technology('demo-asic', 'Switch ASIC', 'switching', { ports: 32, portRateGbps: 400 }),
  technology('demo-nic', '400G network interface', 'attachment', { ports: 2, portRateGbps: 400 }),
  technology('demo-coldplate', 'Liquid cold plate', 'thermal', { ratedRemovalW: 3000 }),
  technology('demo-optical-core', 'Optical switching core', 'switching', { ports: 64 }),
];
const part = (technologyId, quantity = 1) => ({ technologyId, version: 1, quantity });
const model = (modelId, name, kind, chassis, demand, components, note) => ({
  modelId, version: 1, name, kind, status: 'DEMO', source,
  components: [part(chassis), ...components],
  // Only the chassis height is derived. Whole-device demands are explicitly
  // declared; PSU output and cold-plate ratings are not consumption forecasts.
  specification: {
    heightU: technologies.find((t) => t.technologyId === chassis).declares.heightU,
    weightKg: demand[0], powerKw: demand[1], coolingKw: demand[2],
  },
  fieldSources: {
    heightU: `${chassis}@1:heightU`,
    weightKg: demand[0] === null ? 'UNKNOWN' : 'WHOLE_DEVICE_ASSUMPTION',
    powerKw: demand[1] === null ? 'UNKNOWN' : 'WHOLE_DEVICE_ASSUMPTION',
    coolingKw: demand[2] === null ? 'UNKNOWN' : 'WHOLE_DEVICE_ASSUMPTION',
  },
  note,
});
const models = [
  model('demo-gpu-4u', 'GPU server · 4U', 'SERVER', 'demo-chassis-4u', [80, 3, 3],
    [part('demo-cpu-32', 2), part('demo-gpu', 8), part('demo-psu-2000', 2), part('demo-nic', 2), part('demo-coldplate')],
    'Eight illustrative accelerators. The 3 kW demands are independent whole-device assumptions.'),
  model('demo-compute-2u', 'Compute server · 2U', 'SERVER', 'demo-chassis-2u', [25, 0.8, 0.8],
    [part('demo-cpu-32', 2), part('demo-psu-1600', 2), part('demo-nic')],
    'Power-supply redundancy, rails and depth compatibility are not assessed.'),
  model('demo-tor-1u', 'ToR switch · 1U', 'SWITCH', 'demo-chassis-1u', [10, 0.3, 0.3],
    [part('demo-asic'), part('demo-psu-1600', 2)],
    'Port declarations describe the example composition; no Network topology is created.'),
  model('demo-optical-2u', 'Optical switch · 2U', 'SWITCH', 'demo-chassis-2u', [18, 0.2, null],
    [part('demo-optical-core'), part('demo-psu-1600')],
    'Cooling demand is unknown. A cold-plate or PSU rating cannot fill this gap.'),
  model('demo-unspecified-1u', 'Unspecified appliance · 1U', 'APPLIANCE', 'demo-chassis-1u', [null, null, null],
    [], 'Only U height is known; all resource demands remain unknown.'),
];
const catalog = freeze({
  contractVersion: 1, catalogRevision: 'rack-demo-catalog-v1', source, technologies, models,
  scope: 'Read-only local demonstration catalog; no teacher synchronization, approval workflow or global hardware asset identity.',
});
const byKey = new Map(models.map((m) => [`${m.modelId}@${m.version}`, m]));
export const CATALOG_SPEC_FIELDS = freeze(['heightU', 'weightKg', 'powerKw', 'coolingKw']);
export function getRackCatalog() { return catalog; }
export function resolveCatalogReference(ref) {
  record(ref, 'device.catalogRef', new Set(['modelId', 'version']));
  if (typeof ref.modelId !== 'string' || !Number.isSafeInteger(ref.version) || ref.version < 1)
    fail('device.catalogRef', 'requires an exact modelId and positive integer version');
  const found = byKey.get(`${ref.modelId}@${ref.version}`);
  if (!found) fail('device.catalogRef', 'unknown model version; no automatic fallback to latest');
  return found;
}
export function assertCatalogDevice(device) {
  const model = resolveCatalogReference(device.catalogRef);
  for (const field of CATALOG_SPEC_FIELDS) {
    if (device[field] !== model.specification[field])
      fail(`device.${field}`, 'must match the pinned catalog model; detach it to declare custom assumptions');
  }
  return freeze({ modelId: model.modelId, version: model.version });
}
