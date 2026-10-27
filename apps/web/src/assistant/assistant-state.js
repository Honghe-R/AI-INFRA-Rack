/**
 * Assistant composer logic, kept free of React.
 *
 * The composer is shell-owned presentation; conversation content, attachments,
 * and token accounting belong to the assistant and usage services
 * (ui-pattern.md, "Workspace Assistant"). Everything here is either a pure
 * transformation or a rule the spec states explicitly.
 */

/**
 * The attachment policy (assistant-integration.md, "Attachment Policy").
 *
 * The spec's snake_case field names are the ones the wire context reports; the three
 * composer aliases (`accept`, `maxBytes`, `maxCount`) are read by the picker and the
 * post-pick validation. One object carries both spellings so they cannot drift: the
 * surface must not advertise one set of formats and enforce another.
 */
export const ATTACHMENT_MEDIA_TYPES = Object.freeze([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'application/geo+json',
  'application/vnd.google-earth.kml+xml',
  'application/vnd.google-earth.kmz',
  'application/dxf',
  'application/x-step',
  'model/ifc',
]);

export const DEFAULT_ATTACHMENT_POLICY = Object.freeze({
  // Composer-facing aliases.
  accept: ATTACHMENT_MEDIA_TYPES,
  maxBytes: 52_428_800,
  maxCount: 5,
  // The spec's AttachmentPolicy, which is what the context sends.
  accepted_media_types: ATTACHMENT_MEDIA_TYPES,
  max_file_size_bytes: 52_428_800,
  max_attachments_per_message: 5,
  required_permission: 'facility.read',
  promotion_permission: 'facility.import.initiate',
  promotion_write_permission: 'asset.write',
  binds_to_entity: false,
  fact_sheet_tool: 'attachment_fact_sheet',
  page_read_tool: 'attachment_read_page',
});

/** Drafts are retained per workspace context and tool, never globally. */
export function draftKey({ projectId, scenarioId, revisionId, toolId }) {
  return [projectId ?? '-', scenarioId ?? '-', revisionId ?? '-', toolId ?? 'none'].join('|');
}

/**
 * `Enter` sends, `Shift+Enter` inserts a newline, and modified or composing
 * `Enter` never sends. An IME composition in progress must not submit a
 * half-formed word.
 */
export function shouldSend(event, { composing = false } = {}) {
  if (!event || event.key !== 'Enter') return false;
  if (composing || event.isComposing === true) return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  return true;
}

/**
 * Validates a selection against the active tool's policy. Rejections are
 * returned rather than silently dropped, because a silently dropped attachment
 * makes the model truthfully report that it sees no file.
 */
export function addAttachments(existing, incoming, policy = DEFAULT_ATTACHMENT_POLICY) {
  const accepted = [];
  const rejected = [];
  const used = new Set(existing.map((item) => item.attachmentId));
  let count = existing.length;

  for (const candidate of incoming ?? []) {
    if (count >= policy.maxCount) {
      rejected.push({ attachmentId: candidate.attachmentId, reason: `at most ${policy.maxCount} attachments per message` });
      continue;
    }
    if (used.has(candidate.attachmentId)) continue;
    if (policy.accept?.length && !policy.accept.includes(candidate.mediaType)) {
      rejected.push({ attachmentId: candidate.attachmentId, reason: `unsupported type ${candidate.mediaType}` });
      continue;
    }
    if (typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > policy.maxBytes) {
      rejected.push({ attachmentId: candidate.attachmentId, reason: `larger than ${Math.round(policy.maxBytes / (1024 * 1024))} MB` });
      continue;
    }
    used.add(candidate.attachmentId);
    count += 1;
    accepted.push(candidate);
  }

  return { attachments: [...existing, ...accepted], rejected };
}

export function removeAttachment(existing, attachmentId) {
  return existing.filter((item) => item.attachmentId !== attachmentId);
}

/** `Site & Facility · Revision: Draft` — a user must never confuse the context. */
export function scopeLabel({ toolLabel, lifecycleState }) {
  const revision = lifecycleState ? lifecycleState.charAt(0) + lifecycleState.slice(1).toLowerCase() : 'Draft';
  return `${toolLabel} · Revision: ${revision}`;
}

/** A remaining-budget hint that never blocks typing. */
export function budgetHint(draftLength, maxChars) {
  if (!maxChars || draftLength < maxChars * 0.8) return null;
  return { remaining: Math.max(0, maxChars - draftLength), nearLimit: draftLength >= maxChars };
}

/** Send is disabled only when the draft and the attachment set are both empty. */
export function canSend({ draft, attachments = [], streaming = false, uploading = false }) {
  // Sending is blocked while an upload is in flight: the file is part of the message, and
  // a turn sent mid-upload would reference an asset that does not exist yet.
  if (streaming || uploading) return false;
  return draft.trim().length > 0 || attachments.length > 0;
}

export function appendTurn(turns, turn) {
  return [...turns, turn];
}

