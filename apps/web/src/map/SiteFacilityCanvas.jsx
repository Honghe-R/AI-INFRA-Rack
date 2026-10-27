import { useEffect, useMemo, useRef, useState } from 'react';
import { useMapProviders } from '../api/useMapProviders.js';
import { useFacilityEnvelope } from '../facility/useFacilityEnvelope.js';
import { useFacilityAuthoring } from '../facility/useFacilityAuthoring.js';
import { FacilityAuthoringPanel } from '../facility/FacilityAuthoringPanel.jsx';
import { FacilityInspector } from '../facility/FacilityInspector.jsx';
import {
  authoringBlockers,
  draftAreaHint,
  newEntityId,
  pointFromCoordinates,
  polygonFromPoints,
  stageUtilityInterface,
} from '../facility/authoring-state.js';
import { usePermission } from '../permissions/usePermission.jsx';
import { useWorkspaceEffects } from '../facility/workspace-effects.js';
import { DEFAULT_VIEW, activeToolCommand, clampView, clampZoom, endsActiveTool, fitBounds } from './canvas-state.js';
import { OVERLAY_LAYERS, boundsOf, layerCounts, screenGeometry, unprojectScreen } from './facility-overlay.js';
import { CanvasPalette } from './CanvasPalette.jsx';
import { canDropOn, draggedEntityId } from './drag-placement.js';
import { movePlan, placementChanges } from './move-geometry.js';
import { stagedGeometry } from './staged-geometry.js';
import { unplacedObjects } from '../facility/geometry-placement.js';
import { BasemapCanvas } from './BasemapCanvas.jsx';
import { Watermark } from '../shell/Watermark.jsx';
import { Icon } from '../shell/icons.jsx';
import { shortId } from '../shell/format.js';
import { LIFECYCLE_STATES } from '../state/workspace-context.js';

/**
 * The Site & Facility work surface (implementation plan T7b, pulled forward, now
 * with the facility overlay).
 *
 * It owns the viewport, the basemap provider choice, the layer switches, and the
 * selection; the canvas paints tiles and geometry. The two reads are independent
 * and gated separately: `map.read` for the basemap and `facility.read` for the
 * graph, so a role with only one of them still gets a useful surface rather than
 * a denial screen.
 *
 * The graph is read for the active revision the shell resolved when the project
 * was opened, never for "the project": a facility graph belongs to a revision, and
 * a surface that guessed one would show data the user did not open.
 */
