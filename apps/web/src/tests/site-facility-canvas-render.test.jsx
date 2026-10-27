import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

/**
 * Where the draw controls live is a layout decision with a correctness consequence, not
 * a cosmetic one.
 *
 * They used to be passed to the canvas as a `banner`, which inserts a row *above* the map.
 * Entering draw mode therefore resized the map, and because every screen point is
 * unprojected against the map's current pixel size, a vertex clicked after that row
 * appeared landed somewhere other than where the user clicked — the surface moved out from
 * under the drawing.
 *
 * Permission is granted here rather than exercised: `usePermission` never defaults a
 * project-scoped grant to true — correctly, since guessing a grant is guessing a security
 * decision — so a server render can only reach the write-gated markup this way. What is
 * being tested is the layout the grant reveals, not the grant.
 */
vi.mock('../permissions/usePermission.jsx', () => ({
  usePermission: () => ({ allowed: true, pending: false, unavailable: false }),
}));

/**
 * One feature per layer, because a static render never runs the read that would fetch
 * them and the layer control only exists when there are layers to switch. Without this the
 * control is untestable here, and "it renders" would quietly mean "it renders when the
 * envelope happens to be loaded".
 */
const feature = (entityType, id) => ({
  geometryId: `g-${id}`,
  entityId: id,
  entityType,
  role: entityType === 'SITE' ? 'BOUNDARY' : 'FOOTPRINT',
  displayName: id,
  // The graph as the API returns it, which is what the overlay projects. Without it the
  // canvas has features to count and nothing to draw, and every control that exists only
  // over a drawing — the search above all — would be absent from this render.
  geojson4326: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0]]] },
});

vi.mock('../facility/useFacilityEnvelope.js', () => ({
  useFacilityEnvelope: () => ({
    envelope: { revisionId: 'r-1', lifecycleState: 'DRAFT' },
    features: [
      feature('SITE', 'site-1'),
      feature('PARCEL', 'parcel-1'),
      feature('BUILDING', 'building-1'),
      feature('SUPPORT_SPACE', 'space-1'),
      feature('UTILITY_INTERFACE', 'iface-1'),
    ],
    containers: [],
    scopes: [],
    utilitySources: [],
    utilityInterfaces: [],
    spatialConstraints: [],
    capabilityCoverage: [],
    pending: false,
    error: null,
    reload: () => {},
  }),
}));

const { SiteFacilityCanvas } = await import('../map/SiteFacilityCanvas.jsx');

// Enough of a client for the hooks to build request functions without a transport; no
// effect runs under `renderToStaticMarkup`, so nothing is fetched.
const client = {
  request: async () => ({}),
  get: async () => ({}),
  post: async () => ({}),
  put: async () => ({}),
  can: async () => ({ allowed: true }),
};

const markup = () =>
  renderToStaticMarkup(<SiteFacilityCanvas client={client} projectId="p-1" revisionId="r-1" />);

test('the draw controls render after the map surface, inside the aside', () => {
  const html = markup();

  const map = html.indexOf('canvas__surface');
  const aside = html.indexOf('canvas__aside');

  assert.ok(map >= 0, 'the map surface is rendered');
  assert.ok(aside >= 0, 'the aside is rendered');
  assert.ok(
    aside > map,
    'the aside is laid out beside the map, and a row above it would resize the map and move the projection',
  );

  // The selection banner is gone entirely: selecting a feature is what the inspector is
  // for, and a second row above the map would move it again.
  assert.doesNotMatch(html, /canvas__selection/);

  // The tools that enter an authoring mode are the shell's toolbar buttons now, so the
  // aside holds only the form for whichever mode is active — and none is active on load.
  assert.doesNotMatch(html, /authoring__draw/, 'no authoring form is rendered until a tool is chosen');
  assert.doesNotMatch(html, /Draw a footprint/, 'the entry point moved to the toolbar');
});

