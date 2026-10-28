export function rackCorners(rack, model) {
  const [cos, sin] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ][rack.rotationDeg / 90];
  return [
    [-model.widthM / 2, -model.depthM / 2],
    [model.widthM / 2, -model.depthM / 2],
    [model.widthM / 2, model.depthM / 2],
    [-model.widthM / 2, model.depthM / 2],
  ].map(([x, y]) => [rack.xM + x * cos - y * sin, rack.yM + x * sin + y * cos]);
}
export function beginLayoutDraft(layout) {
  return {
    planId: layout.planId,
    baseVersion: layout.version,
    snapshotId: layout.snapshot.snapshotId,
    placements: layout.placements.map((item) => ({ ...item })),
    attempt: null,
  };
}
export function layoutCheckBody(draft) {
  return { contract_version: 1, snapshot_id: draft.snapshotId, placements: draft.placements };
}
export function validateEditorPlacements(placements) {
  if (placements.length > 256) return 'A layout supports at most 256 racks.';
  if (
    placements.some(
      (p) =>
        !p.name.trim() ||
        p.name.length > 160 ||
        !Number.isFinite(p.xM) ||
        !Number.isFinite(p.yM) ||
        Math.abs(p.xM) > 10000 ||
        Math.abs(p.yM) > 10000 ||
        ![0, 90, 180, 270].includes(p.rotationDeg),
    )
  ) {
    return 'Each rack needs a name and finite coordinates within ±10000 m.';
  }
  return null;
}
