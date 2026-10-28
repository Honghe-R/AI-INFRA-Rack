import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  CHAT_USAGE_SCOPE,
  OVERALL_USAGE_SCOPE,
  createAssistantSession,
  turnFromResponse,
  withoutConsumedRequest,
  visibleAssistantText,
} from '../assistant/assistant-session.js';
import { contextFor, createAssistantTransport, assistantSessionKey } from '../assistant/useAssistantSession.js';

const REPLY = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  status: 'ok',
  choices: [{ message: { role: 'assistant', content: 'Data Hall 01 is provisional.' } }],
  entities: [{ kind: 'facility.entity', id: 'e-1', label: 'Data Hall 01' }],
  uiActions: [],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cached_input_tokens: 1 },
};

test('Rack context binds the selected plan and excludes another tab’s Facility effects and draft', () => {
  const workspace = { projectId: 'p', scenarioId: 's', revisionId: 'r', lifecycleState: 'DRAFT' };
  const route = { rackPlanId: 'rack-plan', functionId: 'capacity', rackEditDraft: { baseVersion: 4, placements: [{ rackId: 'local-only' }] } };
  const context = contextFor(workspace, { toolId: 'rack', toolRouteState: route,
    snapshot: { draftSummary: { etag: 'facility-token' }, selectionRefs: [{ entity_id: 'foreign-selection' }] } });
  assert.equal(context.surface, 'rack');
  assert.deepEqual(context.rack_context, { planId: 'rack-plan', clientVersion: 4, hasUnsavedDraft: true });
  assert.equal(context.route_state.function, 'capacity');
  assert.deepEqual(context.available_actions, []); assert.deepEqual(context.selection_refs, []);
  assert.equal(context.draft_summary, undefined);
  assert.equal(context.attachment_policy.maxCount, 0);
  assert.equal(JSON.stringify(context).includes('local-only'), false);
  assert.equal(JSON.stringify(context).includes('facility-token'), false);
});

test('Rack sessions isolate each selected plan from Facility while section switches preserve a session', () => {
  const workspace = { projectId: 'p', scenarioId: 's', revisionId: 'r' };
  const facility = assistantSessionKey(workspace);
  const a = assistantSessionKey(workspace, 'rack', { rackPlanId: 'a', functionId: 'layout' });
  assert.notEqual(a, facility);
  assert.notEqual(a, assistantSessionKey(workspace, 'rack', { rackPlanId: 'b' }));
  assert.notEqual(a, assistantSessionKey(workspace, 'rack'));
  assert.equal(a, assistantSessionKey(workspace, 'rack', { rackPlanId: 'a', functionId: 'candidates' }));
  assert.equal(assistantSessionKey(null, 'rack'), null);
});

function fakeTransport({ response = REPLY, usage = { totalTokens: 9, promptTokens: 6, completionTokens: 3, limitTokens: 100 }, sendTurn = null } = {}) {
  const calls = [];
  return {
    calls,
    async sendTurn(body) {
      calls.push(body);
      if (sendTurn) return sendTurn(body);
      return response;
    },
    async getUsage() {
      return usage;
    },
  };
}

function sessionWith(transport, options = {}) {
  return createAssistantSession({ transport, contextKey: 'p-1|s-1|r-1', scopeLabel: 'Site & Facility · Revision: Draft', ...options });
}

/** A stand-in for the localStorage pointer the hook supplies. */
function cacheStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    read: (key) => store.get(key) ?? null,
    write: (key, value) => store.set(key, value),
    clear: (key) => store.delete(key),
    peek: (key) => store.get(key),
  };
}

function historyTransport({ sessionId = null, sessions = null, turns = [], sendTurn = null } = {}) {
  return {
    async sendTurn(body) {
      if (sendTurn) return sendTurn(body);
      throw new Error('not used');
    },
    async listSessions() {
      return sessions ?? [];
    },
    async loadHistory({ sessionId: requested }) {
      if (sessionId && requested !== sessionId) return { turns: [] };
      return { turns };
    },
    async getUsage() {
      return {};
    },
  };
}

const STORED_TURN = { turnNumber: 1, messages: [{ role: 'user', content: 'earlier question' }], response: REPLY };

test('a turn appends an optimistic user turn and the mapped assistant reply', async () => {
  const transport = fakeTransport();
  const session = sessionWith(transport, { context: () => ({ projectId: 'p-1' }) });

  const assistantTurn = await session.send('What is in the facility?');
  const state = session.getState();

  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0].messages, [{ role: 'user', content: 'What is in the facility?' }]);
  assert.equal(transport.calls[0].contextKey, 'p-1|s-1|r-1');
  assert.deepEqual(transport.calls[0].context, { projectId: 'p-1' });

  assert.equal(state.turns.length, 2);
  assert.equal(state.turns[0].role, 'user');
  assert.equal(state.turns[0].text, 'What is in the facility?');
  assert.equal(state.turns[1].role, 'assistant');
  assert.equal(state.turns[1].text, 'Data Hall 01 is provisional.');
  assert.deepEqual(state.turns[1].entityRefs, ['Data Hall 01']);
  assert.equal(state.sessionId, 'sess-1', 'the server-assigned session id is adopted');
  assert.equal(state.streaming, false);
  assert.equal(state.draft, '');
  assert.equal(assistantTurn.status, 'COMPLETE');
});

