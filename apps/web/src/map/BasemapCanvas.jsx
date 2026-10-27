import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Icon } from '../shell/icons.jsx';
import { Watermark } from '../shell/Watermark.jsx';
import {
  DEFAULT_VIEW,
  INITIAL_BASEMAP_RUN,
  MAX_VISIBLE_TILES,
  attributionFor,
  basemapLost,
  basemapRun,
  clampZoom,
  isPlanOnly,
  panBy,
  planOnlyState,
  scaleBar,
  tileUrl,
  visibleTiles,
  wheelZoom,
  zoomAround,
} from './canvas-state.js';
import { CanvasSearch } from './CanvasSearch.jsx';
import { labelsFor, overlayFor } from './facility-overlay.js';

const FALLBACK_SIZE = { widthPx: 960, heightPx: 520 };
const KEY_PAN_PX = 80;
/** Below this zoom a facility label is bigger than the building it names. */
const LABEL_MIN_ZOOM = 14;

/**
 * The basemap canvas (implementation plan T7b).
 *
 * It draws two things: the project's basemap, proxied through the API so no
 * provider URL or credential reaches the browser, and the facility graph's
 * geometry on top of it. Everything the W5 service guarantees is honoured here —
 * attribution travels with the tiles, the zoom stays inside the provider's
 * declared range, and an unavailable, refused, or unpermitted basemap degrades to
 * the **plan-only grid** rather than a blank canvas or an error.
 *
 * The facility overlay is independent of the basemap on purpose: geometry is the
 * project's own data, so it stays visible on the plan-only grid, and a role
 * without `map.read` still sees the site it can read with `facility.read`. The
 * projection is in `facility-overlay.js`; this file only paints what it returns.
 */
