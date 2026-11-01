import { record, fail } from './input.js';
import { rackFootprint } from './geometry.js';
import { rackClearanceBands } from './constraints.js';

export const PLANNER_LIMITS = Object.freeze({ movableRacks: 64, posesPerRack: 2048, posesPerOption: 16384, batchSize: 128 });
export function normalizePlannerOptions(input = {}) {
  record(input, 'options', new Set(['grid_step_m', 'allow_rotation', 'strategy']));
  const step = input.grid_step_m === undefined ? 0.5 : input.grid_step_m;
  if (!Number.isFinite(step) || step < 0.1 || step > 5) fail('options.grid_step_m', 'must be a number from 0.1 to 5 metres');
  const rotate = input.allow_rotation === undefined ? true : input.allow_rotation;
  if (typeof rotate !== 'boolean') fail('options.allow_rotation', 'must be boolean');
  const strategy = input.strategy === undefined ? 'COMPARE' : input.strategy;
  if (!['COMPARE', 'INPUT_ORDER', 'LARGEST_FIRST'].includes(strategy)) fail('options.strategy', 'unsupported strategy');
  return Object.freeze({ grid_step_m: step, allow_rotation: rotate, strategy });
}

export function plannerGeometry(placement, model, clearance) {
  const footprint = rackFootprint(model, placement);
  const bands = rackClearanceBands(placement, model, clearance);
  return { placement, geometry: { type: 'Polygon', coordinates: [[...footprint.cornersM, footprint.cornersM[0]]] },
    bands: bands.map(b => b.geometry), bounds: footprint.boundsM };
}

function* posesFor(rack, model, boundary, clearance, options) {
  const rotations = options.allow_rotation ? [rack.rotationDeg, ...[0, 90, 180, 270].filter(r => r !== rack.rotationDeg)] : [rack.rotationDeg];
  const outer = boundary.coordinates[0];
  const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  const extents = rotations.map(rotationDeg => {
    const p = { ...rack, xM: 0, yM: 0, rotationDeg };
    const shape = plannerGeometry(p, model, clearance);
    const points = [shape.geometry, ...shape.bands].flatMap(g => g.coordinates[0]);
    const x0 = Math.max(-10000, minX - Math.min(...points.map(p => p[0])));
    const y0 = Math.max(-10000, minY - Math.min(...points.map(p => p[1])));
    const x1 = Math.min(10000, maxX - Math.max(...points.map(p => p[0])));
    const y1 = Math.min(10000, maxY - Math.max(...points.map(p => p[1])));
    return { rotationDeg, x0, y0, nx: Math.floor((x1 - x0) / options.grid_step_m) + 1,
      ny: Math.floor((y1 - y0) / options.grid_step_m) + 1 };
  }).filter(e => e.nx > 0 && e.ny > 0);
  const nx = Math.max(0, ...extents.map(e => e.nx));
  const ny = Math.max(0, ...extents.map(e => e.ny));
  // The envelope only proposes positions. The geometry adapter must check the
  // complete Polygon and every hole; the envelope is never a feasibility test.
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) for (const e of extents) {
    if (ix >= e.nx || iy >= e.ny) continue;
    const xM = e.x0 + ix * options.grid_step_m;
    const yM = e.y0 + iy * options.grid_step_m;
    yield plannerGeometry({ ...rack, xM, yM, rotationDeg: e.rotationDeg }, model, clearance);
  }
}

const shapeBounds = geometry => {
  const points = geometry.coordinates[0];
  return { minX: Math.min(...points.map(p=>p[0])), maxX: Math.max(...points.map(p=>p[0])),
    minY: Math.min(...points.map(p=>p[1])), maxY: Math.max(...points.map(p=>p[1])) };
};
const unionBounds = bounds => ({ minX: Math.min(...bounds.map(b=>b.minX)), maxX: Math.max(...bounds.map(b=>b.maxX)),
  minY: Math.min(...bounds.map(b=>b.minY)), maxY: Math.max(...bounds.map(b=>b.maxY)) });