test('the transcript is compacted out of complete turns and usage is accumulated per chat', async () => {
  const transport = fakeTransport();
  const session = sessionWith(transport);

  await session.send('first');
  await session.send('second');
  await tick();

  assert.deepEqual(transport.calls[1].messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'Data Hall 01 is provisional.' },
    { role: 'user', content: 'second' },
  ]);

  const chat = session.getState().usage.find((entry) => entry.scope === CHAT_USAGE_SCOPE);
  assert.deepEqual(
    { input: chat.inputTokens, output: chat.outputTokens, total: chat.totalTokens },
    { input: 4, output: 2, total: 6 },
    'two provider calls are summed, because one user turn costs several',
  );
  // Cached tokens ride beside the totals rather than inside them: a cached prompt is the same
  // tokens at a fraction of the rate, so the two answer different questions.
  assert.equal(chat.cachedInputTokens, 2, 'the cached input of both calls is summed');

  const overall = session.getState().usage.find((entry) => entry.scope === OVERALL_USAGE_SCOPE);
  assert.equal(overall.totalTokens, 9);
  assert.equal(overall.remainingTokens, 91);
});

test('cached tokens are accumulated for both scopes', async () => {
  const transport = fakeTransport({
    response: { ...REPLY, usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cached_input_tokens: 8 } },
    usage: { totalTokens: 500, promptTokens: 400, completionTokens: 100, cachedInputTokens: 250, cachedOutputTokens: 10, limitTokens: 1000 },
  });
  const session = sessionWith(transport);

  await session.send('one');
  await session.send('two');
  await tick();

  const chat = session.getState().usage.find((entry) => entry.scope === CHAT_USAGE_SCOPE);
  assert.equal(chat.cachedInputTokens, 16, 'each call adds its own cached input');

  // The month's cached figure is the server's, not a sum this browser keeps: it spans work
  // this chat never saw.
  const overall = session.getState().usage.find((entry) => entry.scope === OVERALL_USAGE_SCOPE);
  assert.equal(overall.cachedInputTokens, 250);
  assert.equal(overall.cachedOutputTokens, 10);
});

test('an envelope payload is unwrapped, and an unparsable envelope degrades to text', () => {
  assert.equal(
    visibleAssistantText({ message: { content: '{"type":"final_output","payload":"Rewritten."}' } }),
    'Rewritten.',
  );
  assert.equal(
    visibleAssistantText({ message: { structured_content: { type: 'final_output', payload: 'Structured.' }, content: 'ignored' } }),
    'Structured.',
  );
  // The provider routinely puts a literal newline inside the payload, which makes the
  // object invalid JSON. The payload is recovered rather than handed to the user as a
  // raw envelope — which is what the earlier version of this test asserted, and what the
  // bug actually looked like on screen.
  assert.equal(
    visibleAssistantText({ message: { content: '{"type":"final_output","payload":"broken\nnewline"}' } }),
    'broken\nnewline',
    'a payload with a literal newline is recovered',
  );
});

test('an envelope that spans lines is recovered, not leaked', () => {
  const reply = [
    '{',
    '  "type": "message",',
    '  "payload": "First line.',
    '',
    'Second paragraph with **bold**.',
    '',
    '- a bullet",',
    '  "uiActions": []',
    '}',
  ].join('\n');

  const text = visibleAssistantText({ message: { content: reply } });
  assert.match(text, /^First line\./);
  assert.match(text, /Second paragraph with \*\*bold\*\*\./);
  assert.match(text, /- a bullet/);
  assert.doesNotMatch(text, /"type"|"payload"|uiActions/, 'no envelope markers survive');
});

test('an envelope wrapped in a sentence still yields the payload', () => {
  const text = visibleAssistantText({
    message: { content: 'Here you go:\n{"type":"message","payload":"The answer."}\nHope that helps.' },
  });
  assert.equal(text, 'The answer.');
});

test('escaped quotes and escapes inside the payload survive the repair', () => {
  const text = visibleAssistantText({
    message: { content: '{"type":"message","payload":"He said \\"hello\\" and left.\nThen this."}' },
  });
  assert.equal(text, 'He said "hello" and left.\nThen this.');
});

test('a plain answer is passed through untouched', () => {
  assert.equal(visibleAssistantText({ message: { content: '# Not an envelope\nJust prose.' } }), '# Not an envelope\nJust prose.');
  assert.equal(visibleAssistantText({ message: { content: 'NOT_PROVIDED means no evidence exists.' } }), 'NOT_PROVIDED means no evidence exists.');
  assert.equal(visibleAssistantText({}), '');
});

