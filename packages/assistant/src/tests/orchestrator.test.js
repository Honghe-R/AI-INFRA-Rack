import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createContextResolver, createGuide } from '../context.js';
import { boundValue } from '../bounding.js';
import { LlmError, createRedactor } from '../errors.js';
import { createOrchestrator } from '../orchestrator.js';
import { createToolRegistry, createUiActionRegistry, defineCapability, defineSurface } from '../registry.js';

const surface = defineSurface({ key: 'site_facility', version: 1, digest: {} });
const guide = createGuide({
  key: 'site-facility-guide',
  version: 1,
  surface: 'site_facility',
  requiredEntryFunctions: ['facility.read'],
  instructions: ['Ground answers in tool results.'],
});

const listTool = defineCapability({
  name: 'list_containers',
  description: 'List containers.',
  inputSchema: { type: 'object', properties: {} },
  access: 'read',
  surfaces: ['site_facility'],
  handler: async () => ({ containers: [{ entityId: 'e-1', name: 'Data Hall 01', entityType: 'HALL' }] }),
});

const writeTool = defineCapability({
  name: 'create_container',
  description: 'Create a container.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  access: 'write',
  surfaces: ['site_facility'],
  handler: async () => ({ created: true }),
});

const hugeTool = defineCapability({
  name: 'dump_everything',
  description: 'Return far too much.',
  inputSchema: { type: 'object', properties: {} },
  access: 'read',
  surfaces: ['site_facility'],
  handler: async () => ({ items: Array.from({ length: 5_000 }, (_, index) => ({ entityId: `x-${index}`, name: `Item ${index}`, blob: 'z'.repeat(200) })) }),
});

function scripted(responses) {
  let index = 0;
  return {
    name: 'fake',
    model: 'fake-1',
    get callCount() {
      return index;
    },
    async complete() {
      const entry = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return typeof entry === 'function' ? entry() : entry;
    },
  };
}

function assistantMessage(content, toolCalls = null) {
  return {
    choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
    model: 'fake-1',
    provider: 'fake',
  };
}

function toolCall(name, args = {}, id = 'call-1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function harness({ provider, capabilities = [listTool, writeTool], uiActions = null, readOnly = false, buildDigest = null, audit = null, limits = {}, authorize = async () => true, redact = (value) => value, sessions = null, usageService = null } = {}) {
  const contextResolver = createContextResolver({
    surfaces: [surface],
    guides: [guide],
    resolveScope: async () => ({ surface: 'site_facility', workspaceId: 'ws-1', organisationId: 'org-1', scenarioId: 'scenario-1', revisionId: 'revision-1', baseRevisionId: 'base-1', ifMatch: 'etag-1', lifecycleState: readOnly ? 'VALIDATED' : 'DRAFT', scopeKind: 'project', displayName: 'Project', readOnly }),
  });
  return createOrchestrator({
    provider,
    contextResolver,
    toolRegistry: createToolRegistry({ capabilities }),
    uiActionRegistry: createUiActionRegistry({ actions: uiActions ?? [{ type: 'highlight_entity', version: 1, surfaces: ['site_facility'], inputSchema: { type: 'object' } }] }),
    authorize,
    auditService: audit,
    buildDigest,
    limits,
    redact,
    sessionService: sessions,
    usageService,
  });
}

/** A stand-in for the session store, recording what a turn tried to write. */
function recorder() {
  const turns = [];
  return {
    turns,
    async ensure({ sessionId }) {
      return { sessionId: sessionId ?? '11111111-1111-4111-8111-111111111111' };
    },
    async appendTurn({ requestId, turn }) {
      turns.push({ requestId, turn });
      return turns.length;
    },
  };
}

/** A stand-in for the usage ledger, which records once per turn and must never double-count. */
function ledger() {
  const records = [];
  return {
    records,
    async precheck() {
      return { allowed: true };
    },
    async record(entry) {
      records.push(entry);
    },
  };
}

const turn = (overrides = {}) => ({ messages: [{ role: 'user', content: 'What is in the facility?' }], contextKey: 'facility', context: { userId: 'user-1', workspaceId: 'ws-1' }, ...overrides });

test('the system prompt states the resolved scope so a tool call can name it', async () => {
  // Every facility capability requires `revision_id`; before this the model was never
  // told it, so it invented one and the executor correctly refused the call with a
  // scope mismatch. The server's canonical scope must reach the prompt.
  let system = null;
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete(request) {
      system = request.messages[0];
      return assistantMessage('Nothing to report.');
    },
  };
  const orchestrator = harness({ provider });

  await orchestrator.runTurn(turn());

  assert.equal(system.role, 'system');
  assert.match(system.content, /# Active scope/);
  assert.match(system.content, /- project_id: ws-1/);
  assert.match(system.content, /- scenario_id: scenario-1/);
  assert.match(system.content, /- revision_id: revision-1/);
  assert.match(system.content, /- lifecycle_state: DRAFT/);
});

test('a turn runs a tool, links an entity, and reports usage and a trace', async () => {
  const audits = [];
  const provider = scripted([
    assistantMessage('', [toolCall('list_containers')]),
    assistantMessage('Data Hall 01 is provisional.'),
  ]);
  const orchestrator = harness({ provider, audit: { record: (entry) => audits.push(entry) } });

  const result = await orchestrator.runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(provider.callCount, 2);
  assert.equal(result.trace.toolCalls[0].name, 'list_containers');
  assert.ok(result.choices[0].message.content.includes('[**Data Hall 01**](entity://facility.entity/e-1)'));
  assert.deepEqual(result.entities.map((entity) => entity.label), ['Data Hall 01']);
  assert.equal(result.usage.total_tokens, 6, 'usage is summed across rounds');
  assert.equal(result.usage.cached_input_tokens, 2);
  assert.equal(audits.length, 2, 'one audit line per provider request');
  assert.equal(audits[0].event, 'assistant.provider_request');
});

