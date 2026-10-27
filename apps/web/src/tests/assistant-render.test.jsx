import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantComposer, TokenUsagePopover } from '../assistant/AssistantComposer.jsx';
import { AssistantTranscript } from '../assistant/AssistantTranscript.jsx';
import { Markdown } from '../assistant/Markdown.jsx';

const USAGE = [
  { scope: 'CHAT_SESSION', inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedInputTokens: 900, cachedOutputTokens: 0, estimated: true },
  { scope: 'USER_OVERALL', inputTokens: 90000, outputTokens: 10000, totalTokens: 100000, cachedInputTokens: 45000, cachedOutputTokens: 500, quotaTokens: 105000, remainingTokens: 5000 },
];

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/**
 * The declarations of one top-level rule, read the way `text-contrast.test.js` reads them.
 *
 * The message area's height is a browser measurement, so half of its contract lives in the
 * stylesheet rather than in the markup: the component grows the box, and this rule says how
 * far it may grow and what happens past that. Asserting only the markup would leave the cap
 * and the overflow unchecked, and they are the half a reader of the component cannot see.
 */
function declarations(selector) {
  const start = CSS.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `expected a top-level rule for ${selector}`);
  let depth = 0;
  for (let index = CSS.indexOf('{', start); index < CSS.length; index += 1) {
    if (CSS[index] === '{') depth += 1;
    if (CSS[index] === '}') {
      depth -= 1;
      // Comments are stripped before the rule is asserted on: a rule's own explanation can
      // name a declaration, and `assert.match` would then be satisfied by the comment
      // rather than by the declaration it describes.
      if (depth === 0) return CSS.slice(start, index + 1).replace(/\/\*[\s\S]*?\*\//g, '');
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

test('the message area starts one line high and lets its content decide the rest', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Verify" open draft="one line" />);

  // One row, and no height in the markup. The component measures what is in the box and sets
  // the height after mount, so a `rows` that already fitted several lines would be a second,
  // disagreeing answer to the same question.
  assert.match(html, /<textarea[^>]*rows="1"/);
  assert.doesNotMatch(html, /<textarea[^>]*style=/);
});

test('the stylesheet caps the growth, and past the cap the box scrolls', () => {
  const rule = declarations('.assistant__input');

  const cap = rule.match(/max-height:\s*([^;]+);/);
  assert.ok(cap, 'the message area must declare a maximum height');
  assert.notEqual(cap[1].trim(), 'none');
  assert.match(rule, /min-height:\s*[^;]+;/, 'one line is the floor');
  assert.match(rule, /overflow-y:\s*auto/, 'past the cap, the message scrolls rather than being cut off');
  // The control owns its height now: a manual resize handle would be undone by the next
  // keystroke, because measuring resets the height to fit the content.
  assert.doesNotMatch(rule, /resize:\s*(vertical|horizontal|both)/);
});

test('the collapsed composer is a launcher pill that names the active tool', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Site & Facility" open={false} turns={[{ turnId: 't1', unread: true }]} />);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Ask about Site &amp; Facility/);
  assert.match(html, /aria-label="unread replies"/);
});

test('the open composer states the scope and labels the message area with the tool', () => {
  const html = renderToStaticMarkup(
    <AssistantComposer toolLabel="Site & Facility" open scopeLabelText="Site & Facility · Revision: Draft" />,
  );
  assert.match(html, /Context: Site &amp; Facility · Revision: Draft/);
  assert.match(html, /<textarea/);
  assert.match(html, /Ask about Site &amp; Facility/);
  assert.match(html, /placeholder="Ask about Site &amp; Facility\.\.\."/);
});

test('an open composer can be minimized back to the launcher', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Verify" open scopeLabelText="Verify · Revision: Draft" />);
  // Without this control the only way to collapse was the launcher that is no
  // longer on screen once the composer is open.
  assert.match(html, /aria-label="Minimize assistant"/);
  assert.match(html, /class="assistant__collapse"/);
});

