import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The bucket's placement on the drawing area, and the fact that the canvas mounts it.
 *
 * There is no headless browser in this project, so the two things a render test cannot see are
 * checked against the sources: that the palette floats over the map rather than over the whole
 * frame, and that it is wired to the bucket the canvas derived rather than to an empty list.
 */
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../map/SiteFacilityCanvas.jsx', import.meta.url), 'utf8');

function declarations(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `expected a top-level rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the left rail is positioned against the drawing area, not against the frame', () => {
  // The frame also holds the 360px side column, so a rail placed in the frame's coordinates would
  // float over the inspector instead of over the map. It is measured from the layout that holds
  // the frame, and adds the frame's insets back so its edge is the map overlay's edge.
  const host = declarations('.canvas-layout > .canvas-palette-host');
  assert.match(host, /position:\s*absolute/);
  assert.match(
    host,
    /left:\s*var\(--rail-left\)/,
    'the rail is on the map, inside its own box, and it says where that edge is once',
  );
  // The map's floating controls are inside the surface, so their inset is measured inside the
  // frame's border and padding and the surface's border. The rail is outside all three.
  assert.match(
    host,
    /--rail-left:\s*calc\(var\(--space-3\) \+ var\(--space-2\) \+ 2px\)/,
    'the rail adds back the frame padding, the frame border, and the surface border',
  );
  // A box over the map with the default `pointer-events` would swallow every pan that started in
  // it. Only the panels themselves may take input.
  assert.match(host, /pointer-events:\s*none/);
  // The rows claim input back, and they are declared where the rest of the row is rather than
  // inside the host's `pointer-events: none` scope, which the cascade would not undo.
  assert.match(css, /\.canvas-palette__item \{ pointer-events: auto; \}/);
});

test('the pending card is the second item of the rail, and only exists when it has something to say', () => {
  // Below the palette: the objects without geometry are what the drawing is missing, and the
  // changes are what has been done about it, in that order.
  const host = declarations('.canvas-layout > .canvas-palette-host');
  assert.match(host, /display:\s*flex/);
  assert.match(host, /flex-direction:\s*column/, 'the rail stacks instead of overlapping');

  const card = declarations('.canvas-pending');
  assert.match(card, /pointer-events:\s*auto/, 'the card takes input even though the rail does not');
  // A long change list must not grow the rail past the map it floats on.
  assert.match(host, /max-height:/);
  assert.match(card, /overflow-y:\s*auto/);

  // An empty card is furniture, and on the map it would be furniture over the drawing.
  assert.match(source, /const showsPending =/);
  assert.match(source, /\{showsPending \? authoringPanel : null\}/);
  // It still appears for the things it owes an answer to, not only for staged work.
  for (const field of ['authoring.changes.length > 0', 'authoring.conflict', 'authoring.error', 'authoring.notice', 'authoring.result']) {
    assert.ok(source.includes(field), `the card must show when ${field}`);
  }
  // And it is out of the side column.
  assert.equal(/authoring=\{authoringPanel\}/.test(source), false, 'the card is no longer a side-column prop');
  assert.match(source, /<div className="canvas-palette-host">/);
});

test('the rail is on the left edge, vertically centred, and cannot outgrow the map', () => {
  const host = declarations('.canvas-layout > .canvas-palette-host');

  // The same edge as the basemap select and the layer control, which is what makes the three read
  // as one column of controls over the map rather than as two unrelated clusters.
  assert.match(host, /left:\s*var\(--rail-left\)/);
  assert.match(host, /--rail-left:\s*calc\(/);
  // Centre rather than a corner: the basemap and layer controls own the top of that edge and the
  // scale owns the bottom. The column is centred as a group, so the card sits under the palette
  // without either box having to be measured.
  assert.match(host, /top:\s*50%/);
  assert.match(host, /transform:\s*translateY\(-50%\)/);
  // Bounded by the map on both sides: the width is what is left after the rail's own inset.
  assert.match(
    host,
    /width:\s*min\(240px, calc\(100% - var\(--rail-left\) - var\(--space-2\)\)\)/,
    'never wider than the map',
  );
  // A bucket of forty objects must scroll, not become as tall as the drawing.
  assert.match(declarations('.canvas-palette__list'), /max-height:/);
  assert.match(declarations('.canvas-palette__list'), /overflow-y:\s*auto/);
});

test('the pending card is a title bar, then its actions, then one change per two rows', () => {
  const panel = readFileSync(new URL('../facility/FacilityAuthoringPanel.jsx', import.meta.url), 'utf8');

  // The title stands alone as the card's title bar, and the actions are a row under it. Beside the
  // title, two buttons and a count were competing for one 240px line.
  assert.equal(panel.includes('authoring__head'), false, 'the title and the actions are no longer one row');
  const titleIndex = panel.indexOf('className="authoring__title"');
  const actionsIndex = panel.indexOf('className="authoring__actions"');
  const listIndex = panel.indexOf('className="authoring__list"');
  assert.ok(titleIndex !== -1 && actionsIndex > titleIndex, 'the actions follow the title');
  assert.ok(listIndex > actionsIndex, 'the changes follow the actions');

  const title = declarations('.authoring__title');
  assert.match(title, /padding-bottom:/);
  assert.match(title, /border-bottom:\s*1px solid var\(--line\)/, 'the title bar is a bar');

  // Two rows per change: what it is, then what it is and how to drop it. One row put a
  // description, a kind badge, and a button on one 240px line, so every description wrapped.
  const item = declarations('.authoring__item');
  assert.match(item, /flex-direction:\s*column/);
  assert.match(item, /gap:/);
  assert.ok(panel.includes('className="authoring__item-meta"'), 'the badge and Remove share the second row');

  // Neither action is a footnote to the other: they share the width.
  assert.match(declarations('.authoring__actions'), /gap:/);
  assert.match(declarations('.authoring__actions > button'), /flex:\s*1 1 0/);
});

test('the canvas mounts the palette with the objects it derived', () => {
  assert.match(
    source,
    /const unplaced = useMemo\(/,
    'the bucket is derived once per render input, not on every render',
  );
  assert.match(source, /unplacedObjects\(\{/);
  // All four collections the envelope splits into: a container, a utility source, and a utility
  // interface all owe geometry, and what is already placed is only known from the records.
  for (const field of ['containers:', 'utilitySources:', 'utilityInterfaces:', 'geometryRecords:']) {
    assert.match(source, new RegExp(`\\b${field}`), `the bucket must be composed from ${field}`);
  }
  assert.match(source, /<CanvasPalette/, 'the canvas mounts the palette');
  assert.match(source, /items=\{unplaced\}/, 'the palette gets the derived bucket, not []');
  // The gesture is remembered as well as carried: a drop can arrive with an empty
  // `dataTransfer`, and the release is still a placement (see `drag-placement.js`).
  assert.match(source, /onDragStart=\{\(item\) => \{\s*draggingItemRef\.current = item;/, 'what was picked up is kept');
  assert.match(source, /onDragEnd=\{\(\) => \{/, 'and forgotten when the gesture ends');
});
