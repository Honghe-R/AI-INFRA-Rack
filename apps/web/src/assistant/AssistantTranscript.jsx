import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canApplyProposal, revealExpandedRounds } from './assistant-state.js';
import { Markdown } from './Markdown.jsx';
import { revealReply, nearTranscriptEnd, followTranscriptEnd } from './reply-display.js';
import { getTool } from '../state/tool-registry.js';
import { uiActionTypeFor } from './ui-actions.js';
import { Icon } from '../shell/icons.jsx';

/**
 * The conversation surface: part of the same shell-owned overlay, not a new
 * open-view tab.
 *
 * Every turn displays the scope it answered in, so an answer stays attributable
 * after the active tool changes. A turn that proposes a design change renders as
 * a proposal card naming the owning tool and is **never applied automatically**;
 * applying it still goes through the owning tool's command and permission.
 *
 * The list is the only live region, and it holds complete turns — streamed token
 * updates are never announced.
 *
 * Both sides of a turn are turns. While the provider is working, the assistant's turn is
 * there saying so; if it fails, that same turn carries the error and the retry. The user's
 * message is only ever what the user wrote, which is what makes the transcript readable as
 * a conversation after something has gone wrong.
 *
 * The conversation is read from its end, so this is where the newest turn is kept in view:
 * the composer expands onto the most recent message, and the wait, the reply, and a failure
 * all arrive below whatever is already there.
 */
/**
 * What the assistant did before answering, round by round.
 *
 * A turn is several provider calls: the model asks for a tool, the server runs it, and the
 * model is asked again with the result. Only the last of those produces the reply, so
 * without this a turn that read the facility and one that answered from the prompt are
 * indistinguishable — and the reader cannot tell a grounded answer from an improvised one.
 *
 * Collapsed by default, because it is provenance and the answer is what was asked for; a
 * `<details>` rather than a click handler so the disclosure is keyboard- and
 * screen-reader-native without any state to keep in step.
 *
 * The counts are the honest summary: how many rounds, how many calls, and how long the
 * model took across all of them. A call never reports its arguments — the trace carries
 * names, timings, and outcomes — so a geometry payload cannot appear here.
 */