test('the collapsed composer offers no minimize control', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Verify" open={false} />);
  assert.doesNotMatch(html, /aria-label="Minimize assistant"/);
});

test('the toolbar exposes upload, token usage with expanded state, and send', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Verify" open scopeLabelText="Verify · Revision: Draft" draft="hello" />);
  assert.match(html, /class="assistant__upload"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Send</);
});

test('send is disabled with a reason when there is nothing to send', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Verify" open scopeLabelText="Verify · Revision: Draft" draft="" />);
  assert.match(html, /disabled=""/);
  assert.match(html, /title="Enter a message or attach a file to send"/);
});

test('a streaming turn turns Send into Stop', () => {
  const html = renderToStaticMarkup(<AssistantComposer toolLabel="Verify" open scopeLabelText="Verify · Revision: Draft" draft="x" streaming />);
  assert.match(html, />Stop</);
  assert.doesNotMatch(html, />Send</);
});

test('attachments render as removable chips with accessible names', () => {
  const html = renderToStaticMarkup(
    <AssistantComposer
      toolLabel="Verify"
      open
      scopeLabelText="Verify · Revision: Draft"
      draft=""
      attachments={[{ attachmentId: 'a1', name: 'site-plan.pdf' }]}
    />,
  );
  assert.match(html, /aria-label="Attachments for the next message"/);
  assert.match(html, /site-plan\.pdf/);
  assert.match(html, /aria-label="Remove attachment site-plan\.pdf"/);
});

test('rejected attachments are reported rather than silently dropped', () => {
  const html = renderToStaticMarkup(
    <AssistantComposer
      toolLabel="Verify"
      open
      scopeLabelText="Verify · Revision: Draft"
      attachmentRejections={[{ attachmentId: 'a9', reason: 'unsupported type application/x-msdownload' }]}
    />,
  );
  assert.match(html, /was not attached: unsupported type/);
});

test('the budget hint appears near the limit and is announced politely', () => {
  const html = renderToStaticMarkup(
    <AssistantComposer toolLabel="Verify" open scopeLabelText="Verify · Revision: Draft" draft={'x'.repeat(90)} maxChars={100} />,
  );
  assert.match(html, /10 characters remaining/);
  assert.match(html, /role="status"/);
});

