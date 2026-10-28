import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RACK_SECTIONS, rackSection } from '../rack/rack-sections.js';
import { RackSectionGuide, RackPlanOverview } from '../rack/RackSections.jsx';
import { getTool } from '../state/tool-registry.js';
import { createOpenViewsState, openViewsReducer } from '../state/open-views.js';
import { createWorkspaceContext } from '../state/workspace-context.js';
import { RackEquipment } from '../rack/RackEquipment.jsx';
import { defaultEditorEquipment } from '../rack/edit-layout-state.js';

test('Rack sections match the shell navigation and each section switch retains the selected plan, dirty draft and exact retry request', () => {
  assert.deepEqual(getTool('rack').functions.map((s) => s.functionId), RACK_SECTIONS.map((s) => s.functionId));
  assert.equal(new Set(RACK_SECTIONS.map((s) => s.functionId)).size, 9);
  assert.equal(rackSection('old-unknown-route').functionId, 'overview');
  const context = createWorkspaceContext({ projectId: 'p', scenarioId: 's', revisionId: 'r' });
  const editDraft = { planId: 'plan', baseVersion: 2, placements: [{ rackId: 'rack', xM: 3 }],
    equipment: defaultEditorEquipment(), attempt: { key: 'unchanged-key', version: 2, body: { contract_version: 1, placements: [] } } };
  let state = openViewsReducer(createOpenViewsState(), { type: 'OPEN', tabId: 'rack-tab', toolId: 'rack', workspaceContext: context,
    routeState: { rackPlanId: 'plan', rackEditDraft: editDraft } });
  state = openViewsReducer(state, { type: 'SET_DIRTY', tabId: 'rack-tab', dirty: true, reason: 'Unsaved Rack changes.' });
  for (const section of RACK_SECTIONS) {
    state = openViewsReducer(state, { type: 'SET_ROUTE_STATE', routeState: { functionId: section.functionId } });
    assert.equal(state.tabs.length, 1);
    const tab = state.tabs[0];
    assert.equal(tab.routeState.functionId, section.functionId);
    assert.equal(tab.routeState.rackPlanId, 'plan');
    assert.equal(tab.routeState.rackEditDraft, editDraft);
    assert.equal(tab.routeState.rackEditDraft.attempt.key, 'unchanged-key');
    assert.equal(tab.dirtyState.dirty, true);
    assert.equal(openViewsReducer(state, { type: 'CLOSE', tabId: 'rack-tab' }), state);
  }
});

test('overview exposes module readiness and real selected-plan counts without claiming whole-plan validation', () => {
  const guide = renderToStaticMarkup(<RackSectionGuide onNavigate={() => {}} />);
  assert.ok(guide.includes('Partial scope')); assert.ok(guide.includes('Layout options relocate existing racks'));
  assert.ok(guide.includes('aria-label="Rack Assistant"'));
  assert.ok(guide.includes('reads saved data'));
  assert.ok(guide.includes('configured model provider is required'));
  const html = renderToStaticMarkup(<RackPlanOverview layout={{ version: 2, validationState: 'NOT_RUN' }}
    placements={[{}, {}]} equipment={{ devices: [{ rackId: null }, { rackId: 'r' }] }}
    spatialReport={{ status: 'INCOMPLETE' }} equipmentReport={null} isDraft={true} />);
  for (const text of ['Current draft', 'NOT_RUN', 'INCOMPLETE', 'Not currently checked', 'Open room layout']) assert.ok(html.includes(text));
});

test('layout options navigation exposes implemented search with a partial scope', () => {
  assert.equal(rackSection('candidates').status, 'PARTIAL');
  assert.match(rackSection('candidates').description, /Bounded rack relocation/);
});

test('equipment, capacity and diagnostics modes reuse the existing inventory but expose separate panel groups', () => {
  const props = { equipment: defaultEditorEquipment(), placements: [], models: [], editable: false };
  const capacity = renderToStaticMarkup(<RackEquipment {...props} mode="capacity" />);
  assert.ok(capacity.includes('Rack capacity'));
  assert.ok(capacity.includes('hidden="" data-equipment-panel="devices"'));
  const equipment = renderToStaticMarkup(<RackEquipment {...props} mode="equipment" />);
  assert.ok(equipment.includes('Equipment &amp; U positions'));
  assert.ok(!equipment.includes('hidden="" data-equipment-panel="devices"'));
  const diagnostics = renderToStaticMarkup(<RackEquipment {...props} mode="diagnostics" />);
  assert.ok(diagnostics.includes('Equipment checks'));
  assert.ok(diagnostics.includes('<div hidden=""><label>Equipment planning reference'));
  assert.ok(diagnostics.includes('Equipment has not been checked'));
});
