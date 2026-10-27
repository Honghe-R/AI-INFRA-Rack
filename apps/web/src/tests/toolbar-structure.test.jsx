import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ActiveToolToolbar } from '../shell/ActiveToolToolbar.jsx';
import { commandIcon } from '../shell/icons.jsx';
import { toolCommands } from '../state/tool-registry.js';

/**
 * The toolbar's shape, which is a statement about what the shell repeats and what a tool
 * contributes.
 *
 * Two things changed here and both are worth pinning: the tool's name is no longer drawn
 * on the row below the tab that already says it, and the tool's commands are split into
 * the tools that add to the design and the governance pair that ends the workflow.
 */

const KEYS = ['facility.utility.write', 'facility.entity.write', 'facility.import.initiate', 'facility.validate.run', 'facility.publish'];

const render = (props = {}) =>
  renderToStaticMarkup(
    <ActiveToolToolbar toolId="site_facility" grantedKeys={new Set(KEYS)} {...props} />,
  );

test("the tool's name is not repeated below the tab that already shows it", () => {
  const html = render();

  assert.doesNotMatch(html, /toolbar__tool/, 'the duplicate label is gone from the markup');
  assert.doesNotMatch(html, />Site &amp; Facility</, 'and the name is not drawn anywhere in the row');
  // It survives as the accessible name, which is where a toolbar's identity belongs.
  assert.match(html, /role="toolbar" aria-label="Site &amp; Facility commands"/);
});

test('the toolbar carries the tools that act on this tab, and the governance pair last', () => {
  const html = render();

  for (const label of ['Add interface', 'Draw footprint', 'Import', 'Validate', 'Publish']) {
    assert.match(html, new RegExp(`>${label}<`), `${label} is a toolbar command`);
  }

  // Order in the markup is order on screen: the authoring tools first, then the pair.
  const order = ['Add interface', 'Draw footprint', 'Import', 'Validate', 'Publish'].map((label) =>
    html.indexOf(`>${label}<`),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'the commands read in the order they are used',
  );

  const trailing = html.indexOf('toolbar__group--trailing');
  assert.ok(trailing >= 0, 'there is a trailing group');
  assert.ok(trailing < html.indexOf('>Validate<'), 'validating and publishing sit in it');
  assert.ok(trailing < html.indexOf('>Publish<'));
  assert.ok(
    trailing > html.indexOf('>Import<'),
    'and the authoring tools are outside it, so the pair is pushed to the far end of the row',
  );
});

test('a command the role does not hold is dropped rather than shown dead', () => {
  const html = renderToStaticMarkup(
    <ActiveToolToolbar toolId="site_facility" grantedKeys={new Set(['facility.read'])} />,
  );

  assert.doesNotMatch(html, />Publish</);
  assert.doesNotMatch(html, />Validate</);
  assert.match(html, /No commands are available for your role in this project/);
});

test('the declared commands are the ones the toolbar draws', () => {
  assert.deepEqual(
    toolCommands('site_facility').map((command) => command.commandId),
    ['add_interface', 'draw_footprint', 'import', 'validate', 'publish'],
  );
  assert.deepEqual(
    toolCommands('site_facility')
      .filter((command) => command.variant === 'primary')
      .map((command) => command.commandId),
    ['validate', 'publish'],
    'only the governance pair is primary, which is what the trailing group holds',
  );
});

test('each command has its own glyph, and none of them borrows another control’s', () => {
  // The first version wore `map`, `upload`, and `send` — which are the basemap control,
  // Add files, and Share. A toolbar drawn with another control's icons names the wrong
  // tool, so the five are asserted to be their own set and to avoid the shared glyphs.
  const icons = toolCommands('site_facility').map((command) => commandIcon(command.commandId));

  assert.deepEqual(icons, [
    'addInterface',
    'drawFootprint',
    'importAsset',
    'validateRevision',
    'publishRevision',
  ]);
  assert.equal(new Set(icons).size, icons.length, 'no two commands share a glyph');

  const borrowed = ['map', 'upload', 'send', 'grid', 'plug', 'layout'];
  for (const glyph of icons) {
    assert.equal(borrowed.includes(glyph), false, `${glyph} is another control's icon`);
  }
});

test('an icon-only command keeps its accessible name', () => {
  const html = render();

  for (const label of ['Add interface', 'Draw footprint', 'Import', 'Validate', 'Publish']) {
    // The name is stated on the button, so hiding the label costs a sighted reader the
    // word and leaves the control named. Without this an icon-only row is five unnamed
    // buttons, because the glyph is aria-hidden by design.
    assert.match(html, new RegExp(`aria-label="${label}"`), `${label} keeps a stated name`);
  }
  assert.match(html, /class="toolbar__command-label"/, 'the label is its own element, so CSS can drop it');
});

test('a labelled command titles itself with the reason when blocked, and the label otherwise', () => {
  const html = render({ disabledReasons: { publish: 'The revision is not validated.' } });
  assert.match(html, /title="The revision is not validated\."/);
  assert.match(html, /aria-disabled="true"/);
  // Not blocked: the title is the label, which is what makes an icon-only button legible
  // on hover.
  assert.match(html, /title="Add interface"/);
});

/**
 * The label-hiding rule, checked against the stylesheet because it is a container query
 * and no render test can resolve one. `shell-layout.test.js` checks the shell frame the
 * same way, and `canvas-selection.test.js` checks the selection colour.
 */
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('the labels drop when the row runs out of width, and only the label drops', () => {
  const query = css.match(/@container workspace \(max-width: (\d+)px\) \{\s*\.toolbar__command-label \{ display: none; \}/);

  assert.ok(query, 'the toolbar has a container-query threshold that hides the label');
  // Measured from the rendered commands: the five labelled commands need 599px including
  // their gaps and the row's insets, so the label must survive at 604 and above.
  assert.equal(Number(query[1]), 604, 'the threshold is the measured one, not an estimate');

  // The whole container block, not the first rule in it: brace-matched, because taking
  // everything up to the next `}` stops at the label rule and would silently assert
  // nothing about the rest.
  const start = css.indexOf(query[0]);
  let depth = 0;
  let end = start;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  const block = css.slice(start, end);
  assert.ok(block.length > query[0].length, 'the block has more than the one rule in it');
  assert.match(block, /gap: 0/, 'the gap the label left behind is closed, or the icon sits off centre');
  // The button itself must not be hidden: dropping the label is the whole rule, and
  // hiding the control would take the tool away rather than its word.
  assert.doesNotMatch(block, /\.toolbar__command \{ display: none/);
});

test('the icon is drawn in colour and at its own weight, not the body-text one', () => {
  assert.match(css, /\.toolbar__command \.icon \{ color: var\(--accent\)/, 'secondary commands tint the icon');
  assert.match(css, /\.toolbar__command--primary \.icon \{ color: #ffffff/, 'and the primary pair inverts it');
  // 1.6px reads as hairline beside a 550-weight label, which is why these carry 1.9.
  assert.match(css, /\.toolbar__command \{[^}]*min-height: 32px/s, 'the control is tall enough for a 17px icon');
});