test('the token popover reports both scopes as columns, marking an estimate', () => {
  const html = renderToStaticMarkup(<TokenUsagePopover usage={USAGE} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Token usage"/);
  assert.match(html, /This chat/);
  assert.match(html, /Overall/);
  assert.match(html, /\(estimating\)/);
  assert.match(html, /near limit/);
  assert.match(html, /aria-label="Close token usage"/);

  // Two columns, not one list after another: the only question asked of these numbers is a
  // comparison, and a comparison cannot be read down a single stack.
  assert.match(html, /<div class="usage__columns">/);
  assert.equal(html.split('class="usage__scope"').length - 1, 2, 'one column per scope');
  assert.equal(html.split('turn__rounds').length - 1, 0, 'and nothing else moved in');
});

test('both usage columns carry the same rows, cached included', () => {
  const html = renderToStaticMarkup(<TokenUsagePopover usage={USAGE} />);
  const columns = html.split('class="usage__scope"').slice(1);

  for (const [index, column] of columns.entries()) {
    for (const label of ['Input', 'Output', 'Cached', 'Total']) {
      assert.match(column, new RegExp(`<dt>${label}</dt>`), `${label} is in column ${index + 1}`);
    }
  }

  // The cached figures are the scope's own, so the share of a conversation that was already
  // warm can be read against the month's.
  assert.match(columns[0], /<dt>Cached<\/dt><dd>900<\/dd>/);
  assert.match(columns[1], /<dt>Cached<\/dt><dd>45,500<\/dd>/);
  // Only the allowance has a quota, so only the overall column states one.
  assert.doesNotMatch(columns[0], /Quota/);
  assert.match(columns[1], /<dt>Quota<\/dt>/);
});

test('the two usage columns stay side by side until the panel is too narrow to compare', () => {
  // The popover floats inside a composer the reader can resize, so the collapse is driven by
  // the container rather than by the viewport: `auto-fit` with a minimum column stacks them
  // when there is no room to read across.
  const columns = declarations('.usage__columns');
  assert.match(columns, /display: grid/);
  assert.match(columns, /grid-template-columns: repeat\(auto-fit, minmax\(150px, 1fr\)\)/);
  // Numbers line up digit for digit, which is what makes a difference visible rather than read.
  assert.match(declarations('.usage__values dd'), /font-variant-numeric: tabular-nums/);
});

test('an empty transcript renders nothing, with no placeholder prompt', () => {
  const html = renderToStaticMarkup(<AssistantTranscript turns={[]} />);
  assert.equal(html, '');
});

test('a restoring transcript says so instead of looking empty', () => {
  const html = renderToStaticMarkup(<AssistantTranscript turns={[]} restoring />);
  assert.match(html, /Restoring this conversation/);
});

test('the composer offers a new chat when the host can start one', () => {
  const html = renderToStaticMarkup(<AssistantComposer open onNewSession={() => {}} />);
  assert.match(html, /class="assistant__new"/);
  assert.match(html, /New chat<\/button>/);
  assert.match(html, /title="Start a new conversation"/);

  const withoutHost = renderToStaticMarkup(<AssistantComposer open />);
  assert.doesNotMatch(withoutHost, /New chat/);
});

test('a turn shows its scope only when it differs from the one before it', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        { turnId: 't1', role: 'USER', text: 'first', scopeLabel: 'Site & Facility · Revision: Draft' },
        { turnId: 't2', role: 'ASSISTANT', text: 'answer', scopeLabel: 'Site & Facility · Revision: Draft' },
        { turnId: 't3', role: 'USER', text: 'second', scopeLabel: 'Verify · Revision: Draft' },
        { turnId: 't4', role: 'ASSISTANT', text: 'answer two', scopeLabel: 'Verify · Revision: Draft' },
      ]}
    />,
  );
  assert.match(html, /aria-live="polite"/);
  // The composer header states the active context, so the transcript does not
  // repeat it; it marks only the point where the scope actually changed.
  assert.equal((html.match(/Site &amp; Facility · Revision: Draft/g) ?? []).length, 0);
  assert.equal((html.match(/Verify · Revision: Draft/g) ?? []).length, 1);
});

test('the two sides of the conversation are distinguishable, and referenced entities stay with their turn', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        { turnId: 't1', role: 'USER', text: 'mine' },
        { turnId: 't2', role: 'ASSISTANT', text: 'theirs', entityRefs: ['hall-1', 'hall-2'] },
      ]}
    />,
  );
  assert.match(html, /class="turn turn--user"/);
  assert.match(html, /class="turn turn--assistant"/);
  assert.match(html, /class="turn__bubble"/);
  assert.match(html, /hall-1 · hall-2/);
});

test('every message offers copy-to-clipboard', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        { turnId: 't1', role: 'USER', text: 'mine' },
        { turnId: 't2', role: 'ASSISTANT', text: 'theirs' },
      ]}
    />,
  );
  assert.equal((html.match(/aria-label="Copy message"/g) ?? []).length, 2);
  assert.equal((html.match(/title="Copy message"/g) ?? []).length, 2);
});

test('a failed turn keeps its place and offers a retry with a correlation id', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', text: 'partial', status: 'FAILED', error: 'The provider timed out.', correlationId: 'corr-9' }]} onRetryTurn={() => {}} />,
  );
  assert.match(html, /The provider timed out\./);
  assert.match(html, /correlation corr-9/);
  assert.match(html, />Retry</);
});

const ROUNDS = [
  { iteration: 1, providerMs: 1200, tokens: 340, calls: [{ name: 'list_containers', ms: 19, outcome: 'ok' }] },
  { iteration: 2, providerMs: 53500, tokens: 1180, calls: [] },
];

