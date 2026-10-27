import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_PROMPT, composeSystemPrompt } from '../prompt.js';

/**
 * The prompt must state the resolved scope.
 *
 * The facility capability schemas require `revision_id` on every call, and a call that
 * names a different value than the resolved context is refused with a `403`. A model
 * told to pass an identifier it was never given can only invent one, so the scope comes
 * from the server's canonical resolution and is stated unconditionally.
 */
test('the resolved scope is stated, with only the identifiers that resolved', () => {
  const prompt = composeSystemPrompt({
    scope: { projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1', lifecycleState: 'DRAFT' },
  });

  assert.match(prompt, /# Active scope/);
  assert.match(prompt, /- project_id: p-1/);
  assert.match(prompt, /- scenario_id: s-1/);
  assert.match(prompt, /- revision_id: r-1/);
  assert.match(prompt, /- lifecycle_state: DRAFT/);
  // The model is told the scope for grounding and told not to pass it: the server binds
  // it, because a model asked to echo a UUID truncates or invents one.
  assert.match(prompt, /do NOT pass project_id, scenario_id, or revision_id/i);
});

test('a null identifier is omitted rather than shown as an empty value', () => {
  const prompt = composeSystemPrompt({ scope: { projectId: 'p-1', scenarioId: null, revisionId: null } });

  assert.match(prompt, /- project_id: p-1/);
  assert.doesNotMatch(prompt, /- scenario_id:/);
  assert.doesNotMatch(prompt, /- revision_id:/);
});

test('no scope means no scope section, and no empty heading', () => {
  assert.doesNotMatch(composeSystemPrompt(), /# Active scope/);
  assert.doesNotMatch(composeSystemPrompt({ scope: {} }), /# Active scope/);
  assert.doesNotMatch(composeSystemPrompt({ scope: null }), /# Active scope/);
});

test('the scope block sits beside the other owned parts without replacing them', () => {
  const prompt = composeSystemPrompt({
    scope: { projectId: 'p-1' },
    digest: { revision: 'r-1' },
    tools: [{ function: { name: 'list_containers' } }],
    uiActions: [
      {
        type: 'highlight_entity',
        version: 1,
        inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, label: { type: 'string' } }, required: ['entity_id'] },
      },
    ],
  });

  assert.ok(prompt.startsWith(BASE_PROMPT));
  assert.match(prompt, /# Active scope/);
  assert.match(prompt, /# Workspace digest/);
  assert.match(prompt, /Available tools: list_containers\./);
  // The identity names the version as its own field, and the shape the model must return is
  // spelled out. Naming it `highlight_entity@1` invited the model to copy the whole token
  // into `type`: a well-formed action in a spelling the registry then refused.
  assert.match(prompt, /highlight_entity \(version 1\)/);
  assert.doesNotMatch(prompt, /highlight_entity@1/);
  assert.match(prompt, /"type": "<type>", "version": <version>, "payload"/);
  // And what the payload must contain, which the model was left to invent. It invented
  // `name`, then `entityName`, then put both beside `type`: three correct intents the
  // registry could not read, reported to the reader as a missing field.
  assert.match(prompt, /payload \{ entity_id: string \(required\), label: string \}/);
  assert.match(prompt, /never pass a display name where an id is required/);
});
