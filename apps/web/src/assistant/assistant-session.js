import { uiActionTypeFor } from './ui-actions.js';
import {
  DEFAULT_ATTACHMENT_POLICY,
  addAttachments,
  appendTurn,
  markTurnFailed,
  removeAttachment,
  replaceTurn,
} from './assistant-state.js';

/**
 * The agentic loop hook, kept free of React and the DOM (ui-pattern.md,
 * "Workspace Assistant"; chatbox blueprint §3.1–§3.3).
 *
 * It owns one conversation: the transcript, the draft and its attachments, the
 * session id the server assigned, and the two usage scopes. The transport is
 * injected, so this module is testable without a network and the shell only has
 * to render what it reports.
 *
 * Three rules the surface depends on:
 *  * the assistant's side of a turn exists from the moment the message is sent, so the wait
 *    is visible where the answer will appear and a failure has somewhere of its own to land
 *    rather than being written onto the user's message,
 *  * a failed turn keeps its draft and attachments and exposes a retry, and
 *  * provider usage is accumulated per open chat, because one user turn costs
 *    several provider calls.
 */

export const CHAT_USAGE_SCOPE = 'CHAT_SESSION';
export const OVERALL_USAGE_SCOPE = 'USER_OVERALL';

let sequence = 0;

export function createAssistantSession({
  transport,
  contextKey,
  scopeLabel = '',
  context = {},
  // A function so the model is read as it stands at send time, exactly like `context`:
  // switching model must not rebuild the conversation, and a captured value would be the
  // model from when the composer opened.
  model = null,
  sessionId = null,
  policy = DEFAULT_ATTACHMENT_POLICY,
  makeTurnId = () => `turn-${++sequence}`,
  sessionCache = null,
} = {}) {
  if (typeof transport?.sendTurn !== 'function') throw new Error('createAssistantSession requires a transport with sendTurn.');
  if (!contextKey) throw new Error('createAssistantSession requires a context key.');

  let state = {
    contextKey,
    sessionId,
    turns: [],
    draft: '',
    attachments: [],
    attachmentRejections: [],
    streaming: false,
    restoring: false,
    usage: [],
    error: null,
  };
  const listeners = new Set();
  let inflight = null;
  let restored = false;

  function getState() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function set(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function remember(sessionId) {
    sessionCache?.write?.(state.contextKey, sessionId);
  }

  function forget() {
    sessionCache?.clear?.(state.contextKey);
  }

  /**
   * Appends one completed round to the turn still being written.
   *
   * The placeholder is the turn the reader is already looking at, so a round is added to it
   * rather than to a new one — which is what lets the disclosure fill in while the model
   * works instead of appearing all at once when the answer does. `set` replaces the state it
   * is handed synchronously, so a second round sees the first.
   */
  function addRound(turns, turnId, round) {
    return turns.map((turn) =>
      turn.turnId === turnId ? { ...turn, rounds: [...(turn.rounds ?? []), round] } : turn,
    );
  }

  /**
   * The assistant's place in the conversation before it has answered.
   *
   * An empty assistant turn, not a flag on the composer: the transcript is the only live
   * region and the only place a reply appears, so a wait that lives anywhere else is a wait
   * the reader has to be told about twice. The reply replaces this turn in place, and a
   * failure marks *this* turn, which is why the user's message stays exactly what they wrote.
   */
  function pendingTurn() {
    return {
      turnId: makeTurnId(),
      role: 'assistant',
      text: '',
      scopeLabel,
      entityRefs: [],
      status: 'STREAMING',
      unread: false,
    };
  }

  /**
   * Rehydrates the conversation after a reload. Turn content lives in the object
   * store, so this is a fetch, not a local copy: the client remembers only which
   * session belongs to this context key.
   *
   * A remembered session that no longer resolves falls back to the newest one for
   * the context, and a conversation the user has already started is never
   * clobbered by a slow restore.
   */
  async function restore() {
    if (restored) return state.turns;
    restored = true;

    const remembered = state.sessionId ?? sessionCache?.read?.(state.contextKey) ?? null;
    if (remembered) {
      set({ restoring: true, sessionId: remembered });
      const turns = await loadHistory();
      if (turns.length > 0) {
        remember(remembered);
        set({ restoring: false });
        return turns;
      }
      // Nothing came back for the remembered session, but the reader has already begun
      // talking. Their conversation is the newer one: leave it alone rather than looking for
      // another session to stand in for it.
      if (state.turns.length > 0) {
        set({ restoring: false });
        return state.turns;
      }
    }

    let latest = null;
    try {
      const sessions = (await transport.listSessions?.(state.contextKey)) ?? [];
      latest = sessions.find((session) => (session.turnCount ?? 0) > 0) ?? null;
    } catch {
      // A history read is reporting: an outage leaves an empty transcript, never a
      // broken composer.
      set({ restoring: false });
      return [];
    }

    if (state.turns.length > 0) {
      set({ restoring: false });
      return [];
    }

    if (!latest) {
      // The remembered pointer resolved to no conversation and this caller has no
      // session in this context. A pointer is per *browser*, not per user, so after an
      // identity switch it names the previous identity's session and the server will
      // refuse it. Forget it here rather than send it again and be told so.
      if (remembered) forget();
      set({ restoring: false, ...(remembered ? { sessionId: null } : {}) });
      return [];
    }

    set({ sessionId: latest.sessionId });
    remember(latest.sessionId);
    const turns = await loadHistory();
    set({ restoring: false });
    return turns;
  }

  /** Starts a fresh conversation in this context and forgets the old pointer. */
  function startNew() {
    stop();
    forget();
    set({
      sessionId: null,
      turns: [],
      usage: state.usage.filter((entry) => entry.scope !== CHAT_USAGE_SCOPE),
      error: null,
      restoring: false,
    });
  }

  function setDraft(draft) {
    set({ draft });
  }

  function attach(candidates) {
    const { attachments, rejected } = addAttachments(state.attachments, candidates, policy);
    set({ attachments, attachmentRejections: rejected });
  }

  function detach(attachmentId) {
    set({ attachments: removeAttachment(state.attachments, attachmentId) });
  }

  /**
   * Records refusals the caller determined itself.
   *
   * `attach` reports what *it* rejects against the policy. An upload can fail for reasons
   * the policy cannot see — a denied permission, a gateway error, a reservation with no
   * version — and those belong in the same list, because the reader experiences them as
   * one thing: a file that did not get attached, and why.
   */
  function noteRejections(rejected) {
    const entries = (rejected ?? []).filter(Boolean);
    if (entries.length === 0) return;
    set({ attachmentRejections: [...state.attachmentRejections, ...entries] });
  }

  /** Sends the current draft. Resolves to the assistant turn, or null on failure. */
  async function send(text = state.draft) {
    const content = typeof text === 'string' ? text.trim() : '';
    if (state.streaming) return null;
    if (content.length === 0 && state.attachments.length === 0) return null;

    const history = state.turns;
    const attachments = state.attachments;
    const userTurn = {
      turnId: makeTurnId(),
      role: 'user',
      text: content,
      scopeLabel,
      entityRefs: [],
      status: 'COMPLETE',
      unread: false,
    };
    const pending = pendingTurn();
    set({
      turns: appendTurn(appendTurn(history, userTurn), pending),
      draft: '',
      attachments: [],
      attachmentRejections: [],
      streaming: true,
      error: null,
    });
    return submit({ messages: transcriptMessages([...history, userTurn]), pending, content, attachments });
  }

  /**
   * Re-sends the message a failed turn belongs to, keeping one user turn in the list.
   *
   * The retry control sits on the assistant's failed turn, because that is where the failure
   * is reported. Which message to send again is the user turn above it — the failure itself
   * has no text, and re-sending the user's turn is what the reader means by retrying.
   */
  async function retry(turnId, { confirmations = null, confirmedCalls = null, deniedCalls = null } = {}) {
    if (state.streaming) return null;
    const index = state.turns.findIndex((turn) => turn.turnId === turnId);
    if (index === -1) return null;
    const userIndex = userTurnAtOrBefore(state.turns, index);
    if (userIndex === -1) return null;

    const userTurn = state.turns[userIndex];
    const history = state.turns.slice(0, userIndex + 1);
    const pending = pendingTurn();
    // The failed turn and anything after it go: the reply is being asked for again, and the
    // draft was handed back on failure, so it leaves the field as the retry takes it.
    set({ turns: appendTurn(history, pending), draft: '', streaming: true, error: null });
    return submit({ messages: transcriptMessages(history), pending, content: userTurn.text, confirmations, confirmedCalls, deniedCalls });
  }

  /**
   * Confirms the write a turn proposed and never ran.
   *
   * A confirmation-gated write is refused before its handler, so the turn ends with
   * `pendingConfirmations` and nothing applied — the chatbox showed "needs confirmation" with no
   * way to give one, and the turn stalled. Confirming hands the recorded call back to the server,
   * which **executes exactly that call** and then lets the model report the result. That is what
   * makes the confirmation a confirmation of the arguments the user saw; previously the model was
   * asked to propose the call again, and a live turn answered "I ran the write" without calling
   * anything while the revision never changed.
   */
  function confirm(turnId) {
    const turn = state.turns.find((entry) => entry.turnId === turnId);
    const confirmedCalls = (turn?.pendingConfirmations ?? [])
      .filter((entry) => entry?.toolName)
      .map((entry) => ({ callId: entry.callId ?? null, name: entry.toolName, arguments: entry.arguments ?? {} }));
    if (confirmedCalls.length === 0) return null;
    return retry(turnId, { confirmedCalls });
  }

  /**
   * Declines the write a turn proposed, and lets the turn go on without it.
   *
   * The refusal is handed to the server rather than swallowed here, because the model is the only
   * party that can do anything about it. A card that merely disappeared would be drawn again from
   * the same proposal on the next turn — the reader says no, and the assistant asks the same
   * question again — so the declined call is replayed as the model's own call with a result saying
   * the reader refused it. Nothing runs, and the model answers the refusal.
   */
  function deny(turnId) {
    const turn = state.turns.find((entry) => entry.turnId === turnId);
    const deniedCalls = (turn?.pendingConfirmations ?? [])
      .filter((entry) => entry?.toolName)
      .map((entry) => ({ callId: entry.callId ?? null, name: entry.toolName, arguments: entry.arguments ?? {} }));
    if (deniedCalls.length === 0) return null;
    return retry(turnId, { deniedCalls });
  }

  async function submit({ messages, pending, content, attachments = null, sessionRetried = false, confirmations = null, confirmedCalls = null, deniedCalls = null }) {
    const controller = new AbortController();
    inflight = controller;
    try {
      const response = await transport.sendTurn({
        messages,
        contextKey: state.contextKey,
        sessionId: state.sessionId,
        // A function lets the hook supply the scope as it stands at send time,
        // without rebuilding the conversation on every context change.
        context: typeof context === 'function' ? context() : context,
        model: typeof model === 'function' ? model() : model,
        // A confirmation decision the user made about a proposal the server gated. Omitted when
        // there is none, so an ordinary turn does not carry an empty list.
        confirmations,
        // The call the user confirmed, exactly as it was shown, for the server to execute rather
        // than ask the model to propose it again.
        confirmedCalls,
        deniedCalls,
        signal: controller.signal,
        // Rounds land on the placeholder as they complete, so a slow turn shows what it is
        // doing rather than only that it is busy. `turnFromResponse` replaces the whole turn
        // when the envelope arrives, so nothing has to be reconciled.
        onEvent: (event) => {
          if (event?.type !== 'round') return;
          set({ turns: addRound(state.turns, pending.turnId, event.round) });
        },
      });
      const turns = replaceTurn(state.turns, pending.turnId, turnFromResponse(response, scopeLabel, makeTurnId));
      const sessionId = response?.sessionId ?? state.sessionId;
      if (sessionId) remember(sessionId);
      set({
        turns,
        streaming: false,
        sessionId,
        usage: mergeChatUsage(state.usage, response?.usage),
      });
      // Awaited, so the number the reader opens next is the one that includes the turn
      // they just watched. The server writes its ledger row before replying, so this read
      // cannot miss it.
      await refreshUsage();
      // The settled turn carries the placeholder's id, which is what makes this a
      // replacement; that id is how it is found again here.
      return turns.find((turn) => turn.turnId === pending.turnId) ?? null;
    } catch (error) {
      // A stop is the reader's own doing, so it is reported as one. What the browser raises
      // when a fetch is aborted is a `DOMException` reading "signal is aborted without
      // reason" — accurate, and not a sentence to put in front of someone who just pressed
      // Stop.
      const stopped = controller.signal.aborted;
      // A remembered session the server says belongs to another user is a stale
      // pointer, not a failed turn: the pointer lives in browser storage, so an
      // identity switch (which reloads the page) can leave the next identity sending
      // the previous one's session id. Forget it and ask again with no session, which
      // creates a fresh one. Bounded by `sessionRetried` because the second request
      // carries no session id at all, so this cannot loop.
      if (!stopped && !sessionRetried && error?.code === 'ASSISTANT_SESSION_FORBIDDEN') {
        forget();
        set({ sessionId: null });
        return await submit({ messages, pending, content, attachments, sessionRetried: true });
      }
      const failure = stopped
        ? { correlationId: null, message: 'Stopped before the assistant answered.' }
        : failureOf(error);
      // The failure is the assistant's, so it marks the assistant's turn: the user's message
      // is not a place to report what the provider did. The draft comes back so a transient
      // failure never costs the user their text.
      set({
        turns: markTurnFailed(state.turns, pending.turnId, failure),
        streaming: false,
        draft: content,
        ...(attachments ? { attachments } : {}),
        error: {
          code: stopped ? 'ASSISTANT_TURN_STOPPED' : error?.code ?? 'ASSISTANT_TURN_FAILED',
          message: failure.message,
          correlationId: failure.correlationId,
        },
      });
      return null;
    } finally {
      inflight = null;
    }
  }

  /** Aborts the in-flight provider call; the turn stays retryable. */
  function stop() {
    inflight?.abort();
  }

  /** Rehydrates a stored session; a foreign or unknown session reads as empty. */
  async function loadHistory() {
    if (!state.sessionId || typeof transport.loadHistory !== 'function') return [];
    const history = await transport.loadHistory({ sessionId: state.sessionId, contextKey: state.contextKey });
    const turns = (history?.turns ?? []).flatMap((entry) => turnsFromStoredTurn(entry, scopeLabel, makeTurnId));
    // A history read *fills in* a transcript; it never replaces one that is already on
    // screen. The read is a round trip, and the reader can send their first message inside
    // it — at which point the store's copy is older than what they are looking at, not
    // truer. Replacing it here is how a rehydration that finished late could swallow the
    // turn being answered.
    if (turns.length > 0 && state.turns.length === 0) set({ turns });
    return turns;
  }

  async function refreshUsage() {
    if (typeof transport.getUsage !== 'function') return null;
    try {
      const summary = await transport.getUsage();
      set({ usage: upsertOverallUsage(state.usage, summary) });
      return summary;
    } catch {
      // Usage is reporting, never a reason to fail a turn.
      return null;
    }
  }

  return { getState, subscribe, setDraft, attach, detach, noteRejections, send, retry, confirm, deny, stop, restore, startNew, loadHistory, refreshUsage };
}

/**
 * The user-visible text of a reply.
 *
 * The prompted envelope is `{ "type": "message", "payload": "<markdown>" }`, and a
 * provider routinely puts literal newlines inside that payload — which makes the whole
 * object invalid JSON. A strict parse then fails and the raw envelope is what the user
 * reads, so "degrades to plain text" would have meant exactly the wrong thing: the fix
 * is to recover the payload, not to give up on it.
 *
 * Recovery is deterministic, not a guess. Walking the text and escaping raw control
 * characters *inside string literals* produces valid JSON for the one failure mode the
 * envelope actually has, and the payload is then unescaped by the parser itself.
 */
export function visibleAssistantText(choice) {
  const message = choice?.message ?? {};
  const structured = message.structured_content;
  if (structured && typeof structured.payload === 'string') return structured.payload;

  const content = typeof message.content === 'string' ? message.content : '';
  const parsed = tryParse(content);
  if (parsed && typeof parsed.payload === 'string') return parsed.payload;
  return content;
}

export function turnFromResponse(response, scopeLabel, makeTurnId = () => `turn-${++sequence}`) {
  const choice = response?.choices?.[0];
  const uiActions = response?.uiActions ?? [];
  return {
    turnId: response?.requestId ?? makeTurnId(),
    role: 'assistant',
    text: withoutConsumedRequest(visibleAssistantText(choice), uiActions),
    scopeLabel,
    entityRefs: (response?.entities ?? []).map((entity) => entity.label ?? entity.id).filter(Boolean),
    entities: response?.entities ?? [],
    uiActions,
    // Whether the turn committed a design change. The work surfaces read once and then
    // hold what they drew, so a write is invisible to them until something tells them to
    // look again — which is the difference between "the assistant moved it" and "the
    // assistant says it moved it".
    draftChanged: response?.draftChanged === true,
    usage: response?.usage ?? null,
    status:
      response?.status === 'confirmation_required'
        ? 'CONFIRMATION_REQUIRED'
        : response?.status === 'failed'
          ? 'FAILED'
          : 'COMPLETE',
    // A turn persisted after it failed carries its own error, so a restored transcript shows the
    // failure rather than an empty answer.
    error: response?.error?.message ?? null,
    pendingConfirmations: response?.pendingConfirmations ?? [],
    correlationId: response?.trace?.requestId ?? response?.requestId ?? null,
    // What the assistant actually did, not only what it said. A turn that consults the
    // facility and one that answers from the prompt look identical without this, so a
    // reader cannot tell a grounded answer from an improvised one.
    //
    // Rounds rather than the flat tool list: a turn is several provider calls, and "which
    // tools ran" is a weaker answer than "what happened at each step, and what it cost".
    // The flat list is kept as a fallback for turns stored before rounds existed.
    rounds: Array.isArray(response?.trace?.rounds) ? response.trace.rounds : [],
    toolCalls: Array.isArray(response?.trace?.toolCalls) ? response.trace.toolCalls : [],
    // What the server had to say about the turn itself: a result it truncated to fit, a turn
    // it could not store. They are part of the turn's provenance and were reaching the client
    // only to be dropped.
    notices: Array.isArray(response?.trace?.notices) ? response.trace.notices : [],
    unread: true,
  };
}

/**
 * The request the model wrote into its reply, taken back out of it.
 *
 * The server now removes what it consumed before storing a turn, but turns stored before it did
 * keep the fenced object in their text — and a reader restoring that conversation would go on
 * reading the wire format under an answer that already happened. So the block also goes at
 * display time, for the two shapes that are machinery rather than prose: an envelope, and an
 * object that names a UI action this client declares. Everything else stays, because JSON a
 * model wrote for a person is content, and this is not the layer that decides an answer may
 * not contain braces.
 *
 * `uiActions` is the turn's own record, and a block stating one of them is removed whether or
 * not the object is otherwise recognisable — a turn whose envelope carried the action in some
 * shape this client does not know is still a turn that acted.
 */
export function withoutConsumedRequest(text, uiActions = []) {
  if (typeof text !== 'string' || !text.includes('{')) return text;
  const acted = new Set((uiActions ?? []).map((action) => action?.type).filter(Boolean));

  const stripped = text.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, (block, body) => {
    const parsed = parseObject(body);
    if (!parsed) return block;
    if (Array.isArray(parsed.uiActions)) return '';
    if (acted.has(parsed.type)) return '';
    return uiActionTypeFor(parsed.type, parsed.version) ? '' : block;
  });
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

function turnsFromStoredTurn(entry, scopeLabel, makeTurnId) {
  const turns = [];
  for (const message of entry?.messages ?? []) {
    if (message?.role === 'user') {
      turns.push({ turnId: makeTurnId(), role: 'user', text: message.content ?? '', scopeLabel, entityRefs: [], status: 'COMPLETE', unread: false });
    }
  }
  // `draftChanged` is cleared on the way in: the write it describes is already in the
  // revision, and the surface reading this transcript is reading that same revision now — so
  // re-reading the envelope for each historical write would fetch the answer it already has.
  // The flag is about a turn landing on a surface that read before it, which only a live turn
  // can be.
  if (entry?.response) turns.push({ ...turnFromResponse(entry.response, scopeLabel, makeTurnId), draftChanged: false, unread: false });
  return turns;
}

/**
 * The user turn a turn belongs to: itself, or the last user turn above it.
 *
 * Searching upwards rather than assuming `index - 1` keeps this honest for a transcript
 * where a failure and its message have anything between them.
 */
function userTurnAtOrBefore(turns, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (turns[cursor]?.role === 'user') return cursor;
  }
  return -1;
}