test('a running turn holds its rounds open, so they are watched rather than found later', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', role: 'ASSISTANT', text: '', status: 'STREAMING', rounds: ROUNDS }]} />,
  );

  // Open, because a disclosure that grew while collapsed is the same as no disclosure: the
  // reader asked to see the loop, and the loop is only live while the turn is.
  assert.match(html, /<details class="turn__rounds" open/);
  assert.match(html, /2 rounds · 1 tool/);
  assert.match(html, /Round 1/);
  assert.match(html, /list_containers/);
  assert.match(html, /54\.7s in the model/);
  assert.match(html, /53\.5s · 1,180 tokens/);
  assert.match(html, /Assistant is thinking/);
});

test('a finished turn leaves its disclosure to the reader', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', role: 'ASSISTANT', text: 'Done.', status: 'COMPLETE', rounds: ROUNDS }]} />,
  );

  // No `open`: the turn is over, and the rounds are the record, not the activity. Nothing in
  // the markup forces it either way — the reader's own choice is the last word.
  assert.match(html, /<details class="turn__rounds">/);
  assert.doesNotMatch(html, /<details class="turn__rounds" open/);
  assert.doesNotMatch(html, /Assistant is thinking/);
});

test('the whole rounds row toggles, and clicking a round inside it does not', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', role: 'ASSISTANT', text: 'Done.', status: 'COMPLETE', rounds: ROUNDS }]} />,
  );

  // The summary carries both labels and spans the row, so the count, the time, and the
  // space between them are all the same control. A pill-sized target made the reader aim
  // at two words to open the record.
  const summary = declarations('.turn__rounds-summary');
  assert.match(summary, /width: 100%/);
  assert.match(summary, /cursor: pointer/);
  // Pushed to the far edge, so the middle of the row is the row rather than a gap.
  assert.match(declarations('.turn__rounds-time'), /margin-left: auto/);

  // `cursor: pointer` must NOT sit on the container: it would also cover the expanded
  // list, and every click on a round would collapse the thing being read.
  assert.doesNotMatch(declarations('.turn__rounds'), /cursor: pointer/);

  // The list is a sibling of the summary, not a child of it: `<summary>` toggles only for
  // its own contents, so a click inside the list is not an activation.
  const summaryEnd = html.indexOf('</summary>');
  assert.ok(html.indexOf('turn__rounds-list') > summaryEnd, 'the list follows the summary rather than nesting in it');
  assert.match(html, /<div class="turn__rounds-body">/);
});

test('the confirmation card asks in a person\'s words, not in a tool name and a payload', () => {
  // The card used to read `set_geometry stopped before it ran…` over
  // `{"entity_id":"Central Chiller Plant","geometry_role":"CONNECTION_POINT",…}` — a function the
  // reader never called and a payload they cannot read. The server sends the sentence; the card
  // shows the decision and what it decides about.
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: '',
          status: 'CONFIRMATION_REQUIRED',
          pendingConfirmations: [
            {
              callId: 'call-1',
              toolName: 'set_geometry',
              arguments: { entity_id: 'e-1', geometry_role: 'CONNECTION_POINT', if_match: 'abc' },
              summary: 'Move the Central Chiller Plant to 39.04485, -77.48950.',
            },
          ],
        },
      ]}
      onConfirmTurn={() => {}}
    />,
  );

  assert.match(html, /Move the Central Chiller Plant to 39\.04485, -77\.48950\./);
  assert.match(html, /Nothing has been applied yet\./);
  assert.match(html, /Apply this change/);
  // Declining is a real answer rather than a dismissal: it is a button beside the approval, and
  // it reaches the server, because a card that merely vanished would be drawn again from the same
  // proposal — the model has to be told that the reader said no.
  assert.match(html, /Do not apply/);
  assert.match(html, /class="confirmation__deny"/);
  assert.match(html, /class="confirmation__actions"/);
  assert.doesNotMatch(html, /set_geometry/, 'no function name reaches the reader');
  assert.doesNotMatch(html, /entity_id|geometry_role|if_match|CONNECTION_POINT/, 'and no payload field does either');
});

