import { beginLayoutDraft, validateEditorPlacements, validateEditorConstraints, validateEditorEquipment } from './edit-layout-state.js';
import { createDeviceBatch } from './device-batch.js';
import { RACK_CAPACITY_TEMPLATES } from './capacity-catalog.js';
import { rackSequenceNames } from './rack-sequence.js';

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
    const quantity = Number(values.quantity ?? 1);
    const names = values.numbered || quantity !== 1
      ? rackSequenceNames(next.placements, { ...values, quantity }) : [values.name.trim()];
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 128 || next.placements.length + quantity > 256)
      throw new Error('Add 1–128 racks at a time, within the 256-rack plan limit.');
    const columns = values.columns === '' || values.columns == null ? Math.ceil(Math.sqrt(quantity)) : Number(values.columns);
    const columnGap = Number(values.columnGap ?? 0.2);
    const rowGap = Number(values.rowGap ?? Math.max(1.2, (next.constraints.clearance?.frontM ?? 0) + (next.constraints.clearance?.rearM ?? 0)));
    if (!Number.isSafeInteger(columns) || columns < 1 || columns > 128 || ![columnGap,rowGap].every(v => Number.isFinite(v) && v >= 0 && v <= 100))
      throw new Error('Use 1–128 columns and gaps from 0 to 100 metres.');
    const rotated = [90,270].includes(Number(values.rotationDeg));
    const pitchX = (rotated ? model.depthM : model.widthM) + columnGap;
    const pitchY = (rotated ? model.widthM : model.depthM) + rowGap;
    const rows = Math.ceil(quantity / columns), usedColumns = Math.min(columns, quantity);
    let limits=null;
    if(values.capacityTemplateId && values.capacityTemplateId!=='model') {
      const preset=RACK_CAPACITY_TEMPLATES.find(t=>t.templateId===values.capacityTemplateId);
      if(!preset && values.capacityTemplateId!=='custom')throw new Error('Choose a valid capacity template.');
      limits={};for(const key of ['maxWeightKg','maxPowerKw','maxCoolingKw']) {
        const raw=preset?preset[key]:values[key];const value=raw==null||String(raw).trim()===''?null:Number(raw);
        if(value!==null&&(!Number.isFinite(value)||value<0||value>1000000))throw new Error('Capacity limits must be from 0 to 1000000.');
        limits[key]=value;
      }
    }
    for (let i=0; i<quantity; i++) {
      const rackId=makeId(); if (!selectedId) selectedId=rackId;
      if(limits)next.equipment.rackLimits.push({rackId,...limits});
      next.placements.push({ rackId, modelId: model.modelId, name: names[i],
        xM: Number(values.xM) + (i % columns - (usedColumns-1)/2) * pitchX,
        yM: Number(values.yM) + (Math.floor(i / columns) - (rows-1)/2) * pitchY,
        rotationDeg: Number(values.rotationDeg), locked: values.locked === undefined ? true : values.locked });
    }
  } else if (kind === 'rack_zone') {
    if (next.constraints.obstacles.length >= 64) throw new Error('A plan supports at most 64 exclusion zones.');
    selectedId = makeId();
    next.constraints.obstacles.push({ obstacleId: selectedId, name: values.name.trim(),
      ...Object.fromEntries(['xM', 'yM', 'widthM', 'depthM'].map(key => [key, Number(values[key])])) });
  } else if (kind === 'rack_device') {
    const model = catalog?.models.find(m => `${m.modelId}@${m.version}` === values.catalogKey);
    const devices=createDeviceBatch(next.equipment.devices,{quantity:values.quantity,catalogModel:model,custom:values.catalogKey==='custom'?values.custom:null},makeId);
    next.equipment.devices.push(...devices);selectedId=devices[0]?.deviceId;
  } else throw new Error('Unsupported add command.');
  const error = validateEditorPlacements(next.placements) || validateEditorConstraints(next.constraints) || validateEditorEquipment(next.equipment, next.placements);
  if (error) throw new Error(error);
  return { draft: next, selectedId };
}
