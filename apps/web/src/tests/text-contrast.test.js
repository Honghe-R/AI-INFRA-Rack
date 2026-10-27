import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Contrast of the light scheme's text tokens against every surface they sit on.
 *
 * There is no headless browser here, so the ratio is computed from the stylesheet — the
 * same technique `shell-layout.test.js` uses for the shell frame and `canvas-selection.test.js`
 * for the selection colour. It is worth the arithmetic because the failure was invisible:
 * `--text-subtle` sat at 3.1:1 on white and 2.7:1 on the tinted surfaces while carrying
 * small captions and meta, which need 4.5:1, and no test could see it and no reviewer
 * reads a hex code and knows its ratio.
 *
 * The dark scheme is deliberately not covered. It has the same shape of problem —
 * `--text-subtle` is 3.96:1 there — and it is left as it was because a request to darken
 * the light scheme is not a request to restyle the dark one. Recording that here means the
 * omission is a decision with a number attached rather than an oversight.
 */
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function block(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `expected a top-level rule for ${selector}`);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

function tokens(selector) {
  const found = {};
  for (const [, name, value] of block(selector).matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    found[name] = value.toLowerCase();
  }
  return found;
}

const toRgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) =>
  toRgb(hex)
    .map((channel) => channel / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const LIGHT = tokens(':root');
const TEXT_TOKENS = ['--text', '--text-muted', '--text-subtle'];
// Every surface a text token can land on, including the tinted ones: a caption on
// `--accent-soft` is the worst case, and it was the case nobody looked at.
const SURFACES = [
  '--surface',
  '--canvas',
  '--surface-sunken',
  '--surface-muted',
  '--surface-raised',
  '--accent-soft',
  '--error-soft',
  '--warning-soft',
  '--success-soft',
];

test('every light-scheme text token meets WCAG AA on every surface', () => {
  for (const token of TEXT_TOKENS) {
    assert.ok(LIGHT[token], `${token} is defined`);
    for (const surface of SURFACES) {
      assert.ok(LIGHT[surface], `${surface} is defined`);
      const ratio = contrast(LIGHT[token], LIGHT[surface]);
      assert.ok(
        ratio >= 4.5,
        `${token} on ${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 AA floor for body text`,
      );
    }
  }
});

test('the three text steps stay ordered and each is a real step', () => {
  const steps = TEXT_TOKENS.map((token) => contrast(LIGHT[token], LIGHT['--surface']));

  assert.ok(steps[0] > steps[1] && steps[1] > steps[2], `the ladder is ordered, got ${steps.join(' / ')}`);
  // Darkening the greys until they meet is one fix; darkening them until they are the same
  // colour is another, and it would leave the two-step hierarchy the greys exist for with
  // nothing to say. Each step must remain a visible change — about 1.7x, which is what the
  // current values are.
  for (let index = 1; index < steps.length; index += 1) {
    const ratio = steps[index - 1] / steps[index];
    assert.ok(ratio >= 1.4, `step ${index} is only ${ratio.toFixed(2)}x the next, which is not a visible step`);
  }
});

test('the greys are darker than the bodies of text they describe', () => {
  // The regression, stated directly: the muted pair must stay well clear of the old values,
  // which were light enough to read as disabled.
  assert.ok(contrast(LIGHT['--text-muted'], '#ffffff') > 8, 'muted is comfortably past AA, not merely on it');
  assert.ok(contrast(LIGHT['--text-subtle'], '#ffffff') > 5, 'and subtle is past it with margin');
  assert.notEqual(LIGHT['--text-muted'], '#5b6572', 'the washed-out grey is gone');
  assert.notEqual(LIGHT['--text-subtle'], '#8b939e', 'and so is the one that failed AA');
});