test('a payload JSON cannot hold is salvaged rather than leaked', () => {
  // The model quoting a finding verbatim: the inner quotes end the JSON string early,
  // and escaping control characters does not bring the parse back.
  const text = visibleAssistantText({
    message: {
      content: '{"type":"message","payload":"The rule reads "a level is required" for FLOOR.\nFix it.","uiActions":[]}',
    },
  });

  assert.equal(text, 'The rule reads "a level is required" for FLOOR.\nFix it.');
  assert.doesNotMatch(text, /"type"|uiActions/);
});

test('a code-fenced envelope is unwrapped', () => {
  const text = visibleAssistantText({
    message: { content: '```json\n{"type":"message","payload":"Fenced answer."}\n```' },
  });
  assert.equal(text, 'Fenced answer.');
});

test('an escaped backslash before an n is not turned into a newline', () => {
  const text = visibleAssistantText({
    message: { content: '{"type":"message","payload":"path C:\\\\new and a real\nbreak"}' },
  });
  assert.equal(text, 'path C:\\new and a real\nbreak');
});

test('a streamed turn grows the placeholder as each round completes', async () => {
  const round1 = { iteration: 1, providerMs: 1200, tokens: 340, calls: [{ name: 'list_containers', ms: 19, outcome: 'ok' }] };
  const round2 = { iteration: 2, providerMs: 5300, tokens: 810, calls: [] };
  let release = null;

  const transport = fakeTransport({
    sendTurn: ({ onEvent }) => new Promise((resolve) => {
      onEvent({ type: 'round_started', iteration: 1, model: 'deepseek-chat' });
      onEvent({ type: 'round', round: round1 });
      release = () => {
        onEvent({ type: 'round', round: round2 });
        resolve({ ...REPLY, trace: { rounds: [round1, round2], toolCalls: [{ name: 'list_containers' }] } });
      };
    }),
  });
  const session = sessionWith(transport);

  const pending = session.send('list the containers');

  // The placeholder is chosen before the transport is called, so the first round lands on a
  // row that already exists — the reader watches a disclosure fill in, rather than a new row
  // appearing once the work is done.
  const during = session.getState();
  assert.equal(during.streaming, true);
  assert.equal(during.turns.length, 2);
  assert.equal(during.turns[1].status, 'STREAMING');
  assert.deepEqual(during.turns[1].rounds, [round1], 'the round is on the turn being watched');

  release();
  await pending;

  // The envelope replaces the placeholder wholesale, so the rounds that were streamed onto it
  // must not survive alongside the ones the envelope carries: the same two rounds counted
  // twice would be a disclosure that lies about what the turn did.
  const settled = session.getState();
  assert.equal(settled.turns[1].status, 'COMPLETE');
  assert.deepEqual(settled.turns[1].rounds.map((round) => round.iteration), [1, 2]);
  assert.deepEqual(settled.turns[1].toolCalls, [{ name: 'list_containers' }]);
});

test("the assistant's side of a turn is pending until the provider answers", async () => {
  let release = null;
  const transport = fakeTransport({
    sendTurn: () => new Promise((resolve) => {
      release = () => resolve(REPLY);
    }),
  });
  const session = sessionWith(transport);

  const pending = session.send('what is the hall height?');
  const thinking = session.getState();
  assert.equal(thinking.streaming, true);
  assert.deepEqual(
    thinking.turns.map((turn) => [turn.role, turn.status]),
    [['user', 'COMPLETE'], ['assistant', 'STREAMING']],
    'the wait is a turn of its own on the assistant side, not a flag on the composer',
  );
  const placeholderId = thinking.turns[1].turnId;

  release();
  await pending;

  const settled = session.getState();
  assert.equal(settled.streaming, false);
  assert.equal(settled.turns.length, 2, 'the reply replaces the placeholder rather than following it');
  assert.equal(settled.turns[1].turnId, placeholderId, 'and keeps the row it was written into');
  assert.equal(settled.turns[1].role, 'assistant');
  assert.equal(settled.turns[1].status, 'COMPLETE');
  assert.equal(settled.turns[1].text, 'Data Hall 01 is provisional.');
});

test('a failed turn keeps the draft and attachments, and reports on the assistant side', async () => {
  const transport = fakeTransport({
    sendTurn: async () => {
      throw Object.assign(new Error('quota exhausted'), { code: 'ASSISTANT_QUOTA_EXCEEDED', correlationId: 'corr-7' });
    },
  });
  const session = sessionWith(transport);
  session.attach([{ attachmentId: 'a-1', mediaType: 'application/pdf', sizeBytes: 10 }]);

  assert.equal(await session.send('please help'), null);
  const failed = session.getState();
  assert.equal(failed.streaming, false);
  assert.equal(failed.draft, 'please help', 'the text comes back');
  assert.equal(failed.attachments.length, 1, 'the attachment comes back too');
  assert.equal(failed.error.code, 'ASSISTANT_QUOTA_EXCEEDED');

  const [user, assistant] = failed.turns;
  assert.equal(user.role, 'user');
  assert.equal(user.status, 'COMPLETE', "the user's message is never marked failed");
  assert.equal(user.error, undefined, 'and never carries the error');
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.status, 'FAILED');
  assert.equal(assistant.error, 'quota exhausted');
  assert.equal(assistant.correlationId, 'corr-7');
  assert.equal(assistant.text, '', 'a failure has no answer text, so nothing is sent back as one');
});