test('a write tool stops at the confirmation gate and runs once confirmed', async () => {
  const gatedProvider = scripted([
    assistantMessage('', [toolCall('create_container', { name: 'Hall 2' })]),
    assistantMessage('Done.'),
  ]);
  const gated = await harness({ provider: gatedProvider }).runTurn(turn());
  assert.equal(gated.status, 'confirmation_required');
  assert.equal(gated.pendingConfirmations[0].toolName, 'create_container');

  const confirmedProvider = scripted([
    assistantMessage('', [toolCall('create_container', { name: 'Hall 2' })]),
    assistantMessage('Done.'),
  ]);
  const confirmed = await harness({ provider: confirmedProvider }).runTurn(turn({ confirmations: ['create_container'] }));
  assert.equal(confirmed.status, 'ok');
  assert.equal(confirmedProvider.callCount, 2);
});

test('a confirmed call is executed as it was shown, not re-proposed by the model', async () => {
  // The fabrication this closes: a live turn answered "I ran the write" with no tool call at all,
  // while the draft ETag never moved and no outbox event was written. The pending call's name and
  // arguments are known, so the server runs those and the model only reports what happened.
  const ran = [];
  const write = defineCapability({
    name: 'create_container',
    description: 'Create a container.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async (_executionContext, args) => {
      ran.push(args);
      return { created: args.name };
    },
  });
  const provider = scripted([assistantMessage('Created Hall 2.')]);

  const result = await harness({ provider, capabilities: [write] }).runTurn(
    turn({ confirmedCalls: [{ callId: 'c-1', name: 'create_container', arguments: { name: 'Hall 2' } }] }),
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(ran, [{ name: 'Hall 2' }], 'the confirmed call ran with the arguments the user saw');
  assert.equal(provider.callCount, 1, 'the model was asked to report, not to re-propose');
  assert.equal(result.trace.rounds[0].calls[0].name, 'create_container');
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'ok');
  // A confirmed call is a call: the turn says it changed the draft, which is what the client
  // needs to re-read what it draws. Without it the write was committed and invisible.
  assert.equal(result.draftChanged, true, 'a turn that ran a write says so');
});

test('a turn that only read does not claim to have changed the draft', async () => {
  const provider = scripted([assistantMessage('', [toolCall('list_containers')]), assistantMessage('It is provisional.')]);
  const result = await harness({ provider }).runTurn(turn());
  assert.equal(result.status, 'ok');
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'ok');
  assert.equal(result.draftChanged, false, 'a read is not a change');
});

test("a UI action named the way the prompt named it reaches the client instead of a notice", async () => {
  // The prompt lists the actions as `type@version`, the model copied one whole into `type`,
  // and the highlight was dropped with `Unknown UI action "highlight_entity@1@undefined"` —
  // a notice the reader could only read as a defect in the assistant. The action was
  // well-formed and only the spelling was not, so it is read rather than refused.
  const provider = scripted([
    assistantMessage('{"type":"message","payload":"Highlighting it.","uiActions":[{"type":"highlight_entity@1","payload":{"entity_id":"e-1"}}]}'),
  ]);

  const result = await harness({ provider }).runTurn(turn());

  assert.equal(result.uiActions.length, 1, 'the action was kept');
  assert.equal(result.uiActions[0].type, 'highlight_entity');
  assert.equal(result.uiActions[0].version, 1);
  assert.deepEqual(result.trace.notices ?? [], [], 'and nothing was refused');
});

test('a UI action that is genuinely unknown is named without a version it never had', async () => {
  const provider = scripted([assistantMessage('{"type":"message","payload":"Done.","uiActions":[{"type":"run_javascript","payload":{}}]}')]);

  const result = await harness({ provider }).runTurn(turn());

  assert.deepEqual(result.uiActions, []);
  const [notice] = result.trace.notices;
  assert.equal(notice.code, 'UI_ACTION_REJECTED');
  assert.equal(notice.message, 'Unknown UI action "run_javascript".');
});

test('a missing payload field says what the action received instead', async () => {
  // "missing entity_id" alone does not say whether the model omitted the field or called it
  // something else, and it called it something else — `name`, then `entityName`, then both
  // beside `type`. The reader could not tell a wrong name from a forgotten argument.
  const actions = [
    {
      type: 'highlight_entity',
      version: 1,
      surfaces: ['site_facility'],
      inputSchema: {
        type: 'object',
        properties: { entity_id: { type: 'string' }, entity_type: { type: 'string' } },
        required: ['entity_id', 'entity_type'],
      },
    },
  ];
  const provider = scripted([
    assistantMessage('{"type":"message","payload":"Done.","uiActions":[{"type":"highlight_entity","version":1,"payload":{"name":"Central Chiller Plant"}}]}'),
  ]);

  const result = await harness({ provider, uiActions: actions }).runTurn(turn());

  const [notice] = result.trace.notices;
  assert.equal(
    notice.message,
    'UI action "highlight_entity@1" is missing "entity_id". It received "name".',
    'the notice names the field it got as well as the one it wanted',
  );
  assert.deepEqual(notice.details, [{ expected: ['entity_id', 'entity_type'], received: ['name'] }]);
});

