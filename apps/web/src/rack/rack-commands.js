import { beginLayoutDraft, validateEditorPlacements, validateEditorConstraints, validateEditorEquipment } from './edit-layout-state.js';
import { deviceFromCatalog } from '../catalog/catalog-state.js';
import { MAX_EQUIPMENT_DEVICES } from './limits.generated.js';

export const RACK_COMMANDS = [
  { commandId: 'rack_add', label: 'Add rack', permission: 'rack.write' },
  { commandId: 'rack_device', label: 'Add equipment', permission: 'rack.write' },
  { commandId: 'rack_zone', label: 'Add exclusion zone', permission: 'rack.write' },
  { commandId: 'rack_constraints', label: 'Constraints', permission: 'rack.write', section: 'constraints' },
  { commandId: 'rack_capacity', label: 'Capacity limits', permission: 'rack.write', section: 'capacity' },
  { commandId: 'rack_design', label: 'Auto design', permission: 'rack.write', section: 'candidates' },
  { commandId: 'rack_checks', label: 'Check results', permission: 'rack.read', section: 'validate', variant: 'primary' },
];

export function rackCommandReason({ layout, draft, canWrite, busy }, id) {
  const command = RACK_COMMANDS.find(c => c.commandId === id);
  if (!command) return 'Unknown Rack command.';
  if (!layout?.snapshot) return 'Capture the room input first.';
  if (busy || draft?.attempt) return 'Complete or retry the pending save first.';
  if (id === 'rack_checks') return null;
  if (!canWrite) return 'Editing requires rack.write.';
  if (layout.sourceStatus.status !== 'UNCHANGED') return 'Facility source changed. Editing is blocked.';
  if (draft && (draft.planId !== layout.planId || draft.baseVersion !== layout.version || draft.snapshotId !== layout.snapshot.snapshotId))
    return 'This draft no longer matches the saved plan. Save or discard it before continuing.';
  if (id === 'rack_design' && draft) return 'Save or discard the shared draft before generating candidates.';
  return null;
}

/** Adds to a copy; the caller stages the result, never saves implicitly. */
export function addPlanObject(layout, draft, kind, values, catalog, makeId = () => crypto.randomUUID()) {
  const next = draft ? structuredClone(draft) : beginLayoutDraft(layout);
  if (next.attempt || next.planId !== layout.planId || next.baseVersion !== layout.version || next.snapshotId !== layout.snapshot.snapshotId)
    throw new Error('The draft is not available for editing.');
  let selectedId;
  if (kind === 'rack_add' || kind === 'rack_zone') {
    for (const key of ['xM', 'yM', ...(kind === 'rack_zone' ? ['widthM', 'depthM'] : [])])
      if (values[key] == null || String(values[key]).trim() === '') throw new Error('Enter all dimensions and coordinates explicitly.');
  }
  if (kind === 'rack_add') {
    if (next.placements.length >= 256) throw new Error('A plan supports at most 256 racks.');
    const model = layout.models.find(m => m.modelId === values.modelId);
    if (!model) throw new Error('Choose an available rack model.');
    selectedId = makeId();
    next.placements.push({ rackId: selectedId, modelId: model.modelId, name: values.name.trim(),
      xM: Number(values.xM), yM: Number(values.yM), rotationDeg: Number(values.rotationDeg), locked: values.locked === undefined ? true : values.locked });
  } else if (kind === 'rack_zone') {
    if (next.constraints.obstacles.length >= 64) throw new Error('A plan supports at most 64 exclusion zones.');
    selectedId = makeId();
    next.constraints.obstacles.push({ obstacleId: selectedId, name: values.name.trim(),
      ...Object.fromEntries(['xM', 'yM', 'widthM', 'depthM'].map(key => [key, Number(values[key])])) });
  } else if (kind === 'rack_device') {
    const quantity = Number(values.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 128 || next.equipment.devices.length + quantity > MAX_EQUIPMENT_DEVICES)
      throw new Error(`Add 1–128 devices at a time, within the ${MAX_EQUIPMENT_DEVICES}-device plan limit.`);
    const model = catalog?.models.find(m => `${m.modelId}@${m.version}` === values.catalogKey);
    if (!model) throw new Error('Choose an available versioned equipment model.');
    for (let i = 0; i < quantity; i++) {
      selectedId = makeId();
      const device = deviceFromCatalog(model, selectedId);
      device.name = `${model.name} ${next.equipment.devices.length + 1}`;
      next.equipment.devices.push(device);
    }
  } else throw new Error('Unsupported add command.');
  const error = validateEditorPlacements(next.placements) || validateEditorConstraints(next.constraints) || validateEditorEquipment(next.equipment, next.placements);
  if (error) throw new Error(error);
  return { draft: next, selectedId };
}
