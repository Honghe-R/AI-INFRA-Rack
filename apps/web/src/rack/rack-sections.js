// One navigation definition for the shell and the Rack workspace.
export const RACK_SECTIONS = Object.freeze([
  { functionId: 'overview', label: 'Overview', status: 'AVAILABLE', description: 'Workflow, selected-plan summary and module readiness.' },
  { functionId: 'plans', label: 'Plans', status: 'AVAILABLE', description: 'Create and select a plan bound to one Facility HALL.' },
  { functionId: 'dependencies', label: 'Inputs & impact', status: 'PARTIAL', description: 'Pinned room and model inputs, draft changes and their check dependencies.' },
  { functionId: 'layout', label: 'Rack layout', status: 'AVAILABLE', description: 'Room canvas, rack positions, rotation and locking.' },
  { functionId: 'constraints', label: 'Space rules', status: 'PARTIAL', description: 'Planning exclusion zones and front/rear maintenance distances.' },
  { functionId: 'equipment', label: 'Devices & U slots', status: 'PARTIAL', description: 'Catalog models, device assignment and cabinet U elevation.' },
  { functionId: 'capacity', label: 'Capacity', status: 'PARTIAL', description: 'Per-rack capacity and plan-wide room power/cooling budgets, totals and unknowns.' },
  { functionId: 'candidates', label: 'Layout options', status: 'PARTIAL', description: 'Bounded rack relocation and quantity-driven empty-plan design, comparison, preview and staging for a checked save.' },
  { functionId: 'validate', label: 'Checks', status: 'PARTIAL', description: 'Live checks, saved check history, freshness and JSON/CSV planning reports.' },
].map(Object.freeze));

export function rackSection(id) {
  return RACK_SECTIONS.find((item) => item.functionId === id) ?? RACK_SECTIONS[0];
}
