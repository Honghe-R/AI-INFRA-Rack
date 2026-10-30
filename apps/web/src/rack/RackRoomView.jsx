import { useEffect, useId, useRef, useState } from 'react';
import { rackError } from './rack-plan-state.js';
import { rackCorners, displayClearanceBands } from './edit-layout-state.js';
import { rackLoadDisplay, rackGroupCamera } from './floorplan-load.js';
import {
  boundaryPath,
  CANVAS,
  fitRoom,
  gridLines,
  niceMetres,
  ROOM_VIEW_REASONS,
  toScreen,
} from './floorplan-view.js';

export function RackRoomView({
  client,
  plan,
  canReadFacility,
  facilityPending,
  facilityUnavailable,
  refresh,
}) {
  const [state, setState] = useState({ pending: true, data: null, error: null });
  const [retry, setRetry] = useState(0);
  const input = plan.facilityInput;
  useEffect(() => {
    if (!canReadFacility) return undefined;
    const controller = new AbortController();
    setState({ pending: true, data: null, error: null });
    client
      .getRackRoomView(plan.projectId, plan.planId, { signal: controller.signal })
      .then((result) => {
        const data = result.data;
        if (
          data?.contractVersion !== 1 ||
          data.planId !== plan.planId ||
          data.planVersion !== plan.version ||
          Object.keys(input).some((key) => data.facilityInput?.[key] !== input[key])
        ) {
          throw new Error('The room view does not match this saved plan and Facility reference.');
        }
        if (!controller.signal.aborted) setState({ pending: false, data, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ pending: false, data: null, error });
      });
    return () => controller.abort();
  }, [client, plan.projectId, plan.planId, plan.version, input, canReadFacility, refresh, retry]);
  if (!canReadFacility)
    return (
      <p role="status">
        {facilityPending
          ? 'Checking Facility access…'
          : facilityUnavailable
            ? 'Facility access could not be checked.'
            : 'Facility read access is required to view this floorplan.'}
      </p>
    );
  if (state.pending) return <p role="status">Reading bound HALL geometry…</p>;
  if (state.error)
    return (
      <div role="alert">
        <p className="rack-error">{rackError(state.error)}</p>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Retry floorplan
        </button>
      </div>
    );
  const data = state.data;
  if (data?.status !== 'AVAILABLE')
    return (
      <div className="rack-floor-unavailable" role="status">
        <h3>Floorplan unavailable</h3>
        <p>{ROOM_VIEW_REASONS[data?.reason] ?? 'No supported bound room geometry is available.'}</p>
        <code>{data?.reason ?? 'UNKNOWN'}</code>
        <p className="rack-muted">No room geometry or Rack validation state was changed.</p>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Recheck source
        </button>
      </div>
    );
  return (
    <RoomFloorplan
      key={`${data.planId}:${data.facilityInput.revisionEtag}:${data.sourceGeometry.geometryId}:${refresh}:${retry}`}
      room={data.room}
      view={data.view}
      sourceGeometry={data.sourceGeometry}
    />
  );
}

