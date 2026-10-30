import { rackCorners } from './edit-layout-state.js';
import { CANVAS, fitRoom } from './floorplan-view.js';

// A viewport choice only. Neither changes the room polygon nor stored metres.
export function equipmentCamera(placements, models, constraints, extent) {
  const points = placements.flatMap(rack => {
    const model = models.find(m => m.modelId === rack.modelId);
    return model && [rack.xM, rack.yM].every(Number.isFinite) ? rackCorners(rack, model) : [];
  });
  for (const o of constraints?.obstacles ?? []) {
    if ([o.xM,o.yM,o.widthM,o.depthM].every(Number.isFinite))
      points.push([o.xM-o.widthM/2,o.yM-o.depthM/2],[o.xM+o.widthM/2,o.yM+o.depthM/2]);
  }
  if (!points.length) return fitRoom(extent);
  const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
  const left=Math.min(...xs), right=Math.max(...xs), bottom=Math.min(...ys), top=Math.max(...ys);
  return {cx:(left+right)/2,cy:(bottom+top)/2,
    scale:Math.min(80,(CANVAS.width-100)/(right-left+2),(CANVAS.height-100)/(top-bottom+2))};
}

// SVG preserveAspectRatio can introduce letterboxing; use the uniform physical scale.
export function pointerPosition(clientX, clientY, rect, camera) {
  const scale=Math.min(rect.width/CANVAS.width,rect.height/CANVAS.height);
  const x=(clientX-rect.left-(rect.width-CANVAS.width*scale)/2)/scale;
  const y=(clientY-rect.top-(rect.height-CANVAS.height*scale)/2)/scale;
  return {xM:camera.cx+(x-CANVAS.width/2)/camera.scale,
    yM:camera.cy-(y-CANVAS.height/2)/camera.scale};
}

export function dragPosition(start, pointer, step) {
  const snap=value=>Number((Math.round(value/step)*step).toFixed(4));
  return {xM:snap(start.xM+pointer.xM-start.pointer.xM),
    yM:snap(start.yM+pointer.yM-start.pointer.yM)};
}

export function deviceKind(device) {
  const id=device.catalogRef?.modelId;
  if (id==='demo-gpu-4u') return ['GPU server','gpu'];
  if (id==='demo-compute-2u') return ['Compute server','server'];
  if (id==='demo-tor-1u') return ['ToR switch','switch'];
  if (id==='demo-optical-2u') return ['Optical switch','switch'];
  return ['Equipment','other'];
}
