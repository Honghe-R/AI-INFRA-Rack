export function optionStageReason(layout, result, option, { canWrite, draft, confirmed }) {
  if (!canWrite) return 'Read-only access: staging needs rack.write.';
  if (draft) return 'Save or discard the shared draft before using an option.';
  if (!confirmed) return 'Review the preview and confirm before staging.';
  if (layout.sourceStatus.status !== 'UNCHANGED') return 'Facility input changed; review the source.';
  if (!result || result.projectId !== layout.projectId || result.planId !== layout.planId || result.baseVersion !== layout.version ||
    result.snapshotId !== layout.snapshot.snapshotId || Object.keys(layout.facilityInput).some(k => result.facilityInput?.[k] !== layout.facilityInput[k]))
    return 'This option is based on different inputs. Generate again from the saved plan.';
  if (!option || !result.candidates.includes(option) || !option.canStage || option.unplaced.length ||
    option.report.diagnostics.length || option.equipmentReport.diagnostics.length)
    return 'Unplaced racks or check errors must be resolved before staging.';
  return null;
}

export function stageRackOption(layout, result, option, guards) {
  const reason = optionStageReason(layout, result, option, guards);
  if (reason) throw new Error(reason);
  return { planId: layout.planId, baseVersion: result.baseVersion, snapshotId: result.snapshotId,
    placements: structuredClone(option.body.placements), constraints: structuredClone(option.body.constraints),
    equipment: structuredClone(option.body.equipment), attempt: null };
}
