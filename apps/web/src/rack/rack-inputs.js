import { defaultEditorConstraints, defaultEditorEquipment } from './edit-layout-state.js';

// A view of existing contracts, not a persisted dependency service or rule engine.
export const INPUT_NODES = [
  { id: 'room', label: 'Fixed room input', route: 'dependencies', x: 20, y: 20 },
  { id: 'racks', label: 'Rack layout', route: 'layout', x: 20, y: 110 },
  { id: 'rules', label: 'Space rules', route: 'constraints', x: 20, y: 200 },
  { id: 'devices', label: 'Devices & model pins', route: 'equipment', x: 20, y: 290 },
  { id: 'limits', label: 'Capacity assumptions', route: 'capacity', x: 20, y: 380 },
  { id: 'spatial', label: 'Spatial checks', route: 'validate', x: 340, y: 110 },
  { id: 'equipment', label: 'U & resource checks', route: 'validate', x: 340, y: 290 },
  { id: 'save', label: 'Versioned plan save', route: 'validate', x: 660, y: 200 },
];
export const INPUT_EDGES = [
  ['room', 'spatial'], ['racks', 'spatial'], ['rules', 'spatial'],
  ['racks', 'equipment'], ['devices', 'equipment'], ['limits', 'equipment'],
  ['spatial', 'save'], ['equipment', 'save'],
];

export function inputImpact(id) {
  const reached = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [from, to] of INPUT_EDGES) {
      if (reached.has(from) && !reached.has(to)) { reached.add(to); changed = true; }
    }
  }
  return reached;
}

// Compare without converting NaN to null, or mistaking JSON object key order
// for an edit. List order is conservatively considered part of the draft.
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

export function rackInputSummary(layout, placements, constraints, equipment, draft) {
  const savedEquipment = layout.equipment ?? defaultEditorEquipment();
  const savedConstraints = layout.constraints ?? defaultEditorConstraints();
  const changed = [];
  if (draft) {
    if (!same(layout.placements, placements)) changed.push('racks');
    if (!same(savedConstraints, constraints)) changed.push('rules');
    if (!same(savedEquipment.devices, equipment.devices) || !same(savedEquipment.coverage, equipment.coverage) ||
      !same(savedEquipment.source, equipment.source)) changed.push('devices');
    if (!same(savedEquipment.rackLimits, equipment.rackLimits)) changed.push('limits');
  }
  const pins = new Map();
  for (const device of equipment.devices) {
    if (!device.catalogRef) continue;
    const { modelId, version } = device.catalogRef;
    const key = JSON.stringify([modelId, version]);
    const pin = pins.get(key) ?? { modelId, version, count: 0 };
    pin.count++;
    pins.set(key, pin);
  }
  return {
    changed,
    pins: [...pins.values()],
    customDevices: equipment.devices.filter(d => !d.catalogRef).length,
    assignedDevices: equipment.devices.filter(d => d.rackId !== null).length,
    affected: new Set(changed.flatMap(id => [...inputImpact(id)])),
  };
}