test('a reply envelope with a raw newline in its payload still yields its UI actions', async () => {
  // The provider routinely writes literal newlines inside the payload, which makes the whole
  // object invalid JSON. Discarding the envelope discarded the action with it, silently: a
  // live turn asked for a highlight correctly and nothing happened, while the browser
  // recovered the prose for display — so the reader saw no reason for the missing highlight.
  const actions = [
    {
      type: 'highlight_entity',
      version: 1,
      surfaces: ['site_facility'],
      inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
  ];
  const withNewline =
    '{"type":"message","payload":"Line one\nLine two","uiActions":[{"type":"highlight_entity","version":1,"payload":{"entity_id":"e-1"}}]}';
  const provider = scripted([assistantMessage(withNewline)]);

  const result = await harness({ provider, uiActions: actions }).runTurn(turn());

  assert.equal(result.uiActions.length, 1, 'the action in a repaired envelope is kept');
  assert.equal(result.uiActions[0].type, 'highlight_entity');
  assert.deepEqual(result.trace.notices ?? [], [], 'and nothing was refused');
  assert.match(result.choices[0].message.content, /Line one/, 'the payload is still the reply');
});

test('actions are read from an envelope the model wrapped in prose', async () => {
  // The model wrote the answer and then the envelope in a fenced block. The envelope did not
  // parse as *the reply*, so the highlight it asked for was dropped while the reader was told
  // it had been applied — and this time the payload was exactly right.
  const actions = [
    {
      type: 'highlight_entity',
      version: 1,
      surfaces: ['site_facility'],
      inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
  ];
  const reply = [
    '**Central Chiller Plant** is now highlighted on the canvas.',
    '',
    '```json',
    '{"type":"final_output","payload":"done","uiActions":[{"type":"highlight_entity","version":1,"payload":{"entity_id":"e-1"}}]}',
    '```',
  ].join('\n');
  const provider = scripted([assistantMessage(reply)]);

  const result = await harness({ provider, uiActions: actions }).runTurn(turn());

  assert.equal(result.uiActions.length, 1, 'the request inside the fenced envelope is read');
  assert.equal(result.uiActions[0].type, 'highlight_entity');
  // The prose is the answer and stays the answer: only the actions are taken from the salvage.
  assert.match(result.choices[0].message.raw_content, /is now highlighted on the canvas/);
  assert.deepEqual(result.trace.notices ?? [], [], 'and nothing was refused');
});

test('a JSON snippet the model shows the reader is not mistaken for its envelope', async () => {
  const provider = scripted([assistantMessage('The shape is `{ "example": [1, 2] }` — no actions here.')]);

  const result = await harness({ provider }).runTurn(turn());

  assert.deepEqual(result.uiActions, [], 'no actions were invented from prose');
  assert.deepEqual(result.trace.notices ?? [], []);
});

test('an action the model prints instead of requesting is still a request', async () => {
  // What this deployment's model actually does: the answer in prose, then the action object on
  // its own in a fenced block with every field correct. Two live turns did this, highlighted
  // nothing, and told the reader the plant had been highlighted.
  const actions = [
    {
      type: 'highlight_entity',
      version: 1,
      surfaces: ['site_facility'],
      inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
  ];
  const reply = [
    'Done — **Central Chiller Plant** is highlighted on the canvas.',
    '',
    '```json',
    '{ "type": "highlight_entity", "version": 1, "payload": { "entity_id": "e-1", "entity_type": "UTILITY_SOURCE", "label": "Central Chiller Plant" } }',
    '```',
  ].join('\n');

  const result = await harness({ provider: scripted([assistantMessage(reply)]), uiActions: actions }).runTurn(turn());

  assert.equal(result.uiActions.length, 1, 'the printed action is read as a request');
  assert.equal(result.uiActions[0].type, 'highlight_entity');
  assert.deepEqual(result.uiActions[0].payload, { entity_id: 'e-1', entity_type: 'UTILITY_SOURCE', label: 'Central Chiller Plant' });
  assert.deepEqual(result.trace.notices ?? [], [], 'nothing was refused');

  // And the request is not also shown as prose: the reader asked for a highlight, not for the
  // wire format that asks for one. This is what the chatbox was displaying.
  const content = result.choices[0].message.content;
  assert.match(content, /is highlighted on the canvas/, 'the answer is what remains');
  assert.doesNotMatch(content, /"payload"/, 'the consumed object is gone');
  assert.doesNotMatch(content, /```/, 'and so is the fence around it');
  // The wire text is still recoverable: `raw_content` is the model's own output, unedited.
  assert.match(result.choices[0].message.raw_content, /"payload"/);
});

test('a late envelope is replaced by the answer it carried, not shown as an object', async () => {
  const actions = [
    {
      type: 'highlight_entity',
      version: 1,
      surfaces: ['site_facility'],
      inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
    },
  ];
  const reply = [
    'Reading the revision first.',
    '',
    '```json',
    '{"type":"final_output","payload":"Central Chiller Plant is now highlighted.","uiActions":[{"type":"highlight_entity","version":1,"payload":{"entity_id":"e-1"}}]}',
    '```',
  ].join('\n');

  const result = await harness({ provider: scripted([assistantMessage(reply)]), uiActions: actions }).runTurn(turn());

  assert.equal(result.uiActions.length, 1);
  const content = result.choices[0].message.content;
  assert.match(content, /Reading the revision first\./, 'the prose stays');
  assert.match(content, /Central Chiller Plant is now highlighted\./, 'and the payload it was carrying is kept');
  assert.doesNotMatch(content, /uiActions/, 'while the envelope itself does not');
});

test('JSON the model wrote for the reader is left alone', async () => {
  // Not every brace in a reply is bookkeeping. A model showing the reader a payload, a schema,
  // or a config has written content, and this is not the layer that decides an answer may not
  // contain one.
  const reply = ['The rule payload looks like this:', '', '```json', '{ "entity_id": "e-1", "entity_type": "UTILITY_SOURCE" }', '```'].join('\n');

  const result = await harness({ provider: scripted([assistantMessage(reply)]) }).runTurn(turn());

  assert.deepEqual(result.uiActions, [], 'nothing was dispatched');
  assert.match(result.choices[0].message.content, /"entity_id"/, 'and nothing was removed');
});

test('an action the surface does not declare is not read out of a code block', async () => {
  // The salvage is bounded by the registry: a model explaining `run_javascript`, or showing an
  // example of something the surface has no action for, must not become a dispatched effect.
  const reply = ['Use a script for that:', '', '```json', '{ "type": "run_javascript", "version": 1, "payload": { "source": "alert(1)" } }', '```'].join('\n');

  const result = await harness({ provider: scripted([assistantMessage(reply)]) }).runTurn(turn());

  assert.deepEqual(result.uiActions, [], 'an undeclared action is not salvaged');
});

test('a round records what the model said while it worked, not only what it called', async () => {
  // The trace's job is to show how the model approached the problem. Tool names say what it
  // looked at; only its own sentence says what it was after, and it was being discarded.
  const said = '{"type":"message","payload":"Let me check the containers first."}';
  const provider = scripted([
    assistantMessage(said, [toolCall('list_containers')]),
    assistantMessage('{"type":"message","payload":"One hall."}'),
  ]);

  const result = await harness({ provider }).runTurn(turn());

  const [first, second] = result.trace.rounds;
  assert.equal(first.text, 'Let me check the containers first.', 'the payload is what it said, not the envelope around it');
  assert.equal(first.calls[0].name, 'list_containers');
  // The answering round's words *are* the reply, which is already the turn's own content.
  assert.equal(second.text, 'One hall.');
  assert.equal(second.calls.length, 0);
});

test('a round that said nothing records nothing, and a thinking channel rides along', async () => {
  // Models call tools with no prose at all, and an empty string is not a message: the record
  // must not grow a blank line per round.
  const silent = scripted([assistantMessage('', [toolCall('list_containers')]), assistantMessage('One hall.')]);
  const quiet = await harness({ provider: silent }).runTurn(turn());
  assert.equal('text' in quiet.trace.rounds[0], false, 'a silent round has no text');
  assert.equal(quiet.trace.rounds[1].text, 'One hall.', 'plain content is kept as it stands');

  // A provider with a separate thinking channel states the approach there instead.
  const thinking = scripted([
    {
      ...assistantMessage(''),
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'Two reads would answer this; start with the containers.',
            tool_calls: [toolCall('list_containers')],
          },
        },
      ],
    },
    assistantMessage('One hall.'),
  ]);
  const reasoned = await harness({ provider: thinking }).runTurn(turn());
  assert.equal(reasoned.trace.rounds[0].reasoning, 'Two reads would answer this; start with the containers.');
  assert.equal('text' in reasoned.trace.rounds[0], false);
});