export function BasemapCanvas({
  projectId,
  provider = null,
  providers = [],
  style = null,
  canRead = true,
  onSelectProvider = null,
  onViewChange = null,
  view = DEFAULT_VIEW,
  size = FALLBACK_SIZE,
  planOnlyReason = null,
  features = [],
  layers = [],
  onToggleLayer = null,
  selectedGeometryId = null,
  onSelectFeature = null,
  // An entity the workspace assistant asked to highlight. Entity ids outlive a
  // redraw, so this is a second key beside the search's geometry highlight rather
  // than a reuse of it.
  highlightedEntityId = null,
  onResize = null,
  onFit = null,
  // Drawing is a mode, not a gesture: while it is on, a pointer press places a vertex
  // instead of panning, so the map cannot move under a polygon being drawn.
  drawing = false,
  // What the active mode is called, so the chip names it rather than saying "Drawing"
  // while an interface is being placed.
  drawingLabel = 'Drawing',
  draftShape = null,
  onDraftPoint = null,
  // Moving a placed object. `movable` is the edit gate, `moving` is the shape being carried, and
  // the three callbacks are the move's whole conversation with the surface that owns the graph.
  // The geometry the change set intends, for objects that have been edited but not committed.
  edits = null,
  movable = false,
  moving = null,
  onMoveStart = null,
  onMoveEnd = null,
  onMoveCancel = null,
}) {
  const dragRef = useRef(null);
  // Whether the release of the current gesture has already been answered, so the click the
  // browser synthesises from the same press and release does not answer it a second time.
  const handledRef = useRef(false);
  const nodeRef = useRef(null);
  const wheelRef = useRef(0);
  const [measured, setMeasured] = useState(null);
  const [run, dispatchRun] = useReducer(basemapRun, INITIAL_BASEMAP_RUN);
  // The layer row folds away, so a canvas being read rather than edited is not carrying
  // four switches it is not using.
  const [layersOpen, setLayersOpen] = useState(true);
  // The shape the search panel is pointing at. A hover affordance rather than a selection:
  // it lasts as long as the pointer or the focus does, and it is this component's own
  // because it is a property of the drawing rather than of the shell's context.
  const [highlightedGeometryId, setHighlightedGeometryId] = useState(null);

  /**
   * A different provider is a different upstream, and a different viewport is a
   * different set of tiles, so the failure run starts again. This is not a nicety:
   * while the canvas is degraded it renders no tiles, so nothing can load to clear the
   * run, and a scope change is the only way back. See `basemapRun`.
   */
  const providerId = provider?.providerId ?? null;
  useEffect(() => {
    dispatchRun({ type: 'scope' });
  }, [providerId, view.zoom, view.lon, view.lat]);

  // The viewport's true size decides which tiles are needed; a measured size wins
  // over the caller's estimate once the element is on screen.
  const widthPx = measured?.widthPx ?? size.widthPx;
  const heightPx = measured?.heightPx ?? size.heightPx;

  // The parent needs the same size to fit facility bounds, so a measurement is
  // reported rather than kept private.
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;

  const measure = useCallback((node) => {
    nodeRef.current = node;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        const next = { widthPx: Math.round(rect.width), heightPx: Math.round(rect.height) };
        setMeasured(next);
        resizeRef.current?.(next);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const lost = basemapLost(run);
  const planOnly = isPlanOnly(provider) || !canRead || lost;
  const planOnlyReasonText = planOnlyState({ planOnlyReason, canRead, lost });
  const attribution = attributionFor(provider);
  const layer = planOnly ? { tiles: [], tileSize: 256 } : visibleTiles({ view, widthPx, heightPx, provider });
  const minZoom = provider?.minZoom ?? 0;
  const maxZoom = provider?.maxZoom ?? 22;

  const drawableLayers = layers.filter((item) => item.count > 0);
  // Counted from the layer records the shell already has, so a hidden layer is still not
  // projected: this is a number for the search panel to state, not a second overlay.
  const hiddenCount = layers.filter((item) => !item.visible).reduce((total, item) => total + item.count, 0);
  // Layer visibility is applied in the pure module, before anything is projected,
  // so a hidden layer costs no work and cannot leak into a hit test.
  const visibleLayerIds = layers.length > 0 ? layers.filter((item) => item.visible).map((item) => item.id) : null;
  const overlay = overlayFor(features, {
    view,
    widthPx,
    heightPx,
    selectedGeometryId,
    visibleLayers: visibleLayerIds,
    moving: moving ?? null,
    edits,
  });
  const labels = labelsFor(overlay, { zoom: view.zoom, minZoom: LABEL_MIN_ZOOM });
  // A stated fallback is for a canvas that would otherwise be empty. Once the facility graph
  // is drawn, the map explains itself — there is no readings strip left to say anything.
  const showPlanOnlyNotice = planOnly && overlay.length === 0;
  // Pan and zoom are the canvas's own affordances, so they work whenever there is
  // anything to navigate: a provider to draw, or facility geometry to inspect on
  // the plan-only grid. With neither, the page keeps the scroll and drag gestures.
  const canNavigate = Boolean(provider) || overlay.length > 0;
  // The scale is honest about one latitude, so it is computed for the view centre
  // — the same place the ruler would sit on a paper map.
  const scale = scaleBar({ lat: view.lat, zoom: view.zoom });

  const stopDrag = (event) => {
    // A click on a feature is a selection, not the start of a pan.
    event.stopPropagation();
  };

  // Leaving a move half-done — the object released outside the map, the mode cancelled by
  // Escape, the revision switched — leaves the surface holding a preview of an edit that is no
  // longer being made. The draft belongs to the gesture, so it dies with it.
  useEffect(() => {
    const drag = dragRef.current;
    if (drag?.kind === 'move' && moving === null) dragRef.current = null;
  }, [moving]);

  const selectFeature = (shape) => (event) => {
    stopDrag(event);
    // Set by a release this component already answered. Cleared here rather than on a timer:
    // the click is dispatched in the same task as the release, so the next one is the next
    // gesture and this flag is spent.
    if (handledRef.current) {
      handledRef.current = false;
      return;
    }
    onSelectFeature?.(shape);
  };

  const applyView = (next) => {
    onViewChange?.({ ...next, zoom: clampZoom(next.zoom, provider) });
  };
  const zoomBy = (delta) => applyView({ ...view, zoom: view.zoom + delta });
  const pan = (dxPx, dyPx) => applyView(panBy(view, { dxPx, dyPx }));

  // The wheel handler needs the current view and provider, but re-attaching a
  // listener on every view change would drop the gesture in flight. A ref carries
  // the latest values instead.
  const latest = useRef({ view, provider, canNavigate, widthPx, heightPx, applyView, moving });
  latest.current = { view, provider, canNavigate, widthPx, heightPx, applyView, moving };

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    // React's onWheel is passive at the root, so preventDefault there is ignored
    // and the page scrolls behind the map. A native listener can claim the gesture.
    const onWheel = (event) => {
      const current = latest.current;
      if (!current.canNavigate) return; // nothing to zoom; let the page scroll
      // A horizontal two-finger swipe is a page gesture, not a zoom.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();

      const { steps, accumulated } = wheelZoom({
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        accumulated: wheelRef.current,
      });
      wheelRef.current = accumulated;
      if (steps === 0) return;

      const next = clampZoom(current.view.zoom - steps, current.provider);
      if (next === current.view.zoom) return;
      const rect = node.getBoundingClientRect();
      current.applyView(
        zoomAround(current.view, {
          nextZoom: next,
          anchorPx: { x: event.clientX - rect.left, y: event.clientY - rect.top },
          widthPx: current.widthPx,
          heightPx: current.heightPx,
        }),
      );
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * A press on a placed object, while that object is selected and the revision is editable.
   *
   * This is a *drag* and not a click: the surface's first gesture is panning, and a map where
   * every shape moved under the pointer would be a map that could not be navigated by dragging
   * it. So a press only arms a move, the threshold below decides whether the gesture was a drag,
   * and a press that never passes it stays the selection click it has always been.
   */
  const MOVE_THRESHOLD_PX = 3;
  const onMovePointerDown = (event, shape) => {
    event.stopPropagation();
    stopDrag(event);
    dragRef.current = {
      kind: 'move',
      entityId: shape.entityId,
      originX: event.clientX,
      originY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      dxPx: 0,
      dyPx: 0,
      moving: false,
    };
  };

  const onPointerDown = (event) => {
    if (drawing) {
      if (!onDraftPoint) return;
      const rect = event.currentTarget.getBoundingClientRect();
      onDraftPoint({ xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
      return;
    }
    // A press on a control floating over the map is not the start of a pan.
    //
    // This is not tidiness. `setPointerCapture` below retargets the rest of the gesture to
    // this element, and a `click` is dispatched to the nearest common ancestor of the press
    // and the release — so capturing from a press that landed on an overlay moves the click
    // onto the surface and the control's own handler never runs. Every overlay control
    // silently stopped responding, while hit testing, the handlers, and `element.click()`
    // all reported success. The features in the SVG overlay already avoid this by stopping
    // propagation on `pointerdown`; the floating controls mark themselves instead, so a new
    // overlay cannot reintroduce it by being forgotten.
    if (event.target.closest?.('[data-map-overlay]')) return;
    if (!canNavigate) return;
    // Pointer capture keeps a fast drag from leaving the canvas mid-gesture.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'move') {
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.dxPx = event.clientX - drag.originX;
      drag.dyPx = event.clientY - drag.originY;
      // The threshold is where a move begins, so the map does not pan on the way to it: past
      // this point the gesture belongs to the object under the press and nothing else.
      if (!drag.moving && Math.abs(drag.dxPx) + Math.abs(drag.dyPx) >= MOVE_THRESHOLD_PX) {
        drag.moving = true;
        onMoveStart?.(drag.entityId);
      }
      if (drag.moving) onMoveEnd?.({ entityId: drag.entityId, dxPx: drag.dxPx, dyPx: drag.dyPx });
      return;
    }
    const dxPx = event.clientX - drag.x;
    const dyPx = event.clientY - drag.y;
    dragRef.current = { x: event.clientX, y: event.clientY };
    pan(dxPx, dyPx);
  };

  /**
   * What the release means.
   *
   * A press that never crossed the threshold is the selection click, and it is delivered here
   * rather than through `onClick` because pointer capture retargets the rest of the gesture and
   * suppresses the compatibility click. A press that did cross it ends a move, and the surface is
   * told the delta it stopped at.
   */
  const endDrag = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.kind !== 'move') return;
    // The release is the answer, so the compatibility click that follows it must not answer
    // again: it is dispatched to the nearest common ancestor of press and release, so pointer
    // capture lands it on the surface, where `onClick` would toggle the selection straight back.
    handledRef.current = true;
    if (!drag.moving) {
      const shape = overlay.find((item) => item.entityId === drag.entityId && item.selected);
      if (shape) onSelectFeature?.(shape);
      return;
    }
    onMoveEnd?.({ entityId: drag.entityId, dxPx: drag.lastX - drag.originX, dyPx: drag.lastY - drag.originY, committed: true });
  };

  /** Panning and zooming are reachable without a pointer. */
  const onKeyDown = (event) => {
    const moves = {
      ArrowLeft: [KEY_PAN_PX, 0],
      ArrowRight: [-KEY_PAN_PX, 0],
      ArrowUp: [0, KEY_PAN_PX],
      ArrowDown: [0, -KEY_PAN_PX],
    };
    if (moves[event.key] && canNavigate) {
      event.preventDefault();
      pan(...moves[event.key]);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(-1);
    }
  };

  return (
    <section
      className="canvas"
      aria-label="Basemap canvas"
      data-canvas-mode={planOnly ? 'PLAN_ONLY' : 'BASEMAP'}
      // The viewport as state a test can read. Zoom and pan are the map's whole job and
      // there is otherwise no way to observe them: the tiles are images and the geometry
      // is a projection of the same values, so a frozen map looks exactly like one that
      // is simply not being clicked.
      data-zoom={view.zoom}
      data-centre={`${view.lon.toFixed(4)},${view.lat.toFixed(4)}`}
    >
      <div
        className={`canvas__surface${planOnly ? ' canvas__surface--plan-only' : ''}${drawing ? ' canvas__surface--drawing' : ''}`}
        ref={measure}
        role="application"
        tabIndex={0}
        aria-label={
          drawing
            ? 'Drawing mode. Click to place a vertex. Panning and zooming are paused so the map cannot move under the polygon.'
            : !canNavigate
            ? 'Plan-only grid. Use the basemap control to choose a provider.'
            : planOnly
              ? 'Plan-only grid with facility geometry. Scroll or pinch to zoom, drag to pan, arrow keys pan, plus and minus zoom.'
              : `${provider.label} basemap. Scroll or pinch to zoom, drag to pan, arrow keys pan, plus and minus zoom.`
        }
        onKeyDown={drawing ? undefined : onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Inside the viewport, so the mark is clipped to the map and scrolls with it
            rather than spanning the whole tool. Its z-index puts it above the tiles and
            geometry but below the controls, which already sit at 2 — a watermark you
            cannot see over a basemap is not doing its job. */}
        <Watermark />
        {!planOnly
          ? layer.tiles.map((tile) => (
              <img
                key={tile.key}
                className="canvas__tile"
                src={tileUrl({ projectId, providerId: provider.providerId, z: tile.z, x: tile.x, y: tile.y, style })}
                style={{
                  left: `${tile.left}px`,
                  top: `${tile.top}px`,
                  width: `${layer.tileSize}px`,
                  height: `${layer.tileSize}px`,
                }}
                alt=""
                draggable="false"
                // A tile that arrives proves the provider is answering, so the run of
                // failures ends here rather than accumulating across the whole session.
                onLoad={() => dispatchRun({ type: 'loaded' })}
                onError={() => dispatchRun({ type: 'failed' })}
              />
            ))
          : null}

        {/* The facility graph draws over tiles and over the plan-only grid alike:
            it is the project's own geometry, not a basemap feature. */}
        <svg
          className="canvas__overlay"
          width={widthPx}
          height={heightPx}
          viewBox={`0 0 ${widthPx} ${heightPx}`}
          aria-hidden={overlay.length === 0 && !draftShape ? 'true' : undefined}
        >
          {/* The polygon being drawn. It is unfinished, so it is drawn as a draft rather
              than as a facility feature: dashed, unlabelled, and not selectable. */}
          {draftShape ? (
            <g className="canvas__draft" aria-hidden="true">
              {draftShape.path ? <path className="canvas__draft-path" d={draftShape.path} /> : null}
              {draftShape.points.map((point, index) => (
                <circle key={`${point.x}-${point.y}-${index}`} className="canvas__draft-vertex" cx={point.x} cy={point.y} r={4} />
              ))}
            </g>
          ) : null}
          {overlay.map((shape) => {
            // `--edited` comes before `--selected` so a pending object that is also selected still
            // reads as selected: the edit marker is a state of the data, the selection of the eye.
            const className = `canvas__feature canvas__feature--${shape.layer}${
              shape.edited ? ' canvas__feature--edited' : ''
            }${shape.selected ? ' canvas__feature--selected' : ''}${
              shape.geometryId === highlightedGeometryId || (highlightedEntityId !== null && shape.entityId === highlightedEntityId)
                ? ' canvas__feature--highlighted'
                : ''
            }`;
            const label = `${shape.displayName ?? shape.entityType} (${shape.role})`;
            // A selected object in an editable revision moves when it is dragged; the press is
            // armed here and the gesture's own threshold decides whether it became a drag.
            const canMove = movable && shape.selected && shape.entityId !== null;
            const common = {
              className,
              'aria-label': label,
              role: 'button',
              tabIndex: 0,
              onPointerDown: canMove ? (event) => onMovePointerDown(event, shape) : stopDrag,
              onClick: selectFeature(shape),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectFeature?.(shape);
                }
              },
            };
            // The move is a translation of the shape's own projection, so the object follows the
            // pointer without the world being reprojected on every move.
            const drawn =
              shape.geometry.kind === 'POINT' ? (
                <circle {...common} cx={shape.geometry.points[0].x} cy={shape.geometry.points[0].y} r={shape.selected ? 7 : 5} />
              ) : (
                <path {...common} d={shape.path} />
              );
            return shape.translate ? (
              <g key={shape.geometryId} className="canvas__feature-move" transform={shape.translate}>
                {drawn}
              </g>
            ) : (
              <g key={shape.geometryId}>{drawn}</g>
            );
          })}
          {labels.map((shape) => (
            <text
              key={`label-${shape.geometryId}`}
              className="canvas__feature-label"
              x={shape.anchor.x}
              y={shape.anchor.y}
              textAnchor="middle"
              transform={shape.translate ?? undefined}
            >
              {shape.displayName ?? shape.entityType}
            </text>
          ))}
        </svg>

        {/* Left: what is drawn. The basemap choice and the layer switches are both
            properties of the content, and the layer row folds away so it costs nothing
            until it is wanted. */}
        <div className="canvas__tools canvas__tools--left" data-map-overlay>
          <div className="canvas__pill">
            <label className="canvas__provider">
              <Icon name="map" size={13} />
              <span className="visually-hidden">Basemap</span>
              <select
                value={provider?.providerId ?? ''}
                onChange={(event) => onSelectProvider?.(event.target.value)}
                disabled={!onSelectProvider || providers.length === 0}
                aria-label="Basemap"
                title={providers.find((item) => item.providerId === provider?.providerId)?.label ?? 'Plan only'}
              >
                {/* Turning the basemap off is a valid choice, not a failure state. */}
                <option value="">Plan only</option>
                {providers.map((item) => (
                  <option key={item.providerId} value={item.providerId} disabled={!item.available}>
                    {item.label}
                    {item.available ? '' : ` — ${item.unavailableReason ?? 'unavailable'}`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {drawableLayers.length > 0 ? (
            <div className="canvas__layerbar" data-open={layersOpen ? 'true' : 'false'}>
              <button
                type="button"
                className="canvas__layertoggle"
                aria-expanded={layersOpen}
                aria-controls="canvas-layers"
                onClick={() => setLayersOpen((open) => !open)}
                title={layersOpen ? 'Hide layer switches' : 'Show layer switches'}
              >
                <Icon name="layers" size={14} />
                Layers
                <span className="canvas__layercount">
                  {drawableLayers.filter((item) => item.visible).length}/{drawableLayers.length}
                </span>
                <Icon name={layersOpen ? 'chevronUp' : 'chevronDown'} size={13} />
              </button>

              {layersOpen ? (
                <div className="canvas__layers" id="canvas-layers" role="group" aria-label="Facility layers">
                  {drawableLayers.map((item) => (
                    <label key={item.id} className="canvas__layer">
                      <input
                        type="checkbox"
                        checked={item.visible}
                        disabled={!onToggleLayer}
                        onChange={() => onToggleLayer?.(item.id)}
                      />
                      <span className="canvas__layer-name">{item.label}</span>
                      <span className="canvas__layer-count">{item.count}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Centre: a stated mode or a degraded state, kept out of both corners so that
            entering a mode cannot shift the controls the user is reaching for. */}
        {moving ? (
          <span className="canvas__mode canvas__mode--centre" data-map-overlay>
          Moving {moving.name ?? 'object'} — release to stage it
        </span>
        ) : drawing ? (
          <span className="canvas__mode canvas__mode--centre" data-map-overlay>
          {drawingLabel}
        </span>
        ) : planOnly && planOnlyReasonText.retry ? (
          // The state is recoverable, so it is stated as a control rather than as a label:
          // panning already retries, and a user who does not know that should not have to
          // discover it.
          <button
            type="button"
            className="canvas__mode canvas__mode--retry canvas__mode--centre"
          data-map-overlay
            title={`${planOnlyReasonText.text} Try again.`}
            onClick={() => dispatchRun({ type: 'scope' })}
          >
            Basemap unavailable — retry
          </button>
        ) : planOnly ? (
          <span className="canvas__mode canvas__mode--centre" title={planOnlyReasonText.text} data-map-overlay>
            Plan only
          </span>
        ) : null}

        {/* Right: how it is viewed. A vertical stack on the edge, which is where every map
            puts it, and it leaves the left corner to the content controls. */}
        <div className="canvas__zoom" role="group" aria-label="Map view" data-map-overlay>
          {onFit ? (
            <button
              type="button"
              className="canvas__control"
              aria-label="Fit facility"
              title="Fit facility"
              onClick={() => onFit()}
              disabled={!canNavigate}
            >
              <Icon name="grid" size={15} />
            </button>
          ) : null}
          <button
            type="button"
            className="canvas__control"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => zoomBy(1)}
            disabled={!canNavigate || view.zoom >= maxZoom}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            type="button"
            className="canvas__control"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => zoomBy(-1)}
            disabled={!canNavigate || view.zoom <= minZoom}
          >
            <Icon name="minus" size={15} />
          </button>
          <button
            type="button"
            className="canvas__control"
            aria-label="Reset view"
            title="Reset view"
            onClick={() => applyView(DEFAULT_VIEW)}
            disabled={!canNavigate}
          >
            <Icon name="dot" size={15} />
          </button>
        </div>

        {showPlanOnlyNotice ? (
          <p className="canvas__notice" role="status">
            {planOnlyReasonText.text} Showing the plan-only grid.
          </p>
        ) : null}

        {/* A distance scale, not a zoom number: it states how much ground a pixel
            covers, which is what a facility drawing is read against (D10: SI). */}
        {scale ? (
          <div className="canvas__scale" role="img" aria-label={`Map scale: ${scale.label}`}>
            <span className="canvas__scale-label">{scale.label}</span>
            <span className="canvas__scale-bar" style={{ width: `${scale.widthPx}px` }} />
          </div>
        ) : null}
      </div>

      {/*
        Top right of the map: finding something in the graph. It sits above the view
        controls because it is used first — a name is how a plan is navigated when you do
        not yet know where a thing is — and it is offered only when there is a drawing to
        search.

        It is a **sibling** of the surface rather than a child of it, and that is the whole
        reason it is out here. The surface disables the browser's own touch gestures
        (`touch-action: none`, or a finger drag scrolls the page instead of panning) and
        claims the wheel to zoom — and both of those apply to every descendant. Inside it,
        a wheel over the results zoomed the map instead of scrolling them, and a touch drag
        over them could not scroll them at all. Floating over the surface from beside it
        keeps the map's gesture handling out of the panel's ancestry, so the panel scrolls
        the way any other scrollable box does.
      */}
      {overlay.length > 0 ? (
        <CanvasSearch
          shapes={overlay}
          hiddenCount={hiddenCount}
          onHighlight={setHighlightedGeometryId}
          onSelect={(shape) => onSelectFeature?.(shape)}
        />
      ) : null}

      {/*
        Attribution is a licence condition: it renders whenever tiles do, floating in the
        map's bottom-right corner. It used to share a strip below the map with the tool's
        readings, which cost the drawing area a row and read as a second toolbar under the
        canvas. A corner overlay is where every map puts it, and what the obligation is
        actually about: it must be *on* the map, beside the tiles it credits.
      */}
      <p className={`canvas__attribution${!planOnly && attribution?.text ? '' : ' canvas__attribution--none'}`}>
        {!planOnly && attribution?.text ? (
          attribution.url ? (
            <a href={attribution.url} target="_blank" rel="noopener noreferrer">
              {attribution.text}
            </a>
          ) : (
            attribution.text
          )
        ) : (
          'Plan-only grid'
        )}
      </p>
    </section>
  );
}

export { MAX_VISIBLE_TILES };
