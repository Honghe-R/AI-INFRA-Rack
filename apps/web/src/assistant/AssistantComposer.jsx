import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../shell/icons.jsx';
import { Watermark } from '../shell/Watermark.jsx';
import { AssistantTranscript } from './AssistantTranscript.jsx';
import { AssistantConnection } from './AssistantConnection.jsx';
import { ASSISTANT_MAX_PX, ASSISTANT_MIN_PX } from '../state/ui-context.js';
import { clampOffset, dragDelta, isDrag, nudgeOffset, readStoredOffset, storeOffset } from './launcher-position.js';
import {
  DEFAULT_ATTACHMENT_POLICY,
  budgetHint,
  canSend,
  describeUsage,
  shouldSend,
  usageFor,
} from './assistant-state.js';

/**
 * The shell-owned assistant composer.
 *
 * It owns no route, no open-view tab, and no domain data: it is a frame that
 * floats over the active tool's work surface and re-scopes to whatever tool,
 * selection, and revision is active (ui-pattern.md, "Workspace Assistant").
 *
 * Accessibility commitments:
 *  * the message area is a labelled textbox whose name includes the active tool;
 *  * focus order is message area, upload, token usage, Send;
 *  * the token usage control exposes its expanded state;
 *  * new turns are announced politely, while streamed token updates are not —
 *    the transcript is the only live region and it carries complete turns.
 */
