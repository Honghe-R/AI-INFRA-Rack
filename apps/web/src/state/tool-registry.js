/**
 * The tool catalogue.
 *
 * Outer tools are ordered by intended workflow, then grouped after a visual
 * divider (ui-pattern.md, "Outer tool order and groups"). The shell hard-codes
 * neither a tool's inner functions nor its commands: each tool declares them
 * here, and the active-tool toolbar and sidebar read this registry.
 *
 * `permission` is the key that gates entry. A tool with no declared key is not
 * blocked — the order guides work but never blocks navigation, and a tool's own
 * findings explain incomplete inputs.
 */

import { RACK_KEYS } from '../generated/permission-keys.js';
import { RACK_SECTIONS } from '../rack/rack-sections.js';

export const TOOL_GROUPS = Object.freeze([
  Object.freeze({ groupId: 'design', label: 'Design flow' }),
  Object.freeze({ groupId: 'supporting', label: 'Supporting' }),
]);

export const TOOLS = Object.freeze([
  tool(
    'site_facility',
    'Site & Facility',
    'design',
    'facility.read',
    [
      fn('overview', 'Overview'),
      fn('import_map', 'Import & Map'),
      fn('constraints', 'Constraints'),
      fn('utilities', 'Utilities'),
      fn('capacity', 'Capacity'),
      fn('phasing', 'Phasing'),
      fn('validate', 'Validate'),
    ],
    [
      // The tool's own tools, in the order they are used: add to the design, then bring
      // a source in. Validate and publish are the governance pair and are declared
      // primary so the shell puts them at the end of the row rather than in this list.
      cmd('add_interface', 'Add interface', 'facility.utility.write'),
      cmd('draw_footprint', 'Draw footprint', 'facility.entity.write'),
      cmd('import', 'Import', 'facility.import.initiate'),
      cmd('validate', 'Validate', 'facility.validate.run', { variant: 'primary' }),
      cmd('publish', 'Publish', 'facility.publish', { variant: 'primary' }),
    ],
  ),
  tool('floorplan', 'Floorplan', 'design', null),
  tool('rack', 'Rack', 'design', RACK_KEYS.READ,
    RACK_SECTIONS.map((section) => fn(section.functionId, section.label))),
  tool('network', 'Network', 'design', null),
  tool('route_pathway', 'Route & Pathway', 'design', null),
  tool('cabling', 'Cabling', 'design', null),
  tool('power', 'Power', 'design', null),
  tool('thermal_hvac', 'Thermal & HVAC', 'design', null),
  tool('verify', 'Verify', 'design', 'facility.read'),

  tool('assets', 'Assets', 'supporting', 'asset.read'),
  tool('catalog', 'Catalog', 'supporting', RACK_KEYS.READ,
    [fn('models', 'Models'), fn('technologies', 'Technologies'), fn('examples', 'Rule examples')]),
  tool('workload', 'Workload & Capacity', 'supporting', null),
  tool('simulation', 'Simulation', 'supporting', null),
  tool('cost_schedule', 'Cost & Schedule', 'supporting', null),
  tool('deployment', 'Deployment & Commissioning', 'supporting', null),
  tool('changes', 'Constraints & Changes', 'supporting', null),
]);

const TOOL_BY_ID = new Map(TOOLS.map((item) => [item.toolId, item]));

function tool(toolId, label, groupId, permission, functions = [fn('overview', 'Overview')], commands = []) {
  return Object.freeze({
    toolId,
    label,
    groupId,
    permission,
    functions: Object.freeze(functions),
    commands: Object.freeze(commands),
    defaultFunction: functions[0].functionId,
  });
}

function fn(functionId, label) {
  return Object.freeze({ functionId, label });
}

function cmd(commandId, label, permission, options = {}) {
  return Object.freeze({ commandId, label, permission, variant: options.variant ?? 'secondary' });
}

/** The commands a tool contributes to the shell-owned active-tool toolbar slot. */
export function toolCommands(toolId) {
  return getTool(toolId)?.commands ?? [];
}

export function getTool(toolId) {
  return TOOL_BY_ID.get(toolId) ?? null;
}

export function toolsInGroup(groupId) {
  return TOOLS.filter((item) => item.groupId === groupId);
}

/** The inner functions a tool declares, or an empty list for an unknown tool. */
export function toolFunctions(toolId) {
  return getTool(toolId)?.functions ?? [];
}

/** The function to highlight when a route names none, or names an unknown one. */
export function defaultFunctionId(toolId) {
  return getTool(toolId)?.defaultFunction ?? null;
}

/**
 * Resolves a route state to the inner function to highlight. A route that names
 * no known function falls back to the tool's default rather than highlighting
 * nothing.
 */
export function resolveFunctionId(toolId, routeState) {
  const requested = routeState?.functionId ?? null;
  const declared = toolFunctions(toolId);
  if (requested && declared.some((item) => item.functionId === requested)) return requested;
  return defaultFunctionId(toolId);
}

/**
 * Filters tools by an effective permission set.
 *
 * A tool with no declared key stays visible: the shell must not invent a gate
 * for a capability the catalog does not model. A tool whose key is absent from a
 * resolved key set is hidden, and the caller renders the reason elsewhere.
 */
export function visibleTools(keys) {
  if (!keys) return TOOLS;
  const granted = keys instanceof Set ? keys : new Set(keys);
  return TOOLS.filter((item) => item.permission === null || granted.has(item.permission));
}

/**
 * The tool a project opens into (ui-pattern.md, "Project List Entry": "Creating or
 * opening a project enters its workspace and opens the default landing view: Site
 * and Facility when no facility context exists").
 *
 * A freshly created revision has no facility context, so Site & Facility is the
 * landing view. It is subject to the same visibility rule as the sidebar rather
 * than a second one, so a caller who cannot read the facility graph lands on the
 * project overview instead of a view they may not open.
 */
export const LANDING_TOOL_ID = 'site_facility';

export function landingTool(keys) {
  return visibleTools(keys).find((item) => item.toolId === LANDING_TOOL_ID) ?? null;
}
