import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  LANDING_TOOL_ID,
  TOOLS,
  TOOL_GROUPS,
  defaultFunctionId,
  getTool,
  landingTool,
  resolveFunctionId,
  toolFunctions,
  toolsInGroup,
  visibleTools,
} from '../state/tool-registry.js';

test('tools are unique and every group is declared', () => {
  const ids = TOOLS.map((tool) => tool.toolId);
  assert.equal(new Set(ids).size, ids.length);
  for (const tool of TOOLS) assert.ok(tool.label.length > 0, `${tool.toolId} needs a label`);
  for (const group of TOOL_GROUPS) assert.ok(toolsInGroup(group.groupId).length > 0, `${group.groupId} is empty`);
});

test('the outer order follows the specification', () => {
  const design = toolsInGroup('design').map((tool) => tool.toolId);
  assert.deepEqual(design, [
    'site_facility',
    'floorplan',
    'rack',
    'network',
    'route_pathway',
    'cabling',
    'power',
    'thermal_hvac',
    'verify',
  ]);
  const supporting = toolsInGroup('supporting').map((tool) => tool.toolId);
  assert.deepEqual(supporting, [
    'assets',
    'catalog',
    'workload',
    'simulation',
    'cost_schedule',
    'deployment',
    'changes',
  ]);
});

test('the facility tool declares its inner functions with a default', () => {
  const functions = toolFunctions('site_facility').map((item) => item.functionId);
  assert.deepEqual(functions, ['overview', 'import_map', 'constraints', 'utilities', 'capacity', 'phasing', 'validate']);
  assert.equal(defaultFunctionId('site_facility'), 'overview');
});

test('a route naming no known function falls back to the tool default', () => {
  assert.equal(resolveFunctionId('site_facility', { functionId: 'capacity' }), 'capacity');
  assert.equal(resolveFunctionId('site_facility', { functionId: 'nope' }), 'overview');
  assert.equal(resolveFunctionId('site_facility', {}), 'overview');
  assert.equal(resolveFunctionId('unknown_tool', { functionId: 'x' }), null);
});

test('an unknown tool resolves to nothing rather than throwing', () => {
  assert.equal(getTool('nope'), null);
  assert.deepEqual(toolFunctions('nope'), []);
});

test('visibility filters only tools that declare a key', () => {
  const all = visibleTools(null);
  assert.equal(all.length, TOOLS.length);

  const restricted = visibleTools(['asset.read']);
  const ids = restricted.map((tool) => tool.toolId);
  assert.ok(ids.includes('assets'), 'a granted key keeps its tool');
  assert.ok(!ids.includes('site_facility'), 'a tool whose key is absent is hidden');
  assert.ok(!ids.includes('rack'), 'Rack entry now requires its own read permission');
  assert.ok(visibleTools(['rack.read']).some(tool => tool.toolId === 'rack'));
  assert.ok(ids.includes('floorplan'), 'a tool with no declared key is never blocked by this filter');

  assert.deepEqual(visibleTools(new Set(['facility.read'])).map((t) => t.toolId).includes('site_facility'), true);
});

test('a project lands on Site & Facility when its key is held', () => {
  // ui-pattern.md, "Project List Entry": opening a project opens the default
  // landing view, which is Site & Facility while no facility context exists.
  assert.equal(LANDING_TOOL_ID, 'site_facility');
  assert.equal(landingTool(['facility.read'])?.toolId, 'site_facility');
  // Undetermined keys hide nothing, which is the sidebar's rule too.
  assert.equal(landingTool(null)?.toolId, 'site_facility');
});

test('the landing view is not opened when its key is absent', () => {
  assert.equal(landingTool(['project.read']), null);
});
