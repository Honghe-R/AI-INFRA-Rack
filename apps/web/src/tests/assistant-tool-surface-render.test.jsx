import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../assistant/Markdown.jsx';
import { FacilityInspector } from '../facility/FacilityInspector.jsx';
import { VerificationSurface } from '../facility/VerificationSurface.jsx';
import {
  EMPTY_SNAPSHOT,
  WorkspaceEffectsProvider,
  createWorkspaceEffects,
  routeFunctionName,
  useRouteRequest,
} from '../facility/workspace-effects.js';

/**
 * The markup half of the tool surface: entity links that resolve by kind and id, the
 * inspector tab bar an `open_inspector` action addresses, the focused finding a
 * `show_finding` action asked for, and the effects channel's honest no-ops.
 */

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function declarations(selector) {
  const start = CSS.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `expected a top-level rule for ${selector}`);
  // Comments are stripped before the rule is asserted on: a rule's own explanation can
  // name a declaration, and `assert.match` would then be satisfied by the comment rather
  // than by the declaration it describes.
  return CSS.slice(start, CSS.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ------------------------------------------------- entity links by kind and id */

const LINK = 'See [**Data Hall 01**](entity://facility.entity/e-1).';

test('an entity link resolves by kind and id, in either wire spelling', () => {
  const camel = renderToStaticMarkup(
    <Markdown text={LINK} entities={[{ kind: 'facility.entity', id: 'e-1', label: 'Data Hall 01' }]} onSelectEntity={() => {}} />,
  );
  assert.match(camel, /<button type="button" class="md__entity"/);

  const snake = renderToStaticMarkup(
    <Markdown text={LINK} entities={[{ kind: 'facility.entity', entity_id: 'e-1', label: 'Data Hall 01' }]} onSelectEntity={() => {}} />,
  );
  assert.match(snake, /<button type="button" class="md__entity"/);
});

test('a link whose kind does not match the entity, or whose kind is unknown, stays text', () => {
  // Same id, different kind: the id-only match this replaced would have resolved it.
  const wrongKind = renderToStaticMarkup(
    <Markdown text={LINK} entities={[{ kind: 'facility.geometry', id: 'e-1', label: 'Data Hall 01' }]} onSelectEntity={() => {}} />,
  );
  assert.doesNotMatch(wrongKind, /<button/);
  assert.match(wrongKind, /Data Hall 01/);

  const unknownKind = renderToStaticMarkup(
    <Markdown
      text={'See [**Thing**](entity://facility.spaceship/e-1).'}
      entities={[{ kind: 'facility.spaceship', id: 'e-1', label: 'Thing' }]}
      onSelectEntity={() => {}}
    />,
  );
  assert.doesNotMatch(unknownKind, /<button/);
  assert.match(unknownKind, /Thing/);
});

test('an entity link renders a control only when a handler exists', () => {
  const withoutHandler = renderToStaticMarkup(
    <Markdown text={LINK} entities={[{ kind: 'facility.entity', id: 'e-1' }]} />,
  );
  assert.doesNotMatch(withoutHandler, /<button/);
  assert.match(withoutHandler, /Data Hall 01/);
});

test('the entity control carries hover handlers so the preview is reachable', () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={LINK}
      entities={[{ kind: 'facility.entity', id: 'e-1' }]}
      onSelectEntity={() => {}}
      onEntityHover={() => {}}
      onEntityLeave={() => {}}
    />,
  );
  // React does not serialise event handlers, so the assertion is about the control
  // existing with the affordance rather than about an attribute a browser hides.
  assert.match(html, /class="md__entity"/);
});

/* ------------------------------------------------------- the inspector tabs */

const CONTAINER_FEATURE = {
  geometryId: 'g-1',
  entityId: 'c-1',
  // A HALL, because only a floor or a hall carries the level number this fixture has —
  // the store refuses one on any other kind.
  entityType: 'HALL',
  role: 'FOOTPRINT',
  displayName: 'Hall 01',
};

const FACILITY = {
  containers: [{ containerId: 'c-1', kind: 'HALL', name: 'Hall 01', levelNumber: 1, elevationBaseM: 0, elevationTopM: 10 }],
};

test('the inspector renders the six tabs and marks the active one', () => {
  const html = renderToStaticMarkup(
    <FacilityInspector feature={CONTAINER_FEATURE} facility={FACILITY} canWrite tab="OVERVIEW" />,
  );

  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 6);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 6);
  for (const label of ['Overview', 'Utilities', 'Environment', 'Phasing', 'Assumptions', 'Documents']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /id="inspector-tab-OVERVIEW"[^>]*aria-selected="true"/);
  assert.match(html, /id="inspector-panel-UTILITIES"[^>]*hidden/);
});