test('a real reasoning trace is kept whole, and only a pathological round is cut', async () => {
  // The thinking is the thing being read, so the bound is a guard rather than a reading
  // limit: a trace of the kind this surface produces must survive it untouched.
  const real = 'y'.repeat(40000);
  const kept = scripted([assistantMessage(real, [toolCall('list_containers')]), assistantMessage('One hall.')]);
  const whole = await harness({ provider: kept }).runTurn(turn());
  assert.equal(whole.trace.rounds[0].text.length, 40000, 'a long trace is not a truncated one');
  assert.equal('narrationTruncated' in whole.trace.rounds[0], false);

  // Past the guard the round says it was cut, rather than looking complete.
  const rambling = scripted([assistantMessage('x'.repeat(60000), [toolCall('list_containers')]), assistantMessage('One hall.')]);
  const cut = await harness({ provider: rambling }).runTurn(turn());
  assert.equal(cut.trace.rounds[0].narrationTruncated, true);
  assert.equal(cut.trace.rounds[0].text.length, 50001, 'the bound plus the ellipsis');
  assert.match(cut.trace.rounds[0].text, /…$/);
});

test('a confirmed call that fails is answered in the transcript, so the model reports the failure', async () => {
  // The property is that the model is never left free to narrate a success that did not happen.
  // It used to be protected by never letting the model speak at all, which also meant the reader
  // got a raw 422 where the answer should have been. The failure is now put in front of the model
  // *and* recorded on the round, so the reader sees `refused` whichever way the model spins it.
  const refusing = defineCapability({
    name: 'create_container',
    description: 'Create a container.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => {
      throw new LlmError('CHANGE_SET_REJECTED', 'Only a FLOOR or a HALL carries a level number.', { status: 422 });
    },
  });

  const transcripts = [];
  const responses = [
    assistantMessage('I could not create it: only a FLOOR or a HALL carries a level number.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [refusing] }).runTurn(
    turn({ confirmedCalls: [{ name: 'create_container', arguments: {} }] }),
  );

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 1, 'the model was asked to report what actually happened');
  const refusal = transcripts[0].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the real failure was put in front of the model');
  assert.match(refusal.content, /FLOOR or a HALL/);
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused', 'and the reader is told, not the model alone');
  assert.match(result.choices[0].message.content, /could not create it/);
});

test('a read-only scope refuses a write tool even when the model asks for it, and the turn continues', async () => {
  // The security property is that the write never runs — not that the turn dies. Ending the turn
  // told the reader a 403 they could not act on, and took the work already done in the turn with
  // it; the model is now told in the transcript instead, which is the only thing that can change
  // what it does next.
  let ran = false;
  const guardedWrite = defineCapability({
    name: 'create_container',
    description: 'Create a container.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => {
      ran = true;
      return { created: true };
    },
  });

  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('create_container', { name: 'Hall 2' })]),
    assistantMessage('This scope is read-only, so I cannot create anything here.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [listTool, guardedWrite], readOnly: true }).runTurn(turn());

  assert.equal(ran, false, 'the write was never executed');
  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the model was given another round');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the refusal was returned as a tool result');
  assert.match(refusal.content, /ASSISTANT_TOOL_NOT_SELECTED/);
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused');
});

