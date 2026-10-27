import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isSafeHref, normalizeBoldLinks, parseBlocks, parseEntityHref, parseInline } from '../assistant/markdown.js';

/** Flattens a span tree to its literal text, which is what a reader would see. */
function textOf(spans) {
  return spans
    .map((span) => {
      if (span.type === 'text') return span.text;
      if (span.type === 'code') return span.text;
      return textOf(span.spans);
    })
    .join('');
}

test('paragraphs split on a blank line and a soft break becomes a space', () => {
  const blocks = parseBlocks('first line\nsecond line\n\nsecond paragraph');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(textOf(blocks[0].spans), 'first line second line');
  assert.equal(textOf(blocks[1].spans), 'second paragraph');
});

test('bold and inline code are parsed, and unknown emphasis stays literal', () => {
  const spans = parseInline('a **strong** and `code` and *italic*');
  assert.deepEqual(spans.map((span) => span.type), ['text', 'strong', 'text', 'code', 'text']);
  assert.equal(textOf(spans), 'a strong and code and *italic*');
  assert.equal(spans[1].spans[0].text, 'strong');
  assert.equal(spans[3].text, 'code');
});

test('a fenced block preserves its content and is not parsed as Markdown', () => {
  const blocks = parseBlocks('before\n\n```json\n{ "a": **not bold** }\nline two\n```\n\nafter');
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'code', 'paragraph']);
  assert.equal(blocks[1].language, 'json');
  assert.equal(blocks[1].code, '{ "a": **not bold** }\nline two');
});

test('an unterminated fence degrades to a code block rather than swallowing the message', () => {
  const blocks = parseBlocks('```\nstill code');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].code, 'still code');
});

test('bullet and ordered lists group consecutive items', () => {
  const bullets = parseBlocks('- one\n- two\n* three');
  assert.equal(bullets.length, 1);
  assert.equal(bullets[0].type, 'list');
  assert.equal(bullets[0].ordered, false);
  assert.deepEqual(bullets[0].items.map(textOf), ['one', 'two', 'three']);

  const ordered = parseBlocks('1. first\n2. second');
  assert.equal(ordered[0].ordered, true);
  assert.equal(ordered[0].start, 1);
  assert.deepEqual(ordered[0].items.map(textOf), ['first', 'second']);
});

test('a list resumed after an interruption keeps its own numbering', () => {
  const blocks = parseBlocks('1. first\n\n> a note\n\n2. second\n3. third');
  assert.deepEqual(blocks.map((block) => block.type), ['list', 'quote', 'list']);
  assert.equal(blocks[2].start, 2, 'the second list must not restart at 1');
  assert.deepEqual(blocks[2].items.map(textOf), ['second', 'third']);
});

test('a blockquote is parsed as nested blocks', () => {
  const blocks = parseBlocks('> **Note:** no tools are available\n> in this context.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'quote');
  assert.equal(blocks[0].blocks[0].type, 'paragraph');
  assert.equal(textOf(blocks[0].blocks[0].spans), 'Note: no tools are available in this context.');
  assert.equal(blocks[0].blocks[0].spans[0].type, 'strong');
});

test('a pipe table is recognized with alignment, and inline Markdown inside cells works', () => {
  const blocks = parseBlocks('| Item | Status |\n| :--- | ---: |\n| **Hall 01** | `DRAFT` |\n| Hall 02 | DRAFT |');
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.header.map(textOf), ['Item', 'Status']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0].map(textOf), ['Hall 01', 'DRAFT']);
  assert.equal(table.rows[0][0][0].type, 'strong');
  assert.equal(table.rows[0][1][0].type, 'code');
});

test('headings and raw HTML stay literal text', () => {
  for (const source of ['# Heading', '<script>alert(1)</script>']) {
    const blocks = parseBlocks(source);
    assert.equal(blocks[0].type, 'paragraph', `${source} must not become a block element`);
    assert.ok(textOf(blocks[0].spans).includes(source), `${source} must stay visible`);
  }
});

