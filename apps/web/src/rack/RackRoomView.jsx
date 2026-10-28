import { useEffect, useRef, useState } from 'react';
import { rackError } from './rack-plan-state.js';
import { rackCorners } from './edit-layout-state.js';
import { boundaryPath, CANVAS, fitRoom, gridLines, niceMetres, panCamera, ROOM_VIEW_REASONS, toScreen, zoomCamera } from './floorplan-view.js';

export function RackRoomView({ client, plan, canReadFacility, facilityPending, facilityUnavailable, refresh }) {
  const [state, setState] = useState({ pending: true, data: null, error: null });
  const [retry, setRetry] = useState(0);
  const input = plan.facilityInput;
  useEffect(() => {
    if (!canReadFacility) return undefined;
    const controller = new AbortController();
    setState({ pending: true, data: null, error: null });
    client.getRackRoomView(plan.projectId, plan.planId, { signal: controller.signal }).then(result => {
      const data = result.data;
      if (data?.contractVersion !== 1 || data.planId !== plan.planId || data.planVersion !== plan.version
        || Object.keys(input).some(key => data.facilityInput?.[key] !== input[key])) {
        throw new Error('The room view does not match this saved plan and Facility reference.');
      }
      if (!controller.signal.aborted) setState({ pending: false, data, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ pending: false, data: null, error });
    });
    return () => controller.abort();
  }, [client, plan.projectId, plan.planId, plan.version, input, canReadFacility, refresh, retry]);
  if (!canReadFacility) return <p role="status">{facilityPending ? 'Checking Facility access…'
    : facilityUnavailable ? 'Facility access could not be checked.' : 'Facility read access is required to view this floorplan.'}</p>;
  if (state.pending) return <p role="status">Reading bound HALL geometry…</p>;
  if (state.error) return <div role="alert"><p className="rack-error">{rackError(state.error)}</p>
    <button type="button" onClick={() => setRetry(value => value + 1)}>Retry floorplan</button></div>;
  const data = state.data;
  if (data?.status !== 'AVAILABLE') return <div className="rack-floor-unavailable" role="status">
    <h3>Floorplan unavailable</h3><p>{ROOM_VIEW_REASONS[data?.reason] ?? 'No supported bound room geometry is available.'}</p>
    <code>{data?.reason ?? 'UNKNOWN'}</code>
    <p className="rack-muted">No room geometry or Rack validation state was changed.</p>
    <button type="button" onClick={() => setRetry(value => value + 1)}>Recheck source</button>
  </div>;
  return <RoomFloorplan key={`${data.planId}:${data.facilityInput.revisionEtag}:${data.sourceGeometry.geometryId}:${refresh}:${retry}`}
    room={data.room} view={data.view} sourceGeometry={data.sourceGeometry} />;
}