test('a retry re-sends the failed message without duplicating the user turn', async () => {
  let attempts = 0;
  const transport = fakeTransport({
    sendTurn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return REPLY;
    },
  });
  const session = sessionWith(transport);

  await session.send('retry me');
  const failedTurn = session.getState().turns[1];
  assert.equal(failedTurn.status, 'FAILED');
  const turn = await session.retry(failedTurn.turnId);

  assert.equal(turn.text, 'Data Hall 01 is provisional.');
  const turns = session.getState().turns;
  assert.deepEqual(turns.map((entry) => [entry.role, entry.status]), [['user', 'COMPLETE'], ['assistant', 'COMPLETE']]);
  assert.equal(turns.filter((entry) => entry.role === 'user').length, 1);
  assert.deepEqual(transport.calls[1].messages, [{ role: 'user', content: 'retry me' }]);
});

test('a retry from the assistant side clears the draft the failure handed back', async () => {
  let attempts = 0;
  const transport = fakeTransport({
    sendTurn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return REPLY;
    },
  });
  const session = sessionWith(transport);

  await session.send('send me again');
  assert.equal(session.getState().draft, 'send me again', 'the failure returns the text');
  await session.retry(session.getState().turns[1].turnId);
  assert.equal(session.getState().draft, '', 'and the retry takes it back out of the field');
});

test('attachments are validated against the policy and can be removed', () => {
  const session = sessionWith(fakeTransport());
  session.attach([
    { attachmentId: 'ok', mediaType: 'application/pdf', sizeBytes: 10 },
    { attachmentId: 'bad', mediaType: 'text/plain', sizeBytes: 10 },
  ]);

  assert.deepEqual(session.getState().attachments.map((item) => item.attachmentId), ['ok']);
  assert.deepEqual(session.getState().attachmentRejections, [{ attachmentId: 'bad', reason: 'unsupported type text/plain' }]);

  session.detach('ok');
  assert.deepEqual(session.getState().attachments, []);
});

test('stored history rehydrates into complete turns', async () => {
  const transport = {
    async sendTurn() {
      throw new Error('not used');
    },
    async loadHistory({ sessionId, contextKey }) {
      assert.equal(sessionId, 'sess-1');
      assert.equal(contextKey, 'p-1|s-1|r-1');
      return { turns: [STORED_TURN] };
    },
    async getUsage() {
      return {};
    },
  };
  const session = sessionWith(transport, { sessionId: 'sess-1' });

  const turns = await session.loadHistory();
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ['user', 'earlier question'],
    ['assistant', 'Data Hall 01 is provisional.'],
  ]);
  assert.equal(turns[1].unread, false, 'a replayed reply is not announced as new');
});

test('a reload restores the conversation from the remembered session', async () => {
  const cache = cacheStub({ 'p-1|s-1|r-1': 'sess-9' });
  const transport = historyTransport({
    sessionId: 'sess-9',
    turns: [STORED_TURN],
    sessions: [{ sessionId: 'sess-other', turnCount: 5 }],
  });
  const session = sessionWith(transport, { sessionCache: cache });

  const turns = await session.restore();

  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.equal(session.getState().sessionId, 'sess-9', 'the remembered session wins over a newer one');
  assert.equal(session.getState().restoring, false);
  assert.equal(cache.peek('p-1|s-1|r-1'), 'sess-9');
});

test('a remembered session that no longer resolves falls back to the newest one', async () => {
  const cache = cacheStub({ 'p-1|s-1|r-1': 'gone' });
  const transport = historyTransport({
    sessionId: 'sess-2',
    turns: [STORED_TURN],
    sessions: [
      { sessionId: 'sess-2', turnCount: 2 },
      { sessionId: 'sess-1', turnCount: 0 },
    ],
  });
  const session = sessionWith(transport, { sessionCache: cache });

  await session.restore();

  assert.equal(session.getState().sessionId, 'sess-2');
  assert.equal(cache.peek('p-1|s-1|r-1'), 'sess-2');
  assert.equal(session.getState().turns[0].text, 'earlier question');
});

test('a context with no stored conversation opens empty, not stuck restoring', async () => {
  const session = sessionWith(historyTransport({ sessions: [] }), { sessionCache: cacheStub() });

  assert.deepEqual(await session.restore(), []);
  assert.deepEqual(session.getState().turns, []);
  assert.equal(session.getState().restoring, false);
});

