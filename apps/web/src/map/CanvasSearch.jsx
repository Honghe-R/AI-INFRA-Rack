import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../shell/icons.jsx';
import { OVERLAY_LAYERS } from './facility-overlay.js';
import { SEARCH_RESULT_LIMIT, searchShapes } from './facility-search.js';

const LAYER_LABEL = Object.fromEntries(OVERLAY_LAYERS.map((layer) => [layer.id, layer.label]));

/**
 * Finding a drawn feature by name.
 *
 * It sits where a map puts it — the top-right corner — and is a control until it is wanted:
 * one icon button, and the field appears beside it only once it is. The field is to the left
 * of the button rather than the button to the left of the field, because the button is the
 * anchor the eye already has and the panel opens under both.
 *
 * The results are the **drawn** shapes (see `facility-search.js`), and hovering or focusing
 * one highlights it on the canvas. Focus does what hover does, so the affordance is not
 * pointer-only; clicking one selects it, which is the same thing clicking it on the canvas
 * does.
 *
 * The results are not a `listbox`: there is no active descendant to manage and no value to
 * commit — each result is a button, reachable by Tab and activated by Enter, which is what
 * the transcript's copy control and the layer switches already are.
 */
export function CanvasSearch({
  shapes = [],
  hiddenCount = 0,
  onHighlight = null,
  onSelect = null,
  // Both of these exist so the open state and a query can be rendered and asserted without
  // a DOM — the component is otherwise uncontrolled, and a static render would only ever
  // show the icon.
  defaultOpen = false,
  defaultQuery = '',
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState(defaultQuery);
  const inputRef = useRef(null);
  const toggleRef = useRef(null);
  const containerRef = useRef(null);

  const matches = useMemo(() => searchShapes(shapes, query), [shapes, query]);
  const shown = matches.slice(0, SEARCH_RESULT_LIMIT);
  const searching = query.trim().length > 0;

  // Opening is what moves focus into the field, so the click that opened it is not left as
  // the focus owner and the user can type immediately.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /**
   * Closes the panel.
   *
   * `restoreFocus` is for the two ways of leaving that happen *at* the control — Escape and
   * the button itself. The field is about to be unmounted, and focus in a removed element
   * falls to the document body, which loses a keyboard user's place; the button is where
   * they were. A press somewhere else on the map is the user choosing a new place, so that
   * one leaves the focus alone.
   */
  const close = ({ restoreFocus = false } = {}) => {
    setOpen(false);
    setQuery('');
    onHighlight?.(null);
    if (restoreFocus) toggleRef.current?.focus();
  };

  // A click anywhere else puts the map back in charge, and so does Escape. Escape clears a
  // query first: it is the smaller of the two things the key could mean, and the panel is
  // still there to be dismissed with a second press.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="canvas__search" ref={containerRef} data-map-overlay>
      {open ? (
        <input
          ref={inputRef}
          type="text"
          className="canvas__search-input"
          value={query}
          placeholder="Find a feature…"
          // The button says what the control is; the field says what it searches.
          aria-label="Search the facility graph"
          onChange={(event) => {
            setQuery(event.target.value);
            onHighlight?.(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // The canvas listens for keys too, and Escape here is not meant for it.
            event.stopPropagation();
            if (query.length > 0) setQuery('');
            else close({ restoreFocus: true });
          }}
        />
      ) : null}

      <button
        type="button"
        ref={toggleRef}
        className="canvas__control canvas__search-toggle"
        aria-expanded={open}
        // Only while the panel exists: the attribute points at an element, and an element
        // that is not there is not a disclosure.
        aria-controls={open ? 'canvas-search-results' : undefined}
        aria-label={open ? 'Close search' : 'Search the facility graph'}
        title={open ? 'Close search' : 'Search the facility graph'}
        onClick={() => (open ? close({ restoreFocus: true }) : setOpen(true))}
      >
        <Icon name={open ? 'close' : 'search'} size={15} />
      </button>

      {open ? (
        <div className="canvas__search-panel" id="canvas-search-results">
          {searching && shown.length > 0 ? (
            <ul className="canvas__results" aria-label="Search results">
              {shown.map((shape) => (
                <li key={shape.geometryId}>
                  <button
                    type="button"
                    className="canvas__result"
                    // Focus highlights for the same reason hover does: the map should answer
                    // "this one" however the result was reached.
                    onPointerEnter={() => onHighlight?.(shape.geometryId)}
                    onPointerLeave={() => onHighlight?.(null)}
                    onFocus={() => onHighlight?.(shape.geometryId)}
                    onBlur={() => onHighlight?.(null)}
                    onClick={() => onSelect?.(shape)}
                  >
                    <span className="canvas__result-name">{shape.displayName ?? shape.entityType}</span>
                    <span className="canvas__result-meta">
                      {LAYER_LABEL[shape.layer] ?? shape.layer} · {shape.role}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {searching && shown.length === 0 ? (
            <p className="canvas__search-note" role="status">
              No drawn feature matches “{query.trim()}”.
              {/* A search that finds nothing while the switch that would show the feature is
                  off should say so rather than let the reader conclude it does not exist. */}
              {hiddenCount > 0 ? ` ${hiddenCount} feature${hiddenCount === 1 ? ' is' : 's are'} behind a hidden layer.` : null}
            </p>
          ) : null}

          {searching && matches.length > shown.length ? (
            <p className="canvas__search-note">
              Showing {shown.length} of {matches.length} matches.
            </p>
          ) : null}

          {!searching ? (
            <p className="canvas__search-note">
              {shapes.length === 0
                ? 'The facility graph has no geometry to search.'
                : `Type to search ${shapes.length} drawn feature${shapes.length === 1 ? '' : 's'} by name, type, or role.`}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