export function SiteFacilityCanvas({
  client,
  projectId,
  revisionId = null,
  onDirtyChange = null,
  toolRequest = null,
  onToolRequestConsumed = null,
  // The frame's identity strip. Supplied by the shell rather than read here: the
  // project name, the lifecycle state, and the revision are the shell's context, and a
  // second read would be a second answer to "which revision am I looking at".
  projectName = null,
  lifecycleState = null,
  validationSummary = null,
  authorName = null,
  // The rest of the context the frame still carries now that the shell has no bar: the
  // revision's name, whether the work is saved, and whether it is approved.
  revisions = [],
  unsaved = false,
  approvalAttestationId = null,
  // Which map tool is active, reported upward so the shell can mark the command that
  // started it. The mode itself is owned here — it needs the projection, the viewport, and
  // the pending change set — so this is a report, not a controlled value.
  onActiveToolChange = null,
  // A nonce the shell bumps to cancel the active tool. A request rather than a prop,
  // because the mode is this component's to end: cancelling also discards the draft.
  cancelToolRequest = null,
}) {
  const mapPermission = usePermission('map.read', { projectId });
  const canReadMap = mapPermission.allowed === true;
  const facilityPermission = usePermission('facility.read', { projectId });
  const canReadFacility = facilityPermission.allowed === true;
  // Authoring is a separate gate from reading: a viewer may inspect the graph and may not
  // change it, and the surface says which of the two they are looking at.
  const writePermission = usePermission('facility.entity.write', { projectId });
  const canWrite = writePermission.allowed === true;

  // The project's provider choice is persisted server-side, so opening the project
  // again — or another browser — finds the same basemap. The read is gated on
  // `map.read` before it is attempted, so a role without it never issues a tile
  // request.
  const {
    providers,
    settings,
    provider,
    pending: providersPending,
    error: providersError,
    choose,
  } = useMapProviders({ client, projectId, enabled: canReadMap });

  const facility = useFacilityEnvelope({ client, projectId, revisionId, enabled: canReadFacility });
  const authoring = useFacilityAuthoring({ client, projectId, revisionId, enabled: canWrite });

  const [view, setView] = useState(DEFAULT_VIEW);
  /*
   * The canvas opens on the plan-only grid, and a basemap is something the user asks for.
   *
   * The grid is not the degraded state here, it is the honest one: it is drawn from the project's
   * own geometry, it involves no third party, and it costs no tile quota. A provider is context
   * over a plan the user came to read — the overlay is painted over tiles and over the grid alike
   * — so the map does not spend a licence and a metered request before anyone has asked for
   * imagery.
   *
   * A view default, not a project setting: choosing a provider still persists through `choose`
   * and the choice is remembered, it is simply not applied until the basemap is switched on.
   * Persisting "no basemap" belongs with the rest of the basemap settings in T7.
   */
  const [basemapOff, setBasemapOff] = useState(true);
  const [hiddenLayers, setHiddenLayers] = useState(() => new Set());
  const [selectedGeometryId, setSelectedGeometryId] = useState(null);
  // Selection is an entity first and a geometry second: an entity with no geometry
  // (a utility source, a phase) is still selectable and inspectable, which the
  // assistant's `open_inspector` and `highlight_entity` actions require.
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [selectedEntityType, setSelectedEntityType] = useState(null);
  const [highlightedEntityId, setHighlightedEntityId] = useState(null);
  const [inspectorTab, setInspectorTab] = useState('OVERVIEW');
  const [inspectorFieldPath, setInspectorFieldPath] = useState(null);
  // The layer kind the assistant last switched. The canvas has no notion of a
  // single "active" layer — layers are independent switches — so this records the
  // one the workspace assistant addressed, and nothing when it has addressed none.
  const [activeLayerKind, setActiveLayerKind] = useState(null);
  const [size, setSize] = useState(null);
  const [fittedRevision, setFittedRevision] = useState(null);
  // The active map tool. Both tools place points on the map, so they share `draftPoints`
  // and differ in what they do with it: a footprint accumulates a ring, an interface
  // takes exactly one connection point. `null` means the map pans normally.
  const [mode, setMode] = useState(null);
  const [draftPoints, setDraftPoints] = useState([]);
  const [drawKind, setDrawKind] = useState('BUILDING');
  // A polygon drop arms a draw for the object it carried, which the vertex handler completes.
  // Set from the palette's own item, so the role and the kind of shape come from the one table
  // that decides them (`geometry-placement.js`) rather than from the drag payload.
  const [armedPlacement, setArmedPlacement] = useState(null);
  // The object being dragged, and the screen shift it is being dragged by. The shift lives here
  // rather than in the overlay because it is the same number the release is turned into a world
  // delta from, and one number cannot disagree with itself.
  const [moveDraft, setMoveDraft] = useState(null);
  const [phases, setPhases] = useState([]);
  // The interface being placed: its point is in `draftPoints`, these are the choices the
  // user makes about it.
  const [interfaceSourceId, setInterfaceSourceId] = useState(null);
  const [interfaceServiceState, setInterfaceServiceState] = useState('AVAILABLE');
  const [interfaceName, setInterfaceName] = useState('');

  const clearMode = () => {
    setDraftPoints([]);
    setArmedPlacement(null);
    setMode(null);
    setMoveDraft(null);
  };

  const drawing = mode === 'DRAW_FOOTPRINT';
  const placingInterface = mode === 'PLACE_INTERFACE';
  const mappingTool = drawing || placingInterface;

  // A tool asked for from the shell. The shell cannot own this: the mode needs the
  // projection, the viewport, and the pending change set, all of which live here.
  useEffect(() => {
    if (!toolRequest) return;
    if (toolRequest.intent === 'draw_footprint') {
      setDraftPoints([]);
      setMode((current) => (current === 'DRAW_FOOTPRINT' ? null : 'DRAW_FOOTPRINT'));
    }
    if (toolRequest.intent === 'add_interface') {
      setDraftPoints([]);
      setInterfaceName('');
      // One source is the common case and the only one that needs no decision, so the
      // first is offered rather than making the user open a select to proceed.
      setInterfaceSourceId((current) => current ?? facility.utilitySources[0]?.utilitySourceId ?? null);
      setMode((current) => (current === 'PLACE_INTERFACE' ? null : 'PLACE_INTERFACE'));
    }
    onToolRequestConsumed?.();
  }, [toolRequest, onToolRequestConsumed, facility.utilitySources]);

  // The command that started the active mode, or null. Reported rather than derived by the
  // shell, which cannot see the mode and would have to guess from what it last sent.
  const activeCommandId = activeToolCommand(mode);

  useEffect(() => {
    onActiveToolChange?.(activeCommandId);
  }, [activeCommandId, onActiveToolChange]);

  /**
   * Clears the reported tool on the way out.
   *
   * This is what fixes the stale highlight. Switching to a route that is not the map —
   * Import & Map, Validate — unmounts this component, and without this the shell kept the
   * last answer it was given: the toolbar went on marking "Draw footprint" as active on a
   * surface with nowhere to draw, and returning to the map brought the mode back with it,
   * because that state had outlived the surface that owned it. A tool cannot stay active
   * somewhere it does not exist.
   */
  useEffect(() => () => onActiveToolChange?.(null), [onActiveToolChange]);

  /**
   * Escape deactivates the active tool.
   *
   * Bound to the shell's main column rather than to the document: Escape already closes the
   * composer and dismisses menus elsewhere, and a document-wide listener here would cancel
   * a drawing as a side effect of closing something else.
   *
   * That column is the narrowest ancestor holding both places the reader's focus can be —
   * the toolbar that starts these tools and the map they are used on — and it holds nothing
   * else. The frame looked like the right region and is not: the toolbar is its *sibling*,
   * not its ancestor, so binding there left the command button unable to stop its own tool.
   */
  useEffect(() => {
    if (!mappingTool && !moveDraft) return undefined;
    const region = document.querySelector('.shell__main');
    if (!region) return undefined;
    const endTool = (event) => {
      if (!endsActiveTool(event, { active: true })) return;
      clearMode();
    };
    region.addEventListener('keydown', endTool);
    return () => region.removeEventListener('keydown', endTool);
  }, [mappingTool, moveDraft]);

  /**
   * A cancel asked for from the shell, which is how the toolbar's own active command ends
   * the mode. Same work as Escape: leaving the draft points behind would show a half-drawn
   * ring with no tool to finish it.
   */
  const cancelNonce = cancelToolRequest?.nonce ?? null;
  useEffect(() => {
    if (cancelNonce === null) return;
    clearMode();
  }, [cancelNonce]);

  const blockedReason = authoringBlockers({ envelope: facility.envelope, canWrite, pending: facility.pending });

  const active = basemapOff ? null : provider;
  const features = facility.features;
  // What the change set intends, drawn in place of the revision's own geometry. A move is
  // released long before it is committed, and an edit that vanishes until commit is one the
  // author cannot check; this is also what makes "revert by unstaging" visible, since removing
  // the change removes the edit from the map with it.
  const stagedEdits = useMemo(() => stagedGeometry(authoring.changes), [authoring.changes]);

  const canPlace = canWrite && provider !== null;
  const unplaced = useMemo(
    () =>
      canPlace
        ? unplacedObjects({
            containers: facility.containers,
            utilitySources: facility.utilitySources,
            utilityInterfaces: facility.utilityInterfaces,
            geometryRecords: features,
          })
        : [],
    [canPlace, facility.containers, facility.utilitySources, facility.utilityInterfaces, features],
  );
  // What a drop is carrying, resolved when the gesture ends. The drag carries only the id,
  // and the item is looked up in the bucket as it stands at that moment.
  const paletteRef = useRef(new Map());
  paletteRef.current = new Map(unplaced.map((item) => [item.entityId, item]));
  // What the pointer actually picked up. The payload is the first answer and this is the
  // second: a drop can be delivered with an empty `dataTransfer` (the drag data is the
  // browser's to withhold, and some builds withhold more of it than the spec requires), and a
  // release that landed on the map is a placement whether or not the browser repeats itself.
  const draggingItemRef = useRef(null);
  const counts = useMemo(() => layerCounts(features), [features]);
  const layers = useMemo(
    () => OVERLAY_LAYERS.map((layer) => ({ ...layer, count: counts[layer.id] ?? 0, visible: !hiddenLayers.has(layer.id) })),
    [counts, hiddenLayers],
  );
  const bounds = useMemo(() => boundsOf(features), [features]);

  const fitToFacility = () => {
    if (!size || bounds.length === 0) return;
    setView(fitBounds(bounds, { widthPx: size.widthPx, heightPx: size.heightPx, provider: active }));
  };

  // Fit once per revision, the first moment both the graph and the viewport size
  // are known, so a reload opens on the campus instead of on the whole world. It
  // deliberately does not re-fit on every view change: the user's pan is theirs.
  useEffect(() => {
    if (!revisionId || !size || bounds.length === 0 || fittedRevision === revisionId) return;
    setView(fitBounds(bounds, { widthPx: size.widthPx, heightPx: size.heightPx, provider: active }));
    setFittedRevision(revisionId);
  }, [revisionId, size, bounds, fittedRevision, active]);

  /**
   * Switching the basemap on brings the view into the range the provider can draw.
   *
   * The plan-only default is what makes this reachable: the canvas opens with no provider, so the
   * fit above clamps against nothing and a small site can fit above a provider's ceiling — and the
   * fit deliberately never runs twice for one revision, so turning a basemap on changes the range
   * without moving the view. `clampView` says what a view outside that range costs; the zoom
   * controls would correct it only once the user happened to zoom out.
   */
  useEffect(() => {
    if (!active) return;
    setView((current) => clampView(current, active));
  }, [active]);

  // A move is a gesture on one revision's graph. Switching revision leaves the draft addressing
  // geometry that is no longer on screen, so it goes with the graph it was made against.
  useEffect(() => {
    setMoveDraft(null);
  }, [revisionId]);

  // The pending set is bound to the revision and token the surface is showing, so a
  // conflict can only be raised against a token the user actually held.
  const bindAuthoring = authoring.bind;
  useEffect(() => {
    if (!canWrite) return;
    bindAuthoring({ envelope: facility.envelope });
  }, [bindAuthoring, canWrite, facility.envelope]);

  // The shell owns the unsaved-changes question; this surface owns the answer to "is
  // there anything unsaved", and reporting it is what makes closing the tab safe.
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  useEffect(() => {
    // Depend on the value, never on the callback: the shell passes an inline arrow, so
    // depending on its identity would re-run this on every render and, because the
    // callback dispatches, re-render forever.
    dirtyCallbackRef.current?.(authoring.dirty);
  }, [authoring.dirty]);

  // Phases are read only when an inspector could offer them, so a read-only viewer never
  // issues the request.
  useEffect(() => {
    if (!canWrite || !client || !projectId || !revisionId) return undefined;
    let active = true;
    client
      .listFacilityPhases(projectId, revisionId)
      .then(({ data }) => {
        if (active) setPhases(data?.phases ?? []);
      })
      .catch(() => {
        if (active) setPhases([]);
      });
    return () => {
      active = false;
    };
  }, [client, projectId, revisionId, canWrite]);

  // The draft polygon is projected with the same maths as the committed geometry, so it
  // lands where the finished footprint will.
  const draftShape = useMemo(() => {
    if (draftPoints.length === 0) return null;
    if (!size) return null;
    // An interface is one connection point, so it previews as a vertex rather than as a
    // ring: the same screen maths, without pretending a polygon is being drawn.
    if (placingInterface) {
      const screen = screenGeometry(pointFromCoordinates(draftPoints[0]) ?? { type: 'Point', coordinates: [0, 0] }, {
        view,
        widthPx: size.widthPx,
        heightPx: size.heightPx,
      });
      const point = screen?.points?.[0];
      return point ? { path: null, points: [point] } : null;
    }
    // A ring once there are three vertices, an open line until then, and a single point
    // for the first click — so the shape grows with the drawing rather than appearing
    // only when it is finished.
    const geometry = polygonFromPoints(draftPoints) ?? { type: 'LineString', coordinates: draftPoints };
    const screen = screenGeometry(geometry, { view, widthPx: size.widthPx, heightPx: size.heightPx });
    const points =
      screen?.kind === 'POLYGON'
        ? (screen.polygons[0]?.[0] ?? [])
        : screen?.kind === 'LINESTRING'
          ? (screen.lines[0] ?? [])
          : (screen?.points ?? []);
    const path = points.length > 1 ? `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')}` : null;
    return { path, points };
  }, [draftPoints, size, view, placingInterface]);

  /**
   * The imperative handle the workspace-effects facade drives (assistant-integration.md,
   * "UI-Action Type Registry"). It is rebuilt into a stable ref on every render, so the
   * registered object always closes over the current selection, viewport, and change set
   * — a handle snapshotted at mount would act on a selection the user has since moved.
   */
  const effects = useWorkspaceEffects();
  const handleRef = useRef(null);
  if (!handleRef.current) handleRef.current = {};

  const featureFor = (entityId) => features.find((feature) => feature.entityId === entityId) ?? null;
  const displayNameFor = (entityId) => {
    const container = facility.containers.find((item) => item.containerId === entityId);
    const source = facility.utilitySources.find((item) => item.utilitySourceId === entityId);
    const iface = facility.utilityInterfaces.find((item) => item.interfaceId === entityId);
    const constraint = facility.spatialConstraints.find((item) => item.constraintId === entityId);
    return container?.name ?? source?.displayName ?? iface?.name ?? constraint?.displayName ?? null;
  };

  const selectEntity = ({ entityId = null, entityType = null, geometryId, geometryRole = undefined } = {}) => {
    const feature = entityId ? featureFor(entityId) : null;
    setSelectedEntityId(entityId ?? null);
    setSelectedEntityType(entityType ?? feature?.entityType ?? null);
    setSelectedGeometryId(geometryId !== undefined ? geometryId ?? null : feature?.geometryId ?? null);
    return { applied: true, geometryRole: geometryRole ?? feature?.role ?? null };
  };

  const handle = handleRef.current;
  handle.selectEntity = selectEntity;
  handle.highlightEntity = ({ entityId = null, transient = false } = {}) => {
    setHighlightedEntityId(entityId ?? null);
    return { applied: true, transient };
  };
  handle.clearHighlight = () => {
    setHighlightedEntityId(null);
    return { applied: true };
  };
  handle.focusGeometry = ({ geometryId = null, bbox = null } = {}) => {
    if (geometryId) setSelectedGeometryId(geometryId);
    const target = bbox
      ? bboxPositions(bbox)
      : geometryId
        ? boundsOf(features.filter((feature) => feature.geometryId === geometryId))
        : [];
    if (size && target.length > 0) {
      setView(fitBounds(target, { widthPx: size.widthPx, heightPx: size.heightPx, provider: active }));
    }
    return { applied: true, fitted: target.length > 0 };
  };
  handle.setVisible = ({ layerId, visible, layerKind = null } = {}) => {
    setHiddenLayers((current) => {
      const next = new Set(current);
      if (visible) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
    if (layerKind) setActiveLayerKind(layerKind);
    return { applied: [layerId], delta: [] };
  };
  handle.openInspector = ({ entityId = null, entityType = null, tab = 'OVERVIEW', fieldPath = null } = {}) => {
    if (entityId) selectEntity({ entityId, entityType });
    setInspectorTab(tab ?? 'OVERVIEW');
    setInspectorFieldPath(fieldPath ?? null);
    return { applied: true };
  };
  /**
   * Re-reads the envelope after a change was committed elsewhere.
   *
   * The read is the canvas's own (`useFacilityEnvelope`), so this asks for it rather than
   * duplicating it: a confirmed write lands in the database while the canvas is holding the
   * geometry it drew a moment ago, and without this the design only catches up on a page
   * reload. The selection is deliberately left alone — a reload of the same revision cannot
   * invalidate it, and dropping it would move the reader's attention as a side effect of a
   * change they asked for.
   */
  handle.reloadEnvelope = () => {
    facility.reload();
    return { applied: true, delta: ['Re-read the facility envelope after the change.'] };
  };
  // `showFinding` routes and publishes through the facade, which is where the focus
  // outlives this canvas: switching to Validate unmounts the map.
  handle.showFinding = (input) => effects.showFinding(input);
  handle.snapshot = () => {
    const selectedFeature = selectedGeometryId
      ? features.find((feature) => feature.geometryId === selectedGeometryId) ?? null
      : null;
    return {
      routeState: {
        selectedEntityId,
        selectedGeometryId,
        inspectorTab,
        activeLayer: activeLayerKind,
        // The route function belongs to the shell; the hook that builds the wire
        // context fills it from the active tab.
        function: null,
      },
      selectionRefs: buildSelectionRefs({
        revisionId,
        selectedEntityId,
        selectedEntityType,
        selectedGeometryId,
        selectedGeometryRole: selectedFeature?.role ?? null,
        selectedFeature,
        displayName: selectedEntityId ? displayNameFor(selectedEntityId) : null,
      }),
      draftSummary: {
        dirty: authoring.dirty,
        baseRevisionId: authoring.baseRevisionId,
        etag: authoring.etag,
        changeCount: authoring.changes.length,
      },
      viewport: { view, size },
      highlightedEntityId,
    };
  };
  handle.restoreSnapshot = (snap) => {
    if (!snap) return { applied: false };
    const route = snap.routeState ?? {};
    const entityRef = (snap.selectionRefs ?? []).find((item) => item.kind === 'facility.entity') ?? null;
    setSelectedEntityId(route.selectedEntityId ?? null);
    setSelectedEntityType(entityRef?.entity_type ?? entityRef?.entityType ?? null);
    setSelectedGeometryId(route.selectedGeometryId ?? null);
    setInspectorTab(route.inspectorTab ?? 'OVERVIEW');
    setInspectorFieldPath(null);
    setHighlightedEntityId(snap.highlightedEntityId ?? null);
    if (snap.viewport?.view) setView(snap.viewport.view);
    return { applied: true };
  };

  useEffect(() => effects.register(handleRef.current), [effects]);

  if (!projectId) {
    return (
      <section className="canvas canvas--empty" aria-label="Basemap canvas">
        <p className="canvas__notice">Open a project to see its basemap.</p>
      </section>
    );
  }

  const selected = features.find((feature) => feature.geometryId === selectedGeometryId) ?? null;
  // An entity with no geometry record is still an inspector target, so the entity
  // selection produces the minimal shape the inspector reads.
  const inspected =
    selected ??
    (selectedEntityId
      ? {
          geometryId: null,
          entityId: selectedEntityId,
          entityType: selectedEntityType ?? 'UNKNOWN',
          role: null,
          displayName: displayNameFor(selectedEntityId),
        }
      : null);

  /**
   * Stages a drawn footprint as one container plus its geometry.
   *
   * The identity is minted here so the geometry can address the container in the same
   * change set: the server creates the container from the first change and the second
   * refers to an id that does not exist yet anywhere but in this set.
   */
  const stageDrawnFootprint = () => {
    const geometry = polygonFromPoints(draftPoints);
    if (!geometry) return;
    // An object that was dropped in already exists, so the ring is staged onto it against the
    // role the palette named. Nothing is minted: an entity may hold several roles, and this
    // placement is only ever about the one that is missing.
    if (armedPlacement) {
      authoring.stage({
        kind: 'set_geometry',
        entity_ref: { entity_id: armedPlacement.entityId },
        payload: { role: armedPlacement.role, geojson_4326: geometry },
      });
      clearMode();
      return;
    }
    const containerId = newEntityId();
    const scopeId = facility.scopes[0]?.scopeId ?? null;
    authoring.stage({
      kind: 'create_container',
      payload: {
        container_id: containerId,
        container_kind: drawKind,
        name: `${drawKind === 'BUILDING' ? 'New building' : 'New area'} ${containerId.slice(0, 4)}`,
        scope_id: scopeId,
        // Neither FLOOR nor HALL is drawn here, and only those two may carry a level.
      },
    });
    authoring.stage({
      kind: 'set_geometry',
      entity_ref: { entity_id: containerId },
      payload: { role: 'FOOTPRINT', geojson_4326: geometry },
    });
    setDraftPoints([]);
    setMode(null);
  };

  /**
   * The object a move would carry, and the geometry records that have to move with it.
   *
   * An entity's parts move together — see `move-geometry.js` — so every record the revision holds
   * for it is in the plan, not only the shape whose outline was grabbed.
   */
  const moveParts = (entityId) => features.filter((record) => record.entityId === entityId);

  const beginMove = (entityId) => {
    setMoveDraft({
      entityId,
      name: displayNameFor(entityId),
      dxPx: 0,
      dyPx: 0,
    });
  };

  /**
   * The object following the pointer, and the move being finished.
   *
   * Every call is the same calculation — the screen shift, turned into a world delta and added to
   * each part — with the release being the one that also stages the change set. Nothing is
   * written until then, and the staged set still has to be committed, so a move is reviewed the
   * way every other edit is rather than landing the instant the pointer comes up.
   */
  const applyMove = (entityId, dxPx, dyPx, { stage = false } = {}) => {
    if (!size || !entityId) return;
    setMoveDraft((current) => (current?.entityId === entityId ? { ...current, dxPx, dyPx } : current));

    if (!stage) return;
    const parts = moveParts(entityId);
    if (parts.length === 0) return;

    // The delta comes from unprojecting both ends of the drag rather than from a metres-per-pixel
    // constant: longitude and latitude do not scale together, and the projection already knows
    // exactly how they differ at this latitude and zoom.
    const plan = movePlan({
      records: parts,
      fromPx: { xPx: 0, yPx: 0 },
      toPx: { xPx: dxPx, yPx: dyPx },
      unproject: ({ xPx, yPx }) => unprojectScreen({ xPx, yPx }, { view, widthPx: size.widthPx, heightPx: size.heightPx }),
    });

    // The change the plan commits is the one the server's composition states, so a drag and an
    // assistant placement stage the identical `set_geometry` — role, ordinal, position, heights.
    for (const change of placementChanges(plan)) authoring.stage(change);
    setMoveDraft(null);
  };

  const endMove = ({ entityId, dxPx, dyPx, committed = false }) => {
    if (committed) applyMove(entityId, dxPx, dyPx, { stage: true });
    else setMoveDraft(null);
  };

  /**
   * A drop from the bucket: either the placement itself, or the mode that will make it.
   *
   * A point is complete the moment it is released, so it is staged here. A polygon cannot be
   * carried by a drag, so releasing it arms a draw for the object that owes it and the shape
   * is made the site's normal way; `stageDrawnFootprint` then finishes it against that object
   * instead of minting a container.
   */
  const dropOnMap = (event) => {
    const carried = draggedEntityId({
      carried: event.dataTransfer?.getData('text/plain') ?? '',
      dragged: draggingItemRef.current,
    });
    const item = carried ? paletteRef.current.get(carried) : null;
    if (!item || !size) return false;

    // Placement is measured against the drawing surface, so the release has to have landed on
    // the surface. The listener is on the frame — it has to be, because a drag's events are
    // delivered to the element under the pointer and a release over a tile or a feature is
    // still a release onto the map — but the frame also holds the side column, the toolbar
    // around it, and the overlays, and a release on any of those is not a placement. One
    // containment test covers all of them, the `[data-map-overlay]` controls included.
    const surface = event.currentTarget.querySelector('.canvas__surface');
    if (!surface || !surface.contains(event.target)) return false;
    event.preventDefault();

    if (item.geometryType === 'POINT') {
      const rect = surface.getBoundingClientRect();
      const coordinates = unprojectScreen(
        { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top },
        { view, widthPx: size.widthPx, heightPx: size.heightPx },
      );
      authoring.stage({
        kind: 'set_geometry',
        entity_ref: { entity_id: item.entityId },
        payload: { role: item.role, geojson_4326: { type: 'Point', coordinates } },
      });
      // The object is placed, so it leaves the bucket; the row goes with it, which is what
      // tells the user the drop worked. Nothing is left to finish, so no mode is left behind.
      clearMode();
      return true;
    }

    // A draw, not a mode of its own: an object with a missing footprint is drawn by the same
    // tool as a new building, and only what the finished ring is attached to differs.
    setDraftPoints([]);
    setArmedPlacement({ entityId: item.entityId, role: item.role, name: item.name });
    setMode('DRAW_FOOTPRINT');
    return true;
  };

  /**
   * Answers the drag while it is over the frame, which is what makes the release a drop.
   *
   * `preventDefault` is the whole point of answering: a `dragover` that is not defaulted cancels
   * the drop, so the browser never dispatches one and the gesture ends with nothing placed. The
   * decision is our own memory of the gesture and the surface under the pointer — never
   * `dataTransfer`, which carries nothing readable until the drop (see `drag-placement.js`).
   */
  const allowDrop = (event) => {
    const surface = event.currentTarget.querySelector('.canvas__surface');
    if (!canDropOn({ carrying: draggingItemRef.current, target: event.target, surface })) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  /** Stages the placed connection point as a new interface on the chosen source. */
  const stageInterface = () => {
    const source = facility.utilitySources.find((item) => item.utilitySourceId === interfaceSourceId) ?? null;
    if (!source || draftPoints.length === 0) return;
    stageUtilityInterface({
      stage: authoring.stage,
      source,
      coordinates: draftPoints[0],
      name: interfaceName,
      serviceState: interfaceServiceState,
    });
    setDraftPoints([]);
    setInterfaceName('');
    clearMode();
  };

  const cancelMode = clearMode;

  // The column around this is `FrameSide`; these two are the parts that belong to the
  // canvas — the editor for the selected entity, and the pending-change panel.
  const inspector = (
    <div className="canvas__aside">
      {/*
        The tools that enter these modes live in the shell's toolbar, next to the tool's
        other commands (ui-pattern.md, "Toolbar"). What is left here is the form for
        whichever mode is active: the aside is where a value is chosen, not where a tool
        is started.
      */}
      {canWrite && mappingTool ? (
        <div className="authoring__draw" role="group" aria-label={drawing ? 'Draw a container' : 'Place a utility interface'}>
          {drawing ? (
            <>
              <span className="authoring__draw-hint">
                Click the map to place vertices. {draftPoints.length} placed
                {draftPoints.length >= 3 ? ` · about ${Math.round(draftAreaHint(draftPoints)).toLocaleString()} m²` : ''}
              </span>
              <label className="authoring__draw-field">
                <span>Kind</span>
                <select value={drawKind} onChange={(event) => setDrawKind(event.target.value)}>
                  {['BUILDING', 'EQUIPMENT_YARD', 'PARCEL', 'RESERVED_AREA'].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
              <div className="authoring__draw-actions">
                <button
                  type="button"
                  className="authoring__finish"
                  disabled={draftPoints.length < 3}
                  title={draftPoints.length < 3 ? 'A footprint needs at least three vertices.' : undefined}
                  onClick={stageDrawnFootprint}
                >
                  Add to pending changes
                </button>
                <button type="button" className="authoring__cancel" onClick={cancelMode}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="authoring__draw-hint">
                {draftPoints.length === 0
                  ? 'Click the map to place the connection point.'
                  : 'Connection point placed. Click again to move it.'}
              </span>

              <label className="authoring__draw-field">
                <span>Source</span>
                <select
                  value={interfaceSourceId ?? ''}
                  onChange={(event) => setInterfaceSourceId(event.target.value)}
                >
                  {facility.utilitySources.length === 0 ? <option value="">No utility source in this revision</option> : null}
                  {facility.utilitySources.map((source) => (
                    <option key={source.utilitySourceId} value={source.utilitySourceId}>
                      {source.displayName ?? `${source.kind} source`} · {source.capacityState}
                    </option>
                  ))}
                </select>
              </label>

              <label className="authoring__draw-field">
                <span>Service state</span>
                <select
                  value={interfaceServiceState}
                  onChange={(event) => setInterfaceServiceState(event.target.value)}
                >
                  {['AVAILABLE', 'PLANNED', 'SUSPENDED', 'RETIRED'].map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
              </label>

              <label className="authoring__draw-field">
                <span>Name</span>
                <input
                  type="text"
                  value={interfaceName}
                  placeholder="Utility interface"
                  onChange={(event) => setInterfaceName(event.target.value)}
                />
              </label>

              {/*
                Stated rather than silent. An interface that declared its own domain or
                phase would be redefining its source, which is an ERROR, so both come from
                the source and the user is told so instead of being offered a choice the
                store would refuse.
              */}
              <p className="authoring__draw-note">
                Failure domain and phase come from the source. Capacity is left undeclared; set it in the inspector if
                this interface differs.
              </p>

              <div className="authoring__draw-actions">
                <button
                  type="button"
                  className="authoring__finish"
                  disabled={draftPoints.length === 0 || !interfaceSourceId}
                  title={draftPoints.length === 0 ? 'Place the connection point on the map first.' : undefined}
                  onClick={stageInterface}
                >
                  Add to pending changes
                </button>
                <button type="button" className="authoring__cancel" onClick={cancelMode}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {canWrite && !mappingTool && blockedReason ? (
        <p className="authoring__blocked">{blockedReason}</p>
      ) : null}

      <FacilityInspector
        feature={inspected}
        facility={facility}
        phases={phases}
        canWrite={canWrite}
        blockedReason={blockedReason}
        tab={inspectorTab}
        onTabChange={setInspectorTab}
        fieldPath={inspectorFieldPath}
        onFieldPathConsumed={() => setInspectorFieldPath(null)}
        pendingFor={(entityId) =>
          authoring.changes.filter((change) => (change.entity_ref?.entity_id ?? change.payload?.container_id) === entityId)
        }
        onStage={authoring.stage}
        onClear={() => {
          setSelectedGeometryId(null);
          setSelectedEntityId(null);
          setSelectedEntityType(null);
        }}
      />
    </div>
  );

  /**
   * Whether the pending-changes card has anything to say.
   *
   * A card that reads "No pending changes" is furniture, and on the map it would be furniture
   * covering the drawing. It appears when there is staged work, and it stays while it owes an
   * answer: a conflict to resolve, a refusal to read, or the outcome of the commit just made —
   * hiding the result of a commit the user pressed would be worse than an empty card.
   */
  const showsPending =
    authoring.changes.length > 0 ||
    Boolean(authoring.conflict) ||
    Boolean(authoring.error) ||
    Boolean(authoring.notice) ||
    Boolean(authoring.result);

  const authoringPanel = (
    <FacilityAuthoringPanel
      changes={authoring.changes}
      nameOf={(entityId) => facility.containers.find((container) => container.containerId === entityId)?.name ?? null}
      dirty={authoring.dirty}
      pending={authoring.pending}
      error={authoring.error}
      conflict={authoring.conflict}
      notice={authoring.notice}
      result={authoring.result}
      blockedReason={blockedReason}
      onUnstage={authoring.unstage}
      onCommit={async () => {
        // A commit changes the graph, so the canvas re-reads it rather than showing a
        // footprint that is not there yet.
        const result = await authoring.commit();
        if (result) await facility.reload();
      }}
      onDiscard={authoring.discard}
      onRebase={authoring.rebase}
      onDismissResult={() => authoring.bind({ envelope: facility.envelope })}
    />
  );

  return (
    <div
      className="canvas-layout"
      // The frame listens because a drag's events are delivered to the element under the
      // pointer, and a release over the map may land on a tile, a feature, or an overlay — the
      // same top and left the surface's own box has. The handlers narrow themselves to the
      // drawing area; the frame is only the widest element that contains it.
      onDragOver={allowDrop}
      onDrop={dropOnMap}
    >
      <div className="design-frame">
        <BasemapCanvas
      projectId={projectId}
      provider={active}
      providers={providers}
      style={settings?.style ?? null}
      canRead={canReadMap}
      planOnlyReason={basemapOff ? 'The basemap is off.' : null}
      view={view}
      onViewChange={(next) => setView({ ...next, zoom: clampZoom(next.zoom, active) })}
      onSelectProvider={(providerId) => {
        if (!providerId) {
          setBasemapOff(true);
          return;
        }
        setBasemapOff(false);
        // Choosing a provider is a project setting, so it is persisted; a failure
        // to persist must not take the canvas down with it.
        choose(providerId).catch(() => {});
      }}
      features={features}
      layers={layers}
      onToggleLayer={(layerId) =>
        setHiddenLayers((current) => {
          const next = new Set(current);
          if (next.has(layerId)) next.delete(layerId);
          else next.add(layerId);
          return next;
        })
      }
      selectedGeometryId={selectedGeometryId}
      highlightedEntityId={highlightedEntityId}
      onSelectFeature={(shape) => {
        // A click sets both halves of the selection. The geometry is what the map
        // draws an outline around; the entity is what the inspector and the
        // assistant's `selection_refs` address, and an entity can outlive a redraw
        // that changes its geometry id. Clicking the selected shape clears both.
        const deselect = selectedGeometryId === shape.geometryId;
        setSelectedGeometryId(deselect ? null : shape.geometryId);
        setSelectedEntityId(deselect ? null : shape.entityId ?? null);
        setSelectedEntityType(deselect ? null : shape.entityType ?? null);
      }}
      onResize={setSize}
      onFit={bounds.length > 0 ? fitToFacility : null}
      edits={stagedEdits}
      movable={canWrite && !blockedReason}
      moving={moveDraft}
      onMoveStart={beginMove}
      onMoveEnd={endMove}
      onMoveCancel={() => setMoveDraft(null)}
      drawing={mappingTool}
      draftShape={draftShape}
      drawingLabel={
        placingInterface ? 'Placing interface' : armedPlacement ? `Drawing ${armedPlacement.name ?? 'outline'}` : 'Drawing'
      }
      onDraftPoint={({ xPx, yPx }) => {
        if (!size) return;
        const point = unprojectScreen({ xPx, yPx }, { view, widthPx: size.widthPx, heightPx: size.heightPx });
        // A container accumulates a ring; an interface is a single connection point, so a
        // second click moves it rather than adding a second — one geometry per entity and
        // role is what the store holds.
        setDraftPoints((current) => (placingInterface ? [point] : [...current, point]));
      }}
      />
        <FrameSide
          projectName={projectName}
          projectId={projectId}
          revisionId={revisionId}
          lifecycleState={lifecycleState}
          validationSummary={validationSummary}
          authorName={authorName}
          revisions={revisions}
          unsaved={unsaved}
          approvalAttestationId={approvalAttestationId}
          inspector={inspector}
        />
      </div>

      {/*
        The map's left rail: the objects that have no geometry, and what is staged but not
        committed.

        A **sibling of the frame**, not a child of it, and that is load-bearing. The frame is a
        flex row holding the drawing and the side column, so an absolutely positioned child of it
        becomes a column in that row rather than an overlay on the drawing — which is where this
        rail spent its first life, quietly unstyled, because `.canvas-layout > .canvas-palette-host`
        matched nothing. It is also a sibling of the drawing rather than a child of *that* for the
        reason the search panel is (see `BasemapCanvas`): the surface disables the browser's touch
        gestures and claims the wheel, and a descendant could not scroll with a wheel or a finger.
      */}
      <div className="canvas-palette-host">
        <CanvasPalette
          items={unplaced}
          onDragStart={(item) => {
            draggingItemRef.current = item;
          }}
          onDragEnd={() => {
            // The gesture is over whichever way it ended, so the memory of it does not outlive it
            // and become a placement nobody asked for.
            draggingItemRef.current = null;
          }}
        />
        {showsPending ? authoringPanel : null}
      </div>
    </div>
  );
}

/**
 * The side column of the design frame: what this revision is, and what is selected.
 *
 * The order is the reading order. The identity strip says which revision is on the board; the
 * inspector answers "what did I just click" and takes the height it needs; the info table is
 * pinned to the bottom, so a long inspector never pushes it off the screen.
 *
 * What is *staged* is not here. The pending-changes card belongs on the map, beside the objects
 * it is about, and keeping the commit controls in a column the user reads from the top meant the
 * one thing a commit needs was pinned to the bottom of it. See `.canvas-pending` in the
 * stylesheet, and the rail in `SiteFacilityCanvas`.
 */
function FrameSide({
  projectName,
  projectId,
  revisionId,
  lifecycleState,
  validationSummary,
  authorName,
  revisions = [],
  unsaved = false,
  approvalAttestationId = null,
  inspector,
}) {
  const { errors, warnings } = validationSummary ?? { errors: 0, warnings: 0 };
  const status = revisionStatus({ lifecycleState, errors });
  // Collapsed, the table keeps the author visible: the one line that answers "whose
  // revision is this" is the reason to look at it at all.
  const [infoOpen, setInfoOpen] = useState(true);
  const author = authorName?.trim() ? authorName.trim() : 'Unknown';

  // The name the revision is listed under, where the shell knows one. The table below
  // shows it beside the id, because the id alone does not say which draft this is.
  const activeRevisionName = revisions.find((item) => item.revisionId === revisionId)?.name ?? null;

  return (
    <section className="design-frame__side" aria-label="Revision and selection">
      <Watermark />

      <header className="design-frame__name">
        <div className="design-frame__title">
          <h2 className="design-frame__project" title={projectName ?? projectId}>
            {projectName ?? projectId}
          </h2>
          <span
            className={`chip chip--lifecycle chip--lifecycle-${status.lifecycle.toLowerCase()}`}
            aria-label={`Lifecycle: ${status.lifecycle}`}
          >
            {status.lifecycle}
          </span>
        </div>

        {/*
          No scenario or revision selectors. Switching context from inside a workspace was
          the only thing that used them, and that is gone: the project is chosen on the
          Projects list, and a surface that can silently move the reader to a different
          revision is the opposite of the attribution every view is supposed to carry. What
          stays is the state a reader has to be able to see — which revision this is, and
          whether the work is saved and approved.
        */}
        <div className="design-frame__context">
          {unsaved ? (
            <span className="chip chip--dirty" aria-label="Unsaved changes in this workspace">
              <Icon name="dot" size={12} /> Unsaved
            </span>
          ) : null}
          {approvalAttestationId ? (
            <span className="chip chip--approval" aria-label="Approval attestation present">
              <Icon name="check" size={12} /> Approval
            </span>
          ) : null}
        </div>
      </header>

      <div className="design-frame__scroll">{inspector}</div>

      <div className="design-frame__foot">
        <details
          className="frame-info"
          open={infoOpen}
          onToggle={(event) => setInfoOpen(event.currentTarget.open)}
        >
          <summary className="frame-info__summary">
            <span className="frame-info__title">Revision status</span>
            {infoOpen ? null : <span className="frame-info__collapsed">· {author}</span>}
            <span className={`frame-info__badge frame-info__badge--${status.tone}`}>{status.label}</span>
          </summary>
          <table className="frame-info__table">
            <tbody>
              <tr>
                <th scope="row">Revision</th>
                {/* The name is what the selector above calls it; the id is what a report
                    needs. Both, because the frame is now the only place either appears. */}
                <td title={revisionId ?? undefined}>
                  {activeRevisionName ? `${activeRevisionName} · ` : ''}
                  {revisionId ? shortId(revisionId) : '—'}
                </td>
              </tr>
              <tr>
                <th scope="row">Status</th>
                <td>
                  {status.label}
                  {errors > 0 ? ` · ${errors} ${errors === 1 ? 'error' : 'errors'}` : ''}
                  {warnings > 0 ? ` · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}
                </td>
              </tr>
              <tr>
                <th scope="row">Author</th>
                <td>{author}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </section>
  );
}

/**
 * The one status word for the revision, and the tone that colours it.
 *
 * Ordered most severe first: a revision with validation errors is not "in review"
 * whatever else is true of it, and a label that hid the errors would be the one line
 * on the board that lies.
 */
function revisionStatus({ lifecycleState = null, errors = 0 } = {}) {
  const lifecycle = LIFECYCLE_STATES.includes(lifecycleState) ? lifecycleState : 'DRAFT';
  if (errors > 0) return { lifecycle, label: `${errors} ${errors === 1 ? 'error' : 'errors'}`, tone: 'error' };
  if (lifecycle === 'PUBLISHED') return { lifecycle, label: 'Published', tone: 'ok' };
  if (lifecycle === 'VALIDATED') return { lifecycle, label: 'Validated', tone: 'ok' };
  return { lifecycle, label: 'Draft', tone: 'neutral' };
}

/**
 * The attributes a planner reads off the map: what kind of container it is and
 * how tall, or what a utility point carries. Every value comes from the envelope
 * that was read; nothing is inferred from the geometry.
 */
export function describeFeature(feature, facility) {
  const lines = [];
  const container = facility.containers?.find((item) => item.containerId === feature.entityId);
  if (container) {
    const level = container.levelNumber === null || container.levelNumber === undefined ? null : `level ${container.levelNumber}`;
    lines.push(['Container', container.kind, level].filter(Boolean).join(' · '));
    if (container.elevationBaseM !== null && container.elevationTopM !== null) {
      lines.push(`Elevation ${container.elevationBaseM}–${container.elevationTopM} m`);
    }
  }

  const source = facility.utilitySources?.find((item) => item.utilitySourceId === feature.entityId);
  if (source) {
    lines.push(`${source.kind} source · ${formatCapacity(source)} · ${source.capacityState}`);
  }

  const utilityInterface = facility.utilityInterfaces?.find((item) => item.interfaceId === feature.entityId);
  if (utilityInterface) {
    lines.push(`Interface · ${utilityInterface.serviceState} · ${formatCapacity(utilityInterface)}`);
  }

  const constraint = facility.spatialConstraints?.find((item) => item.constraintId === feature.entityId);
  if (constraint) {
    const rule =
      constraint.ruleKind && constraint.ruleValue !== null
        ? `${constraint.ruleKind} ${constraint.ruleValue}${constraint.ruleUnit ? ` ${constraint.ruleUnit}` : ''}`
        : constraint.ruleKind;
    lines.push([constraint.kind, constraint.severity, rule].filter(Boolean).join(' · '));
  }

  if (feature.heightM !== null && feature.heightM !== undefined) lines.push(`Height ${feature.heightM} m`);
  return lines;
}

function formatCapacity(quantity) {
  if (quantity?.capacityValue === null || quantity?.capacityValue === undefined) return 'capacity not declared';
  return `${quantity.capacityValue} ${quantity.capacityUnit ?? ''}`.trim();
}

/**
 * The `selection_refs` the assistant context reports. Only kinds from
 * assistant-integration.md's "Entity-Reference Kinds" appear here, and a geometry
 * reference carries the extra identity that kind requires.
 */
export function buildSelectionRefs({
  revisionId = null,
  selectedEntityId = null,
  selectedEntityType = null,
  selectedGeometryId = null,
  selectedGeometryRole = null,
  selectedFeature = null,
  displayName = null,
} = {}) {
  const refs = [];
  if (selectedEntityId) {
    refs.push({
      kind: 'facility.entity',
      revision_id: revisionId,
      entity_id: selectedEntityId,
      entity_type: selectedEntityType,
      label: displayName ?? selectedEntityType ?? selectedEntityId,
    });
  }
  if (selectedGeometryId) {
    refs.push({
      kind: 'facility.geometry',
      revision_id: revisionId,
      geometry_id: selectedGeometryId,
      entity_id: selectedEntityId ?? selectedFeature?.entityId ?? null,
      geometry_role: selectedGeometryRole ?? selectedFeature?.role ?? null,
      label: [displayName ?? selectedFeature?.displayName, selectedGeometryRole ?? selectedFeature?.role]
        .filter(Boolean)
        .join(' · ') || selectedGeometryId,
    });
  }
  return refs;
}

/** A `[min-x, min-y, max-x, max-y]` box as the `{lon, lat}` list `fitBounds` consumes. */
export function bboxPositions(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return [];
  if (!bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) return [];
  return [
    { lon: bbox[0], lat: bbox[1] },
    { lon: bbox[2], lat: bbox[3] },
  ];
}

