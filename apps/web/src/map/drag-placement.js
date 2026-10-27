/**
 * Whether a drag from the bucket may be released where the pointer is.
 *
 * This lives outside the canvas so that one browser rule can be stated once and asserted: **a
 * drag carries nothing readable while it is in flight.** `dataTransfer.getData` returns an empty
 * string until the drop is dispatched, and Chrome goes further — measured over a real
 * mouse-driven drag, every `dragover` over the map exposed `types: ['chromium/x-drag-id']` and
 * `getData('text/plain') === ''`. Neither the payload nor the type the row declared is visible
 * during the drag.
 *
 * So a `dragover` handler that decides by reading the drag refuses the gesture before the
 * browser can dispatch a drop: the row drags, the cursor shows nothing, and the object cannot
 * be placed. The only thing that can gate the drop is what this surface already knows — that its
 * own row started the gesture, and that the pointer is over the drawing surface.
 */

/** The payload kind the row writes. Read back at the drop, where the store is finally readable. */
export const DRAG_MIME = 'text/plain';

/**
 * Whether a drag from the bucket may be released where the pointer is.
 *
 * `carrying` is deliberately not a payload: it is the item the palette handed over at
 * `dragstart`, because nothing about the gesture is readable before the drop. The surface is
 * still the gate — the listener is on the frame, which also holds the side column and the
 * toolbar around it, and a release on either is not a placement.
 */
export function canDropOn({ carrying = null, target = null, surface = null } = {}) {
  if (!carrying) return false;
  return Boolean(surface && target && surface.contains(target));
}

/**
 * Which object a drop is carrying, from the two answers available.
 *
 * The payload first: it is the browser's own record of what was dragged, and it is readable by
 * the time the drop arrives. The pointer's memory second, because a drop can be delivered with
 * an empty `dataTransfer` and a release that landed on the map is a placement whether or not the
 * browser repeats itself. The id is looked up in the bucket as it stands, so an object that was
 * placed or removed mid-gesture is simply not found.
 */
export function draggedEntityId({ carried = '', dragged = null } = {}) {
  if (carried) return carried;
  return dragged?.entityId ?? null;
}
