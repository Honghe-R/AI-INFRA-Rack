/**
 * The demo watermark.
 *
 * This deployment is a demonstration for domain review, and a partially filled canvas
 * is easy to read as a finished service — or a screenshot of one is easy to mistake for
 * production. The mark is part of the interface rather than a post-processing step so
 * that it is drawn from the same theme tokens as everything else, and therefore stays
 * legible in either colour scheme instead of being a light grey that vanishes on a dark
 * canvas.
 *
 * It is a **mask**, not a picture of text. The tile carries only the letter shapes; the
 * colour comes from `background-color: var(--text)` in the stylesheet, so one asset
 * serves both schemes, and `background-repeat` tiles it without limit in both
 * directions. An earlier version rendered a fixed number of spans in a grid, which left
 * a large canvas bare and crowded a small panel — a count can never fit both.
 *
 * `VITE_DEMO_WATERMARK` is read at **build** time. An empty value renders nothing, so a
 * production build turns it off with one variable rather than a code change — and a
 * build-time value is deliberate: a watermark an operator can switch off at runtime is
 * not a watermark.
 *
 * It carries `aria-hidden`, and `pointer-events: none` in the stylesheet, because it
 * must change what the interface *looks* like and nothing about what it *does*.
 */
const WATERMARK_TEXT = import.meta.env?.VITE_DEMO_WATERMARK ?? 'AI Infra Planner Demo';

/**
 * One tile of the repeating pattern.
 *
 * Sized from the rotated text rather than guessed: at 12px with this tracking, the
 * phrase measures roughly 190px wide, so rotating it by 22 degrees needs about 190x90.
 * The tile is 250x130 — enough margin that a glyph is never clipped at a tile edge,
 * which would read as a seam across the surface. Both directions tile, so the margin is
 * the whole of the spacing.
 */
const TILE_WIDTH = 250;
const TILE_HEIGHT = 130;

/** The phrase is drawn uppercase, so the tile is built from the same string it displays. */
function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[char]);
}

function watermarkTile(text) {
  const label = escapeXml(text.toUpperCase());
  const x = TILE_WIDTH / 2;
  const y = TILE_HEIGHT / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_WIDTH}" height="${TILE_HEIGHT}">` +
    `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" ` +
    `font-size="12" font-weight="600" letter-spacing="1.6" fill="#000" ` +
    `transform="rotate(-22 ${x} ${y})">${label}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function Watermark() {
  if (!WATERMARK_TEXT) return null;

  return (
    <div
      className="watermark"
      aria-hidden="true"
      style={{
        '--watermark-tile': watermarkTile(WATERMARK_TEXT),
        '--watermark-tile-size': `${TILE_WIDTH}px ${TILE_HEIGHT}px`,
      }}
    />
  );
}

export { WATERMARK_TEXT };