test('a slow restore never clobbers a conversation the user already started', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const transport = {
    async sendTurn() {
      return REPLY;
    },
    async listSessions() {
      await gate;
      return [{ sessionId: 'sess-old', turnCount: 3 }];
    },
    async loadHistory() {
      return { turns: [STORED_TURN] };
    },
    async getUsage() {
      return {};
    },
  };
  const session = sessionWith(transport, { sessionCache: cacheStub() });

  const restoring = session.restore();
  await session.send('new question');
  release();
  await restoring;

  assert.equal(session.getState().turns.length, 2, 'the fresh exchange is not replaced by history');
  assert.equal(session.getState().turns[0].text, 'new question');
});

test('a new chat clears the conversation, its usage, and its pointer', async () => {
  const cache = cacheStub({ 'p-1|s-1|r-1': 'sess-1' });
  const session = sessionWith(fakeTransport(), { sessionCache: cache });

  await session.send('hello');
  await tick();
  assert.ok(session.getState().usage.some((entry) => entry.scope === CHAT_USAGE_SCOPE));

  session.startNew();

  assert.equal(session.getState().sessionId, null);
  assert.deepEqual(session.getState().turns, []);
  assert.equal(cache.peek('p-1|s-1|r-1'), undefined, 'the old session is forgotten');
  assert.equal(session.getState().usage.some((entry) => entry.scope === CHAT_USAGE_SCOPE), false);
});

test('a stop aborts the in-flight provider call', async () => {
  let seen = null;
  const transport = fakeTransport({
    sendTurn: (body) =>
      new Promise((_resolve, reject) => {
        seen = body.signal;
        body.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'LLM_CANCELLED', status: 499 })));
      }),
  });
  const session = sessionWith(transport);

  const pending = session.send('stop me');
  session.stop();
  await pending;

  assert.equal(seen.aborted, true);
  const [user, assistant] = session.getState().turns;
  assert.equal(user.status, 'COMPLETE', 'a stop is not the user message failing');
  assert.equal(assistant.status, 'FAILED');
  // Not the browser's abort text: "signal is aborted without reason" is what the fetch
  // raises, and what the reader did was press Stop.
  assert.equal(assistant.error, 'Stopped before the assistant answered.');
  assert.equal(session.getState().error.code, 'ASSISTANT_TURN_STOPPED');
});

test('a remembered session that resolves to nothing for this caller is forgotten, not re-sent', async () => {
  // The pointer is per browser, not per user: after an identity switch it names the
  // previous identity's session. A foreign session's history reads as empty and the
  // caller has no session in this context, so the pointer must be dropped rather than
  // sent again and refused.
  const cache = cacheStub({ 'p-1|s-1|r-1': 'someone-elses' });
  const session = sessionWith(historyTransport({ sessions: [] }), { sessionCache: cache });

  assert.deepEqual(await session.restore(), []);
  assert.equal(session.getState().sessionId, null);
  assert.equal(cache.peek('p-1|s-1|r-1'), undefined, 'the stale pointer is forgotten');
});

test('a turn sent with a session that belongs to another user forgets it and retries without one', async () => {
  const cache = cacheStub({ 'p-1|s-1|r-1': 'someone-elses' });
  const attempts = [];
  const transport = {
    async sendTurn(body) {
      attempts.push(body.sessionId);
      if (body.sessionId) {
        throw Object.assign(new Error('That session belongs to another user.'), {
          code: 'ASSISTANT_SESSION_FORBIDDEN',
          status: 403,
        });
      }
      return { ...REPLY, sessionId: 'sess-new' };
    },
    async getUsage() {
      return {};
    },
  };
  const session = sessionWith(transport, { sessionId: 'someone-elses', sessionCache: cache });

  const turn = await session.send('what is the status?');

  assert.deepEqual(attempts, ['someone-elses', null], 'the stale session is dropped before the retry');
  assert.equal(cache.peek('p-1|s-1|r-1'), 'sess-new', 'the new session replaces the stale pointer');
  assert.equal(session.getState().sessionId, 'sess-new');
  assert.equal(session.getState().error, null);
  assert.equal(session.getState().streaming, false);
  assert.equal(turn.status, 'COMPLETE');
  assert.equal(session.getState().turns.length, 2);
  assert.equal(session.getState().turns[0].text, 'what is the status?');
});

test('a confirmation gate is reported as a distinct turn status', () => {
  const turn = turnFromResponse(
    { ...REPLY, status: 'confirmation_required', pendingConfirmations: [{ callId: 'c-1', toolName: 'create_container' }] },
    'scope',
  );
  assert.equal(turn.status, 'CONFIRMATION_REQUIRED');
  assert.deepEqual(turn.pendingConfirmations, [{ callId: 'c-1', toolName: 'create_container' }]);
});