/**
 * Puts a turn where another one stands, keeping its position.
 *
 * The assistant's side of a turn exists from the moment the message is sent — as a
 * placeholder — so the answer replaces it rather than arriving after it. Writing the
 * placeholder's id onto the settled turn is what makes that a replacement to React as well:
 * the row keeps its key, so the node is updated in place instead of being unmounted and
 * mounted again, and a live region hears the new text rather than an insert.
 */
export function replaceTurn(turns, turnId, next) {
  return turns.map((turn) => (turn.turnId === turnId ? { ...next, turnId } : turn));
}

/**
 * Marks a turn failed, with the correlation id that ties it to the server's log.
 *
 * What a failure *keeps* — the draft, the attachments, and the retry — is the session's
 * business: the turn being marked here is the assistant's, whose only content is the error,
 * and the message it belongs to is the user turn above it.
 */
export function markTurnFailed(turns, turnId, { correlationId, message = 'The turn failed.' }) {
  return turns.map((turn) => (turn.turnId === turnId ? { ...turn, status: 'FAILED', correlationId, error: message } : turn));
}

/**
 * A proposed design change is never applied automatically, and applying it still
 * requires the owning tool's permission (acceptance criterion 11).
 *
 * Unlike tool navigation — where an unknown key set means "show it, the server
 * refuses anyway" — applying a change mutates the design, so an undetermined key
 * set fails closed rather than optimistically allowing the button.
 */
export function canApplyProposal(proposal, grantedKeys) {
  if (!proposal?.toolId) return { allowed: false, reason: 'the proposal names no owning tool' };
  if (proposal.status === 'APPLIED') return { allowed: false, reason: 'already applied' };
  if (proposal.status === 'DISCARDED') return { allowed: false, reason: 'discarded' };

  if (proposal.permission) {
    const granted = grantedKeys instanceof Set ? grantedKeys : grantedKeys ? new Set(grantedKeys) : null;
    if (!granted) return { allowed: false, reason: 'permissions could not be determined' };
    if (!granted.has(proposal.permission)) {
      return { allowed: false, reason: 'you do not hold the permission this change requires' };
    }
  }

  return { allowed: true, reason: null };
}

/** Tokens are reported by the usage service; the shell only selects a scope. */
export function usageFor(usage, scope) {
  return usage?.find((entry) => entry.scope === scope) ?? null;
}

export function describeUsage(entry) {
  if (!entry) return null;
  const format = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : '0');
  const nearLimit = entry.quotaTokens && entry.totalTokens >= entry.quotaTokens * 0.9;
  return {
    label: entry.scope === 'CHAT_SESSION' ? 'This chat, since last load' : 'Overall user usage',
    input: format(entry.inputTokens),
    output: format(entry.outputTokens),
    total: format(entry.totalTokens),
    // One figure per column, so the two scopes can be read across: the split of cached tokens
    // is only interesting when both sides of the comparison are visible at once.
    cached: format(number(entry.cachedInputTokens) + number(entry.cachedOutputTokens)),
    estimating: entry.estimated === true,
    quota: entry.quotaTokens ? format(entry.quotaTokens) : null,
    remaining: typeof entry.remainingTokens === 'number' ? format(entry.remainingTokens) : null,
    nearLimit: Boolean(nearLimit),
  };
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/**
 * Whether opening a rounds disclosure should bring it into view, and how.
 *
 * The transcript is scrolled to its end, so a turn sits against its bottom edge and a
 * disclosure below it has nowhere to grow but downwards — off the visible area. Expanding
 * one without scrolling therefore shows a reader nothing at all, which reads as a broken
 * control rather than a hidden answer.
 *
 * Two cases must not scroll. A **collapse** has no content to reveal. And the disclosure
 * opens by itself while a turn streams, so scrolling then would drag the view down under a
 * reader who has scrolled up to read something else — the transcript's own effect owns the
 * position while turns are arriving.
 *
 * `block: 'end'` rather than `'nearest'`, which is the whole point: `'nearest'` does
 * nothing when any part of the panel is already visible, and that is exactly the failing
 * case — the summary row is on screen and the content beneath it is not.
 */
export const ROUNDS_REVEAL_OPTIONS = Object.freeze({ block: 'end', behavior: 'smooth' });

export function revealExpandedRounds({ open, openedByStream, element = null } = {}) {
  if (!open || openedByStream) return false;
  element?.scrollIntoView?.(ROUNDS_REVEAL_OPTIONS);
  return true;
}

/**
 * Whether the round record opens itself because the model is still working.
 *
 * A live turn is held open so its rounds are *watched* as they arrive rather than discovered
 * afterwards — that is the whole reason they are streamed. But a round lands every few
 * seconds, so an auto-open that kept winning would re-open the panel under a reader who had
 * just closed it, and the head would be a control that does not work for exactly the turn
 * they most want out of the way.
 *
 * The reader's own activation therefore settles it: asked with their decision, this is false
 * for the rest of the turn. Nothing else counts as a decision — the `open` prop moves the
 * element without a click, so a streaming open cannot silence the next one.
 */
export function shouldAutoOpenRounds({ streaming = false, readerDecided = false } = {}) {
  return streaming === true && readerDecided !== true;
}