test('the inspector fields carry the field_path anchors open_inspector scrolls to', () => {
  const html = renderToStaticMarkup(
    <FacilityInspector feature={CONTAINER_FEATURE} facility={FACILITY} canWrite tab="OVERVIEW" />,
  );
  for (const path of ['name', 'level_number', 'elevation_base_m', 'elevation_top_m']) {
    assert.match(html, new RegExp(`data-field-path="${path}"`));
  }

  const sourceHtml = renderToStaticMarkup(
    <FacilityInspector
      feature={{ entityId: 's-1', entityType: 'UTILITY_SOURCE', role: null, displayName: 'Grid A' }}
      facility={{ utilitySources: [{ utilitySourceId: 's-1', kind: 'POWER', displayName: 'Grid A', capacityState: 'FIRM' }] }}
      canWrite
      tab="UTILITIES"
    />,
  );
  assert.match(sourceHtml, /data-field-path="capacity_state"/);
});

test('a phase can be assigned from the inspector when the plan is available', () => {
  const html = renderToStaticMarkup(
    <FacilityInspector feature={CONTAINER_FEATURE} facility={FACILITY} canWrite phases={[{ phaseId: 'p-1', name: 'Phase 1' }]} />,
  );
  assert.match(html, /Assign to phase/);
  assert.match(html, /data-field-path="phase_id"/);
});

test('the inspector styles the tab row it introduces', () => {
  const tabs = declarations('.inspector__tabs');
  assert.match(tabs, /display:\s*flex/);
  const active = declarations('.inspector__tab--active');
  assert.match(active, /border-bottom-color|background/);
});

/* ---------------------------------------------------- the focused finding */

const FOCUSED_DIAGNOSTICS = [
  {
    diagnosticId: 'd-1',
    constraintId: 'facility.site.height.exceeded',
    severity: 'ERROR',
    status: 'OPEN',
    entityRefs: [],
    sourceValues: [],
    computed: {},
  },
];

test('a focused finding is marked and brought into view by id', () => {
  const html = renderToStaticMarkup(
    <VerificationSurface revisionId="r-1" lifecycleState="DRAFT" diagnostics={FOCUSED_DIAGNOSTICS} focus={{ diagnosticId: 'd-1' }} />,
  );
  assert.match(html, /id="verify-finding-d-1"/);
  assert.match(html, /data-focused="true"/);
  assert.match(html, /finding--focused/);
});

test('a focus on a finding this revision does not have says so', () => {
  const html = renderToStaticMarkup(
    <VerificationSurface
      revisionId="r-1"
      lifecycleState="DRAFT"
      diagnostics={FOCUSED_DIAGNOSTICS}
      focus={{ constraintId: 'facility.cooling.none' }}
    />,
  );
  assert.match(html, /No finding with constraint facility\.cooling\.none is recorded/);
  assert.doesNotMatch(html, /data-focused="true"/);
});

test('a constraint focus marks the finding that carries it', () => {
  const html = renderToStaticMarkup(
    <VerificationSurface
      revisionId="r-1"
      lifecycleState="DRAFT"
      diagnostics={FOCUSED_DIAGNOSTICS}
      focus={{ constraintId: 'facility.site.height.exceeded' }}
    />,
  );
  assert.match(html, /data-focused="true"/);
});

/* ------------------------------------------------------ the effects channel */

test('the route function ids map onto the spec uppercase names', () => {
  assert.equal(routeFunctionName('import_map'), 'IMPORT_AND_MAP');
  assert.equal(routeFunctionName('validate'), 'VALIDATE');
  assert.equal(routeFunctionName('unknown'), 'OVERVIEW');
  assert.equal(routeFunctionName(null), 'OVERVIEW');
});

test('an effects object with no registered canvas no-ops with a stated delta', () => {
  const effects = createWorkspaceEffects();
  assert.equal(effects.isMounted(), false);
  assert.equal(effects.selectEntity({ entityId: 'e-1' }).applied, false);
  assert.match(effects.selectEntity({ entityId: 'e-1' }).delta[0], /No canvas is mounted/);
  assert.deepEqual(effects.snapshot(), EMPTY_SNAPSHOT);
  assert.equal(effects.revealAssetLayer({ assetVersionId: 'a-1' }).applied, false);
  assert.match(effects.revealAssetLayer({ assetVersionId: 'a-1' }).delta[0], /not drawn on the canvas yet/);
  assert.equal(effects.reloadEnvelope().applied, false);
  assert.match(effects.reloadEnvelope().delta[0], /No canvas is mounted/);
});