test('declining a gated write re-sends the turn with the refusal, and never as a confirmation', async () => {
  // The refusal is the server's to pass on, not the client's to swallow: the model is the only
  // party that can do anything about it. A card that merely disappeared would be drawn again from
  // the same proposal on the next turn — the reader says no, and the assistant asks again.
  const transport = fakeTransport({
    sendTurn: (body) =>
      body.deniedCalls
        ? REPLY
        : { ...REPLY, status: 'confirmation_required', pendingConfirmations: [{ callId: 'c-1', toolName: 'create_container', arguments: { name: 'Hall' } }] },
  });
  const session = sessionWith(transport);

  await session.send('make a hall');
  const gated = session.getState().turns.at(-1);
  assert.equal(gated.status, 'CONFIRMATION_REQUIRED');

  const settled = await session.deny(gated.turnId);

  assert.equal(settled.status, 'COMPLETE');
  assert.deepEqual(
    transport.calls[1].deniedCalls,
    [{ callId: 'c-1', name: 'create_container', arguments: { name: 'Hall' } }],
    'the declined call is handed back, so the server can tell the model it was refused',
  );
  assert.equal(transport.calls[1].confirmedCalls, null, 'and it is not sent as an approval');
  assert.equal(
    session.getState().turns.some((entry) => entry.status === 'CONFIRMATION_REQUIRED'),
    false,
    'the confirmation turn is replaced by the answer',
  );
});

test('declining a turn with no pending decision does nothing', async () => {
  const transport = fakeTransport();
  const session = sessionWith(transport);
  await session.send('hello');
  const before = transport.calls.length;

  assert.equal(session.deny(session.getState().turns.at(-1).turnId), null);
  assert.equal(transport.calls.length, before, 'no turn is sent for a decision that was never asked for');
});

test('confirming a gated write re-sends the turn with the decision', async () => {
  // Before this the chatbox showed "needs confirmation" and nothing could give one, so the turn
  // stalled with the write unapplied. Confirming re-sends the conversation with the decision; the
  // server matches it by call id or tool name and lets the call through.
  const transport = fakeTransport({
    sendTurn: (body) =>
      body.confirmedCalls
        ? REPLY
        : { ...REPLY, status: 'confirmation_required', pendingConfirmations: [{ callId: 'c-1', toolName: 'create_container', arguments: { name: 'Hall' } }] },
  });
  const session = sessionWith(transport);

  await session.send('make a hall');
  const gated = session.getState().turns.at(-1);
  assert.equal(gated.status, 'CONFIRMATION_REQUIRED');
  assert.equal(transport.calls[0].confirmations, null, 'an ordinary turn carries no decision');

  const settled = await session.confirm(gated.turnId);

  assert.equal(settled.status, 'COMPLETE');
  assert.deepEqual(
    transport.calls[1].confirmedCalls,
    [{ callId: 'c-1', name: 'create_container', arguments: { name: 'Hall' } }],
    'the call is handed back exactly as it was shown, for the server to execute',
  );
  assert.equal(
    session.getState().turns.some((entry) => entry.status === 'CONFIRMATION_REQUIRED'),
    false,
    'the confirmation turn is replaced by the answer',
  );
});

test('confirming a turn with no pending decision does nothing', async () => {
  const transport = fakeTransport();
  const session = sessionWith(transport);
  await session.send('hello');
  const before = transport.calls.length;

  assert.equal(session.confirm(session.getState().turns.at(-1).turnId), null);
  assert.equal(transport.calls.length, before, 'no turn was sent');
});

test('confirming a gated write keeps the turns that came before it', async () => {
  let calls = 0;
  const transport = fakeTransport({
    sendTurn: (body) => {
      calls += 1;
      if (calls === 7) {
        return {
          ...REPLY,
          requestId: 'req-7',
          status: 'confirmation_required',
          pendingConfirmations: [{ callId: 'c-1', toolName: 'create_container', arguments: { name: 'Hall' } }],
        };
      }
      return { ...REPLY, requestId: `req-${calls}` };
    },
  });
  const session = sessionWith(transport);

  for (let index = 1; index <= 6; index += 1) await session.send(`question ${index}`);
  await session.send('now move it');
  const gated = session.getState().turns.at(-1);
  assert.equal(gated.status, 'CONFIRMATION_REQUIRED');

  // Seven exchanges, and the assistant's half of the last one is the question the reader is
  // answering. Confirming answers it in place: the count before and after is the invariant
  // that matters, because a confirmation that restarts the timeline is the defect this
  // guards — the reader loses the conversation they were in the middle of.
  const before = session.getState().turns.length;
  assert.equal(before, 14, `expected 7 user + 7 assistant, got ${before}`);

  await session.confirm(gated.turnId);

  const texts = session.getState().turns.map((turn) => turn.text);
  assert.equal(session.getState().turns.length, before, `the confirmation replaced the gated turn, it did not drop the conversation: got ${session.getState().turns.length}`);
  assert.ok(texts.includes('question 1'), 'the first turn survives');
  assert.ok(texts.includes('question 6'), 'the sixth turn survives');
  assert.equal(session.getState().turns.filter((entry) => entry.status === 'CONFIRMATION_REQUIRED').length, 0, 'the gated turn was answered');
  const confirmation = transport.calls.at(-1);
  assert.equal(confirmation.sessionId, 'sess-1', 'the confirmation reuses the session');
  assert.equal(confirmation.confirmedCalls.length, 1, 'and hands the recorded call back');
});

