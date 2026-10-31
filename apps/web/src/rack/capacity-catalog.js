// Local planning presets, not vendor specifications or Facility allocations.
export const RACK_CAPACITY_TEMPLATES = Object.freeze([
  { templateId: 'edge', version: 1, name: 'Light-duty / edge', maxWeightKg: 600, maxPowerKw: 3, maxCoolingKw: 3,
    note: 'Small server or network installations with a modest power budget.' },
  { templateId: 'general', version: 1, name: 'General-purpose servers', maxWeightKg: 1000, maxPowerKw: 8, maxCoolingKw: 8,
    note: 'Mixed general-purpose servers, storage and switches.' },
  { templateId: 'compute', version: 1, name: 'Compute-dense', maxWeightKg: 1200, maxPowerKw: 15, maxCoolingKw: 15,
    note: 'Dense compute installations with enhanced power and cooling provision.' },
  { templateId: 'gpu', version: 1, name: 'High-density GPU', maxWeightKg: 1500, maxPowerKw: 30, maxCoolingKw: 30,
    note: 'GPU-heavy installations; verify high-density power delivery and heat removal.' },
  { templateId: 'liquid-ai', version: 1, name: 'Liquid-cooled AI', maxWeightKg: 1800, maxPowerKw: 80, maxCoolingKw: 80,
    note: 'High-power AI installations with suitable liquid cooling and residual air cooling.' },
].map(Object.freeze));

export function applyRackCapacityTemplate(equipment, placements, rackId, templateId) {
  const template = RACK_CAPACITY_TEMPLATES.find(t => t.templateId === templateId);
  if (!template) throw new Error('Choose a valid capacity template.');
  if (!placements.some(r => r.rackId === rackId)) throw new Error('Choose an existing rack.');
  const limits = { rackId, maxWeightKg: template.maxWeightKg, maxPowerKw: template.maxPowerKw, maxCoolingKw: template.maxCoolingKw };
  const exists = equipment.rackLimits.some(l => l.rackId === rackId);
  return { ...equipment, rackLimits: exists
    ? equipment.rackLimits.map(l => l.rackId === rackId ? limits : l)
    : [...equipment.rackLimits, limits] };
}
