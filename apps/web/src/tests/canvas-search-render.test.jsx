import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasSearch } from '../map/CanvasSearch.jsx';

/**
 * The search control's three states, rendered as markup.
 *
 * The component is uncontrolled — a click opens it, typing fills it — so a static render
 * would only ever show the icon. `defaultOpen` and `defaultQuery` exist for that reason, and
 * they are what these use: the states a pointer would reach are asserted here, and the
 * pointer itself is exercised in the browser.
 */
const shape = (displayName, entityType, role, layer) => ({
  geometryId: `g-${displayName}`,
  entityType,
  role,
  layer,
  displayName,
});

const SHAPES = [
  shape('Northern DC Campus', 'SITE', 'BOUNDARY', 'site'),
  shape('Data Hall 01', 'HALL', 'FOOTPRINT', 'spaces'),
  shape('Power Interface A', 'UTILITY_INTERFACE', 'CONNECTION_POINT', 'utilities'),
];

const render = (props = {}) => renderToStaticMarkup(<CanvasSearch shapes={SHAPES} {...props} />);

test('at rest it is one icon, and it says what it would do', () => {
  const html = render();

  assert.match(html, /class="canvas__control canvas__search-toggle"/);
  assert.match(html, /aria-label="Search the facility graph"/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal(html.includes('canvas__search-input'), false, 'no field until it is wanted');
  assert.equal(html.includes('canvas__results'), false);
  // No panel exists to point at, so nothing claims to control one.
  assert.equal(html.includes('aria-controls'), false);
});

test('opened, the field is beside the icon and the results are under both', () => {
  const html = render({ defaultOpen: true });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="Close search"/, 'the icon becomes the way out');
  assert.match(html, /aria-controls="canvas-search-results"/, 'and points at the panel it opened');
  assert.match(html, /class="canvas__search-input"/);
  assert.match(html, /placeholder="Find a feature…"/);
  assert.match(html, /aria-label="Search the facility graph"/, 'the field carries the name the button had');
  // The field is before the button in the markup, which is what puts it to the left.
  assert.ok(html.indexOf('canvas__search-input') < html.indexOf('canvas__search-toggle'));

  // Opened with nothing typed: the panel states what can be searched rather than showing an
  // empty list.
  assert.match(html, /canvas__search-panel/);
  assert.match(html, /Type to search 3 drawn features by name, type, or role\./);
});

test('a query lists the matches with what tells them apart', () => {
  const html = render({ defaultOpen: true, defaultQuery: 'hall' });

  assert.match(html, /aria-label="Search results"/);
  assert.match(html, /canvas__result-name">Data Hall 01</);
  // The layer label, not the layer id, and the role beside it.
  assert.match(html, /Floors, halls &amp; spaces · FOOTPRINT/);
  assert.equal((html.match(/class="canvas__result"/g) ?? []).length, 1);
});

test('a query with no match says so rather than showing nothing', () => {
  const html = render({ defaultOpen: true, defaultQuery: 'cooling' });

  assert.match(html, /No drawn feature matches “cooling”\./);
  assert.equal(html.includes('canvas__results'), false);
});

test('a search that finds nothing says how much is behind a hidden layer', () => {
  const one = render({ defaultOpen: true, defaultQuery: 'cooling', hiddenCount: 1 });
  assert.match(one, /1 feature is behind a hidden layer\./);

  const several = render({ defaultOpen: true, defaultQuery: 'cooling', hiddenCount: 4 });
  assert.match(several, /4 features are behind a hidden layer\./);

  // With nothing hidden, the sentence would be a lie by omission rather than by statement,
  // so it is left out.
  assert.doesNotMatch(render({ defaultOpen: true, defaultQuery: 'cooling' }), /hidden layer/);
});

test('the panel lists a bounded number and counts the rest', () => {
  const many = Array.from({ length: 11 }, (_, index) => shape(`Data Hall ${index}`, 'HALL', 'FOOTPRINT', 'spaces'));
  const html = renderToStaticMarkup(<CanvasSearch shapes={many} defaultOpen defaultQuery="data hall" />);

  assert.equal((html.match(/class="canvas__result"/g) ?? []).length, 8);
  assert.match(html, /Showing 8 of 11 matches\./);
});

test('a graph with nothing drawn says so instead of offering an empty search', () => {
  const html = renderToStaticMarkup(<CanvasSearch shapes={[]} defaultOpen />);
  assert.match(html, /The facility graph has no geometry to search\./);
});