test('a turn that committed a write is marked, so the surfaces can re-read', async () => {
  const session = sessionWith(fakeTransport({ response: { ...REPLY, draftChanged: true } }));
  const turn = await session.send('move it into the yard');
  assert.equal(turn.draftChanged, true, 'the committed change is visible on the turn');

  const reader = sessionWith(fakeTransport());
  const answer = await reader.send('what is in the yard?');
  assert.equal(answer.draftChanged, false, 'a turn that only read is not marked');
});

test('a restored turn does not ask for a second read of the revision', async () => {
  // The write it describes is already in the revision, and the surface reading this
  // transcript is reading that same revision: re-reading per historical write would fetch the
  // answer it already has. Only a live turn lands on a surface that read before it.
  const transport = historyTransport({
    sessionId: 'sess-1',
    turns: [{ turnNumber: 1, messages: [{ role: 'user', content: 'move it' }], response: { ...REPLY, requestId: 'req-9', draftChanged: true } }],
  });
  const session = sessionWith(transport, { sessionCache: cacheStub({ 'p-1|s-1|r-1': 'sess-1' }) });

  await session.restore();

  const assistantTurn = session.getState().turns.find((turn) => turn.role === 'assistant');
  assert.equal(assistantTurn.text, REPLY.choices[0].message.content, 'the stored turn was rehydrated');
  assert.equal(assistantTurn.draftChanged, false, 'and it asks for no read');
});

