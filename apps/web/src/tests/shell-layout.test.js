import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Layout regression guard for the shell frame.
 *
 * There is no headless browser in this project, so the one invariant that a
 * render test cannot see is checked directly against the stylesheet: the shell
 * must be a fixed viewport-height frame whose regions scroll internally. When
 * the frame was allowed to grow with its content, the collapsed bottom drawer's
 * handle was pushed below the fold and disappeared.
 */
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function declarations(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `expected a top-level rule for ${selector}`);
  // Comments are stripped before the rule is asserted on: a rule's own explanation can
  // name a declaration, and `assert.match` would then be satisfied by the comment
  // rather than by the declaration it describes.
  return css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the shell is a fixed viewport-height frame', () => {
  const shell = declarations('.shell');

  assert.match(shell, /height:\s*100dvh/, 'the frame takes the dynamic viewport height');
  assert.match(
    shell,
    /grid-template-rows:\s*minmax\(0,\s*1fr\)/,
    'the row must be pinned, or content makes the grid taller than the frame',
  );
  assert.match(shell, /overflow:\s*hidden/, 'the frame clips instead of scrolling as a document');
  assert.doesNotMatch(
    shell,
    /min-height:\s*100vh/,
    'a min-height frame grows with content and pushes the drawer off screen',
  );
});

test('boxes are sized by their border box', () => {
  // Without this, `width: 100%` plus padding and a border makes an element wider
  // than its container: the assistant textarea measured 746px inside a 720px
  // content box and spilled past the frame that holds it. Every `width: 100%` in
  // the stylesheet assumes this model.
  assert.match(
    css,
    /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box/,
    'the border-box model must be set globally',
  );
});

test('shell regions scroll internally instead of growing the frame', () => {
  // A sidebar with sixteen tools plus an open function list exceeds a short
  // viewport; it scrolls rather than stretching the grid.
  assert.match(declarations('.sidebar'), /overflow-y:\s*auto/);
  assert.match(declarations('.main-view'), /overflow:\s*auto/);

  // Both wrappers must be shrinkable, otherwise their content sets a floor and
  // the frame overflows again.
  assert.match(declarations('.shell__main'), /min-height:\s*0/);
  assert.match(declarations('.shell__surface'), /min-height:\s*0/);
});

test('the toolbar is the container-driven region that remains', () => {
  // The rest of the project context bar's disclosure tiers are gone with the bar. What is
  // left is the toolbar's, and it is worth holding: the tiers used to hide
  // `.chip--lifecycle` and `.chip--validation`, which now sit inside `.design-frame__side`
  // — also inside this container — so a surviving tier would silently strip the revision's
  // state from the one place that still shows it.
  assert.match(css, /container-type:\s*inline-size/, 'the shell column is a named container');

  const tierBlocks = [...css.matchAll(/@container workspace[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const hidden = tierBlocks.join('\n');

  assert.match(hidden, /toolbar__command-label/, 'the toolbar still sheds its command labels');
  assert.doesNotMatch(hidden, /context-bar/, 'no tier outlives the component it styled');
  assert.doesNotMatch(hidden, /chip--lifecycle/, 'a tier must not hide the canvas frame\'s lifecycle chip');
  assert.doesNotMatch(hidden, /chip--validation/, 'nor its validation chip');
});

test('the drawer sits at its natural height inside the frame', () => {
  const drawer = declarations('.drawer');

  assert.match(drawer, /border-top/, 'the handle is a distinct, visible strip');
  assert.doesNotMatch(
    drawer,
    /position:\s*(fixed|absolute)/,
    'the drawer is an in-flow row of the main column, above nothing',
  );

  // The resize control drives the body's height through this custom property,
  // which the shell sets from the persisted preference.
  assert.match(declarations('.drawer__body'), /height:\s*var\(--drawer-height\)/);
});

test('the canvas takes the surface height, and the composer overlays it', () => {
  // The inset exists so the collapsed launcher cannot cover a tool's primary action. On
  // the canvas there is no such action under it — the lower band is empty map — so the
  // inset only cost the frame height it needs to read as a drawing board.
  assert.match(css, /\.shell__surface \.main-view:has\(\.canvas-layout\) \{\s*padding-bottom:\s*0/);

  // Scoped, or every other surface loses the inset too.
  assert.match(css, /\.shell__surface \.main-view \{\s*padding-bottom:\s*88px/);
  assert.doesNotMatch(
    css,
    /\.shell__surface \.main-view \{\s*padding-bottom:\s*0/,
    'the inset is removed for the canvas, not for every tool',
  );

  // Lifted onto the map, not left floating in the frame-chrome strip beneath it, where a
  // launcher reads as another toolbar row. Scoped to the canvas again: on a surface where
  // the inset is still doing its job, the composer must stay clear of the bottom.
  assert.match(css, /\.shell__surface:has\(\.canvas-layout\) \.assistant \{\s*bottom:\s*var\(--space-4\)/);
});

test('the launcher is positioned by a slot, so dragging cannot fight its hover', () => {
  // The launcher transforms itself on hover, and both would write `translate` — on one
  // element the hover wins and a dragged launcher snaps back under the pointer.
  assert.match(declarations('.assistant__launcher-slot'), /transition:\s*transform/);
  assert.match(css, /\.assistant__launcher-slot\[data-dragging\]\s*\{\s*transition:\s*none/);
  // `declarations` finds the first mention, which is a `pointer-events` group, so this
  // rule is read off the stylesheet by its property instead.
  assert.match(css, /\.assistant__launcher \{[\s\S]*?touch-action:\s*none[\s\S]*?\}/);
});

