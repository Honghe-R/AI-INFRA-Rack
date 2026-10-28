export const modelKey = (model) => `${model.modelId}@${model.version}`;
export function filterCatalog(items, query, kind, field) {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => (!kind || item[field] === kind) &&
    [item.name, item.modelId, item.technologyId, item.kind, item.slotType, item.version]
      .join(' ').toLowerCase().includes(needle));
}
/** A new plan-local identity; model version and copied demands stay pinned. */
export function deviceFromCatalog(model, deviceId) {
  return { deviceId, name: model.name, ...model.specification,
    catalogRef: { modelId: model.modelId, version: model.version }, rackId: null, startU: null };
}
export function detachCatalogDevice(device) {
  const { catalogRef, ...custom } = device;
  return custom;
}