/** SVG display in projected metres; screen Y inversion never changes the data. */
export function RoomFloorplan({ room, view, sourceGeometry, placements = [], models = [], selectedId = null,
  onSelect = null, onMove = null, report = null, focusRequest = null }) {
  const fit = fitRoom(view.extentM);
  const [camera, setCamera] = useState(fit);
  const svgRef = useRef(null);
  const dragging = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  useEffect(() => {
    const rack=placements.find(item=>item.rackId===focusRequest?.rackId);
    if(rack && Number.isFinite(rack.xM) && Number.isFinite(rack.yM)) setCamera({cx:rack.xM,cy:rack.yM,scale:Math.min(fit.scale*32,Math.max(fit.scale,50))});
  },[focusRequest]);
  useEffect(() => {
    const svg = svgRef.current;
    const wheel = event => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = [(event.clientX - rect.left) * CANVAS.width / rect.width,
        (event.clientY - rect.top) * CANVAS.height / rect.height];
      setCamera(current => zoomCamera(current, Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * .002), fit.scale, anchor));
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [fit.scale]);
  const grid = gridLines(camera);
  const scaleM = niceMetres(110 / camera.scale);
  const origin = toScreen([0, 0], camera);
  const synthetic = sourceGeometry.provenanceReference === 'dev-seed-facility';

  function finishDrag(event) {
    dragging.current = null; setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keydown(event) {
    const delta = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[event.key];
    if (delta) setCamera(current => panCamera(current, ...delta));
    else if (['+', '='].includes(event.key)) setCamera(current => zoomCamera(current, 1.25, fit.scale));
    else if (event.key === '-') setCamera(current => zoomCamera(current, .8, fit.scale));
    else if (['0', 'Home'].includes(event.key)) setCamera(fit);
    else return;
    event.preventDefault();
  }

  return <section className="rack-floorplan" aria-label="Bound HALL floorplan">
      <div className="rack-heading"><div><h3>{room.name}</h3><p className="rack-muted">{onMove ? 'Layout editor' : 'Saved layout'} · Projected grid metres</p></div>
      <div className="rack-actions" aria-label="Floorplan controls">
        <button type="button" aria-label="Zoom out floorplan" onClick={() => setCamera(current => zoomCamera(current, .8, fit.scale))}>−</button>
        <output aria-label="Floorplan zoom">{(camera.scale / fit.scale).toFixed(2)}×</output>
        <button type="button" aria-label="Zoom in floorplan" onClick={() => setCamera(current => zoomCamera(current, 1.25, fit.scale))}>+</button>
        <button type="button" onClick={() => setCamera(fit)}>Fit room</button>
      </div>
    </div>
    <svg ref={svgRef} className={`rack-room-canvas${isDragging ? ' is-dragging' : ''}`} viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
      role="group" tabIndex={0} aria-label={`${room.name} floorplan. Drag to pan, scroll to zoom; arrow keys pan, plus and minus zoom, zero fits the room.`}
      onKeyDown={keydown}
      onPointerDown={event => {
        if (event.button !== 0 || dragging.current) return;
        event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind:'pan' }; setIsDragging(true);
      }}
      onPointerMove={event => {
        const previous = dragging.current;
        if (!previous || previous.pointerId !== event.pointerId) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const dx = (event.clientX - previous.x) * CANVAS.width / rect.width;
        const dy = (event.clientY - previous.y) * CANVAS.height / rect.height;
        if(previous.kind==='rack') {
          onMove?.(previous.rackId,{xM:previous.xM+dx/camera.scale,yM:previous.yM-dy/camera.scale});
        } else {
          dragging.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind:'pan' };
          setCamera(current => panCamera(current, dx, dy));
        }
      }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={() => { dragging.current = null; setIsDragging(false); }}>
      <title>{`${room.name} · Facility polygon in local projected metres`}</title>
      <rect width={CANVAS.width} height={CANVAS.height} className="rack-room-background" />
      <g className="rack-room-grid">{grid.lines.map((line, index) => <line key={index} x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} />)}</g>
      <path d={boundaryPath(view.boundaryLocalM, camera)} fillRule="evenodd" className="rack-room-boundary" />
      <g aria-label="Rack footprints">{placements.map(rack=>{
        const model=models.find(item=>item.modelId===rack.modelId);
        if(!model || !Number.isFinite(rack.xM) || !Number.isFinite(rack.yM)) return null;
        const corners=rackCorners(rack,model).map(point=>toScreen(point,camera));
        const center=toScreen([rack.xM,rack.yM],camera);
        const issue=report?.diagnostics?.some(item=>item.rackIds.includes(rack.rackId));
        return <g key={rack.rackId} role="button" tabIndex={0} aria-label={`Select rack ${rack.name}`}
          className={`rack-drawn-rack${selectedId===rack.rackId?' is-selected':''}${issue?' has-issue':''}`}
          onKeyDown={event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();onSelect?.(rack.rackId);}}}
          onClick={()=>onSelect?.(rack.rackId)}
          onPointerDown={event=>{
            event.stopPropagation();onSelect?.(rack.rackId);
            if(event.button!==0 || rack.locked || !onMove) return;
            svgRef.current.focus();svgRef.current.setPointerCapture(event.pointerId);
            dragging.current={kind:'rack',pointerId:event.pointerId,rackId:rack.rackId,x:event.clientX,y:event.clientY,xM:rack.xM,yM:rack.yM};
            setIsDragging(true);
          }}>
          <title>{`${rack.name} · ${model.widthM} × ${model.depthM} m · ${rack.rotationDeg}°${rack.locked?' · Locked':''}`}</title>
          <polygon points={corners.map(point=>point.join(',')).join(' ')} />
          <line className="rack-front-edge" x1={corners[0][0]} y1={corners[0][1]} x2={corners[1][0]} y2={corners[1][1]} />
          {camera.scale*model.widthM>22 && <text x={center[0]} y={center[1]-camera.scale*model.depthM/2-7} textAnchor="middle">{rack.name}</text>}
        </g>;
      })}</g>
      {origin[0] > 20 && origin[0] < CANVAS.width - 70 && origin[1] > 20 && origin[1] < CANVAS.height - 45 &&
        <g className="rack-room-origin"><circle cx={origin[0]} cy={origin[1]} r="4" /><text x={origin[0] + 9} y={origin[1] - 9}>(0, 0)</text></g>}
      <g className="rack-room-label"><rect x="12" y="12" width="168" height="30" rx="4" /><text x="22" y="32">Boundary · grid {grid.stepM} m</text></g>
      <g className="rack-room-north"><text x="758" y="32" textAnchor="middle">↑</text><text x="758" y="51" textAnchor="middle">Grid N</text></g>
      <g className="rack-room-scale"><rect x="15" y="385" width="150" height="44" rx="4" />
        <path d={`M30 407 v7 h${scaleM * camera.scale} v-7`} /><text x="30" y="401">{scaleM} m</text></g>
    </svg>
    <p className="rack-muted">Drag to pan · Scroll or + / − to zoom · Arrow keys to pan · 0 to fit</p>
    <dl className="rack-floor-stats">
      <div><dt>X extent</dt><dd>{view.extentM.width.toFixed(2)} m</dd></div>
      <div><dt>Y extent</dt><dd>{view.extentM.height.toFixed(2)} m</dd></div>
      <div><dt>Polygon area</dt><dd>{view.areaM2.toFixed(2)} m²</dd></div>
      <div><dt>Interior rings</dt><dd>{view.interiorRingCount}</dd></div>
    </dl>
    <p className="rack-warning">Obstacles: UNKNOWN · Rack validation: NOT_RUN. Spatial checks cover Polygon containment, holes and rack overlap only.</p>
    <details className="rack-room-source"><summary>Coordinates and source</summary>
      <p>{synthetic ? 'Synthetic Facility sample (dev-seed-facility); not surveyed engineering data.'
        : `Facility provenance: ${sourceGeometry.provenanceReference ?? 'Not recorded'}.`}</p>
      <p>{view.sourceCrs} · X = grid east, Y = grid north. Translation only; no room rotation.</p>
      <p>Projected origin: [{view.originProjectedM.map(value => value.toFixed(3)).join(', ')}] m. {view.originDescription}</p>
      <p>Extents describe the outer ring bounding box; the polygon, including holes, is drawn without replacement or simplification.</p>
      <p>Geometry <code>{sourceGeometry.geometryId}</code> · {sourceGeometry.role}</p>
      <p>Georeferencing review: {sourceGeometry.transformReviewState}. The stored projection is used for display; survey accuracy and projection distortion have not been verified.</p>
    </details>
    {synthetic && <p className="rack-muted">Synthetic Facility sample · {placements.length} rack placement(s)</p>}
  </section>;
}