test('a declined call is recorded on the round as the reader\'s decision', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'I have not changed anything.',
          status: 'COMPLETE',
          rounds: [{ iteration: 0, calls: [{ name: 'set_geometry', ms: 0, outcome: 'denied' }] }],
        },
      ]}
      onDenyTurn={() => {}}
    />,
  );

  assert.match(html, /you declined/, 'the turn says the call was the reader\'s own decision');
  assert.doesNotMatch(html, /set_geometry<\/code><span[^>]*>0ms/, 'not as a call that ran in zero milliseconds');
});

test('a confirmation with no sentence still asks in words, and never in a payload', () => {
  // A surface that could not name the change leaves the card without its sentence. The fallback
  // has to be plain too, or the one case with no description is the one case that shows JSON.
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: '',
          status: 'CONFIRMATION_REQUIRED',
          pendingConfirmations: [{ callId: 'call-1', toolName: 'create_container', arguments: { name: 'Hall 2' } }],
        },
      ]}
      onConfirmTurn={() => {}}
    />,
  );

  assert.match(html, /A change to this revision\. Nothing has been applied yet\./);
  assert.doesNotMatch(html, /create_container/);
  assert.doesNotMatch(html, /Hall 2/, 'the argument values are not shown in place of a sentence');
});

test('the record says what the turn cost and which request it was', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'Done.',
          status: 'COMPLETE',
          correlationId: 'req-42',
          rounds: ROUNDS,
          usage: { prompt_tokens: 12345, completion_tokens: 678, total_tokens: 13023, cached_input_tokens: 900 },
          notices: [{ code: 'TOOL_RESULT_TRUNCATED', message: 'The result was truncated to fit the budget.' }],
        },
      ]}
    />,
  );

  // The two questions asked of a finished turn, both already in the envelope: what it bought,
  // and which line in the log it is. They sit under the record rather than in its head — the
  // head says what the turn holds, and the cost is the detail beneath it.
  assert.match(html, /54\.7s in the model<\/span>/);
  assert.doesNotMatch(html, /in the model · [\d,]+ tokens/, 'the head is the record, not the bill');
  assert.match(html, /in 12,345 · out 678 tokens · 900 cached/);
  assert.match(html, /request req-42/);
  // The server's own statement about the turn, which reached the client only to be dropped.
  assert.match(html, /The result was truncated to fit the budget\./);
});

test('a round shows what the model said while it worked', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'The yard holds one boundary.',
          status: 'COMPLETE',
          rounds: [
            { iteration: 1, providerMs: 900, tokens: 200, text: 'Let me check the yard boundary first.', calls: [{ name: 'get_entity', ms: 12, outcome: 'ok' }] },
            { iteration: 2, providerMs: 400, tokens: 90, text: 'The yard holds one boundary.', calls: [] },
          ],
        },
      ]}
    />,
  );

  // The narration is the approach: the call says it read the entity, and only the sentence
  // says what it was after. Rendered as prose, not as another line of bookkeeping.
  assert.match(html, /Let me check the yard boundary first\./);
  assert.match(html, /turn__round-said/);

  // The call-less round's words *are* the reply, which is already above it: it is labelled
  // as the answer rather than printed twice.
  assert.equal(html.split('The yard holds one boundary.').length - 1, 1, 'the answer is not repeated');
  assert.match(html, /turn__round-final">answered/);
});