function failureOf(error) {
  return {
    correlationId: error?.correlationId ?? null,
    message: error?.message ?? 'The turn failed.',
  };
}

/** The transcript as the provider sees it: complete turns, no empty content. */
function transcriptMessages(turns) {
  return turns
    .filter((turn) => typeof turn.text === 'string' && turn.text.length > 0)
    .map((turn) => ({ role: turn.role, content: turn.text }));
}

function mergeChatUsage(usage, raw) {
  const existing = usage.find((entry) => entry.scope === CHAT_USAGE_SCOPE) ?? {
    scope: CHAT_USAGE_SCOPE,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cachedOutputTokens: 0,
    quotaTokens: null,
    remainingTokens: null,
    estimated: false,
  };
  // Cached tokens are accumulated beside the totals, never inside them: the provider bills a
  // cached prompt at a fraction of the rate, so "how much of this was already warm" is a
  // different question from "how much did this cost", and both are asked of one conversation.
  const merged = {
    ...existing,
    inputTokens: existing.inputTokens + number(raw?.prompt_tokens),
    outputTokens: existing.outputTokens + number(raw?.completion_tokens),
    totalTokens: existing.totalTokens + number(raw?.total_tokens),
    cachedInputTokens: number(existing.cachedInputTokens) + number(raw?.cached_input_tokens),
    cachedOutputTokens: number(existing.cachedOutputTokens) + number(raw?.cached_output_tokens),
  };
  return [merged, ...usage.filter((entry) => entry.scope !== CHAT_USAGE_SCOPE)];
}