const occupiedBounds = shape => unionBounds([shape.bounds,...shape.bands.map(shapeBounds)]);
const sizeKey = model => `${model.widthM}:${model.depthM}`;
const boundsDistance = (a,b) => Math.hypot(Math.max(0,a.minX-b.maxX,b.minX-a.maxX),
  Math.max(0,a.minY-b.maxY,b.minY-a.maxY));
// These shapes are rectangles at quarter turns. Reject only definite interior
// overlap, with a conservative tolerance for rotation roundoff; PostGIS still
// decides boundary/obstacle contact, holes and complete candidate validity.
const overlaps = (a,b) => Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)>1e-8 &&
  Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY)>1e-8;

function adjacentPoses(rack, model, boundary, clearance, options, placed, catalog) {
  const room = shapeBounds(boundary);
  if (!placed.length) {
    const seed=plannerGeometry(rack,model,clearance), b=occupiedBounds(seed);
    return b.minX>=room.minX && b.maxX<=room.maxX && b.minY>=room.minY && b.maxY<=room.maxY ? [seed] : [];
  }
  const core = unionBounds(placed.map(p=>p.bounds));
  const fixed = placed.map(p=>({shape:p,extent:occupiedBounds(p),bands:p.bands.map(shapeBounds)}));
  // Group by physical dimensions, including different catalog models of the
  // same size. Locks stay exact; matching-size neighbours are a soft preference.
  const peers = placed.filter(p=>sizeKey(catalog.get(p.placement.modelId))===sizeKey(model));
  const rotations = options.allow_rotation ? [rack.rotationDeg,...[0,90,180,270].filter(r=>r!==rack.rotationDeg)] : [rack.rotationDeg];
  const seen = new Set(), candidates = [];
  const gap = Math.min(.2,options.grid_step_m);
  for (const rotationDeg of rotations) {
    const origin = plannerGeometry({...rack,xM:0,yM:0,rotationDeg},model,clearance);
    const extent = occupiedBounds(origin);
    for (const anchor of fixed) {
      const a = anchor.shape.placement, b = anchor.extent;
      const positions = [
        [b.minX-extent.maxX-gap,a.yM], [b.maxX-extent.minX+gap,a.yM],
        [a.xM,b.minY-extent.maxY-gap], [a.xM,b.maxY-extent.minY+gap],
      ];
      for (const [direction,[xM,yM]] of positions.entries()) {
        if (Math.abs(xM)>10000 || Math.abs(yM)>10000) continue;
        const key = `${rotationDeg}:${xM.toFixed(8)}:${yM.toFixed(8)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (xM+extent.minX<room.minX || xM+extent.maxX>room.maxX || yM+extent.minY<room.minY || yM+extent.maxY>room.maxY) continue;
        const shape = plannerGeometry({...rack,xM,yM,rotationDeg},model,clearance);
        const bands = shape.bands.map(shapeBounds);
        if (fixed.some(p=>overlaps(shape.bounds,p.shape.bounds) || p.bands.some(b=>overlaps(shape.bounds,b)) || bands.some(b=>overlaps(b,p.shape.bounds)))) continue;
        const next = unionBounds([core,shape.bounds]);
        // Extend aligned rows, but start another row before creating a long
        // one-rack-wide strip. Existing wide fixed clusters are not penalized.
        const stretched=(next.maxX-next.minX)/(next.maxY-next.minY)>Math.max(2,(core.maxX-core.minX)/(core.maxY-core.minY));
        candidates.push({shape, aligned: rotationDeg!==a.rotationDeg ? 2 : direction<2 ? (stretched?1:0) : (stretched?0:1),
          sizeDistance:peers.length ? Math.min(...peers.map(p=>boundsDistance(shape.bounds,p.bounds))) : 0,
          area:(next.maxX-next.minX)*(next.maxY-next.minY),
          distance:Math.hypot(xM-(core.minX+core.maxX)/2,yM-(core.minY+core.maxY)/2)});
      }
    }
  }
  candidates.sort((a,b)=>a.aligned-b.aligned || Math.round(a.sizeDistance*1e8)-Math.round(b.sizeDistance*1e8) || a.area-b.area || a.distance-b.distance ||
    a.shape.placement.yM-b.shape.placement.yM || a.shape.placement.xM-b.shape.placement.xM || a.shape.placement.rotationDeg-b.shape.placement.rotationDeg);
  return candidates.map(c=>c.shape);
}

export function layoutMetrics(placements, models, previous) {
  const catalog = new Map(models.map(m => [m.modelId, m]));
  const footprints = placements.map(p => rackFootprint(catalog.get(p.modelId), p).boundsM);
  const spanX = footprints.length ? Math.max(...footprints.map(b => b.maxX)) - Math.min(...footprints.map(b => b.minX)) : 0;
  const spanY = footprints.length ? Math.max(...footprints.map(b => b.maxY)) - Math.min(...footprints.map(b => b.minY)) : 0;
  const old = new Map(previous.map(p => [p.rackId, p]));
  return { envelopeAreaM2: spanX * spanY, spanXM: spanX, spanYM: spanY,
    movedRacks: placements.filter(p => ['xM', 'yM', 'rotationDeg'].some(k => p[k] !== old.get(p.rackId)?.[k])).length,
    movementM: placements.reduce((n, p) => n + Math.hypot(p.xM - old.get(p.rackId).xM, p.yM - old.get(p.rackId).yM), 0) };
}

/** Deterministic bounded greedy search. pickPosition is an injected authoritative
 * geometry adapter returning the first acceptable index, or null. No IO here. */
export async function generateRackOptions({ placements, models, boundary, constraints, options: input, pickPosition }) {
  const options = normalizePlannerOptions(input);
  const movable = placements.filter(p => !p.locked);
  if (movable.length > PLANNER_LIMITS.movableRacks) fail('placements', 'planner supports at most 64 movable racks; lock others first');
  if (placements.length === 0) fail('placements', 'add racks before generating options');
  const catalog = new Map(models.map(m => [m.modelId, m]));
  const strategies = options.strategy === 'COMPARE' ? ['INPUT_ORDER', 'LARGEST_FIRST'] : [options.strategy];
  const results = [];
  for (const strategy of strategies) {
    // Complete each size group before starting another, avoiding interleaved
    // large/small additions even when saved UUID order alternates dimensions.
    const groups = new Map();
    for (const rack of movable) {
      const key=sizeKey(catalog.get(rack.modelId));
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(rack);
    }
    const orderedGroups=[...groups.values()];
    if (strategy === 'LARGEST_FIRST') {
      orderedGroups.sort((a,b)=>{
        const ma=catalog.get(a[0].modelId), mb=catalog.get(b[0].modelId);
        return mb.widthM*mb.depthM-ma.widthM*ma.depthM || mb.widthM-ma.widthM || mb.depthM-ma.depthM;
      });
      for (const group of orderedGroups) group.sort((a,b)=>a.rackId<b.rackId?-1:a.rackId>b.rackId?1:0);
    }
    const queue=orderedGroups.flat();
    const placed = placements.filter(p => p.locked).map(p => plannerGeometry(p, catalog.get(p.modelId), constraints.clearance));
    const chosen = new Map(placed.map(g => [g.placement.rackId, g.placement]));
    // Identical model/orientation searches enumerate identical geometry. Once a
    // pose is rejected it remains rejected as placed only grows. Continue that
    // stream for the next rack instead of spending its budget on the same prefix.
    // Keep the unexamined suffix: the adapter returns only the FIRST valid pose.
    const searches = new Map();
    const unplaced = [];
    let submitted = 0;
    for (const rack of queue) {
      const key = `${rack.modelId}:${rack.rotationDeg}`;
      if (!searches.has(key)) searches.set(key, {
        iterator: posesFor(rack, catalog.get(rack.modelId), boundary, constraints.clearance, options), pending: [], exhausted: false,
      });
      const search = searches.get(key);
      let found = null, rackSubmitted = 0, exhausted = false;
      // Grow rows around the fixed/placed cluster before searching the room grid.
      // These are freshly ranked for every rack; successful placement changes
      // the compact envelope and creates new adjacent row-extension positions.
      const nearby = adjacentPoses(rack,catalog.get(rack.modelId),boundary,constraints.clearance,options,placed,catalog);
      for (let offset=0;offset<nearby.length && !found && rackSubmitted<PLANNER_LIMITS.posesPerRack && submitted<PLANNER_LIMITS.posesPerOption;) {
        // Ranked neighbours usually succeed near the front. Avoid submitting a
        // full room-grid batch against every fixed rack just to use its first pose.
        const count=Math.min(32,PLANNER_LIMITS.batchSize,nearby.length-offset,PLANNER_LIMITS.posesPerRack-rackSubmitted,PLANNER_LIMITS.posesPerOption-submitted);
        const batch=nearby.slice(offset,offset+count);offset+=count;
        rackSubmitted+=count;submitted+=count;
        const index=await pickPosition(batch,placed);
        if (index!==null) {
          if (!Number.isInteger(index)||index<0||index>=batch.length) throw new Error('Invalid planner geometry adapter result');
          found=batch[index];
        }
      }
      while (!found && rackSubmitted < PLANNER_LIMITS.posesPerRack && submitted < PLANNER_LIMITS.posesPerOption) {
        const batch = [];
        const count = Math.min(PLANNER_LIMITS.batchSize, PLANNER_LIMITS.posesPerRack - rackSubmitted, PLANNER_LIMITS.posesPerOption - submitted);
        for (let i = 0; i < count; i++) {
          const next = search.pending.length ? { value: search.pending.shift(), done: false } : search.iterator.next();
          if (next.done) { search.exhausted = true; break; }
          const pose = next.value;
          batch.push({ ...pose, placement: { ...rack, xM: pose.placement.xM, yM: pose.placement.yM, rotationDeg: pose.placement.rotationDeg } });
        }
        exhausted = search.exhausted;
        if (!batch.length) break;
        submitted += batch.length; rackSubmitted += batch.length;
        const index = await pickPosition(batch, placed);
        if (index !== null) {
          if (!Number.isInteger(index) || index < 0 || index >= batch.length) throw new Error('Invalid planner geometry adapter result');
          found = batch[index];
          search.pending.unshift(...batch.slice(index + 1));
        }
        if (exhausted) break;
      }
      if (!found) {
        unplaced.push({ rackId: rack.rackId, code: exhausted ? 'NO_GRID_POSITION' : 'SEARCH_LIMIT', positionsSubmitted: rackSubmitted,
          message: exhausted ? 'No accepted position on this grid given earlier placements. This is not proof of infeasibility.'
            : 'Search budget reached; try a coarser grid, fewer unlocked racks or different constraints.' });
        // Keep all original identities and equipment mappings in partial previews.
        // Such previews are blocked from staging, and still receive full checks.
        found = plannerGeometry(rack, catalog.get(rack.modelId), constraints.clearance);
      }
      placed.push(found); chosen.set(rack.rackId, found.placement);
    }
    const next = placements.map(p => chosen.get(p.rackId));
    results.push({ algorithmId: strategy === 'INPUT_ORDER' ? 'row-scan-v1' : 'largest-first-v1', strategy,
      options, placements: next, unplaced, positionsSubmitted: submitted, metrics: layoutMetrics(next, models, placements) });
  }
  return results;
}