test('a UI action called as a tool is named as one, so the model can use the channel it was given', async () => {
  // The live case: the model called `show_finding` — a UI action its prompt lists under
  // "# UI actions", to be returned in the envelope — as a tool. "Tool ... is not available in
  // this context" is true and teaches nothing, so the next move is to try another name, and the
  // turn ends on the iteration budget instead of on an answer. The refusal has to say which
  // registry the name belongs to, and only this layer holds both.
  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('show_finding', { revision_id: 'r-1' })]),
    assistantMessage('Here is the finding.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({
    provider,
    capabilities: [listTool],
    uiActions: [{ type: 'show_finding', version: 1, surfaces: ['site_facility'], inputSchema: { type: 'object' } }],
  }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the turn did not end on the refusal');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the refusal was returned as a tool result');
  assert.match(refusal.content, /not available in this context/);
  assert.match(refusal.content, /is a UI action, not a tool/);
  // The quotes arrive escaped inside the serialized tool result, so the assertion reads the
  // sentence rather than the JSON spelling of it.
  assert.match(refusal.content, /uiActions\\?" array instead of calling it/);
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused');
});

test('an unknown tool name is answered in the transcript rather than ending the turn', async () => {
  // A name that was never offered reads the same as one withheld by a permission, and neither is
  // the reader's to fix. The hint is only for a name this layer can place in the other registry.
  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('list_unicorns', {})]),
    assistantMessage('I do not have a tool for that.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the model was given another round');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.match(refusal.content, /not available in this context/);
  assert.doesNotMatch(refusal.content, /is a UI action/, 'a name in neither registry is not explained as one');
});

test('a name that is both a tool and a UI action is not explained as the wrong one', async () => {
  // The two registries are separate, so a name can be in both. When it is, the refusal means the
  // *tool* was withheld — by the scope here — and saying "that is a UI action, not a tool" would
  // send the model to the wrong channel for the wrong reason. Nothing distinguishes the two
  // cases from the name alone, so the hint stays off.
  const bothRegistries = defineCapability({
    name: 'open_inspector',
    description: 'A tool that happens to share a UI action name.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => ({ opened: true }),
  });

  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('open_inspector', {})]),
    assistantMessage('Listing what I can do instead.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({
    provider,
    capabilities: [listTool, bothRegistries],
    readOnly: true,
    uiActions: [{ type: 'open_inspector', version: 1, surfaces: ['site_facility'], inputSchema: { type: 'object' } }],
  }).runTurn(turn());

  assert.equal(result.status, 'ok');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.match(refusal.content, /not available in this context/);
  assert.doesNotMatch(refusal.content, /is a UI action/);
});

test('a tool refused for its arguments is answered in the transcript, so the model gets another round', async () => {
  // Unwinding here showed the user the raw refusal — "The arguments are not valid for this
  // tool." — as if it were the answer. A refusal about arguments or targets is the model's
  // to repair, so it is returned as a tool result and the turn continues.
  const refusing = defineCapability({
    name: 'compare_revisions',
    description: 'Compare two revisions.',
    inputSchema: { type: 'object', properties: {} },
    access: 'read',
    surfaces: ['site_facility'],
    handler: async () => {
      throw new LlmError('VALIDATION_FAILED', 'The arguments are not valid for this tool.', {
        status: 400,
        details: [{ field: 'base_revision_id', reason: 'not_a_uuid' }],
      });
    },
  });

  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('compare_revisions', { base_revision_id: '2d6213ee' })]),
    assistantMessage('That revision does not exist, so here is the revision history instead.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [refusing] }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the model was given another round');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the refusal was returned as a tool result');
  assert.equal(refusal.tool_call_id, 'call-1');
  assert.match(refusal.content, /not_a_uuid/);
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused');
  assert.match(result.choices[0].message.content, /revision history instead/);
});

test('a tool that breaks for a reason the model cannot fix is answered in the transcript too', async () => {
  // The database being unreachable is not the model's to fix — but the model is still the only
  // party that can tell the reader anything, and the reader's alternative was a `500` where an
  // answer should have been. So it is reported to the model like any other outcome. The bound on
  // this is the iteration budget, not a dead turn.
  const broken = defineCapability({
    name: 'list_containers',
    description: 'List containers.',
    inputSchema: { type: 'object', properties: {} },
    access: 'read',
    surfaces: ['site_facility'],
    handler: async () => {
      throw new Error('the database is unreachable');
    },
  });

  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('list_containers')]),
    assistantMessage('I could not read the facility: the service is unavailable.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [broken] }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the model was given another round');
  const failure = transcripts[1].find((message) => message.role === 'tool');
  assert.match(failure.content, /unreachable/, 'the real reason is in front of the model');
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused');
});

test('tool arguments that are not parseable JSON are answered, not unwound', async () => {
  // The one tool-call failure that escaped the handler entirely: `parseArguments` was called
  // before the `try`, so a model that emitted malformed JSON for its own arguments killed the
  // turn with the very refusal the loop was built to hand back.
  const transcripts = [];
  const responses = [
    assistantMessage('', [{ id: 'call-1', type: 'function', function: { name: 'create_container', arguments: '{"name": "Hall 2",}' } }]),
    assistantMessage('Let me send that again.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the model was given another round');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the refusal was returned as a tool result');
  assert.match(refusal.content, /ASSISTANT_TOOL_ARGUMENTS_INVALID/);
  assert.match(refusal.content, /unparsable arguments/);
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused');
});

test('a confirmation is spent by the call it authorised, so a retry cannot ride on it', async () => {
  // The invariant the old "a refused write unwinds" rule was standing in for: the confirmation
  // was for the arguments the user saw. It used to be kept by ending the turn, which also ended
  // every other thing the turn was doing. It is kept where it belongs instead — by consuming the
  // confirmation — so a retry with different arguments has to be confirmed again, and the model
  // is free to make one.
  const ran = [];
  const refusingWrite = defineCapability({
    name: 'create_container',
    description: 'Create a container.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, level_number: { type: 'number' } } },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async (_executionContext, args) => {
      ran.push(args);
      throw new LlmError('CHANGE_SET_REJECTED', 'Only a FLOOR or a HALL carries a level number.', { status: 422 });
    },
  });

  const responses = [
    assistantMessage('', [toolCall('create_container', { name: 'Hall' })]),
    assistantMessage('', [toolCall('create_container', { name: 'Hall', level_number: 3 })]),
    assistantMessage('That one needs your confirmation.'),
  ];
  const provider = scripted(responses);

  const result = await harness({ provider, capabilities: [refusingWrite] }).runTurn(
    turn({ confirmations: ['create_container'] }),
  );

  assert.equal(ran.length, 1, 'the retry did not execute on the confirmation already spent');
  assert.equal(ran[0].level_number, undefined, 'the call that ran was the one the user confirmed');
  assert.equal(result.status, 'confirmation_required', 'the retry asks again rather than running');
  assert.equal(result.pendingConfirmations[0].toolName, 'create_container');
  assert.equal(result.pendingConfirmations[0].arguments.level_number, 3, 'and it asks about the arguments now proposed');
});