test('a committed write re-reads the envelope through the registered canvas', () => {
  // The canvas holds what it read, so a change committed inside an assistant turn is
  // invisible in the one place it was asked for until the page is reloaded. The reload goes
  // through the canvas because the read is the canvas's own.
  let reloads = 0;
  const effects = createWorkspaceEffects();
  const detach = effects.register({ reloadEnvelope: () => { reloads += 1; return { applied: true }; } });

  assert.deepEqual(effects.reloadEnvelope(), { applied: true });
  assert.equal(reloads, 1, 'the canvas was asked to re-read');

  // A canvas that has gone away is a stated no-op, not a thrown error: the assistant is
  // shell-owned and may be answering on a route where no canvas exists.
  detach();
  assert.equal(effects.reloadEnvelope().applied, false);
  assert.equal(reloads, 1);
});

test('setLayerVisible maps the spec layer kinds onto the canvas overlay layers', () => {
  const moved = [];
  const effects = createWorkspaceEffects();
  effects.register({ setVisible: ({ layerId, visible }) => { moved.push([layerId, visible]); } });

  const facilities = effects.setLayerVisible({ layerKind: 'FACILITIES', visible: false });
  assert.deepEqual(facilities.applied, ['site', 'spaces', 'buildings']);
  assert.deepEqual(moved, [['site', false], ['spaces', false], ['buildings', false]]);

  moved.length = 0;
  assert.deepEqual(effects.setLayerVisible({ layerKind: 'UTILITIES', visible: true }).applied, ['utilities']);
  assert.deepEqual(effects.setLayerVisible({ layerKind: 'HAZARDS', visible: true }).applied, ['constraints']);
  assert.deepEqual(moved, [['utilities', true], ['constraints', true]]);

  // A kind with no canvas layer reports what it did not do rather than lying.
  for (const layerKind of ['PHASES', 'DIAGNOSTICS', 'IMPORT_SOURCE']) {
    const outcome = effects.setLayerVisible({ layerKind, visible: false });
    assert.equal(outcome.applied, false, layerKind);
    assert.match(outcome.delta[0], new RegExp(`${layerKind} layer is not drawn`));
  }

  const narrowed = effects.setLayerVisible({ layerKind: 'UTILITIES', visible: true, geometryRole: 'ROUTE' });
  assert.deepEqual(narrowed.applied, ['utilities']);
  assert.match(narrowed.delta[0], /geometry_role narrowing is not drawn yet/);
});

test('showFinding routes to validate and publishes the finding for the surface to read', () => {
  const routed = [];
  const effects = createWorkspaceEffects({ onRoute: (functionId) => routed.push(functionId) });

  const outcome = effects.showFinding({ revisionId: 'r-1', constraintId: 'facility.site.height.exceeded', severity: 'ERROR' });
  assert.deepEqual(routed, ['validate']);
  assert.equal(outcome.route, 'validate');
  assert.deepEqual(effects.getRouteRequest(), {
    functionId: 'validate',
    revisionId: 'r-1',
    diagnosticId: null,
    constraintId: 'facility.site.height.exceeded',
    severity: 'ERROR',
    nonce: 1,
  });
});

test('openRoute publishes the request before the route changes', () => {
  const effects = createWorkspaceEffects();
  const outcome = effects.openRoute({ functionId: 'import_map', bindingId: 'b-1' });
  assert.equal(outcome.applied, true);
  assert.equal(effects.getRouteRequest().functionId, 'import_map');
  assert.equal(effects.getRouteRequest().bindingId, 'b-1');
});

test('openTool forwards the tool request to the shell', () => {
  const opened = [];
  const effects = createWorkspaceEffects({ onOpenTool: (toolId, request) => opened.push([toolId, request.assetId]) });
  const outcome = effects.openTool({ toolId: 'assets', assetId: 'asset-1' });
  assert.equal(outcome.toolId, 'assets');
  assert.deepEqual(opened, [['assets', 'asset-1']]);
});

function RouteProbe() {
  const request = useRouteRequest('validate');
  return <span>{request ? request.constraintId : 'none'}</span>;
}

test('a surface on the route reads the published request through the provider', () => {
  const effects = createWorkspaceEffects();
  effects.showFinding({ constraintId: 'facility.site.height.exceeded' });
  const html = renderToStaticMarkup(
    <WorkspaceEffectsProvider effects={effects}>
      <RouteProbe />
    </WorkspaceEffectsProvider>,
  );
  assert.match(html, /facility\.site\.height\.exceeded/);
});
