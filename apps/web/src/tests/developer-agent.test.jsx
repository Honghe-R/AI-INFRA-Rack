import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantComposer } from '../assistant/AssistantComposer.jsx';
import { contextFor, assistantSessionKey } from '../assistant/useAssistantSession.js';

test('one Rack agent entry retains admin patch export without a Planning/Development task selector', () => {
  const html = renderToStaticMarkup(<AssistantComposer open developer={{ enabled: true, runtimeReady: true }}
    developerPatchUrl="/api/v1/assistant/developer/patch?project_id=p" />);
  assert.doesNotMatch(html, /Assistant task|>Planning<|>Development</); assert.match(html, /Download code patch/);
  assert.match(html, /Code changes use a private workspace/); assert.match(html, /Plan changes use checked saves/);
  assert.doesNotMatch(renderToStaticMarkup(<AssistantComposer open />), /Download code patch/);
});

test('Development context and session separate source editing from saved plan/draft and Facility effects', () => {
  const scope = { projectId: 'p', scenarioId: 's', revisionId: 'r', lifecycleState: 'PUBLISHED' };
  const ctx = contextFor(scope, { toolId: 'rack_developer', toolRouteState: { rackPlanId: 'plan', rackEditDraft: { secret: 'draft' } } });
  assert.equal(ctx.surface, 'rack_developer'); assert.equal(ctx.readOnly, false);
  assert.deepEqual(ctx.available_actions, []); assert.equal(ctx.rack_context, undefined);
  assert.notEqual(assistantSessionKey(scope, 'rack_developer'), assistantSessionKey(scope, 'rack', { rackPlanId: 'plan' }));
});