test('a task-list line is a plain bullet, never a checkbox', () => {
  const blocks = parseBlocks('- [ ] a task');
  assert.equal(blocks[0].type, 'list');
  assert.equal(textOf(blocks[0].items[0]), '[ ] a task');
});

test('an image degrades to its alt text, never to an image or an anchor', () => {
  const spans = parseInline('![site plan](https://example.test/plan.png)');
  assert.deepEqual(spans, [{ type: 'text', text: 'site plan' }]);
});

test('an entity link keeps its identity in the target and its label in the prose', () => {
  const spans = parseInline('See [**Data Hall 01**](entity://facility.entity/e-1).');
  const link = spans.find((span) => span.type === 'link');
  assert.equal(link.href, 'entity://facility.entity/e-1');
  assert.equal(link.spans[0].type, 'strong');
  assert.equal(textOf(link.spans), 'Data Hall 01');

  assert.deepEqual(parseEntityHref('entity://facility.entity/e-1'), { kind: 'facility.entity', id: 'e-1' });
  assert.deepEqual(parseEntityHref('entity://asset/e-1'), { kind: 'asset', id: 'e-1' });
  assert.equal(parseEntityHref('https://example.test'), null);
  assert.equal(parseEntityHref('entity://no-id'), null);
  assert.equal(parseEntityHref('entity:///e-1'), null);
  assert.equal(parseEntityHref(null), null);
});

test('only http and https become anchors', () => {
  assert.equal(isSafeHref('https://example.test'), true);
  assert.equal(isSafeHref('http://example.test'), true);
  assert.equal(isSafeHref('javascript:alert(1)'), false);
  assert.equal(isSafeHref('data:text/html,x'), false);
  assert.equal(isSafeHref('entity://facility.entity/e-1'), false);
});

test('a link the model bolded around its brackets is repaired, not shown as literal markup', () => {
  // A model does not write `[Label](href)`. It writes `**[**Label**](href)**` — bolding the whole
  // link *and* the label — which parsed as three spans, because the emphasis alternative matched
  // `**[**` before the link alternative could match at `[`. The citation rendered as literal
  // asterisks and brackets and the entity was never linked. Reported as "MD formatting seems
  // broken by a line wrap"; the wrap only made it easier to notice.
  const variants = [
    '**[**Central Chiller Plant**](entity://facility.entity/e-1)**',
    '**[**Central Chiller Plant**](entity://facility.entity/e-1)',
    '**[Central Chiller Plant](entity://facility.entity/e-1)**',
    // The same, with the label broken across a line.
    '**[**\nCentral Chiller Plant**](entity://facility.entity/e-1)**',
    '[**Central Chiller\nPlant**](entity://facility.entity/e-1)',
  ];

  for (const variant of variants) {
    const spans = parseBlocks(variant)[0].spans;
    assert.equal(spans.length, 1, `not one span: ${JSON.stringify(spans)} for ${variant}`);
    assert.equal(spans[0].type, 'link', `not a link for ${JSON.stringify(variant)}`);
    assert.equal(spans[0].href, 'entity://facility.entity/e-1');
    // The label is the entity's name, whole, and it is still emphasised.
    const label = spans[0].spans.map((span) => span.text ?? span.spans?.map((inner) => inner.text).join('')).join('');
    assert.equal(label, 'Central Chiller Plant', `label came out as ${JSON.stringify(label)}`);
  }
});

test('a well-formed link is left exactly as it is', () => {
  // The server's own rewrite emits this shape, so the repair must be a no-op on it.
  const canonical = '[**Central Chiller Plant**](entity://facility.entity/e-1)';
  assert.equal(normalizeBoldLinks(canonical), canonical);
  // And a bold run with no link in it is not touched.
  assert.equal(normalizeBoldLinks('**not a link**'), '**not a link**');
  assert.equal(normalizeBoldLinks(''), '');
  assert.equal(normalizeBoldLinks(null), null);
});

test('an empty or non-string message parses to no blocks', () => {
  assert.deepEqual(parseBlocks(''), []);
  assert.deepEqual(parseBlocks(null), []);
  assert.deepEqual(parseInline(undefined), []);
});
