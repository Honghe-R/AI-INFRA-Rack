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
    equipment: structuredClone(layout.equipment ?? defaultEditorEquipment()),
    attempt: null,
  };
}
export function layoutCheckBody(draft) {
  return {
    contract_version: 1,
    snapshot_id: draft.snapshotId,
    placements: draft.placements,
    ...(draft.constraints ? { constraints: draft.constraints } : {}),
    ...(draft.equipment ? { equipment: draft.equipment } : {}),
  };
}
export function defaultEditorEquipment() {
  return {
    coverage: 'UNKNOWN',
    source: {
      kind: 'ASSUMED',
      reference: 'Equipment planning inputs not recorded.',
    },
    devices: [],
    rackLimits: [],
  };
}
export function validateEditorEquipment(e, placements) {
  if (
    !e ||
    !['UNKNOWN', 'DECLARED_COMPLETE'].includes(e.coverage) ||
    e.source?.kind !== 'ASSUMED' ||
    !e.source.reference?.trim() ||
    e.source.reference.length > 512
  )
    return 'Record the equipment planning reference and inventory coverage.';
  if (
    !Array.isArray(e.devices) ||
    e.devices.length > 512 ||
    !Array.isArray(e.rackLimits) ||
    e.rackLimits.length > 256
  )
    return 'Equipment supports up to 512 devices and 256 rack limits.';
  const quantity = (v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1000000);
  const rackIds = new Set(placements.map((p) => p.rackId));
  for (const d of e.devices) {
    if (
      !d.name.trim() ||
      d.name.length > 160 ||
      !Number.isInteger(d.heightU) ||
      d.heightU < 1 ||
      d.heightU > 100 ||
      ![d.weightKg, d.powerKw, d.coolingKw].every(quantity)
    )
      return 'Each device needs a name, 1–100 U, and non-negative demand values (blank means unknown).';
    if (
      d.rackId !== null &&
      (!rackIds.has(d.rackId) || !Number.isInteger(d.startU) || d.startU < 1 || d.startU > 10000)
    )
      return 'Assigned devices need a rack in this layout and a starting U from 1 to 10000. Unassign before deleting a rack.';
    if (d.rackId === null && d.startU !== null) return 'Unassigned devices must have no starting U.';
  }
  if (new Set(e.devices.map((d) => d.deviceId)).size !== e.devices.length)
    return 'A device may appear only once in the plan inventory.';
  if (
    e.rackLimits.some(
      (l) => !rackIds.has(l.rackId) || ![l.maxWeightKg, l.maxPowerKw, l.maxCoolingKw].every(quantity),
    )
  )
    return 'Capacity limits need a rack in this layout and non-negative values (blank means unknown).';
  return null;
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
    ![c.clearance.frontM, c.clearance.rearM].every(
      (v) => Number.isFinite(v) && (v === 0 || v >= 0.001) && v <= 10,
    )
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
    .filter(([, d]) => Number.isFinite(d) && d >= 0.001 && d <= 10)
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