test('everything the canvas offers is overlaid on the map', () => {
  const html = markup();
  const map = html.indexOf('canvas__surface');

  assert.ok(map >= 0, 'the map surface is rendered');

  // Nothing sits above it: the row that carried the basemap, the layers, and the view
  // controls is gone, and each of those is now inside the surface.
  assert.equal(html.indexOf('canvas__bar'), -1, 'there is no row above the map');
  for (const [what, marker] of [
    ['the basemap select', 'aria-label="Basemap"'],
    ['the layer control', 'canvas__layerbar'],
    ['the view controls', 'canvas__zoom'],
  ]) {
    assert.ok(html.indexOf(marker) > map, `${what} renders after the map surface opens, so it floats over it`);
  }

  // And none of them precedes the map, which is the invariant the old banner slot broke:
  // a control above the map resizes it and moves every feature under the cursor.
  for (const marker of ['aria-label="Basemap"', 'canvas__layerbar', 'canvas__zoom']) {
    assert.ok(html.indexOf(marker) > map, `${marker} must not be above the map`);
  }
});

test('the layer row folds, and says how many layers are on', () => {
  const html = markup();
  assert.match(html, /aria-expanded="true"/, 'the layer row starts open');
  assert.match(html, /aria-controls="canvas-layers"/);
  assert.match(html, /class="canvas__layercount">\d+\/\d+</, 'it states the visible count out of the total');
});

/* ---------------------------------------------------------------- the layout */

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function rule(selector) {
  // A plain `indexOf` finds the selector inside longer ones — `.toolbar__command` also
  // matches `.toolbar__commands` and `.toolbar__command-label` — and then slices whatever
  // block follows, or nothing at all. So the occurrence has to be the *last* selector
  // before its block opens: `{` directly, a comma when it shares a selector group, or the
  // selector's own `:hover`/`:focus-visible` variant. Anything else is a longer name that
  // merely starts the same way.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    escaped + '(?=\\s*(?:\\{|,|:(?:hover|focus-visible|active)))',
    'g',
  );
  let match = pattern.exec(css);
  let open = -1;
  while (match) {
    const brace = css.indexOf('{', match.index);
    const between = css.slice(match.index + match[0].length, brace);
    // A comma or colon between the match and the brace means this occurrence was part of a
    // longer selector — `.toolbar__command:focus-visible,` — not the rule being asked for.
    if (!/[.:#\[]/.test(between)) {
      open = brace;
      break;
    }
    match = pattern.exec(css);
  }
  assert.notEqual(open, -1, `expected a rule for ${selector}`);
  const body = css.slice(match.index, css.indexOf('}', open));
  // Comments are stripped before the rule is asserted on. These rules carry the reason they
  // exist, and a comment that names a declaration — as the `.design-frame__side` one does,
  // to explain the flex floor — otherwise satisfies `assert.match` on its own, so the test
  // passed with the declaration deleted.
  return body.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the view controls sit on the right, and the layer row extends rather than scrolls', () => {
  const zoom = rule('.canvas__zoom');
  assert.match(zoom, /position: absolute/, 'the view controls float on the map');
  assert.match(zoom, /right: var\(--space-2\)/, 'anchored to the right edge');
  assert.match(zoom, /flex-direction: column/, 'stacked, which is where every map puts zoom');
  // Vertically centred, so it is neither lost under the layer row nor crowded by the scale.
  assert.match(zoom, /top: 50%/);
  assert.match(zoom, /translateY\(-50%\)/);

  // The layer list runs down, not across: the tags carry a name and a feature count, which
  // is what a planner picks between, and a row of them reads as a sentence to be parsed.
  // (A horizontal row is the right shape for icons, which is a different control.)
  const layers = rule('.canvas__layers');
  assert.match(layers, /flex-direction: column/);
  assert.doesNotMatch(
    layers,
    /overflow(-y)?: (auto|scroll)/,
    'the layer set is a fixed enum of five, so the list is bounded and must not need a scroll that could hide one',
  );
});

test('the overlay column takes no pointer input of its own', () => {
  // The controls float over the map, and the map pans by dragging. A full-width column
  // that captured pointer events would swallow every pan that started beside a control.
  const tools = rule('.canvas__tools');
  assert.match(tools, /pointer-events: none/);
  assert.match(css, /\.canvas__tools > \* \{ pointer-events: auto; \}/, 'and the controls themselves still take it');
});

