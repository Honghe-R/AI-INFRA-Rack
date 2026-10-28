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
    constraints: structuredClone(layout.constraints ?? defaultEditorConstraints()),
    attempt: null,
  };
}
export function layoutCheckBody(draft) {
  return {
    contract_version: 1,
    snapshot_id: draft.snapshotId,
    placements: draft.placements,
    ...(draft.constraints ? { constraints: draft.constraints } : {}),
  };
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
export function defaultEditorConstraints() {
  return {
    obstacleCoverage: 'UNKNOWN',
    source: { kind: 'ASSUMED', reference: 'Planning inputs not recorded.' },
    obstacles: [],
    clearance: null,
  };
}
export function validateEditorConstraints(c) {
  if (
    !c ||
    !['UNKNOWN', 'DECLARED_COMPLETE'].includes(c.obstacleCoverage) ||
    c.source?.kind !== 'ASSUMED' ||
    !c.source.reference?.trim() ||
    c.source.reference.length > 512
  )
    return 'Record the planning input reference (1–512 characters) and obstacle coverage.';
  if (!Array.isArray(c.obstacles) || c.obstacles.length > 64)
    return 'At most 64 planning obstacles are supported.';
  if (
    c.obstacles.some(
      (o) =>
        !o.name.trim() ||
        o.name.length > 160 ||
        !Number.isFinite(o.xM) ||
        !Number.isFinite(o.yM) ||
        Math.abs(o.xM) > 10000 ||
        Math.abs(o.yM) > 10000 ||
        ![o.widthM, o.depthM].every((v) => Number.isFinite(v) && v >= 0.001 && v <= 10000),
    )
  ) {
    return 'Each obstacle needs a name, finite centre coordinates within ±10000 m, and dimensions from 0.001 to 10000 m.';
  }
  if (
    c.clearance !== null &&
    ![c.clearance.frontM, c.clearance.rearM].every((v) => Number.isFinite(v) && (v===0 || v>=.001) && v <= 10)
  )
    return 'Front and rear maintenance distances must be zero or from 0.001 to 10 m.';
  return null;
}
export function displayClearanceBands(rack, model, clearance) {
  if (!clearance || !Number.isFinite(rack.xM) || !Number.isFinite(rack.yM)) return [];
  const [cos, sin] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ][rack.rotationDeg / 90];
  return [
    ['FRONT', clearance.frontM, -1],
    ['REAR', clearance.rearM, 1],
  ]
    .filter(([, d]) => Number.isFinite(d) && d >= .001 && d <= 10)
    .map(([side, d, sign]) => ({
      side,
      points: [
        [-model.widthM / 2, sign < 0 ? -model.depthM / 2 - d : model.depthM / 2],
        [model.widthM / 2, sign < 0 ? -model.depthM / 2 - d : model.depthM / 2],
        [model.widthM / 2, sign < 0 ? -model.depthM / 2 : model.depthM / 2 + d],
        [-model.widthM / 2, sign < 0 ? -model.depthM / 2 : model.depthM / 2 + d],
      ].map(([x, y]) => [rack.xM + x * cos - y * sin, rack.yM + x * sin + y * cos]),
    }));
}
