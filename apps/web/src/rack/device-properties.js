import { detachCatalogDevice } from '../catalog/catalog-state.js';

export const deviceSpecificationFields = [
  ['heightU', 'Device height (U)'],
  ['weightKg', 'Device weight (kg)'],
  ['powerKw', 'Device power (kW)'],
  ['coolingKw', 'Device cooling (kW)'],
];

export function confirmDeviceProperties(device, input) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 160) throw new Error('Device name must contain 1–160 characters.');
  const values = {};
  for (const [key] of deviceSpecificationFields) {
    const raw = String(input[key] ?? '').trim();
    const value = raw === '' ? null : Number(raw);
    if (key === 'heightU') {
      if (!Number.isInteger(value) || value < 1 || value > 100)
        throw new Error('Device height must be a whole number from 1 to 100 U.');
    } else if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1000000)) {
      throw new Error('Weight, power and cooling must be from 0 to 1000000; blank means unknown.');
    }
    values[key] = value;
  }
  const changed = deviceSpecificationFields.some(([key]) => values[key] !== device[key]);
  const base = changed && device.catalogRef ? detachCatalogDevice(device) : device;
  return { ...base, name, ...values };
}