test('every floating control is marked as an overlay', () => {
  // This attribute is load-bearing, not decoration. The map pans by capturing the pointer
  // on a press, and `setPointerCapture` retargets the rest of the gesture — including the
  // click a control is waiting for — so capturing from a press that landed on an overlay
  // silently moves the click onto the map. Every control then stopped responding while hit
  // testing, its handler, and `element.click()` all reported success. The surface's pointer
  // handler bails on this attribute, so an overlay that omits it goes dead in the browser
  // and nowhere else.
  const html = markup();

  for (const [what, marker] of [
    ['the basemap and layer cluster', 'canvas__tools canvas__tools--left'],
    ['the search control', 'canvas__search'],
    ['the view controls', 'canvas__zoom'],
  ]) {
    const at = html.indexOf(marker);
    assert.ok(at >= 0, `${what} renders`);
    const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
    assert.match(tag, /data-map-overlay/, `${what} must be marked, or its controls cannot be clicked`);
  }
});

test('the basemap control is not sized by its widest option', () => {
  // A `<select>` is as wide as its widest option, and the disabled providers carry an
  // unavailability reason — so left alone the pill spans a third of the map for text
  // nobody selected. The cap is what keeps it beside the layer panel rather than across
  // the canvas, and ellipsis is what makes the truncation read as truncated: without it
  // the name is cut mid-word, which reads as a rendering fault.
  const select = rule('.canvas__tools .canvas__provider select');

  assert.match(select, /max-width: \d+px/, 'the control is capped rather than sized by its options');
  assert.match(select, /text-overflow: ellipsis/);
  assert.match(select, /overflow: hidden/);
});

/* ------------------------------------------------------ the frame and side column */

const frame = (extra = {}) =>
  renderToStaticMarkup(
    <SiteFacilityCanvas
      client={client}
      projectId="p-1"
      revisionId="r-1"
      projectName="Northern DC Campus"
      lifecycleState="VALIDATED"
      validationSummary={{ errors: 2, warnings: 5 }}
      authorName="Dana Whitfield"
      {...extra}
    />,
  );

test('the drawing area and the side column are one frame, read in that order', () => {
  const html = frame();
  const surface = html.indexOf('canvas__surface');
  const side = html.indexOf('design-frame__side');

  assert.ok(surface >= 0, 'the drawing area renders');
  assert.ok(side >= 0, 'the side column renders');
  // The surface must still precede the aside: the layout test above depends on nothing
  // being inserted above the map, and the frame must not become that row.
  assert.ok(surface < side, 'the drawing area is laid out before the side column');
  assert.ok(html.indexOf('canvas__aside') > surface, 'the inspector still sits beside the map');
});

test('the side column states the project, the revision status, and the author', () => {
  const html = frame();

  assert.match(html, /class="design-frame__project"[^>]*>Northern DC Campus</, 'the project name heads the column');
  assert.match(html, /chip--lifecycle-validated/, 'the lifecycle state is shown as a chip');
  // Errors outrank the lifecycle word: a validated revision with two errors is not "Validated".
  assert.match(html, /2 errors/, 'the error count is stated');
  assert.match(html, /5 warnings/, 'the warning count is stated');
  assert.match(html, /Dana Whitfield/, 'the author is named');
});

test('the frame carries the revision state, and no context switcher', () => {
  const html = frame({
    revisions: [{ revisionId: 'r-1', name: 'Draft 1' }],
    unsaved: true,
    approvalAttestationId: 'a-1',
  });

  // The revision is named, not only identified: a short id does not say which draft.
  assert.match(html, /Draft 1/);
  assert.match(html, /title="r-1"/);

  // The two state chips.
  assert.match(html, /chip--dirty/, 'unsaved work is stated');
  assert.match(html, /chip--approval/, 'an approval attestation is stated');

  // And nothing that switches context. A surface able to move the reader to a different
  // scenario or revision is the opposite of the attribution every view carries, so those
  // selectors are gone from the whole application — the project is chosen on the list.
  // Scoped to the context area: the authoring form's own Kind select is a different thing
  // and is not being removed.
  assert.doesNotMatch(html, /Scenario<\/span>/);
  assert.doesNotMatch(html, /Revision<\/span>/);
  const contextAt = html.indexOf('design-frame__context');
  if (contextAt !== -1) {
    const contextBlock = html.slice(contextAt, html.indexOf('</header>', contextAt));
    assert.doesNotMatch(contextBlock, /<select/, 'the context area offers no choice');
  }
});

