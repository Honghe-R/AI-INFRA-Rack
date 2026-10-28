import { getRackCatalog } from './catalog.js';
import { EMPTY_EQUIPMENT, normalizeEquipment, checkEquipment } from './equipment.js';

/** Read-only scenarios exercise the same equipment rules as plan check/save. */
export function getCatalogExamples() {
  const rackId = '20000000-0000-4000-8000-000000000001';
  const modelId = '10000000-0000-4000-8000-000000000001';
  const rack = { rackId, modelId, name: 'Example A01' };
  const rackModel = { modelId, heightU: 42, maxWeightKg: null, maxPowerKw: null, maxCoolingKw: null };
  const device = (index, id, startU) => {
    const m = getRackCatalog().models.find((item) => item.modelId === id);
    return { deviceId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: m.name,
      ...m.specification, catalogRef: { modelId: m.modelId, version: m.version }, rackId, startU };
  };
  const gpu = device(1, 'demo-gpu-4u', 35), tor = device(2, 'demo-tor-1u', 41);
  return [
    ['normal', 'Normal allocation', '5 U, 90 kg and 3.3 kW within declared example limits.', [gpu, tor], 6],
    ['u-overlap', 'U position conflict', 'The switch overlaps the GPU server at U36.', [gpu, { ...tor, startU: 36 }], 6],
    ['power-limit', 'Power capacity exceeded', '3.3 kW known demand exceeds an explicit 3 kW limit.', [gpu, tor], 3],
    ['unknown', 'Unknown specification', 'Unknown resource demands must not become zero or a passing capacity result.',
      [device(1, 'demo-unspecified-1u', 1)], 6],
  ].map(([exampleId, name, description, devices, maxPowerKw]) => {
    const equipment = normalizeEquipment({ ...EMPTY_EQUIPMENT, coverage: 'DECLARED_COMPLETE',
      source: { kind: 'ASSUMED', reference: `Synthetic catalog scenario: ${exampleId}.` }, devices,
      rackLimits: [{ rackId, maxWeightKg: 500, maxPowerKw, maxCoolingKw: 6 }] }, [rack]);
    return { exampleId, name, description, rack, rackModel, equipment,
      equipmentReport: checkEquipment(equipment, [rack], [rackModel]), validationState: 'NOT_RUN' };
  });
}
