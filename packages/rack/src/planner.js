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
    const queue = [...movable];
    if (strategy === 'LARGEST_FIRST') queue.sort((a, b) => {
      const ma = catalog.get(a.modelId), mb = catalog.get(b.modelId);
      return mb.widthM * mb.depthM - ma.widthM * ma.depthM || (a.rackId < b.rackId ? -1 : a.rackId > b.rackId ? 1 : 0);
    });
    const placed = placements.filter(p => p.locked).map(p => plannerGeometry(p, catalog.get(p.modelId), constraints.clearance));
    const chosen = new Map(placed.map(g => [g.placement.rackId, g.placement]));
    const unplaced = [];
    let submitted = 0;
    for (const rack of queue) {
      const iterator = posesFor(rack, catalog.get(rack.modelId), boundary, constraints.clearance, options);
      let found = null, rackSubmitted = 0, exhausted = false;
      while (!found && rackSubmitted < PLANNER_LIMITS.posesPerRack && submitted < PLANNER_LIMITS.posesPerOption) {
        const batch = [];
        const count = Math.min(PLANNER_LIMITS.batchSize, PLANNER_LIMITS.posesPerRack - rackSubmitted, PLANNER_LIMITS.posesPerOption - submitted);
        for (let i = 0; i < count; i++) {
          const next = iterator.next();
          if (next.done) { exhausted = true; break; }
          batch.push(next.value);
        }
        if (!batch.length) break;
        submitted += batch.length; rackSubmitted += batch.length;
        const index = await pickPosition(batch, placed);
        if (index !== null) {
          if (!Number.isInteger(index) || index < 0 || index >= batch.length) throw new Error('Invalid planner geometry adapter result');
          found = batch[index];
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