test('a write refused for its argument shape is answered in the transcript, so the model can repair', async () => {
  // The registry refuses a missing or malformed argument *before* the handler runs and before any
  // confirmation, so the rule above does not apply: nothing was confirmed and nothing ran. A live
  // turn reached a correct `set_geometry` and was discarded whole over a missing
  // `base_revision_id` the server already held.
  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('create_container', {})]),
    assistantMessage('Let me read the revision first.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [writeTool] }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 2, 'the model was given another round');
  const refusal = transcripts[1].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the refusal was returned as a tool result');
  assert.match(refusal.content, /ASSISTANT_TOOL_ARGUMENTS_INVALID/);
  assert.match(refusal.content, /is missing/);
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'refused');
});

test('a denied entry permission refuses the turn before any provider call', async () => {
  const provider = scripted([assistantMessage('should never run')]);
  const orchestrator = harness({ provider, authorize: async ({ key }) => key !== 'facility.read' });

  await assert.rejects(orchestrator.runTurn(turn()), (error) => {
    assert.equal(error.code, 'ASSISTANT_FORBIDDEN');
    assert.equal(error.status, 403);
    assert.deepEqual(error.details, [{ permission_key: 'facility.read' }]);
    return true;
  });
  assert.equal(provider.callCount, 0);
});

test('an over-budget tool result is bounded with a notice instead of failing the turn', async () => {
  const provider = scripted([
    assistantMessage('', [toolCall('dump_everything')]),
    assistantMessage('The result was truncated.'),
  ]);
  const result = await harness({ provider, capabilities: [hugeTool] }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(result.trace.toolCalls[0].truncated, true);
  assert.ok(result.trace.notices.some((notice) => notice.code === 'TOOL_RESULT_TRUNCATED'));
});

test('an over-budget digest degrades to a truncated snapshot, not a failure', async () => {
  const provider = scripted([assistantMessage('No tools were needed.')]);
  const bigDigest = { containers: Array.from({ length: 4_000 }, (_, index) => ({ entityId: `e-${index}`, name: `Entity ${index}` })) };
  const result = await harness({ provider, buildDigest: async () => bigDigest, limits: { digestBytes: 1_500 } }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(result.trace.digest.truncated, true);
  assert.ok(boundValue(bigDigest, { limitBytes: 1_500 }).value.original_bytes > 1_500);
});

test('exceeding the iteration budget is an explicit error that says what it did', async () => {
  const provider = scripted([assistantMessage('', [toolCall('list_containers', {}, 'call-loop')])]);
  await assert.rejects(harness({ provider, limits: { maxIterations: 3 } }).runTurn(turn()), (error) => {
    assert.equal(error.code, 'ASSISTANT_ITERATION_BUDGET');
    assert.equal(error.status, 408);
    // "Exceeded its iteration budget" on its own is not diagnosable from the chatbox.
    assert.match(error.message, /3-round budget/);
    assert.match(error.message, /list_containers ok/);
    assert.deepEqual(error.details[0].calls, [{ name: 'list_containers', outcome: 'ok' }]);
    return true;
  });
  assert.equal(provider.callCount, 3);
});

test('a call the reader declined is answered as their refusal, and the turn goes on', async () => {
  // A denial the model never hears is a denial it proposes again: the reader says no, the turn
  // ends, and the same card is drawn from the same proposal a moment later. So the declined call
  // comes back as the model's own call with a result saying the reader refused it — nothing runs,
  // and the model answers the refusal rather than repeating the question.
  let ran = false;
  const gated = defineCapability({
    name: 'set_geometry',
    description: 'Set geometry.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => {
      ran = true;
      return { applied: true };
    },
  });

  const transcripts = [];
  const responses = [assistantMessage('Understood — I have not changed anything.')];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [listTool, gated] }).runTurn(
    turn({ deniedCalls: [{ callId: 'call-7', name: 'set_geometry', arguments: { entity_id: 'e-1' } }] }),
  );

  assert.equal(ran, false, 'the handler was never consulted');
  assert.equal(result.status, 'ok');
  assert.equal(transcripts.length, 1, 'the model was given a round to answer the refusal');
  const refusal = transcripts[0].find((message) => message.role === 'tool');
  assert.ok(refusal, 'the refusal was returned as a tool result');
  assert.equal(refusal.tool_call_id, 'call-7', 'against the call the model actually made');
  assert.match(refusal.content, /TOOL_DENIED_BY_USER/);
  assert.match(refusal.content, /declined/);
  // The model's own proposal is reconstructed, so the tool result has a call to belong to.
  const proposal = transcripts[0].find((message) => message.role === 'assistant' && message.tool_calls);
  assert.equal(proposal.tool_calls[0].function.name, 'set_geometry');
  assert.equal(result.trace.rounds[0].calls[0].outcome, 'denied', 'and the reader is told, not the model alone');
  assert.match(result.choices[0].message.content, /have not changed anything/);
});