test('a request stored inside a reply is not shown as prose', () => {
  // Turns stored before the server started removing what it consumed keep the fenced object in
  // their text, so a restored conversation would go on displaying its own wire format under an
  // answer that already happened. The block goes only when the turn carries the action it
  // states, which is the evidence that it was a request.
  const stored = 'Central Chiller Plant is highlighted.\n\n```json\n{ "type": "highlight_entity", "version": 1, "payload": { "entity_id": "e-1" } }\n```';
  const actions = [{ id: 'a-1', type: 'highlight_entity', version: 1, payload: { entity_id: 'e-1' } }];

  const cleaned = withoutConsumedRequest(stored, actions);
  assert.match(cleaned, /Central Chiller Plant is highlighted\./);
  assert.doesNotMatch(cleaned, /entity_id/);
  assert.doesNotMatch(cleaned, /```/);

  // JSON the model wrote for the reader is untouched: this turn states no action, so nothing
  // here says the braces were a request.
  const example = 'The payload looks like this:\n\n```json\n{ "entity_id": "e-1" }\n```';
  assert.equal(withoutConsumedRequest(example, []), example, 'an object that is not an action is content');
  assert.equal(withoutConsumedRequest('', actions), '');

  // A turn stored before the server read requests keeps the object with no action beside it,
  // and the shape alone is enough: a fenced object naming a declared action is the machinery
  // that asks for one, whatever the turn's record says.
  assert.equal(withoutConsumedRequest(stored, []), 'Central Chiller Plant is highlighted.');
  assert.doesNotMatch(withoutConsumedRequest(stored, []), /highlight_entity/);
});

test('a rehydration that finishes late does not replace a conversation already on screen', async () => {
  let release = null;
  const transport = {
    async sendTurn() {
      return REPLY;
    },
    async listSessions() {
      return [];
    },
    async loadHistory() {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { turns: [STORED_TURN] };
    },
    async getUsage() {
      return {};
    },
  };
  const session = sessionWith(transport, { sessionCache: cacheStub({ 'p-1|s-1|r-1': 'sess-1' }) });

  const restoring = session.restore();
  await session.send('a question asked while the read was in flight');
  assert.equal(session.getState().turns.length, 2, "the reader's own exchange is on screen");

  release();
  await restoring;

  assert.equal(session.getState().turns.length, 2, 'the stored history did not swallow the live conversation');
  assert.equal(session.getState().turns[0].text, 'a question asked while the read was in flight');
});

test('the transport maps the wire contract onto the API client', async () => {
  const seen = [];
  const transport = createAssistantTransport({
    async sendAssistantTurn(body, options) {
      seen.push({ body, options });
      return { data: { status: 'ok', sessionId: 'sess-1' } };
    },
    async listAssistantSessions(contextKey) {
      seen.push({ list: contextKey });
      return { data: { sessions: [{ sessionId: 'sess-1' }] } };
    },
    async loadAssistantHistory(sessionId, contextKey) {
      seen.push({ history: [sessionId, contextKey] });
      return { data: { turns: [] } };
    },
    async getAssistantUsage() {
      return { data: { totalTokens: 5 } };
    },
  });

  const signal = new AbortController().signal;
  await transport.sendTurn({
    messages: [{ role: 'user', content: 'hi' }],
    contextKey: 'p-1|s|r',
    sessionId: 'sess-1',
    context: { projectId: 'p-1' },
    signal,
  });
  assert.deepEqual(seen[0].body, {
    messages: [{ role: 'user', content: 'hi' }],
    context_key: 'p-1|s|r',
    session_id: 'sess-1',
    context: { projectId: 'p-1' },
  });
  assert.equal(seen[0].options.signal, signal);

  assert.deepEqual(await transport.listSessions('p-1|s|r'), [{ sessionId: 'sess-1' }]);
  assert.deepEqual(await transport.loadHistory({ sessionId: 's-1', contextKey: 'p-1|s|r' }), { turns: [] });
  assert.deepEqual(await transport.getUsage(), { totalTokens: 5 });
});

test('the scope sent to the server carries the revision and a defensive read-only flag', () => {
  const context = contextFor({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1', lifecycleState: 'DRAFT' });

  // The flat camelCase scope the assistant route resolves the project from is kept.
  assert.equal(context.surface, 'site_facility');
  assert.equal(context.projectId, 'p-1');
  assert.equal(context.scenarioId, 's-1');
  assert.equal(context.revisionId, 'r-1');
  assert.equal(context.readOnly, false);

  // And all eight documented `AssistantComposerContext` fields are reported
  // (assistant-integration.md, "Grounding and Workspace Digest").
  assert.deepEqual(context.workspace_context, {
    project_id: 'p-1',
    scenario_id: 's-1',
    revision_id: 'r-1',
    lifecycle_state: 'DRAFT',
  });
  assert.equal(context.tool_id, 'site_facility');
  assert.deepEqual(context.route_state, {
    function: 'OVERVIEW',
    selected_entity_id: null,
    selected_geometry_id: null,
    inspector_tab: null,
    active_layer: null,
  });
  assert.deepEqual(context.selection_refs, []);
  assert.deepEqual(context.draft_summary, {
    dirty: false,
    base_revision_id: 'r-1',
    if_match: null,
    pending_change_count: 0,
  });
  assert.equal(context.available_actions.length, 6);
  assert.deepEqual(
    context.available_actions.map((item) => `${item.type}@${item.version}`),
    [
      'highlight_entity@1',
      'focus_geometry@1',
      'open_inspector@1',
      'show_finding@1',
      'reveal_asset_layer@1',
      'set_layer_visibility@1',
    ],
  );
  assert.equal(context.attachment_policy.accepted_media_types.length, 10);
  assert.equal(context.attachment_policy.max_file_size_bytes, 52_428_800);
  assert.equal(context.attachment_policy.max_attachments_per_message, 5);
  assert.equal(context.attachment_policy.required_permission, 'facility.read');
  assert.equal(context.attachment_policy.promotion_permission, 'facility.import.initiate');
  assert.equal(context.attachment_policy.promotion_write_permission, 'asset.write');
  assert.equal(context.attachment_policy.binds_to_entity, false);
  assert.equal(context.attachment_policy.fact_sheet_tool, 'attachment_fact_sheet');
  assert.equal(context.attachment_policy.page_read_tool, 'attachment_read_page');
  assert.equal(context.context_token, undefined, 'an absent token is omitted, never empty');

  assert.equal(contextFor({ projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1', lifecycleState: 'PUBLISHED' }).readOnly, true);
  assert.equal(contextFor(null), null);
});

test('the route state reports the active function, selection, and pending change set', () => {
  const context = contextFor(
    { projectId: 'p-1', scenarioId: 's-1', revisionId: 'r-1', lifecycleState: 'DRAFT' },
    {
      routeFunctionId: 'utilities',
      snapshot: {
        routeState: { selectedEntityId: 'e-1', selectedGeometryId: 'g-1', inspectorTab: 'UTILITIES', activeLayer: 'UTILITIES' },
        selectionRefs: [{ kind: 'facility.entity', entity_id: 'e-1', entity_type: 'BUILDING', label: 'Hall 01' }],
        draftSummary: { dirty: true, baseRevisionId: 'r-1', etag: 'etag-9', changeCount: 2 },
      },
      contextToken: 'opaque-token',
    },
  );

  assert.equal(context.route_state.function, 'UTILITIES');
  assert.equal(context.route_state.selected_entity_id, 'e-1');
  assert.equal(context.route_state.selected_geometry_id, 'g-1');
  assert.equal(context.route_state.inspector_tab, 'UTILITIES');
  assert.equal(context.route_state.active_layer, 'UTILITIES');
  assert.deepEqual(context.selection_refs, [
    { kind: 'facility.entity', entity_id: 'e-1', entity_type: 'BUILDING', label: 'Hall 01' },
  ]);
  assert.deepEqual(context.draft_summary, {
    dirty: true,
    base_revision_id: 'r-1',
    if_match: 'etag-9',
    pending_change_count: 2,
  });
  assert.equal(context.context_token, 'opaque-token', 'a token is sent only when the client holds one');
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