function TurnRounds({ turn, onEntitySelect = null, onEntityHover = null, onEntityLeave = null }) {
  const rounds = turn.rounds ?? [];
  const calls = rounds.flatMap((round) => round.calls ?? []);
  const providerMs = rounds.reduce((total, round) => total + (round.providerMs ?? 0), 0);
  // What the turn cost rides the foot rather than the head: the head is what the record
  // holds, and the cost is the detail underneath it.
  const usage = turn.usage ?? null;
  const wrote = calls.some((call) => call.wrote === true);
  const notices = Array.isArray(turn.notices) ? turn.notices : [];

  // Keep diagnostics available without competing with the answer, including live turns.
  const streaming = turn.status === 'STREAMING';
  const [open, setOpen] = useState(false);
  const detailsRef = useRef(null);
  const readerOpenedRef = useRef(false);
  useLayoutEffect(() => {
    if (readerOpenedRef.current) {
      revealExpandedRounds({ open, openedByStream: false, element: detailsRef.current });
      readerOpenedRef.current = false;
    }
  }, [open]);

  // Turns stored before rounds existed still carry the flat list. Showing it costs nothing
  // and is the difference between an old conversation disclosing its tools and losing them.
  if (rounds.length === 0) {
    if (!turn.toolCalls?.length) return null;
    return (
      <div className="turn__tools">
        <span className="turn__tools-label">
          {turn.toolCalls.length === 1 ? 'Used' : `Used ${turn.toolCalls.length} tools`}
        </span>
        <ul className="turn__tools-list">
          {turn.toolCalls.map((call, index) => (
            <li key={`${call.name}-${index}`} className="turn__tool">
              <code>{call.name}</code>
              {call.truncated ? <span className="turn__tool-note">result truncated</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <details
      className="turn__rounds"
      ref={detailsRef}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {/*
        The whole row is the control, not the two words in it. `summary` is the
        disclosure element, so making it span the full width is what turns the row into
        the hit target — the count, the time, and the empty space beside them all toggle.
        The list is a sibling, so clicking a round inside it never collapses the
        disclosure.
      */}
      <summary
        className="turn__rounds-summary"
        onClick={() => { readerOpenedRef.current = true; }}
      >
        {streaming ? <span className="turn__rounds-live">live</span> : null}
        <span className="turn__rounds-count">
          {rounds.length === 1 ? '1 round' : `${rounds.length} rounds`}
          {calls.length > 0 ? ` · ${calls.length === 1 ? '1 tool' : `${calls.length} tools`}` : ''}
          {wrote ? ' · changed the draft' : ''}
        </span>
        <span className="turn__rounds-time">
          {(providerMs / 1000).toFixed(1)}s in the model
        </span>
      </summary>
      <div className="turn__rounds-body">
        <ol className="turn__rounds-list">
          {rounds.map((round) => (
            <li key={round.iteration} className="turn__round">
              <span className="turn__round-index">Round {round.iteration}</span>
              <span className="turn__round-meta">
                {(round.providerMs / 1000).toFixed(1)}s
                {typeof round.tokens === 'number' ? ` · ${round.tokens.toLocaleString('en-US')} tokens` : ''}
              </span>
              {/*
                What the model said while it worked, which is the only thing in a turn that
                states an approach: the calls say what it looked at, and the answer says what
                it concluded, but neither says what it was after. Rendered as markdown with
                the turn's own entities, so a name it mentioned is the same link here as in
                the reply.

                The last round has no calls — its words *are* the reply, shown below — so a
                call-less round is not repeated. Reasoning is the provider's separate thinking
                channel: it accompanies the answer rather than restating it, so it is shown
                wherever the provider supplied one.
              */}
              {round.reasoning ? (
                <p className="turn__round-reasoning">
                  <span className="turn__round-reasoning-label">thinking</span>
                  {round.reasoning}
                </p>
              ) : null}
              {round.text && (round.calls ?? []).length > 0 ? (
                <div className="turn__round-said">
                  <Markdown
                    text={round.text}
                    entities={turn.entities}
                    onSelectEntity={onEntitySelect}
                    onEntityHover={onEntityHover}
                    onEntityLeave={onEntityLeave}
                  />
                </div>
              ) : null}
              {round.narrationTruncated ? <span className="turn__round-note">narration truncated</span> : null}
              {(round.calls ?? []).length > 0 ? (
                <ul className="turn__round-calls">
                  {round.calls.map((call, index) => (
                    <li key={`${call.name}-${index}`} className="turn__call">
                      <code>{call.name}</code>
                      <span className={`turn__call-outcome turn__call-outcome--${call.outcome ?? 'ok'}`}>
                        {call.outcome === 'confirmation_required'
                          ? 'needs confirmation'
                          : call.outcome === 'denied'
                            ? 'you declined'
                            : call.outcome === 'degraded'
                              ? 'truncated result'
                              : call.outcome === 'refused'
                                ? 'refused'
                                : `${call.ms}ms`}
                      </span>
                      {/* The one call outcome that is a change to the design rather than a
                          read of it, which is what the reader asked for and cannot see in
                          the reply alone. */}
                      {call.wrote ? <span className="turn__call-wrote">changed the draft</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                // A round with no calls is the one that answered.
                <span className="turn__round-final">answered</span>
              )}
            </li>
          ))}
        </ol>
        {/*
          What the turn cost and which request it was. Both are the questions asked of a
          turn after the fact — "was that expensive" and "which line in the log is this" —
          and both are already in the envelope, so leaving them out made the reader go and
          find them. `notices` are the server's own statements about the turn (a result it
          had to truncate, a turn it could not store); they were invisible before.
        */}
        {turn.usage || turn.correlationId || notices.length > 0 ? (
          <div className="turn__rounds-foot">
            {usage ? (
              <span className="turn__rounds-cost">
                {`in ${(usage.prompt_tokens ?? 0).toLocaleString('en-US')} · out ${(usage.completion_tokens ?? 0).toLocaleString('en-US')} tokens`}
                {usage.cached_input_tokens > 0 ? ` · ${usage.cached_input_tokens.toLocaleString('en-US')} cached` : ''}
              </span>
            ) : null}
            {turn.correlationId ? <span className="turn__rounds-request">request {turn.correlationId}</span> : null}
            {notices.map((notice, index) => (
              <span key={notice.code ?? index} className="turn__rounds-notice">
                {notice.message ?? notice.code}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ReplyText({ turn, onEntitySelect, onEntityHover, onEntityLeave }) {
  const liveRef = useRef(turn.status === 'STREAMING');
  const [display, setDisplay] = useState(null);
  useLayoutEffect(() => {
    if (turn.status === 'STREAMING') { liveRef.current = true; setDisplay(null); return; }
    if (!liveRef.current || !turn.text) return;
    liveRef.current = false;
    // Older/restored answers and reduced-motion users see the complete answer immediately.
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    return revealReply(turn.text, (text, done) => setDisplay(done ? null : text));
  }, [turn.status, turn.text]);
  if (!turn.text) return null;
  return <div className="turn__text" aria-live="off" aria-busy={display !== null}>
    <Markdown text={display ?? turn.text} entities={turn.entities}
      onSelectEntity={onEntitySelect} onEntityHover={onEntityHover} onEntityLeave={onEntityLeave} />
  </div>;
}

export function AssistantTranscript({
  turns = [],
  restoring = false,
  onApplyProposal = () => {},
  onRetryTurn = null,
  onConfirmTurn = null,
  confirmationDisabled = false,
  onDenyTurn = null,
  grantedKeys = null,
  onEntitySelect = null,
  onEntityHover = null,
  onEntityLeave = null,
}) {
  const listRef = useRef(null);

  const followingRef = useRef(true);
  const previousCountRef = useRef(turns.length);
  useLayoutEffect(() => {
    const list = listRef.current;
    // A newly submitted message starts following again. Streaming updates do not
    // interrupt someone who has deliberately scrolled back to read older messages.
    if (turns.length > previousCountRef.current) followingRef.current = true;
    previousCountRef.current = turns.length;
    followTranscriptEnd(list, followingRef.current);
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => followTranscriptEnd(list, followingRef.current));
    observer.observe(list);
    for (const item of list.children) observer.observe(item);
    return () => observer.disconnect();
  }, [turns]);

  if (turns.length === 0) {
    // Nothing to read: the composer alone is the surface, with no placeholder
    // sentence competing with the active tool for attention. The one thing worth
    // saying is that a stored conversation is on its way.
    if (!restoring) return null;
    return (
      <div className="transcript transcript--empty" aria-label="Conversation" role="status">
        <p>Restoring this conversation…</p>
      </div>
    );
  }

  return (
    <ol className="transcript" aria-label="Conversation" aria-live="polite" ref={listRef}
      onScroll={event => { followingRef.current = nearTranscriptEnd(event.currentTarget); }}>
      {turns.map((turn, index) => {
        // The composer header already states the active context, so a turn repeats
        // it only when it answered in a different scope from the one before it —
        // which is the case attribution actually has to survive.
        const showScope = index > 0 && (turns[index - 1].scopeLabel ?? null) !== (turn.scopeLabel ?? null);
        const role = (turn.role ?? 'assistant').toLowerCase();
        return (
          <li key={turn.turnId} className={`turn turn--${role}`}>
            {showScope ? <p className="turn__scope">{turn.scopeLabel ?? 'unknown scope'}</p> : null}
            <div className="turn__bubble">
              <TurnRounds
                turn={turn}
                onEntitySelect={onEntitySelect}
                onEntityHover={onEntityHover}
                onEntityLeave={onEntityLeave}
              />
              {turn.text || turn.status === 'STREAMING' ? (
                <ReplyText turn={turn} onEntitySelect={onEntitySelect} onEntityHover={onEntityHover} onEntityLeave={onEntityLeave} />
              ) : null}

              {/*
                A turn whose entire reply was a request has no words of its own: the model wrote
                the action instead of asking for it, the server read it and took it out of the
                reply, and the bubble would otherwise be blank under a canvas that visibly
                changed. So the answer position states what was done, in the action's own
                words — the registry's description, never prose invented on the assistant's
                behalf.
              */}
              {!turn.text && (turn.uiActions ?? []).length > 0 ? (
                <ul className="turn__actions">
                  {turn.uiActions.map((action, index) => (
                    <li key={action.id ?? `${action.type}-${index}`}>
                      {uiActionTypeFor(action.type, action.version)?.description ?? action.type}
                    </li>
                  ))}
                </ul>
              ) : null}

              {turn.entityRefs?.length ? <p className="turn__refs">{turn.entityRefs.join(' · ')}</p> : null}



              {/* The wait, in the assistant's own bubble: that is where the answer will
                  appear, and the transcript is the only live region, so a reader is told
                  once rather than by a second indicator somewhere else. */}
              {turn.status === 'STREAMING' ? (
                <p className="turn__thinking">
                  Assistant is thinking
                  {/* The dots carry the motion and the words carry the meaning, so the
                      accessible text is the sentence and nothing is announced repeatedly. */}
                  <span className="turn__thinking-dots" aria-hidden="true">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                </p>
              ) : null}

              {/* A failure is the assistant's turn, so it reads here and never inside the
                  message the user wrote. */}
              {turn.status === 'FAILED' ? (
                <p className="turn__failed">
                  {turn.error ?? 'The turn failed.'}
                  {turn.correlationId ? <span className="turn__correlation"> correlation {turn.correlationId}</span> : null}
                </p>
              ) : null}

              {turn.status === 'FAILED' && onRetryTurn ? (
                <button type="button" className="turn__retry" onClick={() => onRetryTurn(turn.turnId)}>
                  Retry
                </button>
              ) : null}

              {/* A confirmation-gated write stopped before its handler, so the turn is not a
                  failure and not an answer: it is a question the reader has to answer. Without
                  this card the turn stalled on "needs confirmation" with nothing to click. */}
              {turn.status === 'CONFIRMATION_REQUIRED' && (turn.pendingConfirmations ?? []).length > 0 ? (
                <ConfirmationCard
                  pending={turn.pendingConfirmations}
                  disabled={confirmationDisabled}
                  onConfirm={() => onConfirmTurn?.(turn.turnId)}
                  onDeny={() => onDenyTurn?.(turn.turnId)}
                />
              ) : null}

              {/* Nothing to copy on a turn that has no text of its own: a placeholder, or a
                  failure, whose text is the error rather than an answer. */}
              {turn.text ? <CopyButton text={turn.text} /> : null}

              {turn.proposal ? <ProposalCard proposal={turn.proposal} grantedKeys={grantedKeys} onApply={onApplyProposal} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Copies the visible text of a turn. The control is revealed on hover and on
 * keyboard focus, and keeps its place in the layout so nothing shifts when it
 * appears. A clipboard that is unavailable (an insecure origin, an older browser)
 * simply leaves the button unacknowledged rather than throwing into the transcript.
 */
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const label = copied ? 'Copied' : 'Copy message';

  async function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text ?? '');
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className="turn__copy" aria-label={label} title={label} onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/**
 * The question a confirmation-gated write leaves the reader.
 *
 * A write is refused before its handler when the caller has not confirmed it, so the turn ends
 * with `pendingConfirmations` and nothing applied. The card used to say so with the tool's name
 * and its arguments as JSON — `set_geometry {"entity_id":"Central Chiller Plant",…}` — which asks
 * a reader to approve a function they never called, in a payload they cannot read. The server
 * sends a sentence instead, written by the surface that knows what the arguments mean and what
 * the objects are called, and what is left here is the decision and what it decides about.
 *
 * Both answers are real answers. Declining is handed to the server, not swallowed here, because a
 * card that merely disappeared would be drawn again from the same proposal: the model has to be
 * told that the reader said no, or it will ask the same question again.
 */
function ConfirmationCard({ pending, onConfirm, onDeny, disabled = false }) {
  const single = pending.length === 1 ? pending[0] : null;
  const summaryOf = (entry) => entry?.summary ?? 'A change to this revision';
  return (
    <section className="confirmation" aria-label="Confirmation required">
      <p className="confirmation__note">
        {single
          ? `${summaryOf(single)}. Nothing has been applied yet.`
          : `${pending.length} changes are waiting for your confirmation. Nothing has been applied yet.`}
      </p>
      {pending.length > 1 ? (
        <ul className="confirmation__list">
          {pending.map((entry, index) => (
            <li key={entry.callId ?? `${index}`} className="confirmation__item">
              {summaryOf(entry)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="confirmation__actions">
        <button type="button" className="confirmation__confirm" onClick={onConfirm} disabled={disabled}>
          {single ? 'Apply this change' : `Apply ${pending.length} changes`}
        </button>
        <button type="button" className="confirmation__deny" onClick={onDeny}>
          {single ? 'Do not apply' : 'Apply none'}
        </button>
      </div>
    </section>
  );
}

function ProposalCard({ proposal, grantedKeys, onApply }) {
  const tool = getTool(proposal.toolId);
  const verdict = canApplyProposal(proposal, grantedKeys);

  return (
    <section className="proposal" aria-label="Proposed change">
      <h3 className="proposal__title">Proposed change in {tool?.label ?? proposal.toolId}</h3>
      <p className="proposal__summary">{proposal.summary}</p>
      <p className="proposal__note">This is never applied automatically. Applying it runs the owning tool's command and validation.</p>
      <button
        type="button"
        className="proposal__apply"
        aria-disabled={verdict.allowed ? undefined : 'true'}
        title={verdict.allowed ? undefined : verdict.reason}
        onClick={() => {
          if (verdict.allowed) onApply(proposal);
        }}
      >
        Apply in {tool?.label ?? proposal.toolId}
        {verdict.allowed ? null : <span className="visually-hidden"> — unavailable: {verdict.reason}</span>}
      </button>
    </section>
  );
}
