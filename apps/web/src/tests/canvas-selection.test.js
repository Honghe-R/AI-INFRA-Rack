import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeToolCommand, endsActiveTool } from '../map/canvas-state.js';

/**
 * The selection outline must not be the object's own colour.
 *
 * A selected feature used to be marked only by a thicker stroke, drawn in whatever hue its
 * layer already owned — accent for site and buildings, success for spaces, error for
 * constraints, warning for utilities. So the border that was supposed to answer "which one
 * is selected" was the same border the object already had, only heavier, and on a canvas
 * where several features of a layer sit together there was nothing to see.
 *
 * No headless browser is available, so the invariant is checked against the stylesheet, as
 * `shell-layout.test.js` checks the frame: the selected rule must name a stroke, that
 * stroke must be the dedicated `--selection` token, the token must be defined for both
 * colour schemes, and no layer rule may spend it — a layer that borrowed it would put the
 * confusion straight back.
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

const LAYER_HUES = [
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--accent-line',
  '--success',
  '--success-soft',
  '--error',
  '--error-soft',
  '--warning',
  '--warning-soft',
];

test('a selected feature is outlined in the selection colour, not the layer colour', () => {
  const selected = declarations('.canvas__feature--selected');

  assert.match(selected, /stroke:\s*var\(--selection\)/, 'the selected outline names the selection token');
  // Width stays where it was: the complaint was the colour, and a heavier stroke alone is
  // what was already there.
  assert.match(selected, /stroke-width:\s*3/);
});

test('no layer borrows the selection colour', () => {
  for (const layer of ['site', 'buildings', 'spaces', 'constraints', 'utilities']) {
    const rule = declarations(`.canvas__feature--${layer}`);
    assert.doesNotMatch(
      rule,
      /--selection/,
      `${layer} must not draw itself in the selection colour: selection would be invisible on it`,
    );
  }
});

test('the selection token is defined in every colour scheme', () => {
  const light = declarations(':root').match(/--selection:\s*([^;]+);/);
  const dark = declarations("[data-color-scheme='DARK']").match(/--selection:\s*([^;]+);/);

  assert.ok(light, 'the light scheme defines --selection');
  assert.ok(dark, 'the dark scheme defines --selection');
  assert.notEqual(light[1].trim(), dark[1].trim(), 'the dark canvas needs its own value');

  // High contrast reuses the scheme colours and only overrides line and text, so the token
  // must not be defined in a way that leaves it absent there.
  assert.doesNotMatch(declarations("[data-contrast='HIGH']"), /--selection/, 'high contrast inherits it rather than redefining it');
});

test('the selection colour is one no layer already uses', () => {
  // A token equal to a layer hue would be the original bug wearing a variable name.
  const light = declarations(':root');
  const value = light.match(/--selection:\s*([^;]+);/)[1].trim();

  for (const hue of LAYER_HUES) {
    const declared = light.match(new RegExp(`${hue}:\\s*([^;]+);`));
    if (!declared) continue;
    assert.notEqual(
      declared[1].trim(),
      value,
      `--selection must differ from ${hue}, or a selected feature of that layer looks unselected`,
    );
  }
});

/* ------------------------------------------------------------- tool-mode helpers */

test('a tool mode names the command that started it', () => {
  assert.equal(activeToolCommand('DRAW_FOOTPRINT'), 'draw_footprint');
  assert.equal(activeToolCommand('PLACE_INTERFACE'), 'add_interface');
  // An idle map belongs to no command, so the toolbar marks nothing.
  assert.equal(activeToolCommand(null), null);
  assert.equal(activeToolCommand(undefined), null);
  assert.equal(activeToolCommand('SOMETHING_ELSE'), null);
});

test('Escape ends a running tool, and an idle map does not swallow the key', () => {
  // The tools stay active while they are used — a footprint takes several vertices — so
  // they need a way out that is not "finish the shape".
  assert.equal(endsActiveTool({ key: 'Escape' }, { active: true }), true);

  // Idle: Escape must keep working as the way to dismiss whatever else is open, which is
  // what the composer and the shell's menus bind it to.
  assert.equal(endsActiveTool({ key: 'Escape' }, { active: false }), false);
  assert.equal(endsActiveTool({ key: 'Escape' }), false);

  // Any other key is not the gesture, including the one that ends a text field.
  for (const key of ['Enter', 'Tab', 'Delete', 'Esc', 'Escape ']) {
    assert.equal(endsActiveTool({ key }, { active: true }), false, `${key} must not end the tool`);
  }
  assert.equal(endsActiveTool(null, { active: true }), false);
});