/** SVG display in projected metres; screen Y inversion never changes the data. */
export function RoomFloorplan({
  room,
  view,
  sourceGeometry,
  placements = [],
  models = [],
  selectedId = null,
  onSelect = null,
  onMove = null,
  report = null,
  focusRequest = null,
  constraints = null,
  selectedObstacleId = null,
  onSelectObstacle = null,
  equipmentReport = null,
  layoutLabel = null,
}) {
  const fit = fitRoom(view.extentM);
  const [camera, setCamera] = useState(() => rackGroupCamera(placements, models, fit) ?? fit);
  const svgRef = useRef(null);
  const dotsId = `rack-preview-dots-${useId().replace(/:/g, '')}`;
  const dragging = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const sectionRef = useRef(null);
  const [expanded, setExpanded] = useState(false), [expandError, setExpandError] = useState(null);
  const [showObstacles, setShowObstacles] = useState(true), [showMaintenance, setShowMaintenance] = useState(true);
  const [showRackLabels, setShowRackLabels] = useState(true);
  const [loadMode, setLoadMode] = useState('layout');
  useEffect(() => {
    const changed = () => setExpanded(document.fullscreenElement === sectionRef.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  async function toggleExpanded() {
    try {
      setExpandError(null);
      if (document.fullscreenElement === sectionRef.current) await document.exitFullscreen();
      else if (sectionRef.current.requestFullscreen) await sectionRef.current.requestFullscreen();
      else setExpandError('This browser does not support expanding the map. Automatic fit remains available.');
    } catch { setExpandError('The browser could not expand the map. Automatic fit remains available.'); }
  }
  useEffect(() => {
    if (focusRequest?.fitRacks) {
      setCamera(rackGroupCamera(placements, models, fit) ?? fit);
      return;
    }
    const rack = focusRequest?.obstacleId
      ? constraints?.obstacles.find((o) => o.obstacleId === focusRequest.obstacleId)
      : placements.find((item) => item.rackId === focusRequest?.rackId);
    if (rack && Number.isFinite(rack.xM) && Number.isFinite(rack.yM))
      setCamera({ cx: rack.xM, cy: rack.yM, scale: Math.min(fit.scale * 32, Math.max(fit.scale, 50)) });
  }, [focusRequest]);
  const grid = gridLines(camera);
  const scaleM = niceMetres(110 / camera.scale);
  const origin = toScreen([0, 0], camera);
  const synthetic = sourceGeometry.provenanceReference === 'dev-seed-facility';

  function finishDrag(event) {
    dragging.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keydown(event) {
    if (['0', 'Home'].includes(event.key)) setCamera(fit);
    else return;
    event.preventDefault();
  }

  return (
    <section ref={sectionRef} className="rack-floorplan" aria-label="Bound HALL floorplan">
      <div className="rack-heading">
        <div>
          <h3>{room.name}</h3>
          <p className="rack-muted">{layoutLabel ?? (onMove ? 'Layout editor' : 'Saved layout')} · Projected grid metres · Auto-fit dot-grid view</p>
        </div>
        <div className="rack-actions" aria-label="Floorplan controls">
          <button onClick={toggleExpanded}>{expanded ? 'Exit expanded map' : 'Expand map'}</button>
          <button type="button" onClick={() => setCamera(fit)}>
            Fit room
          </button>
          <button type="button" disabled={!placements.length} onClick={() => setCamera(rackGroupCamera(placements, models, fit) ?? fit)}>Fit racks</button>
        </div>
      </div>
      {expandError && <p role="status">{expandError}</p>}
      <div className="rack-map-layers" aria-label="Map display layers">
        <label>Color by<select value={loadMode} onChange={(e) => setLoadMode(e.target.value)}>
          <option value="layout">Layout</option><option value="u">Known U occupation</option><option value="power">Power demand / limit</option>
        </select></label>
        <label><input type="checkbox" checked={showObstacles} onChange={(e) => setShowObstacles(e.target.checked)} />Planning obstacles</label>
        <label><input type="checkbox" checked={showMaintenance} onChange={(e) => setShowMaintenance(e.target.checked)} />Maintenance bands</label>
        <label><input type="checkbox" checked={showRackLabels} onChange={(e) => setShowRackLabels(e.target.checked)} />Rack labels</label>
        <span className="rack-muted">Display controls only; all constraints remain checked.</span>
      </div>
      {loadMode !== 'layout' && <p className="rack-map-legend">Blue: below 80% · Amber: ≥80% · Red: conflict or exceeded · Gray: unknown / not checked. Colors describe the provided inventory and declared assumptions.</p>}
      <svg
        ref={svgRef}
        className={`rack-room-canvas${isDragging ? ' is-dragging' : ''}`}
        viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
        role="group"
        tabIndex={0}
        aria-label={`${room.name} floorplan. Automatic fit; select racks or use Fit room and Fit racks.`}
        onKeyDown={keydown}
        onPointerDown={(event) => {
          if (event.button !== 0 || dragging.current) return;
          event.currentTarget.focus();
        }}
        onPointerMove={(event) => {
          const previous = dragging.current;
          if (!previous || previous.pointerId !== event.pointerId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const dx = ((event.clientX - previous.x) * CANVAS.width) / rect.width;
          const dy = ((event.clientY - previous.y) * CANVAS.height) / rect.height;
          if (previous.kind === 'rack') {
            onMove?.(previous.rackId, {
              xM: previous.xM + dx / camera.scale,
              yM: previous.yM - dy / camera.scale,
            });
          }
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          dragging.current = null;
          setIsDragging(false);
        }}
      >
        <title>{`${room.name} · Facility polygon in local projected metres`}</title>
        <rect width={CANVAS.width} height={CANVAS.height} className="rack-room-background" />
        <path
          d={boundaryPath(view.boundaryLocalM, camera)}
          fillRule="evenodd"
          className="rack-room-boundary"
        />
        <defs><pattern id={dotsId} width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.65" fill="currentColor"/></pattern></defs>
        <rect width={CANVAS.width} height={CANVAS.height} fill={`url(#${dotsId})`} opacity="0.22" pointerEvents="none"/>
        <g aria-label="Maintenance bands">
          {(showMaintenance ? placements : []).flatMap((rack) => {
            const model = models.find((m) => m.modelId === rack.modelId);
            if (!model) return [];
            return displayClearanceBands(rack, model, constraints?.clearance).map((band) => (
              <polygon
                key={`${rack.rackId}:${band.side}`}
                className={`rack-maintenance-band ${band.side.toLowerCase()}`}
                points={band.points.map((p) => toScreen(p, camera).join(',')).join(' ')}
              >
                <title>{`${rack.name} ${band.side} maintenance band`}</title>
              </polygon>
            ));
          })}
        </g>
        <g aria-label="Planning obstacles">
          {(showObstacles ? constraints?.obstacles ?? [] : []).map((o) => {
            if (![o.xM, o.yM, o.widthM, o.depthM].every(Number.isFinite) || o.widthM <= 0 || o.depthM <= 0)
              return null;
            const points = [
              [o.xM - o.widthM / 2, o.yM - o.depthM / 2],
              [o.xM + o.widthM / 2, o.yM - o.depthM / 2],
              [o.xM + o.widthM / 2, o.yM + o.depthM / 2],
              [o.xM - o.widthM / 2, o.yM + o.depthM / 2],
            ].map((p) => toScreen(p, camera));
            const issue = report?.diagnostics.some((d) => d.obstacleIds?.includes(o.obstacleId));
            return (
              <g
                key={o.obstacleId}
                role="button"
                tabIndex={0}
                aria-label={`Select obstacle ${o.name}`}
                className={`rack-drawn-obstacle${issue ? ' has-issue' : ''}${selectedObstacleId === o.obstacleId ? ' is-selected' : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onSelectObstacle?.(o.obstacleId)}
                onKeyDown={(e) => {
                  if (['Enter', ' '].includes(e.key)) {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectObstacle?.(o.obstacleId);
                  }
                }}
              >
                <title>{`Planning obstacle: ${o.name} · ${o.widthM} × ${o.depthM} m`}</title>
                <polygon points={points.map((p) => p.join(',')).join(' ')} />
                {camera.scale * o.widthM > 25 && (
                  <text x={points[0][0]} y={points[0][1] + 15}>
                    {o.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        <g aria-label="Rack footprints">
          {placements.map((rack) => {
            const model = models.find((item) => item.modelId === rack.modelId);
            if (!model || !Number.isFinite(rack.xM) || !Number.isFinite(rack.yM)) return null;
            const corners = rackCorners(rack, model).map((point) => toScreen(point, camera));
            const center = toScreen([rack.xM, rack.yM], camera);
            const issue = report?.diagnostics?.some((item) => item.rackIds.includes(rack.rackId)) ||
              equipmentReport?.diagnostics?.some((item) => item.rackId === rack.rackId);
            const load = rackLoadDisplay(loadMode, rack.rackId, equipmentReport);
            return (
              <g
                key={rack.rackId}
                role="button"
                tabIndex={0}
                aria-label={`Select rack ${rack.name}`}
                data-load={load?.tone}
                className={`rack-drawn-rack${selectedId === rack.rackId ? ' is-selected' : ''}${issue ? ' has-issue' : ''}`}
                onKeyDown={(event) => {
                  if (['Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect?.(rack.rackId);
                  }
                }}
                onClick={() => onSelect?.(rack.rackId)}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onSelect?.(rack.rackId);
                  if (event.button !== 0 || rack.locked || !onMove) return;
                  svgRef.current.focus();
                  svgRef.current.setPointerCapture(event.pointerId);
                  dragging.current = {
                    kind: 'rack',
                    pointerId: event.pointerId,
                    rackId: rack.rackId,
                    x: event.clientX,
                    y: event.clientY,
                    xM: rack.xM,
                    yM: rack.yM,
                  };
                  setIsDragging(true);
                }}
              >
                <title>{`${rack.name} · ${model.widthM} × ${model.depthM} m · ${rack.rotationDeg}°${rack.locked ? ' · Locked' : ''}${load ? ` · ${load.label}` : ''}`}</title>
                <polygon points={corners.map((point) => point.join(',')).join(' ')} />
                <line
                  className="rack-front-edge"
                  x1={corners[0][0]}
                  y1={corners[0][1]}
                  x2={corners[1][0]}
                  y2={corners[1][1]}
                />
                {showRackLabels && camera.scale * model.widthM > 10 && (
                  <text
                    style={{fontSize: camera.scale * model.widthM > 22 ? 12 : 9}}
                    x={center[0]}
                    y={center[1] - (camera.scale * model.depthM) / 2 - 7}
                    textAnchor="middle"
                  >
                    {rack.name}
                  </text>
                )}
                {load && camera.scale * model.widthM > 45 && <text className="rack-load-label" x={center[0]} y={center[1] + 4} textAnchor="middle">{load.label}</text>}
              </g>
            );
          })}
        </g>
        {origin[0] > 20 &&
          origin[0] < CANVAS.width - 70 &&
          origin[1] > 20 &&
          origin[1] < CANVAS.height - 45 && (
            <g className="rack-room-origin">
              <circle cx={origin[0]} cy={origin[1]} r="4" />
              <text x={origin[0] + 9} y={origin[1] - 9}>
                (0, 0)
              </text>
            </g>
          )}
        <g className="rack-room-label">
          <rect x="12" y="12" width="168" height="30" rx="4" />
          <text x="22" y="32">
            Boundary · grid {grid.stepM} m
          </text>
        </g>
        <g className="rack-room-north">
          <text x="758" y="32" textAnchor="middle">
            ↑
          </text>
          <text x="758" y="51" textAnchor="middle">
            Grid N
          </text>
        </g>
        <g className="rack-room-scale">
          <rect x="15" y="385" width="150" height="44" rx="4" />
          <path d={`M30 407 v7 h${scaleM * camera.scale} v-7`} />
          <text x="30" y="401">
            {scaleM} m
          </text>
        </g>
      </svg>
      <p className="rack-muted">
        Dashed blue: front maintenance · Dashed amber: rear maintenance · Shaded blocks: planning obstacles
      </p>
      <p className="rack-muted">Dots are a visual guide, not a physical grid · Fit room: full room · Fit racks: equipment area · 0: full room · Esc: exit expanded view</p>
      <dl className="rack-floor-stats">
        <div>
          <dt>X extent</dt>
          <dd>{view.extentM.width.toFixed(2)} m</dd>
        </div>
        <div>
          <dt>Y extent</dt>
          <dd>{view.extentM.height.toFixed(2)} m</dd>
        </div>
        <div>
          <dt>Polygon area</dt>
          <dd>{view.areaM2.toFixed(2)} m²</dd>
        </div>
        <div>
          <dt>Interior rings</dt>
          <dd>{view.interiorRingCount}</dd>
        </div>
      </dl>
      <p className="rack-warning">
        Obstacles: {constraints?.obstacleCoverage ?? 'UNKNOWN'} · Maintenance:{' '}
        {constraints?.clearance
          ? `front ${constraints.clearance.frontM} m / rear ${constraints.clearance.rearM} m`
          : 'NOT_SET'}{' '}
        · Rack validation: NOT_RUN. Spatial checks use declared planning inputs; access routes and
        engineering accuracy remain unchecked. Equipment and capacity are reported separately below.
      </p>
      <details className="rack-room-source">
        <summary>Coordinates and source</summary>
        <p>
          {synthetic
            ? 'Synthetic Facility sample (dev-seed-facility); not surveyed engineering data.'
            : `Facility provenance: ${sourceGeometry.provenanceReference ?? 'Not recorded'}.`}
        </p>
        <p>{view.sourceCrs} · X = grid east, Y = grid north. Translation only; no room rotation.</p>
        <p>
          Projected origin: [{view.originProjectedM.map((value) => value.toFixed(3)).join(', ')}] m.{' '}
          {view.originDescription}
        </p>
        <p>
          Extents describe the outer ring bounding box; the polygon, including holes, is drawn without
          replacement or simplification.
        </p>
        <p>
          Geometry <code>{sourceGeometry.geometryId}</code> · {sourceGeometry.role}
        </p>
        <p>
          Georeferencing review: {sourceGeometry.transformReviewState}. The stored projection is used for
          display; survey accuracy and projection distortion have not been verified.
        </p>
      </details>
      {synthetic && (
        <p className="rack-muted">Synthetic Facility sample · {placements.length} rack placement(s)</p>
      )}
    </section>
  );
}