test('a round carries the provider thinking channel and says when narration was cut', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'Done.',
          status: 'COMPLETE',
          rounds: [
            {
              iteration: 1,
              providerMs: 900,
              tokens: 200,
              text: 'Checking the interfaces.',
              reasoning: 'The question names two tools, so start with the narrower read.',
              narrationTruncated: true,
              calls: [{ name: 'list_utility_interfaces', ms: 12, outcome: 'ok' }],
            },
          ],
        },
      ]}
    />,
  );

  assert.match(html, /turn__round-reasoning">.*turn__round-reasoning-label">thinking<\/span>The question names two tools/s);
  assert.match(html, /turn__round-note">narration truncated/);
  assert.match(html, /Checking the interfaces\./);
});

test('the record names a call that changed the draft rather than leaving a duration', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'Moved.',
          status: 'COMPLETE',
          rounds: [{ iteration: 0, providerMs: 0, tokens: null, calls: [{ name: 'set_geometry', ms: 31, outcome: 'ok', wrote: true }] }],
        },
      ]}
    />,
  );

  // A write is the one outcome whose effect outlives the turn, so it is named in the row and
  // in the head — the reader asked for a change, and the reply alone cannot show one landed.
  assert.match(html, /1 round · 1 tool · changed the draft/);
  assert.match(html, /turn__call-wrote">changed the draft/);
  assert.match(html, /31ms/);
});

test('a turn that answered with an action says what it did, not nothing', () => {
  // The model sometimes writes the action instead of asking for it; the server reads it, takes
  // it out of the reply, and the bubble would otherwise be blank under a canvas that visibly
  // changed. The action's own description is what fills the answer position — never prose
  // invented on the assistant's behalf.
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: '',
          status: 'COMPLETE',
          uiActions: [{ id: 'a-1', type: 'highlight_entity', version: 1, payload: { entity_id: 'e-1' } }],
        },
      ]}
    />,
  );

  assert.match(html, /turn__actions/);
  assert.match(html, /Highlight one entity in the active revision\./);
  assert.doesNotMatch(html, /"payload"/, 'and the wire format is not what the reader sees');
});

test('a turn with words of its own does not also explain its actions', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'Central Chiller Plant is highlighted.',
          status: 'COMPLETE',
          uiActions: [{ id: 'a-1', type: 'highlight_entity', version: 1, payload: { entity_id: 'e-1' } }],
        },
      ]}
    />,
  );

  assert.match(html, /Central Chiller Plant is highlighted\./);
  assert.doesNotMatch(html, /turn__actions/, 'the reply is the answer; the action is not repeated');
});

test('a live record is marked as live, and a finished one is not', () => {
  const live = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', role: 'ASSISTANT', text: '', status: 'STREAMING', rounds: ROUNDS }]} />,
  );
  assert.match(live, /<span class="turn__rounds-live">live<\/span>/);

  const done = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', role: 'ASSISTANT', text: 'Done.', status: 'COMPLETE', rounds: ROUNDS }]} />,
  );
  assert.doesNotMatch(done, /turn__rounds-live/);
});

test('a refused tool call is labelled rather than shown as a bare duration', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          role: 'ASSISTANT',
          text: 'I used the history read instead.',
          status: 'COMPLETE',
          rounds: [{ iteration: 1, providerMs: 900, calls: [{ name: 'compare_revisions', ms: 12, outcome: 'refused' }] }],
        },
      ]}
    />,
  );

  assert.match(html, /turn__call-outcome--refused/);
  assert.match(html, />refused</);
});

test('a turn from before rounds existed still discloses its tools', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[{ turnId: 't1', role: 'ASSISTANT', text: 'Earlier.', status: 'COMPLETE', toolCalls: [{ name: 'list_containers' }] }]}
    />,
  );

  // The flat list is the shape of every conversation stored before rounds were kept. Losing
  // it would mean an older chat disclosing less than a newer one for no reason of its own.
  assert.match(html, /Used/);
  assert.match(html, /list_containers/);
});

