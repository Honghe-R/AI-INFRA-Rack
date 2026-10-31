// Browser-only serialization of the API report. Domain checking stays server-side.
export function assertRackReportScope(report, layout) {
  const data = report?.layout;
  if (report?.contractVersion !== 1 || report.kind !== 'RACK_PLANNING_REPORT' ||
    data?.projectId !== layout.projectId || data?.planId !== layout.planId ||
    data?.version !== layout.version || data?.snapshot?.snapshotId !== layout.snapshot?.snapshotId)
    throw new Error('The saved plan changed or the report scope does not match. Reload the plan before downloading.');
  return report;
}
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Excel/Sheets may interpret even quoted user labels as formulas.
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function rackInventoryCsv(report) {
  const { layout } = report, racks = new Map(layout.placements.map(r => [r.rackId, r]));
  const headers = ['project_id', 'plan_id', 'saved_version', 'snapshot_id', 'device_id', 'device_name', 'assignment',
    'rack_id', 'rack_name', 'start_u', 'end_u', 'height_u', 'weight_kg', 'power_kw', 'cooling_kw', 'catalog_model_id', 'catalog_version'];
  const rows = layout.equipment.devices.map(d => [layout.projectId, layout.planId, layout.version, layout.snapshot?.snapshotId,
    d.deviceId, d.name, d.rackId === null ? 'UNASSIGNED' : 'INSTALLED', d.rackId, racks.get(d.rackId)?.name,
    d.startU, d.startU === null ? null : d.startU + d.heightU - 1, d.heightU, d.weightKg, d.powerKw, d.coolingKw,
    d.catalogRef?.modelId, d.catalogRef?.version]);
  return '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function downloadRackFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function savedCheckBlockReason(layout, draft, canWrite) {
  if (!canWrite) return 'Recording requires Rack edit permission.';
  if (draft) return 'Save or discard your draft before recording saved checks.';
  if (!layout.snapshot) return 'Capture the room input first.';
  if (layout.sourceStatus.status !== 'UNCHANGED') return 'Facility inputs changed. Refresh inputs before recording checks.';
  return null;
}
