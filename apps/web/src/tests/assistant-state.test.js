import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATTACHMENT_POLICY,
  addAttachments,
  appendTurn,
  replaceTurn,
  budgetHint,
  canApplyProposal,
  ROUNDS_REVEAL_OPTIONS,
  revealExpandedRounds,
  shouldAutoOpenRounds,
  canSend,
  describeUsage,
  draftKey,
  markTurnFailed,
  removeAttachment,
  scopeLabel,
  shouldSend,
  usageFor,
} from '../assistant/assistant-state.js';

test('drafts are keyed per workspace context and tool', () => {
  const base = { projectId: 'p', scenarioId: 's', revisionId: 'r', toolId: 'site_facility' };
  assert.equal(draftKey(base), 'p|s|r|site_facility');
  assert.notEqual(draftKey(base), draftKey({ ...base, revisionId: 'r2' }), 'a new revision is a new draft');
  assert.notEqual(draftKey(base), draftKey({ ...base, toolId: 'floorplan' }), 'each tool keeps its own draft');
  assert.equal(draftKey({}), '-|-|-|none');
});

test('Enter sends only on an unmodified, non-composing keypress', () => {
  assert.equal(shouldSend({ key: 'Enter' }), true);
  assert.equal(shouldSend({ key: 'Enter', shiftKey: true }), false, 'shift inserts a newline');
  assert.equal(shouldSend({ key: 'Enter', ctrlKey: true }), false);
  assert.equal(shouldSend({ key: 'Enter', metaKey: true }), false);
  assert.equal(shouldSend({ key: 'Enter', altKey: true }), false);
  assert.equal(shouldSend({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSend({ key: 'Enter' }, { composing: true }), false, 'an IME composition never submits a half-formed word');
  assert.equal(shouldSend({ key: 'a' }), false);
  assert.equal(shouldSend(null), false);
});

test('attachments are validated against the active policy and rejections are reported', () => {
  const existing = [{ attachmentId: 'a1', mediaType: 'image/png', sizeBytes: 10 }];
  const { attachments, rejected } = addAttachments(existing, [
    { attachmentId: 'a2', mediaType: 'image/png', sizeBytes: 10 },
    { attachmentId: 'a3', mediaType: 'application/x-msdownload', sizeBytes: 10 },
    { attachmentId: 'a4', mediaType: 'image/png', sizeBytes: 999 * 1024 * 1024 },
    { attachmentId: 'a1', mediaType: 'image/png', sizeBytes: 10 },
  ]);

  assert.deepEqual(attachments.map((item) => item.attachmentId), ['a1', 'a2']);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /unsupported type/);
  assert.match(rejected[1].reason, /larger than/);
});

test('the attachment count is capped', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ attachmentId: `a${index}`, mediaType: 'image/png', sizeBytes: 1 }));
  const { attachments, rejected } = addAttachments([], many, DEFAULT_ATTACHMENT_POLICY);
  assert.equal(attachments.length, DEFAULT_ATTACHMENT_POLICY.maxCount);
  assert.equal(rejected.length, 4);
});

test('detaching removes exactly one chip', () => {
  const list = [{ attachmentId: 'a1' }, { attachmentId: 'a2' }];
  assert.deepEqual(removeAttachment(list, 'a1').map((item) => item.attachmentId), ['a2']);
});

test('the scope label always names the tool and revision', () => {
  assert.equal(scopeLabel({ toolLabel: 'Site & Facility', lifecycleState: 'DRAFT' }), 'Site & Facility · Revision: Draft');
  assert.equal(scopeLabel({ toolLabel: 'Verify', lifecycleState: 'PUBLISHED' }), 'Verify · Revision: Published');
  assert.equal(scopeLabel({ toolLabel: 'Floorplan' }), 'Floorplan · Revision: Draft');
});

test('the budget hint appears only near the limit and never blocks typing', () => {
  assert.equal(budgetHint(10, 100), null);
  assert.deepEqual(budgetHint(90, 100), { remaining: 10, nearLimit: false });
  assert.deepEqual(budgetHint(120, 100), { remaining: 0, nearLimit: true });
  assert.equal(budgetHint(10, null), null);
});

test('send is disabled only for an empty draft and attachment set, or while streaming', () => {
  assert.equal(canSend({ draft: '' }), false);
  assert.equal(canSend({ draft: '   ' }), false);
  assert.equal(canSend({ draft: 'hello' }), true);
  assert.equal(canSend({ draft: '', attachments: [{ attachmentId: 'a1' }] }), true, 'attachments alone are sendable');
  assert.equal(canSend({ draft: 'hello', streaming: true }), false, 'while streaming the action becomes Stop');
});

test('a failed turn keeps its place and exposes a correlation id', () => {
  const turns = appendTurn([], { turnId: 't1', status: 'COMPLETE' });
  const failed = markTurnFailed(turns, 't1', { correlationId: 'corr-1' });
  assert.equal(failed.length, 1, 'the turn is never dropped');
  assert.equal(failed[0].status, 'FAILED');
  assert.equal(failed[0].correlationId, 'corr-1');
});

test('a settled turn takes the place of the one it was waiting in', () => {
  const turns = [
    { turnId: 'u1', role: 'user', text: 'hello', status: 'COMPLETE' },
    { turnId: 'a1', role: 'assistant', text: '', status: 'STREAMING' },
  ];
  const settled = replaceTurn(turns, 'a1', { turnId: 'req-9', role: 'assistant', text: 'hi', status: 'COMPLETE' });

  assert.equal(settled.length, 2, 'the reply replaces the placeholder rather than following it');
  assert.equal(settled[1].turnId, 'a1', 'and keeps the row id, so the transcript node is updated in place');
  assert.equal(settled[1].text, 'hi');
  assert.equal(settled[0].text, 'hello', 'nothing else moves');
});