test('a failure is reported on the assistant side, never inside the user message', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        { turnId: 'u1', role: 'USER', text: 'Why is the cooling path short?', status: 'COMPLETE' },
        { turnId: 'a1', role: 'ASSISTANT', text: '', status: 'FAILED', error: 'No LLM provider is configured.', correlationId: 'corr-3' },
      ]}
      onRetryTurn={() => {}}
    />,
  );

  // The two sides are separate rows, and only the assistant's row carries the failure and
  // the retry. The user's message is exactly what they wrote.
  const userTurn = html.slice(html.indexOf('turn turn--user'), html.indexOf('turn turn--assistant'));
  assert.match(userTurn, /Why is the cooling path short\?/);
  assert.equal(userTurn.includes('No LLM provider'), false);
  assert.equal(userTurn.includes('Retry'), false);
  assert.match(html, /class="turn turn--assistant"/);
  assert.match(html, /No LLM provider is configured\./);
  assert.equal((html.match(/>Retry</g) ?? []).length, 1);
});

test('the assistant says it is thinking while the provider has not answered', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        { turnId: 'u1', role: 'USER', text: 'What is the hall height?' },
        { turnId: 'a1', role: 'ASSISTANT', text: '', status: 'STREAMING' },
      ]}
    />,
  );

  assert.match(html, /class="turn turn--assistant"/);
  assert.match(html, /Assistant is thinking/);
  // The dots are motion and the words are meaning: the animated spans are out of the
  // accessible text, so a screen reader reads the sentence once and not once per frame.
  assert.match(html, /<span class="turn__thinking-dots" aria-hidden="true"><span>\.<\/span><span>\.<\/span><span>\.<\/span><\/span>/);

  // A turn with no text yet has nothing to copy and nothing to render as prose, so it is one
  // line in the assistant's bubble rather than an empty paragraph above it. The user's own
  // turn, which does have text, keeps both.
  const assistantTurn = html.slice(html.indexOf('turn turn--assistant'));
  assert.equal(assistantTurn.includes('aria-label="Copy message"'), false);
  assert.equal(assistantTurn.includes('turn__text'), false);
  assert.equal((html.match(/aria-label="Copy message"/g) ?? []).length, 1);
});

test('the thinking dots animate, and stand still when motion is not wanted', () => {
  const moving = declarations('.turn__thinking-dots span');
  assert.match(moving, /animation:\s*turn-thinking/, 'the dots are what moves');

  // Decoration that ignores a reduced-motion request is a defect, not a flourish, so the
  // guard is part of the contract rather than a nicety: this reads the media block itself.
  const still = declarations('@media (prefers-reduced-motion: reduce)');
  assert.match(still, /\.turn__thinking-dots span\s*\{\s*animation:\s*none;?\s*\}/);
});

test('a proposed change is presented as a card and never applied automatically', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[
        {
          turnId: 't1',
          text: 'I can raise the hall height.',
          proposal: { toolId: 'site_facility', permission: 'facility.geometry.write', summary: 'Increase hall-1 height to 16 m.' },
        },
      ]}
      grantedKeys={['facility.geometry.write']}
    />,
  );
  assert.match(html, /aria-label="Proposed change"/);
  assert.match(html, /Proposed change in Site &amp; Facility/);
  assert.match(html, /never applied automatically/);
  assert.match(html, /Apply in Site &amp; Facility/);
  assert.match(html, /Increase hall-1 height to 16 m\./);
});

test('a proposal the caller cannot apply stays visible and explains why', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript
      turns={[{ turnId: 't1', text: 'ok', proposal: { toolId: 'site_facility', permission: 'facility.publish', summary: 'Publish the revision.' } }]}
      grantedKeys={['facility.read']}
    />,
  );
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /unavailable: you do not hold the permission this change requires/);
});

// --- the render contract (chatbox blueprint §3.4) ---------------------------

