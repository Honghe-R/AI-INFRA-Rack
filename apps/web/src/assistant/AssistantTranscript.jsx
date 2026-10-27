import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canApplyProposal, revealExpandedRounds, shouldAutoOpenRounds } from './assistant-state.js';
import { Markdown } from './Markdown.jsx';
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

  // A turn that is still running holds its disclosure open, so rounds are *watched* as they
  // arrive rather than discovered afterwards — which is the whole reason they are streamed.
  // A finished turn is left exactly as the reader left it: the flag only ever opens, so
  // closing it mid-turn is not undone by the next round, and the answer does not snap shut
  // the moment it lands.
  const streaming = turn.status === 'STREAMING';
  const [open, setOpen] = useState(streaming);
  /**
   * Whether the reader has made their own decision about this disclosure.
   *
   * Rounds land every few seconds while the model works, so an auto-open that kept winning
   * would make the head unclickable for exactly the turn the reader most wants out of the
   * way. A click on the summary is the reader's own act — the `open` prop moves the element
   * without one — so it settles the question for the rest of the turn.
   */
  const readerDecidedRef = useRef(false);
  useEffect(() => {
    if (shouldAutoOpenRounds({ streaming, readerDecided: readerDecidedRef.current })) setOpen(true);
  }, [streaming]);

  const detailsRef = useRef(null);
  // Whether the change being rendered was the streaming open rather than a reader's
  // click. The disclosure is opened by data arriving as well as by the summary, and only
  // the reader's own action should move their scroll position.
  const openingByStreamRef = useRef(streaming);

  /**
   * Brings the rounds into view when the reader opens them.
   *
   * The transcript is scrolled to its end, so a turn sits against the bottom edge — and a
   * disclosure below it has nowhere to grow *but* downwards, off the end of the visible
   * area. Without this the panel expands and the content the reader asked for is below the
   * fold: it looks like nothing happened. `scrollIntoView` walks up to the first scrollable
   * ancestor, which is the transcript, so it does not need a handle on the list or any
   * knowledge of the composer's own scroll container.
   *
   * A layout effect so the position is right before the paint, like the transcript's own
   * scroll-to-end; otherwise the panel is painted off screen and then jumps. The decision
   * itself lives in `revealExpandedRounds` so it can be asserted without a browser.
   */
  useLayoutEffect(() => {
    // Read and clear in the same pass: the flag describes the change being committed, so
    // leaving it set after a streaming open would suppress the reader's *next* open — the
    // one that actually needs the scroll, and the one they would report as broken.
    const openedByStream = openingByStreamRef.current;
    openingByStreamRef.current = false;
    revealExpandedRounds({ open, openedByStream, element: detailsRef.current });
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
      onToggle={(event) => {
        // `onToggle` fires for the streaming open too, so the flag is set only when the
        // browser changed it under the reader rather than because of them.
        if (event.currentTarget.open && streaming && !readerDecidedRef.current) openingByStreamRef.current = true;
        setOpen(event.currentTarget.open);
      }}
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
        // The reader's own activation, which is what settles the disclosure open or closed
        // for the rest of the turn. Nothing else sets this: the `open` prop moves the element
        // without a click.
        onClick={() => {
          readerDecidedRef.current = true;
        }}
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

                The last round has no calls — its words *are* the reply, already above — so a
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

export function AssistantTranscript({
  turns = [],
  restoring = false,
  onApplyProposal = () => {},
  onRetryTurn = null,
  onConfirmTurn = null,
  onDenyTurn = null,
  grantedKeys = null,
  onEntitySelect = null,
  onEntityHover = null,
  onEntityLeave = null,
}) {
  const listRef = useRef(null);

  /**
   * Keeps the newest turn in view.
   *
   * The composer mounts this list every time it expands — minimizing unmounts it and the
   * launcher stands in its place — so the effect running on mount *is* the "scroll to the
   * bottom when expanded" behaviour, and the same one call covers a turn arriving while the
   * composer is already open. A layout effect rather than an effect for the reason the
   * message area's height uses one: the position has to be right before the paint, or the
   * panel opens showing the top of the conversation and jumps.
   *
   * `scrollHeight` rather than `scrollIntoView` on the last turn: the list is the only thing
   * here that scrolls, and naming the target keeps the composer's layout out of it.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
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
    <ol className="transcript" aria-label="Conversation" aria-live="polite" ref={listRef}>
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
              {turn.text ? (
                <div className="turn__text">
                  <Markdown
                    text={turn.text}
                    entities={turn.entities}
                    onSelectEntity={onEntitySelect}
                    onEntityHover={onEntityHover}
                    onEntityLeave={onEntityLeave}
                  />
                </div>
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

              <TurnRounds
                turn={turn}
                onEntitySelect={onEntitySelect}
                onEntityHover={onEntityHover}
                onEntityLeave={onEntityLeave}
              />

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
function ConfirmationCard({ pending, onConfirm, onDeny }) {
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
        <button type="button" className="confirmation__confirm" onClick={onConfirm}>
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