test('a declined call leaves the transcript\'s other work alone', async () => {
  // Declining one proposal is not declining the turn: the calls executed beside it keep their
  // results, and a model that offered two writes is told the outcome of each.
  const ran = [];
  const write = defineCapability({
    name: 'create_container',
    description: 'Create a container.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async (_executionContext, args) => {
      ran.push(args);
      return { created: true };
    },
  });

  const transcripts = [];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return assistantMessage('Done.');
    },
  };

  await harness({ provider, capabilities: [listTool, write] }).runTurn(
    turn({
      confirmedCalls: [{ callId: 'call-1', name: 'create_container', arguments: { name: 'Hall 2' } }],
      deniedCalls: [{ callId: 'call-2', name: 'create_container', arguments: { name: 'Hall 3' } }],
    }),
  );

  assert.deepEqual(ran, [{ name: 'Hall 2' }], 'only the call the reader allowed ran');
  const results = transcripts[0].filter((message) => message.role === 'tool');
  assert.equal(results.length, 2, 'and each call has its own answer');
  assert.equal(results.find((entry) => entry.tool_call_id === 'call-1').content.includes('created'), true);
  assert.match(results.find((entry) => entry.tool_call_id === 'call-2').content, /TOOL_DENIED_BY_USER/);
});

test('a missing message list and an oversized input are refused before any provider call', async () => {
  const provider = scripted([assistantMessage('hi')]);
  const orchestrator = harness({ provider });
  await assert.rejects(orchestrator.runTurn({ contextKey: 'facility', context: { userId: 'u' }, messages: [] }), (error) => error.code === 'ASSISTANT_MESSAGES_REQUIRED');
  await assert.rejects(
    orchestrator.runTurn(turn({ messages: [{ role: 'user', content: 'x'.repeat(300_000) }] })),
    (error) => error.code === 'ASSISTANT_INPUT_TOO_LARGE' && error.status === 413,
  );
  assert.equal(provider.callCount, 0);
});

/* ------------------------------------------------- when a turn dies, it still leaves a record */

test('a turn that dies mid-loop is persisted, with the rounds it managed', async () => {
  // The record of a turn is the only record of a turn. It used to be written at exactly one throw
  // site — the iteration budget — so a provider that failed on round two, or a transcript over the
  // message budget, left the reader with a failure they saw once and nothing at all after a reload.
  const sessions = recorder();
  const usage = ledger();
  let calls = 0;
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete() {
      calls += 1;
      if (calls === 1) return assistantMessage('', [toolCall('list_containers')]);
      throw new LlmError('LLM_PROVIDER_ERROR', 'The provider is unavailable.', { status: 503 });
    },
  };

  await assert.rejects(harness({ provider, sessions, usageService: usage }).runTurn(turn()), /unavailable/);

  assert.equal(sessions.turns.length, 1, 'the failed turn was written');
  const stored = sessions.turns[0].turn;
  assert.equal(stored.response.status, 'failed');
  assert.equal(stored.response.error.code, 'LLM_PROVIDER_ERROR');
  assert.match(stored.response.error.message, /unavailable/);
  assert.equal(stored.response.trace.rounds.length, 1, 'the round that did complete is in the record');
  assert.equal(stored.response.trace.rounds[0].calls[0].name, 'list_containers');
  assert.equal(stored.response.trace.rounds[0].calls[0].outcome, 'ok');
  assert.equal(usage.records.length, 1, 'what the turn spent is recorded even though it failed');
});

test('an over-budget turn is written once, and its usage counted once', async () => {
  // Two persistence paths is how a ledger gets a turn it never charged for, or charges for twice.
  const sessions = recorder();
  const usage = ledger();
  const provider = scripted([assistantMessage('', [toolCall('list_containers', {}, 'call-loop')])]);

  await assert.rejects(
    harness({ provider, sessions, usageService: usage, limits: { maxIterations: 2 } }).runTurn(turn()),
    (error) => error.code === 'ASSISTANT_ITERATION_BUDGET',
  );

  assert.equal(sessions.turns.length, 1, 'written once, not once per persistence path');
  assert.equal(usage.records.length, 1, 'and the ledger is not double-counted');
  assert.equal(sessions.turns[0].turn.response.error.code, 'ASSISTANT_ITERATION_BUDGET');
  assert.match(sessions.turns[0].turn.response.error.message, /2-round budget/);
});

test('a transcript over the message budget is persisted rather than vanishing', async () => {
  // Raised by the loop, before any provider call, and not persisted at all before this.
  const sessions = recorder();
  const provider = scripted([assistantMessage('never reached')]);

  await assert.rejects(
    harness({ provider, sessions, limits: { maxMessages: 1 } }).runTurn(
      turn({ messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }] }),
    ),
    (error) => error.code === 'ASSISTANT_MESSAGE_BUDGET',
  );

  assert.equal(provider.callCount, 0, 'the provider was never asked');
  assert.equal(sessions.turns.length, 1, 'and the turn is still on the record');
  assert.equal(sessions.turns[0].turn.response.error.code, 'ASSISTANT_MESSAGE_BUDGET');
});

test('a turn refused before a session exists writes no turn, and does not fail on the way out', async () => {
  // There is no session to attach it to, so there is nothing to write — and the failure path must
  // not turn a caller error into a second, different error.
  const sessions = recorder();
  const provider = scripted([assistantMessage('never reached')]);

  await assert.rejects(
    harness({ provider, sessions }).runTurn({ contextKey: 'facility', context: { userId: 'u' }, messages: [] }),
    (error) => error.code === 'ASSISTANT_MESSAGES_REQUIRED',
  );

  assert.equal(sessions.turns.length, 0);
  assert.equal(provider.callCount, 0);
});