test('the allowed Markdown subset renders as elements', () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={['Steps:', '', '1. **Define the workload** — `training` or `inference`', '2. Assess the environment', '', '> Note: no tools are available', '', '```json', '{ "a": 1 }', '```'].join('\n')}
    />,
  );

  assert.match(html, /<ol class="md__list"|<ol class="md__list">/);
  assert.match(html, /<strong>Define the workload<\/strong>/);
  assert.match(html, /<code class="md__code">training<\/code>/);
  assert.match(html, /<blockquote class="md__quote">/);
  assert.match(html, /<pre class="md__pre">/);
  assert.match(html, /\{ &quot;a&quot;: 1 \}|\{ "a": 1 \}/, 'code content is preserved, not parsed');
});

test('a pipe table renders with a header row and cells', () => {
  const html = renderToStaticMarkup(<Markdown text={'| Item | Status |\n| :--- | ---: |\n| Hall 01 | DRAFT |'} />);
  assert.match(html, /<table class="md__table">/);
  assert.match(html, /<th[^>]*>Item<\/th>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /<td[^>]*>Hall 01<\/td>/);
});

test('a resumed ordered list carries its start number', () => {
  const html = renderToStaticMarkup(<Markdown text={'1. first\n\n> note\n\n2. second'} />);
  assert.match(html, /<ol class="md__list" start="2">/);
});

test('raw HTML and headings are shown as text, never as markup', () => {
  const html = renderToStaticMarkup(<Markdown text={'# Heading\n\n<script>alert(1)</script>'} />);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<h1>/);
  assert.match(html, /# Heading/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('an entity reference becomes a control only when it resolves and can be acted on', () => {
  const text = 'See [**Data Hall 01**](entity://facility.entity/e-1).';
  const entities = [{ kind: 'facility.entity', id: 'e-1', label: 'Data Hall 01' }];

  const live = renderToStaticMarkup(<Markdown text={text} entities={entities} onSelectEntity={() => {}} />);
  assert.match(live, /<button type="button" class="md__entity"/);
  assert.match(live, /<strong>Data Hall 01<\/strong>/);

  const unresolved = renderToStaticMarkup(<Markdown text={text} entities={[]} onSelectEntity={() => {}} />);
  assert.doesNotMatch(unresolved, /entity:\/\//, 'an unresolved reference must not render a dead anchor');
  assert.doesNotMatch(unresolved, /<button/);
  assert.match(unresolved, /Data Hall 01/, 'the label stays visible as plain text');
});

test('only http and https links become anchors', () => {
  const safe = renderToStaticMarkup(<Markdown text="[docs](https://example.test)" />);
  assert.match(safe, /<a class="md__link" href="https:\/\/example\.test"/);

  const unsafe = renderToStaticMarkup(<Markdown text="[click](javascript:alert(1))" />);
  assert.doesNotMatch(unsafe, /<a /);
  assert.match(unsafe, /click/);
});

test('a transcript turn renders its Markdown rather than the raw source', () => {
  const html = renderToStaticMarkup(
    <AssistantTranscript turns={[{ turnId: 't1', role: 'ASSISTANT', text: '**Bold** and `code`.', scopeLabel: 'Scope' }]} />,
  );
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<code class="md__code">code<\/code>/);
  assert.doesNotMatch(html, /\*\*Bold\*\*/);
});

test('the rounds disclosure is wired to the reveal decision, not just able to make it', () => {
  // The decision lives in `assistant-state.js` and is asserted there. What a render test
  // can add is that the component actually consults it: a disclosure that never calls the
  // helper would pass every test of the helper and still leave the panel off screen.
  const source = readFileSync(new URL('../assistant/AssistantTranscript.jsx', import.meta.url), 'utf8');

  assert.match(source, /revealExpandedRounds\(/, 'the disclosure asks whether to reveal');
  // Read and cleared in the same pass, or a streaming open leaves the flag set and
  // suppresses the reader's *next* open — the one that needs the scroll.
  assert.match(source, /const openedByStream = openingByStreamRef\.current;\s*\n\s*openingByStreamRef\.current = false;/);
  // A layout effect, so the position is right before the paint rather than jumping after.
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*?revealExpandedRounds/);
});
