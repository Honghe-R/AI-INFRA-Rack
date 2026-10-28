import { record, fail } from './input.js';
import { createRackPlacement, createRackModel } from './model.js';
import { rackFootprint } from './geometry.js';

/** Shared request normalization and footprints. Polygon topology is evaluated
 * by the authoritative PostGIS adapter, not by a bounding-box approximation. */
export function normalizeEditableLayout({ placements, models, projectId, planId }) {
  if (!Array.isArray(placements) || placements.length > 256)
    fail('placements', 'must be an array of at most 256 racks');
  const catalog = new Map(
    models.map((input) => {
      const model = createRackModel(input);
      return [model.modelId, model];
    }),
  );
  const ids = new Set();
  return Array.from(placements, (input, index) => {
    record(
      input,
      `placements[${index}]`,
      new Set(['rackId', 'modelId', 'name', 'xM', 'yM', 'rotationDeg', 'locked']),
    );
    const placement = createRackPlacement({ ...input, projectId, planId });
    if (ids.has(placement.rackId)) fail('rackId', 'must be unique within the layout');
    ids.add(placement.rackId);
    if (Math.abs(placement.xM) > 10000 || Math.abs(placement.yM) > 10000)
      fail('position', 'must be within ±10000 metres');
    const model = catalog.get(placement.modelId);
    if (!model) fail('modelId', 'must reference the server catalog');
    const footprint = rackFootprint(model, placement);
    return { placement, footprint };
  });
}

/** A locked rack must be explicitly unlocked in its own saved revision before
 * moving, replacing or deleting it; unrelated rack edits remain allowed. */
export function assertLockedRacksUnchanged(previous, next) {
  const byId = new Map(next.map((item) => [item.rackId, item]));
  for (const old of previous.filter((item) => item.locked)) {
    const item = byId.get(old.rackId);
    if (!item || ['modelId', 'xM', 'yM', 'rotationDeg'].some((key) => item[key] !== old[key])) {
      fail('locked', `unlock and save rack ${old.rackId} before moving, changing model or deleting it`);
    }
  }
}
