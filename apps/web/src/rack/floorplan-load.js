import { rackCorners } from './edit-layout-state.js';
import { CANVAS } from './floorplan-view.js';

export function rackGroupCamera(placements, models, roomFit) {
  const points = placements.flatMap((rack) => {
    const model = models.find((m) => m.modelId === rack.modelId);
    if (!model || !Number.isFinite(rack.xM) || !Number.isFinite(rack.yM)) return [];
    return rackCorners(rack, model);
  });
  if (!points.length || !points.flat().every(Number.isFinite)) return null;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
  return { cx: (left + right) / 2, cy: (bottom + top) / 2,
    scale: Math.max(roomFit.scale / 4, Math.min(roomFit.scale * 32,
      (CANVAS.width - 120) / (right - left + 4), (CANVAS.height - 120) / (top - bottom + 4))) };
}

/** Display only. Results are supplied by the current-body server equipment report. */
export function rackLoadDisplay(mode, rackId, report) {
  if (mode === 'layout') return null;
  const rack = report?.racks.find((item) => item.rackId === rackId);
  if (!rack) return { tone: 'unknown', label: 'Not checked' };
  if (mode === 'u') return {
    tone: rack.uStatus === 'ISSUES_FOUND' ? 'issue' : rack.occupiedU / rack.heightU >= 0.8 ? 'high' : 'clear',
    label: `${rack.occupiedU}/${rack.heightU} U`,
  };
  const c = rack.capacities.powerKw;
  const total = c.total === null ? `≥${Number(c.knownSubtotal.toFixed(3))}` : Number(c.total.toFixed(3));
  return { tone: c.status === 'EXCEEDED' ? 'issue' : c.status === 'UNKNOWN' ? 'unknown' :
    c.limit > 0 && c.knownSubtotal / c.limit >= 0.8 ? 'high' : 'clear',
    label: `${total}/${c.limit === null ? '?' : c.limit} kW` };
}