test('a turn whose session cannot be established is not claimed as a written turn', async () => {
  // `ensure` is what creates the session; a failure there is the caller's, and the failure path
  // has no id to write under. It must propagate the original error, not one of its own.
  const sessions = {
    turns: [],
    async ensure() {
      throw new LlmError('ASSISTANT_SESSION_FORBIDDEN', 'That session belongs to another user.', { status: 403 });
    },
    async appendTurn() {
      throw new Error('appendTurn should not have been called');
    },
  };

  await assert.rejects(
    harness({ provider: scripted([assistantMessage('never reached')]), sessions }).runTurn(turn()),
    (error) => error.code === 'ASSISTANT_SESSION_FORBIDDEN',
  );
  assert.equal(sessions.turns.length, 0);
});

test('a refused call records why, so a stored turn can be read', async () => {
  // The transcript carries the reason to the model and is never stored; the round is what a stored
  // turn keeps. `set_geometry refused` with no reason is what a live turn left behind, and it reads
  // identically for a name that was never offered, arguments the registry rejected, and a write the
  // facility itself turned down — the one question anyone asks of the log.
  const refusing = defineCapability({
    name: 'set_geometry',
    description: 'Set geometry.',
    inputSchema: { type: 'object', properties: {} },
    access: 'write',
    surfaces: ['site_facility'],
    handler: async () => {
      throw new LlmError('CHANGE_SET_REJECTED', 'Only a FLOOR or a HALL carries a level number.', { status: 422 });
    },
  });

  const responses = [
    assistantMessage('', [toolCall('set_geometry', {})]),
    assistantMessage('That write was refused.'),
  ];
  const provider = scripted(responses);

  const result = await harness({ provider, capabilities: [refusing] }).runTurn(turn({ confirmations: ['set_geometry'] }));

  assert.equal(result.status, 'ok');
  const call = result.trace.rounds[0].calls[0];
  assert.equal(call.name, 'set_geometry');
  assert.equal(call.outcome, 'refused');
  assert.equal(call.error.code, 'CHANGE_SET_REJECTED');
  assert.match(call.error.message, /FLOOR or a HALL/);
});

test('a refusal that is not the tool\'s own also names its code', async () => {
  // The other two shapes the same `refused` label used to hide: a name that is not on this turn's
  // menu, and arguments the registry rejected before the handler ran.
  const transcripts = [];
  const responses = [
    assistantMessage('', [toolCall('not_a_tool_here', {})]),
    assistantMessage('', [toolCall('create_container', {})]),
    assistantMessage('Neither call worked.'),
  ];
  const provider = {
    name: 'fake',
    model: 'fake-1',
    async complete({ messages }) {
      transcripts.push(messages);
      return responses[Math.min(transcripts.length - 1, responses.length - 1)];
    },
  };

  const result = await harness({ provider, capabilities: [writeTool] }).runTurn(turn());

  const [unknown, malformed] = result.trace.rounds.map((round) => round.calls[0]);
  assert.equal(unknown.error.code, 'ASSISTANT_TOOL_NOT_SELECTED');
  assert.equal(malformed.error.code, 'ASSISTANT_TOOL_ARGUMENTS_INVALID');
  assert.match(malformed.error.message, /is missing/);
});

test('the resolved scenario, revision, and write preconditions ride the execution context into a tool', async () => {
  let captured = null;
  const contextTool = defineCapability({
    name: 'capture_context',
    description: 'Capture the execution context.',
    inputSchema: { type: 'object', properties: {} },
    access: 'read',
    surfaces: ['site_facility'],
    handler: async (executionContext) => {
      captured = executionContext;
      return { ok: true };
    },
  });
  const provider = scripted([assistantMessage('', [toolCall('capture_context')]), assistantMessage('Done.')]);

  const result = await harness({ provider, capabilities: [contextTool] }).runTurn(turn());

  assert.equal(result.status, 'ok');
  assert.equal(captured.scenarioId, 'scenario-1');
  assert.equal(captured.revisionId, 'revision-1');
  // The write preconditions travel the same path, so the projection can bind them instead of
  // asking the model for two uuids it cannot reproduce.
  assert.equal(captured.baseRevisionId, 'base-1');
  assert.equal(captured.ifMatch, 'etag-1');
  assert.equal(captured.readOnly, false);
});

test('a configured secret is redacted from the returned content', async () => {
  const provider = scripted([assistantMessage('The credential is super-secret-value and must not surface.')]);
  const result = await harness({ provider, redact: createRedactor(['super-secret-value']) }).runTurn(turn());

  assert.equal(result.choices[0].message.content.includes('super-secret-value'), false);
  assert.equal(result.choices[0].message.raw_content.includes('super-secret-value'), false);
  assert.match(result.choices[0].message.content, /\[redacted\]/);
});

test('one audit record per tool call carries a digest, never an argument value', async () => {
  const audited = [];
  const provider = scripted([assistantMessage('', [toolCall('list_containers', { secret: 'top-secret-value' })]), assistantMessage('Done.')]);
  const orchestrator = harness({ provider, audit: { record() {}, recordToolCall: (entry) => audited.push(entry) } });

  await orchestrator.runTurn(turn());

  assert.equal(audited.length, 1);
  assert.equal(audited[0].tool, 'list_containers');
  assert.equal(audited[0].access, 'read');
  assert.equal(audited[0].outcome, 'ok');
  assert.equal(audited[0].argument_digest, createHash('sha256').update(JSON.stringify({ secret: 'top-secret-value' })).digest('hex'));
  assert.equal(JSON.stringify(audited[0]).includes('top-secret-value'), false);
  assert.deepEqual(audited[0].scope_ids, { project_id: 'ws-1', scenario_id: 'scenario-1', revision_id: 'revision-1' });
});