export function AssistantComposer({
  toolLabel = 'Workspace',
  scopeLabelText,
  open = false,
  onToggleOpen = () => {},
  draft = '',
  onDraftChange = () => {},
  onSend = () => {},
  onStop = () => {},
  streaming = false,
  attachments = [],
  uploading = false,
  attachmentPolicy = DEFAULT_ATTACHMENT_POLICY,
  attachmentRejections = [],
  onAttach = () => {},
  onDetach = () => {},
  usage = [],
  provider = null,
  models = [],
  model = null,
  onModelChange = null,
  permissionMode = null,
  developer = null,
  developerPatchUrl = null,
  onPermissionModeChange = null,
  connectionClient = null,
  connectionPending = false,
  connectionError = null,
  onConnectionChange = () => {},
  width = null,
  onResize = () => {},
  turns = [],
  restoring = false,
  onNewSession = null,
  onApplyProposal = () => {},
  onRetryTurn = null,
  onConfirmTurn = null,
  onDenyTurn = null,
  onEntitySelect = null,
  onEntityHover = null,
  onEntityLeave = null,
  // The dispatcher's system notices: a stale or failed UI action is reported here
  // rather than thrown into the conversation.
  uiActionNotices = [],
  grantedKeys = null,
  maxChars = 8000,
}) {
  const [usageOpen, setUsageOpen] = useState(false);
  const textareaRef = useRef(null);
  const usageButtonRef = useRef(null);
  const hint = budgetHint(draft.length, maxChars);
  const setupBlocked = connectionPending || Boolean(connectionError) || provider?.configured === false;
  const sendable = !setupBlocked && canSend({ draft, attachments, streaming, uploading });

  /**
   * Where the collapsed launcher has been dragged to.
   *
   * The composer is an overlay on the canvas, so the launcher may be moved off the
   * bottom edge and parked wherever it is out of the way — the work it covers is the
   * work the reader is trying to see. The offset is a viewport delta rather than a
   * layout position, and it is remembered so a reader who moved it once does not have
   * to move it again on every reload.
   */
  const [launcherOffset, setLauncherOffset] = useState(() => readStoredOffset());
  // Also state, because it drives rendering: while true the slot drops its transition so
  // the launcher tracks the pointer instead of easing behind it.
  const [launcherDragging, setLauncherDragging] = useState(false);
  const launcherRef = useRef(null);
  // A gesture, not React state: these change on every pointer move, and re-rendering the
  // composer for each one would fight the pointer.
  const gestureRef = useRef(null);
  // Set when a drag ends, so the click the browser synthesises afterwards is swallowed
  // once. A ref rather than state because the click arrives in the same turn.
  const suppressClickRef = useRef(false);

  const persistOffset = (next) => {
    setLauncherOffset(next);
    storeOffset(next);
  };

  /**
   * How far the launcher may move, as bounds on the offset.
   *
   * The rendered rect already carries the current offset — the transform moves the box —
   * so measuring where it sits *now* and clamping against that would cancel the very
   * movement being clamped. Subtracting the offset recovers the resting box, and the
   * bounds are then stable for the whole gesture.
   */
  const launcherBounds = (rect, offset) => {
    if (!rect) return null;
    const rest = { left: rect.left - offset.x, right: rect.right - offset.x, top: rect.top - offset.y, bottom: rect.bottom - offset.y };
    const margin = 8;
    return {
      minX: margin - rest.left,
      maxX: window.innerWidth - rest.right - margin,
      minY: margin - rest.top,
      maxY: window.innerHeight - rest.bottom - margin,
    };
  };

  const beginLauncherDrag = (event) => {
    // The primary button only: a right-click or a middle-click is not a drag.
    if (event.button !== undefined && event.button !== 0) return;
    const rect = launcherRef.current?.getBoundingClientRect();
    gestureRef.current = {
      from: { x: event.clientX, y: event.clientY },
      base: launcherOffset,
      bounds: launcherBounds(rect, launcherOffset),
      moved: false,
      last: null,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveLauncherDrag = (event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const delta = dragDelta(gesture.from, { x: event.clientX, y: event.clientY });
    if (!delta) return;
    // A few pixels of movement is a shaky click, not a drag. Latching it keeps a click
    // that twitched from also being read as a reposition.
    if (!gesture.moved && !isDrag(delta)) return;
    gesture.moved = true;
    if (!gesture.active) {
      gesture.active = true;
      setLauncherDragging(true);
    }
    const next = clampOffset(
      { x: gesture.base.x + delta.x, y: gesture.base.y + delta.y },
      gesture.bounds,
    );
    // Kept on the gesture as well as in state: `endLauncherDrag` runs from the same
    // closure that started it, so it would otherwise persist the offset it captured at
    // pointer-down rather than the one the drag ended on.
    gesture.last = next;
    setLauncherOffset(next);
  };

  const endLauncherDrag = (event) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setLauncherDragging(false);
    event?.currentTarget?.releasePointerCapture?.(event.pointerId);
    // Only a real drag is recorded. A click leaves the launcher where it was, and
    // writing storage on every click would be a write per open.
    if (gesture?.moved && gesture.last) {
      persistOffset(gesture.last);
      // A drag ends with a click event on the button. Consumed once, so the launcher is
      // not also treated as pressed — the gesture was a move, not a request to open.
      suppressClickRef.current = true;
    }
  };

  // Arrow keys move the launcher, so the same reach is available without a pointer.
  const moveLauncherWithKeyboard = (event) => {
    const rect = launcherRef.current?.getBoundingClientRect();
    const next = nudgeOffset(launcherOffset, event.key, { bounds: launcherBounds(rect, launcherOffset) });
    if (!next) return;
    event.preventDefault();
    persistOffset(next);
  };
  // Opening the composer from the keyboard moves focus into the message area, so
  // the control that opened it is not left as the focus owner.
  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  /**
   * The message area is as tall as what has been typed into it, up to a limit, and then it
   * scrolls.
   *
   * A fixed height is wrong in both directions. One line high, a three-line message is read
   * through a slot the width of a line, which is no way to check what you are about to send;
   * tall enough for the longest message anyone writes, the composer is a mostly empty box
   * covering the work surface the assistant is talking about. So it grows with its content and
   * stops at the `max-height` the stylesheet declares — about five lines — past which it
   * scrolls, because a composer that keeps growing eventually hides the thing being asked
   * about.
   *
   * `useLayoutEffect`, not `useEffect`: the height has to be right before the browser paints,
   * or a keystroke that adds a line paints at the old height and the box visibly jumps.
   *
   * The height is set to `auto` before measuring, and that is load-bearing rather than
   * defensive. A box already at its maximum would report `scrollHeight` as that maximum, so
   * deleting a line could never make it smaller again — the composer would grow and never
   * shrink.
   */
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return undefined;

    const measure = () => {
      element.style.height = 'auto';
      // The cap comes from the stylesheet, resolved to pixels, so `max-height: 9em` there is
      // the only place the limit is written down and it still scales with the font size.
      const cap = Number.parseFloat(getComputedStyle(element).maxHeight);
      const wanted = element.scrollHeight;
      element.style.height = `${Number.isFinite(cap) ? Math.min(wanted, cap) : wanted}px`;
    };
    measure();

    // A narrower composer wraps the same text onto more lines, and the box has to grow to
    // match — the window resizing is not the only way that happens; the sidebar collapsing
    // changes it too. The observer watches the element's own width, and re-measuring changes
    // only its height, so the guard against reacting to our own writes is the width check.
    if (typeof ResizeObserver !== 'function') return undefined;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [draft, open]);

  /**
   * Resizing the composer.
   *
   * The frame is centred, so widening it by N moves each edge out by N/2 — following the
   * pointer with the left edge therefore means growing by twice the distance dragged,
   * and stopping where the pointer stops.
   *
   * Listeners go on `window` rather than the handle because a fast drag outruns the
   * element and the pointer stops being over it. `pointerup` and `pointercancel` both
   * end the gesture, so a cancelled drag cannot leave the composer stuck to the cursor.
   */
  const beginResize = (event) => {
    if (typeof width !== 'number') return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent) => onResize(startWidth + (startX - moveEvent.clientX) * 2);
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const resizeWithKeyboard = (event) => {
    if (typeof width !== 'number') return;
    // The handle is on the left edge, so left arrow widens and right arrow narrows.
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onResize(width + 40);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onResize(width - 40);
    }
  };

  // "provider · model". The provider is the endpoint's host — the service actually
  // answering — not the protocol it speaks; the protocol is worth a tooltip and not a
  // label, because "openai-compatible · deepseek-chat" tells a reader nothing about
  // whose model it is. Falls back to whichever half is known, and to nothing at all
  // when neither is.
  //
  // When a selector is shown the chip drops the model and keeps only the host: the
  // selector already names the model, and leaving the deployment's *default* in the chip
  // made the composer say two different models at once the moment one was changed.
  const hasModelChoice = models.length > 1 && Boolean(onModelChange);
  const fileInputRef = useRef(null);

  const providerLabel = [provider?.host, hasModelChoice ? null : provider?.model].filter(Boolean).join(' · ');
  const providerTitle = [provider?.host, provider?.model, provider?.provider && `over ${provider.provider}`]
    .filter(Boolean)
    .join(' · ');

  if (!open) {
    return (
      <div className="assistant assistant--collapsed">
        {/*
          The drag offset lives on this wrapper, not on the button. The button already
          transforms itself on hover, and both would write `translate` — the hover would
          win and the launcher would snap back to its resting place under the pointer.
          Keeping them on separate elements also means the drag is not animated.
        */}
        <div
          className="assistant__launcher-slot"
          style={{ transform: `translate(${launcherOffset.x}px, ${launcherOffset.y}px)` }}
          data-dragging={launcherDragging ? 'true' : undefined}
        >
          <button
            type="button"
            ref={launcherRef}
            className="assistant__launcher"
            aria-expanded="false"
            onClick={(event) => {
              // A drag is not an open. The gesture already moved the launcher, and opening
              // the composer as well would make the panel jump to wherever it was parked —
              // the opposite of what dragging it out of the way asked for.
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                event.preventDefault();
                return;
              }
              onToggleOpen(true);
            }}
            onPointerDown={beginLauncherDrag}
            onPointerMove={moveLauncherDrag}
            onPointerUp={endLauncherDrag}
            onPointerCancel={endLauncherDrag}
            onKeyDown={moveLauncherWithKeyboard}
            // Announced as movable rather than merely clickable, and the arrow keys below
            // are what make that true without a pointer.
            title="Drag to move, or use the arrow keys"
          >
            <Icon name="sparkle" size={15} /> Ask about {toolLabel}
            {turns.some((turn) => turn.unread) ? <span className="assistant__unread" aria-label="unread replies"> •</span> : null}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="assistant">
      <section
        className="assistant__frame"
        aria-label="Workspace assistant"
        style={typeof width === 'number' ? { width: `${width}px` } : undefined}
        // Scoped to the composer rather than the document: with the listener on `window`,
        // Escape pressed inside a dialog or a menu elsewhere in the shell would collapse
        // the chat as well as closing what the reader was actually dismissing.
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          // The token popover is the nearest thing to dismiss, so it goes first.
          if (usageOpen) {
            event.stopPropagation();
            setUsageOpen(false);
            return;
          }
          event.stopPropagation();
          onToggleOpen(false);
        }}
      >
        <Watermark />
        {/* A resize affordance that is also a keyboard control: the window-splitter
            pattern, so the panel is not mouse-only. */}
        <div
          className="assistant__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the assistant"
          aria-valuenow={typeof width === 'number' ? width : undefined}
          aria-valuemin={ASSISTANT_MIN_PX}
          aria-valuemax={ASSISTANT_MAX_PX}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
        />
        {/* An open composer needs a way back to the launcher. Without it the only
            route to collapse was the control that opened it, which is no longer on
            screen (ui-pattern.md: the composer "opens, collapses, and takes focus
            from the keyboard"). */}
        <header className="assistant__head">
          <div className="assistant__head-meta">
            <p className="assistant__scope">Context: {scopeLabelText}</p>
            {/*
              Which model is answering. The server owns provider selection, so this is
              read from it rather than configured in the bundle — a deployment that
              switches gateway or model relabels itself, and a reviewer can see what is
              behind the box without any credential being present in the page.
            */}
            {providerLabel ? (
              <span className="assistant__provider" title={providerTitle || undefined}>
                {providerLabel}
              </span>
            ) : null}
            {/*
              Only when there is a choice to make. A menu of one is a control that cannot
              do anything, and a deployment that names no models runs its configured one —
              which the chip above already reports.
            */}
            {hasModelChoice ? (
              <label className="assistant__model">
                <span className="visually-hidden">Model</span>
                <select
                  className="assistant__model-select"
                  value={model ?? provider?.model ?? ''}
                  onChange={(event) => onModelChange(event.target.value)}
                >
                  {models.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="assistant__head-actions">
            {onNewSession ? (
              <button
                type="button"
                className="assistant__new"
                title="Start a new conversation"
                onClick={() => onNewSession()}
              >
                <Icon name="plus" size={14} /> New chat
              </button>
            ) : null}
            <button
              type="button"
              className="assistant__collapse"
              aria-label="Minimize assistant"
              title="Minimize assistant"
              onClick={() => onToggleOpen(false)}
            >
              <Icon name="chevronDown" size={14} />
            </button>
          </div>
        </header>

        {connectionClient ? <AssistantConnection client={connectionClient} forceSetup={!connectionPending && provider?.configured === false}
          onChanged={onConnectionChange} disabled={streaming} /> : null}
        {connectionPending ? <p className="assistant__notices" role="status">Loading model connection…</p> : null}
        {connectionError ? <p className="assistant__notices" role="alert">{connectionError} <button type="button" onClick={onConnectionChange}>Reload connection info</button></p> : null}

        <AssistantTranscript
          turns={turns}
          restoring={restoring}
          onApplyProposal={onApplyProposal}
          onRetryTurn={onRetryTurn}
          onConfirmTurn={onConfirmTurn}
          confirmationDisabled={permissionMode === 'read_only' || streaming}
          onDenyTurn={onDenyTurn}
          onEntitySelect={onEntitySelect}
          onEntityHover={onEntityHover}
          onEntityLeave={onEntityLeave}
          grantedKeys={grantedKeys}
        />

        {uiActionNotices.length > 0 ? (
          <ul className="assistant__notices" aria-label="Assistant view actions" role="status">
            {uiActionNotices.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        ) : null}

        {attachments.length > 0 ? (
          <ul className="assistant__chips" aria-label="Attachments for the next message">
            {attachments.map((attachment) => (
              <li key={attachment.attachmentId} className="assistant__chip">
                <span>{attachment.name ?? attachment.attachmentId}</span>
                <button
                  type="button"
                  aria-label={`Remove attachment ${attachment.name ?? attachment.attachmentId}`}
                  onClick={() => onDetach(attachment.attachmentId)}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {attachmentRejections.length > 0 ? (
          <ul className="assistant__rejections" aria-label="Attachments not accepted">
            {attachmentRejections.map((rejection) => (
              <li key={rejection.attachmentId}>
                {rejection.attachmentId} was not attached: {rejection.reason}
              </li>
            ))}
          </ul>
        ) : null}

        <label className="assistant__field">
          <span className="visually-hidden">Ask about {toolLabel}</span>
          <textarea
            ref={textareaRef}
            className="assistant__input"
            rows={1}
            placeholder={`Ask about ${toolLabel}...`}
            value={draft}
            aria-describedby={hint ? 'assistant-budget' : undefined}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (shouldSend(event)) {
                event.preventDefault();
                if (sendable) onSend();
                return;
              }
              if (event.key === 'Escape' && draft.length === 0) textareaRef.current?.blur();
            }}
          />
        </label>

        {hint ? (
          <p className="assistant__hint" id="assistant-budget" role="status">
            {hint.nearLimit ? 'Message limit reached' : `${hint.remaining} characters remaining`}
          </p>
        ) : null}

        <div className="assistant__toolbar">
          {/*
            A hidden input rather than a styled label: the button keeps its own focus and
            keyboard behaviour, and `accept` is derived from the same policy the post-pick
            validation uses, so the picker cannot advertise a filter the composer does not
            enforce.
          */}
          <input
            ref={fileInputRef}
            type="file"
            disabled={uploading || attachmentPolicy.maxCount === 0}
            multiple
            accept={attachmentPolicy.accept.join(',')}
            className="visually-hidden"
            tabIndex={-1}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              // Reset first: picking the same file twice must fire `change` again, and a
              // retained value would make the second pick a silent no-op — which is exactly
              // how this control looked broken.
              event.target.value = '';
              if (files.length > 0) onAttach(files);
            }}
          />
          <button
            type="button"
            className="assistant__upload"
            disabled={uploading || attachmentPolicy.maxCount === 0}
            title={attachmentPolicy.maxCount === 0 ? 'Attachments are not supported by this tool.' : undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" size={14} /> {uploading ? 'Uploading…' : 'Upload'}
            <span className="visually-hidden">
              {' '}
              files ({attachmentPolicy.accept.join(', ')})
            </span>
          </button>

          <div className="assistant__trailing">
            {permissionMode && onPermissionModeChange ? (
              <select
                className="assistant__permission-mode"
                aria-label="Assistant operation mode"
                title="Controls confirmation for authorized operations. Account permissions always apply. Code edits stay in a private workspace."
                value={permissionMode}
                disabled={streaming || restoring}
                onChange={(event) => onPermissionModeChange(event.target.value)}
              >
                <option value="read_only">Read only</option>
                <option value="ask">Ask for permission</option>
                <option value="full">Full authorization</option>
              </select>
            ) : null}
            {developer?.enabled && developerPatchUrl && <a className="assistant__usage" href={developerPatchUrl} download="rack-development.patch">Download code patch</a>}
            <button
              type="button"
              ref={usageButtonRef}
              className="assistant__usage"
              aria-expanded={usageOpen}
              aria-haspopup="dialog"
              onClick={() => setUsageOpen((value) => !value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setUsageOpen(false);
                  usageButtonRef.current?.focus();
                }
              }}
            >
              <Icon name="chart" size={14} /> Tokens
            </button>

            {streaming ? (
              <button type="button" className="assistant__send" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="assistant__send"
                disabled={!sendable}
                title={setupBlocked ? 'Set up a model connection first' : sendable ? undefined : 'Enter a message or attach a file to send'}
                onClick={() => onSend()}
              >
                Send
              </button>
            )}
          </div>
        </div>

        {developer?.enabled && <p className="assistant__scope">Code changes use a private workspace and require patch review. Plan changes use checked saves.
          {!developer?.runtimeReady && ' Sandbox setup required: npm run rack:developer:setup.'}</p>}
        {usageOpen ? (
          <TokenUsagePopover
            usage={usage}
            onClose={() => {
              setUsageOpen(false);
              usageButtonRef.current?.focus();
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * Two scopes, kept explicitly separate: the current chat since load, and the
 * signed-in user's cumulative usage. The shell renders what the usage service
 * reports and stores nothing.
 */
export function TokenUsagePopover({ usage, onClose = () => {} }) {
  const chat = describeUsage(usageFor(usage, 'CHAT_SESSION'));
  const overall = describeUsage(usageFor(usage, 'USER_OVERALL'));

  return (
    <div className="usage" role="dialog" aria-label="Token usage">
      <button type="button" className="usage__close" aria-label="Close token usage" title="Close token usage" onClick={onClose}>
        <Icon name="close" size={14} />
      </button>

      {/*
        The two scopes sit side by side rather than stacked, because the only question anyone
        asks of them is a comparison: how much of the month's usage is this conversation. Rows
        are therefore the same rows in the same order on both sides, so they read across — and
        `auto-fit` collapses them into one column when the composer is too narrow to compare
        anything, rather than squeezing two number columns into a phone.
      */}
      <div className="usage__columns">
        <UsageScope title="This chat" entry={chat} empty="No turns yet in this conversation." />
        <UsageScope title="Overall" entry={overall} empty="Usage is not available yet." />
      </div>
    </div>
  );
}

function UsageScope({ title, entry, empty }) {
  return (
    <section className="usage__scope" aria-label={title}>
      <h3 className="usage__title">{title}</h3>
      {entry ? (
        <dl className="usage__values">
          <dt>Input</dt>
          <dd>{entry.input}</dd>
          <dt>Output</dt>
          <dd>{entry.output}</dd>
          {/*
            Cached tokens are shown in both columns for the same reason the columns exist: a
            cached prompt is the same tokens at a fraction of the rate, so the share of a
            conversation's input that was already warm is only legible against the whole
            month's.
          */}
          <dt>Cached</dt>
          <dd>{entry.cached}</dd>
          <dt>Total</dt>
          <dd>
            {entry.total}
            {entry.estimating ? <span className="usage__estimating"> (estimating)</span> : null}
          </dd>
          {/* The window and what is left of it belong to the allowance, which only the overall
              scope has: a single chat has no quota of its own. */}
          {entry.quota ? (
            <>
              <dt>Quota</dt>
              <dd>{entry.quota}</dd>
              <dt>Remaining</dt>
              <dd>
                {entry.remaining ?? 'unknown'}
                {entry.nearLimit ? <span className="usage__near"> near limit</span> : null}
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="usage__empty">{empty}</p>
      )}
    </section>
  );
}