test('the info table is a disclosure whose whole row is the control', () => {
  const html = frame();
  const at = html.indexOf('frame-info__summary');

  assert.ok(at >= 0, 'the info table has a summary row');
  // A native `<details>` again, for the same reason the rounds use one: keyboard and
  // screen-reader operability with no state to keep in step.
  assert.ok(html.lastIndexOf('<details', at) > html.lastIndexOf('</details>', at), 'the row belongs to a <details>');
  assert.match(html.slice(html.lastIndexOf('<summary', at), at), /<summary/, 'and it is the summary');

  const summary = rule('.frame-info__summary');
  assert.match(summary, /width: 100%/, 'the row spans the column, so the whole row toggles');
  assert.match(summary, /cursor: pointer/);
  // On the container instead, this would also cover the open table and any click in it.
  assert.doesNotMatch(rule('.frame-info'), /cursor: pointer/);

  // Open by default, and the author rides on the summary only when it is collapsed.
  assert.doesNotMatch(html, /frame-info__collapsed/, 'nothing is collapsed on first render');
});

test('the inspector scrolls inside the column, and the table does not move', () => {
  const scroll = rule('.design-frame__scroll');
  assert.match(scroll, /overflow-y: auto/, 'an inspector taller than the column scrolls');
  // Without this a flex child refuses to shrink below its content, so the column grows and
  // pushes the pinned bottom section out of the frame instead of scrolling.
  assert.match(scroll, /min-height: 0/);

  // The table has a fixed height, so opening it never reflows the column.
  const table = rule('.frame-info__table');
  assert.match(table, /height: \d+px/);
  assert.match(table, /overflow-y: auto/);
});

test('the side column cannot be widened by what it contains', () => {
  // The column is 360px, and a selection must not change that — the map loses exactly the
  // width the panel gains, so an unstable panel drags every feature out from under the
  // pointer mid-gesture. It did: selecting anything pushed the column to 467px and took
  // 107px off the canvas, because `flex: 0 0 360px` alone is not a width.
  const side = rule('.design-frame__side');

  assert.match(side, /flex: 0 0 360px/, 'the column states its width');
  // A flex item defaults to `min-width: auto`, which refuses to shrink below its content's
  // intrinsic width — so one wide child overrides the basis. This is the fix.
  assert.match(side, /min-width: 0/, 'the basis must not be overridden by an item that cannot shrink');
  // And a block box is also at least as wide as its longest unbreakable word, which puts a
  // second floor under it: an entity id has no spaces to break at.
  assert.match(side, /overflow-wrap: anywhere/);

  // The canvas is the flexing side, so the fixed column is what the map is measured against.
  assert.match(rule('.design-frame > .canvas'), /flex: 1 1 auto/);
});

test('an active toolbar tool is marked by its fill alone', () => {
  const active = rule('.toolbar__command--active');
  assert.match(active, /background: var\(--accent\)/, 'the accent fill is the signal');
  assert.match(active, /color: #ffffff/);
  // The fill already marks it unmistakably, so there is no ring: a fill and a ring said the
  // same thing twice, and the ring read as an outline nobody asked for.
  assert.doesNotMatch(active, /box-shadow: 0 0 0/, 'no ring around the fill');

  // Every command in the row carries a 1px border, so the active one goes transparent
  // rather than dropping it: without the border the box is two pixels narrower than its
  // neighbours, which reads as a mis-sized button.
  const base = rule('.toolbar__command');
  assert.match(base, /border: 1px solid/, 'the row is bordered');
  assert.match(active, /border-color: transparent/, 'and the active command keeps the width without the outline');

  // Still not drawn as an action: `--primary` is the fill Validate and Publish wear, so the
  // active mode must not simply be declared one. That the two classes never co-occur is
  // asserted in `shell-render.test.jsx`, where the toolbar itself is rendered.
});