function upsertOverallUsage(usage, summary) {
  const limit = number(summary?.limitTokens) || null;
  const total = number(summary?.totalTokens);
  const entry = {
    scope: OVERALL_USAGE_SCOPE,
    inputTokens: number(summary?.promptTokens),
    outputTokens: number(summary?.completionTokens),
    totalTokens: total,
    cachedInputTokens: number(summary?.cachedInputTokens),
    cachedOutputTokens: number(summary?.cachedOutputTokens),
    quotaTokens: limit,
    remainingTokens: limit === null ? null : Math.max(0, limit - total),
    estimated: false,
  };
  return [entry, ...usage.filter((item) => item.scope !== OVERALL_USAGE_SCOPE)];
}

/** Strict parse, then the same object with string-internal control characters escaped. */
function tryParse(text) {
  if (typeof text !== 'string' || !text.includes('{')) return null;

  const candidates = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  // A reply that wraps the envelope in a sentence: take the outermost braces.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    const parsed = parseObject(candidate);
    if (parsed) return parsed;
    const repaired = parseObject(escapeControlCharsInStrings(candidate));
    if (repaired) return repaired;
    const salvaged = payloadFromEnvelope(candidate);
    if (salvaged !== null) return { payload: salvaged };
  }
  return null;
}

/**
 * Last resort for prose JSON cannot hold even after the control characters are escaped,
 * which in practice means an unescaped `"` the model wrote inside its own answer.
 *
 * Only the `payload` member is ever displayed, so it is taken verbatim from the first
 * `"payload"` key to the last closing quote that ends the object, then unescaped in one
 * pass — a chain of `.replace()` calls would turn an escaped backslash before an `n`
 * into a newline.
 */
function payloadFromEnvelope(text) {
  const match = /"payload"\s*:\s*"([\s\S]*)"\s*[,}]/.exec(text);
  if (!match) return null;
  return match[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape) => {
    if (escape[0] === 'u') return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[escape] ?? escape;
  });
}

function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Escapes raw newlines and tabs that appear *inside* a JSON string.
 *
 * The distinction is the whole point: a newline between fields is legal whitespace and
 * must be left alone, while a newline inside a quoted payload is what breaks the parse.
 * Backslash escapes are tracked so an escaped quote does not end the string early.
 */
export function escapeControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && (char === '\n' || char === '\r' || char === '\t')) {
      out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : '\\t';
      continue;
    }
    out += char;
  }
  return out;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
