/**
 * Where the collapsed assistant launcher sits on the canvas.
 *
 * The composer is an overlay, so its position is a viewport offset rather than a layout
 * fact: the launcher starts centred at the bottom of the surface, and dragging it moves
 * it from there. Keeping the arithmetic here — pure, DOM-free — is what makes "it stays
 * on screen" and "a drag is not a click" assertable without a browser.
 */

/** A move shorter than this is a click on the launcher, not a drag of it. */
export const LAUNCHER_DRAG_SLOP_PX = 4;

/** How far one arrow key moves the launcher. */
export const LAUNCHER_KEY_STEP_PX = 16;

export const LAUNCHER_POSITION_KEY = 'ai-infra.assistant-launcher';

/**
 * The pointer movement between two points. `null` when either point is unknown, so a
 * caller can distinguish "not dragging" from "dragged by zero".
 */
export function dragDelta(from, to) {
  if (!from || !to) return null;
  if (![from.x, from.y, to.x, to.y].every((value) => Number.isFinite(value))) return null;
  return { x: to.x - from.x, y: to.y - from.y };
}

/** Whether a gesture moved far enough to count as a drag rather than a click. */
export function isDrag(delta, slop = LAUNCHER_DRAG_SLOP_PX) {
  if (!delta) return false;
  return Math.abs(delta.x) > slop || Math.abs(delta.y) > slop;
}

/**
 * The offset to apply to the launcher.
 *
 * `origin` is where the gesture started (null for a key press, which moves from wherever
 * the launcher already is), and `base` is the offset held when the gesture began. The
 * result is clamped to the room actually available: `bounds` describes the box the
 * launcher may move in, already expressed as an offset from its resting place, so a
 * caller that measures once does not have to measure again per pointer move.
 */
export function clampOffset({ x = 0, y = 0 } = {}, bounds = null) {
  if (!bounds) return { x, y };
  const { minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity } = bounds;
  return {
    // A floor above the ceiling cannot be satisfied; the ceiling wins so the launcher is
    // never pushed off the far edge, which is the worse failure of the two.
    x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
  };
}

/**
 * Moves the launcher by one key press.
 *
 * Arrow keys move it, and the result is clamped like a drag: a keyboard user gets the
 * same reach as a pointer user, which is the whole reason this is not pointer-only.
 */
export function nudgeOffset(current, key, { step = LAUNCHER_KEY_STEP_PX, bounds = null } = {}) {
  const start = { x: current?.x ?? 0, y: current?.y ?? 0 };
  const moves = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  }[key];
  if (!moves) return null;
  return clampOffset({ x: start.x + moves.x, y: start.y + moves.y }, bounds);
}

/** Reads a stored offset, falling back to the resting place for anything malformed. */
export function readStoredOffset(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LAUNCHER_POSITION_KEY);
    if (!raw) return { x: 0, y: 0 };
    const parsed = JSON.parse(raw);
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: parsed.x, y: parsed.y };
  } catch {
    // Unreadable storage is not a reason to fail to draw the composer.
  }
  return { x: 0, y: 0 };
}

export function storeOffset(offset, storage = globalThis.localStorage) {
  try {
    storage?.setItem(LAUNCHER_POSITION_KEY, JSON.stringify({ x: Math.round(offset.x), y: Math.round(offset.y) }));
  } catch {
    // A private-mode quota error must not take the composer down with it.
  }
}
