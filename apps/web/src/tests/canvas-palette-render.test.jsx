import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasPalette } from '../map/CanvasPalette.jsx';

/**
 * The bucket, rendered.
 *
 * The component is a drag source, so what it can be asserted to do in a static render is the
 * contract the drop side depends on: which rows exist, what they say the gesture is, and the
 * `text/plain` id a release reads back. The gesture itself — a ghost, a drop, an armed draw —
 * needs a layout engine and is exercised in the browser.
 */
const item = (entityId, entityType, name, role, geometryType) => ({ entityId, entityType, name, role, geometryType });

const ITEMS = [
  item('c-building', 'BUILDING', 'Data Centre A', 'FOOTPRINT', 'POLYGON'),
  item('s-entrance', 'UTILITY_SOURCE', 'Utility Entrance B', 'CONNECTION_POINT', 'POINT'),
];

const render = (props = {}) => renderToStaticMarkup(<CanvasPalette items={ITEMS} {...props} />);

/** The drag handlers off each row, which the static render cannot exercise. */
function rowProps(items) {
  const aside = CanvasPalette({ items });
  const list = aside.props.children.find((child) => child?.props?.className === 'canvas-palette__list');
  return list.props.children.map((row) => row.props.children.props);
}

test('an empty bucket renders nothing at all', () => {
  // Not an empty panel: a bucket with nothing in it has nothing to say, and permanent
  // "nothing is missing" furniture is what this is here to avoid.
  assert.equal(renderToStaticMarkup(<CanvasPalette items={[]} />), '');
  assert.equal(renderToStaticMarkup(<CanvasPalette />), '');
});

test('every object to place is a row, named and counted', () => {
  const html = render();

  assert.match(html, /aria-label="Objects without geometry"/);
  assert.match(html, /class="canvas-palette__count">2</);
  assert.match(html, /objects to place/);
  assert.match(html, /Data Centre A/);
  assert.match(html, /Utility Entrance B/);
  // The kind is stated in the reader's words, not as the enum the store holds.
  assert.match(html, /building/);
  assert.match(html, /utility source/);
  assert.equal(/UTILITY_SOURCE/.test(html), false, 'the enum is not the label');
});

test('a single object says so in the singular', () => {
  assert.match(render({ items: [ITEMS[0]] }), /object to place/);
  assert.equal(/objects to place/.test(render({ items: [ITEMS[0]] })), false);
});

test('the row says which gesture the object needs', () => {
  const html = render();

  // The two behaviours are different — one drops where it is released, the other cannot be
  // carried at all — so each row says which, rather than leaving a drag to fail.
  assert.match(html, /canvas-palette__shape canvas-palette__shape--polygon">outline</);
  assert.match(html, /canvas-palette__shape canvas-palette__shape--point">point</);
  assert.match(html, /Data Centre A — drop to start drawing/);
  assert.match(html, /Utility Entrance B — drop on the map/);
});

test('a row is draggable and carries its id, which is what a drop reads back', () => {
  const html = render();

  assert.match(html, /draggable="true"/);

  // The id is the whole payload. The role and the kind of shape are deliberately not in it:
  // the drop looks the object up in the bucket as it stands, so the role comes from the one
  // table that decides roles (`geometry-placement.js`) rather than from the gesture.
  const carried = rowProps(ITEMS).map((row) => {
    const calls = [];
    const dataTransfer = { effectAllowed: null, setData: (type, value) => calls.push([type, value]) };
    row.onDragStart({ dataTransfer });
    assert.equal(dataTransfer.effectAllowed, 'copy', 'a drag from the bucket adds nothing where it lands');
    return calls;
  });

  assert.deepEqual(carried, [
    [['text/plain', 'c-building']],
    [['text/plain', 's-entrance']],
  ]);
});

test('an unnamed object still has a row a user can grab', () => {
  const html = renderToStaticMarkup(
    <CanvasPalette items={[item('u-1', 'UTILITY_SOURCE', null, 'CONNECTION_POINT', 'POINT')]} />,
  );

  assert.match(html, /u-1/);
});