test('a proposed change is never applied automatically and still needs its permission', () => {
  const granted = new Set(['facility.entity.write']);
  assert.equal(canApplyProposal({ toolId: 'site_facility', permission: 'facility.entity.write' }, granted).allowed, true);

  const missing = canApplyProposal({ toolId: 'site_facility', permission: 'facility.publish' }, granted);
  assert.equal(missing.allowed, false);
  assert.match(missing.reason, /permission/);

  assert.equal(canApplyProposal({ permission: 'facility.entity.write' }, granted).allowed, false, 'an ownerless proposal cannot be applied');
  assert.equal(canApplyProposal({ toolId: 'site_facility', status: 'APPLIED' }, granted).allowed, false);
  assert.equal(canApplyProposal({ toolId: 'site_facility', status: 'DISCARDED' }, granted).allowed, false);

  // Unknown key set means "cannot determine", not "allowed".
  assert.equal(canApplyProposal({ toolId: 'site_facility', permission: 'facility.publish' }, null).allowed, false);
});

test('usage is selected by scope and formatted for display', () => {
  const usage = [
    { scope: 'CHAT_SESSION', inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedInputTokens: 900, estimated: true },
    { scope: 'USER_OVERALL', inputTokens: 90000, outputTokens: 10000, totalTokens: 100000, cachedInputTokens: 45000, cachedOutputTokens: 500, quotaTokens: 105000, remainingTokens: 5000 },
  ];

  assert.equal(usageFor(usage, 'CHAT_SESSION').totalTokens, 1500);
  assert.equal(usageFor(usage, 'NOPE'), null);

  const chat = describeUsage(usageFor(usage, 'CHAT_SESSION'));
  assert.equal(chat.label, 'This chat, since last load');
  assert.equal(chat.total, '1,500');
  assert.equal(chat.cached, '900', 'cached tokens are reported, not folded into the total');
  assert.equal(chat.estimating, true, 'a streaming estimate is marked as such');
  assert.equal(chat.quota, null);

  const overall = describeUsage(usageFor(usage, 'USER_OVERALL'));
  assert.equal(overall.label, 'Overall user usage');
  assert.equal(overall.total, '100,000');
  // Cached input and cached output are one figure per column: the split is the provider's
  // bookkeeping, and the question the number answers is how much of this was already warm.
  assert.equal(overall.cached, '45,500');
  assert.equal(overall.quota, '105,000');
  assert.equal(overall.remaining, '5,000');
  assert.equal(overall.nearLimit, true, 'near-limit state is text, not color');

  // A scope that has never cached anything says zero rather than going blank.
  assert.equal(describeUsage({ scope: 'CHAT_SESSION', totalTokens: 5 }).cached, '0');

  assert.equal(describeUsage(null), null);
});

test('opening the rounds scrolls them into view, and nothing else does', () => {
  // The transcript is scrolled to its end, so a turn sits on the bottom edge and a
  // disclosure below it has nowhere to grow but downwards, off the visible area. Expanding
  // without scrolling shows the reader nothing, which reads as a broken control. Verified
  // in the deployment: scrollTop 3059 -> 3114, and the last round 886 -> 831 against a
  // transcript bottom of 831.
  const calls = [];
  const element = { scrollIntoView: (options) => calls.push(options) };

  assert.equal(revealExpandedRounds({ open: true, openedByStream: false, element }), true);
  assert.equal(calls.length, 1, 'a reader opening it brings it into view');

  // `block: 'end'` is the whole fix. `'nearest'` does nothing when any part of the panel is
  // already visible — and here the summary row is on screen while the content beneath it is
  // not, so `'nearest'` would leave the reported bug in place.
  assert.deepEqual(calls[0], { block: 'end', behavior: 'smooth' });
  assert.deepEqual(calls[0], ROUNDS_REVEAL_OPTIONS);

  // A round arriving opens the disclosure by itself. Scrolling then would drag the view
  // down under a reader who has scrolled up to read something else.
  assert.equal(revealExpandedRounds({ open: true, openedByStream: true, element }), false);
  assert.equal(calls.length, 1, 'a streaming open does not move the scroll position');

  // Collapsing has no content to reveal.
  assert.equal(revealExpandedRounds({ open: false, openedByStream: false, element }), false);
  assert.equal(calls.length, 1, 'collapsing does not scroll');

  // A missing element or a node without the method is not a crash.
  assert.equal(revealExpandedRounds({ open: true, openedByStream: false, element: null }), true);
  assert.doesNotThrow(() => revealExpandedRounds({ open: true, openedByStream: false, element: {} }));
  assert.equal(revealExpandedRounds(), false);
});

test('a live round record opens itself until the reader says otherwise', () => {
  // While the model works, the record is held open so rounds are watched as they arrive.
  assert.equal(shouldAutoOpenRounds({ streaming: true, readerDecided: false }), true);

  // Rounds land every few seconds. An auto-open that kept winning would re-open the panel
  // under a reader who had just closed it, which is the head being a control that does not
  // work for exactly the turn they most want out of the way.
  assert.equal(shouldAutoOpenRounds({ streaming: true, readerDecided: true }), false);

  // A finished turn never opens itself: the rounds are the record then, not the activity.
  assert.equal(shouldAutoOpenRounds({ streaming: false, readerDecided: false }), false);
  assert.equal(shouldAutoOpenRounds({ streaming: false, readerDecided: true }), false);

  // Nothing is decided by omission.
  assert.equal(shouldAutoOpenRounds(), false);
  assert.equal(shouldAutoOpenRounds({ streaming: 'yes', readerDecided: false }), false);
});
