import { useState } from 'react';
import { RackRoomCapacity } from './RackRoomCapacity.jsx';
import { deviceFromCatalog, detachCatalogDevice, modelKey } from '../catalog/catalog-state.js';
import { MAX_EQUIPMENT_DEVICES } from './limits.generated.js';
import { RackBulkRemoval } from './RackBulkRemoval.jsx';
import { bulkRemoval } from './bulk-removal.js';
import { RackCapacityCatalog } from './RackCapacityCatalog.jsx';
import { applyRackCapacityTemplate } from './capacity-catalog.js';

const dimensions = [
  ['weightKg', 'maxWeightKg', 'Weight', 'kg'],
  ['powerKw', 'maxPowerKw', 'Power', 'kW'],
  ['coolingKw', 'maxCoolingKw', 'Cooling', 'kW'],
];
const numeric = (v) => (v === '' ? NaN : Number(v));
const optional = (v) => (v === '' ? null : Number(v));
const display = (v) => (v === null ? 'Unknown' : Number(v.toFixed(4)).toString());

export function RackElevation({ rack, model, devices, selectedId, onSelect, readOnly = false }) {
  if (!rack || !model) return <p>Select a rack on the floorplan to see its U positions.</p>;
  // Server catalog is bounded separately; avoid an unbounded DOM for a future model.
  if (!Number.isInteger(model.heightU) || model.heightU < 1 || model.heightU > 100)
    return <p>Elevation supports rack models from 1–100 U.</p>;
  return (
    <section className="rack-elevation" aria-label={`${rack.name} U elevation`}>
      <h4>
        {rack.name} · {model.heightU}U
      </h4>
      <p className="rack-muted">Front schematic · U1 at the bottom · Full-width devices only</p>
      <div className="rack-u-slots">
        {Array.from({ length: model.heightU }, (_, i) => model.heightU - i).map((u) => {
          const occupants = devices.filter(
            (d) =>
              d.rackId === rack.rackId &&
              Number.isInteger(d.startU) &&
              Number.isInteger(d.heightU) &&
              u >= d.startU &&
              u < d.startU + d.heightU,
          );
          return (
            <div className={`rack-u-slot${occupants.length > 1 ? ' has-issue' : ''}`} key={u}>
              <span>U{u}</span>
              <div>
                {occupants.length ? (
                  occupants.map((d) => (
                    <button
                      key={d.deviceId}
                      disabled={readOnly}
                      aria-pressed={selectedId === d.deviceId}
                      onClick={() => onSelect(d.deviceId)}
                    >
                      {d.name}
                    </button>
                  ))
                ) : (
                  <span className="rack-u-empty">Free</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function RackEquipment({
  equipment: e,
  placements,
  models,
  editable,
  selectedRackId,
  onSelectRack,
  onChange,
  report,
  pending,
  inputError,
  checkError,
  catalogState = null,
  mode = 'all',
}) {
  const [selectedId, setSelectedId] = useState(null);
  const [catalogId, setCatalogId] = useState('');
  const catalog = catalogState?.data;
  const catalogModel = catalog?.models.find((item) => modelKey(item) === catalogId) ?? catalog?.models[0];
  const d = e.devices.find((item) => item.deviceId === selectedId);
  const rack = placements.find((p) => p.rackId === selectedRackId);
  const model = models.find((m) => m.modelId === rack?.modelId);
  const summary = report?.racks.find((r) => r.rackId === selectedRackId);
  const limit = e.rackLimits.find((l) => l.rackId === selectedRackId);
  const patch = (value) => {
    if (editable) onChange({ ...e, ...value });
  };
  const patchDevice = (value) =>
    patch({
      devices: e.devices.map((item) => (item.deviceId === selectedId ? { ...item, ...value } : item)),
    });
  function selectDevice(id) {
    setSelectedId(id);
    const item = e.devices.find((item) => item.deviceId === id);
    if (item?.rackId) onSelectRack(item.rackId);
  }
  return (
    <section className="rack-card rack-equipment" aria-label="Equipment and capacity">
      <h3>{mode === 'capacity' ? 'Rack capacity' : mode === 'diagnostics' ? 'Equipment checks' : mode === 'equipment' ? 'Equipment & U positions' : 'Equipment & capacity'}</h3>
      <p className="rack-muted">
        Plan-local assumed specifications, not a global asset registry. Blank demand/limit means unknown; zero
        is explicit. Changes save together with the layout.
      </p>
      {['all','capacity'].includes(mode) && <RackRoomCapacity equipment={e} report={report} editable={editable} onChange={onChange} />}
      <div hidden={mode === 'diagnostics'}>
      <label>
        Equipment planning reference
        <textarea
          value={e.source.reference}
          maxLength={512}
          disabled={!editable}
          onChange={(event) =>
            patch({
              source: { kind: 'ASSUMED', reference: event.target.value },
            })
          }
        />
      </label>
      <label>
        Equipment inventory coverage
        <select
          value={e.coverage}
          disabled={!editable}
          onChange={(event) => patch({ coverage: event.target.value })}
        >
          <option value="UNKNOWN">Unknown — additional equipment may exist</option>
          <option value="DECLARED_COMPLETE">
            I declare this plan inventory complete for this assumption
          </option>
        </select>
      </label>
      <div hidden={mode === 'capacity'} data-equipment-panel="devices">
      <div className="rack-actions">
        <h4>Devices · {e.devices.length}/{MAX_EQUIPMENT_DEVICES}</h4>
        <button
          disabled={!editable || e.devices.length >= MAX_EQUIPMENT_DEVICES}
          onClick={() => {
            const deviceId = crypto.randomUUID();
            patch({
              devices: [
                ...e.devices,
                {
                  deviceId,
                  name: `Device ${e.devices.length + 1}`,
                  heightU: 1,
                  weightKg: null,
                  powerKw: null,
                  coolingKw: null,
                  rackId: null,
                  startU: null,
                },
              ],
            });
            setSelectedId(deviceId);
          }}
        >
          Add device
        </button>
      </div>
      <fieldset className="rack-catalog-picker">
        <legend>Versioned equipment catalog</legend>
        {catalogState?.pending ? <p role="status">Reading model specifications…</p> : catalogState?.error ?
          <div role="alert"><p>Catalog could not be loaded. Custom device entry remains available.</p><button onClick={catalogState.retry}>Retry catalog</button></div> : catalog ? <>
          <label>Equipment model<select value={catalogModel ? modelKey(catalogModel) : ''} disabled={!editable} onChange={(event) => setCatalogId(event.target.value)}>
            {catalog.models.map((item) => <option key={modelKey(item)} value={modelKey(item)}>{item.name} · v{item.version}</option>)}
          </select></label>
          {catalogModel && <p className="rack-muted">ASSUMED · {catalogModel.specification.heightU} U · {display(catalogModel.specification.weightKg)} kg · {display(catalogModel.specification.powerKw)} kW power · {display(catalogModel.specification.coolingKw)} kW cooling. Unknown values stay unknown.</p>}
          <button disabled={!editable || !catalogModel || e.devices.length >= MAX_EQUIPMENT_DEVICES} onClick={() => {
            if (!editable || !catalogModel || e.devices.length >= MAX_EQUIPMENT_DEVICES) return;
            const deviceId = crypto.randomUUID();
            patch({ devices: [...e.devices, deviceFromCatalog(catalogModel, deviceId)] });
            setSelectedId(deviceId);
          }}>Add from catalog</button>
          <p className="rack-muted">Creates an unassigned device in this draft. Choose its rack and starting U, then save the layout.</p>
        </> : <p className="rack-muted">Catalog unavailable. Devices can still use explicit custom assumptions.</p>}
      </fieldset>
      <RackBulkRemoval kind="devices" placements={placements} equipment={e} editable={editable} onApply={ids => {
        if (!editable) throw new Error('This draft is not editable.');
        const result = bulkRemoval({ kind: 'devices', ids, placements, equipment: e });
        onChange(result.equipment);
        if (ids.includes(selectedId)) setSelectedId(null);
      }} />
      <label>
        Selected device
        <select value={d?.deviceId ?? ''} onChange={(event) => selectDevice(event.target.value)}>
          <option value="">Choose a device</option>
          {e.devices.map((item) => (
            <option key={item.deviceId} value={item.deviceId}>
              {item.name} ·{' '}
              {item.rackId
                ? (placements.find((p) => p.rackId === item.rackId)?.name ?? 'Missing rack')
                : 'Unassigned'}
            </option>
          ))}
        </select>
      </label>
      {d && (
        <div className="rack-device-form">
          <p className="rack-muted">Device ID: {d.deviceId}</p>
          {d.catalogRef && <div className="rack-catalog-binding"><p>Pinned model: <code>{d.catalogRef.modelId}@{d.catalogRef.version}</code> · ASSUMED local catalog</p>
            <p className="rack-muted">Specifications are fixed to this version. Name and U assignment remain editable.</p>
            <button disabled={!editable} onClick={() => patch({ devices: e.devices.map((item) => item.deviceId === d.deviceId ? detachCatalogDevice(item) : item) })}>Detach to custom assumptions</button>
          </div>}
          <label>
            Device name
            <input
              value={d.name}
              maxLength={160}
              disabled={!editable}
              onChange={(event) => patchDevice({ name: event.target.value })}
            />
          </label>
          <div className="rack-form-fields">
            <label>
              Device height (U)
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                value={Number.isFinite(d.heightU) ? d.heightU : ''}
                disabled={!editable || Boolean(d.catalogRef)}
                onChange={(event) => patchDevice({ heightU: numeric(event.target.value) })}
              />
            </label>
            {dimensions.map(([key, , label, unit]) => (
              <label key={key}>
                Device {label.toLowerCase()} ({unit})
                <input
                  type="number"
                  min="0"
                  max="1000000"
                  step="any"
                  placeholder="Unknown"
                  value={Number.isFinite(d[key]) ? d[key] : ''}
                  disabled={!editable || Boolean(d.catalogRef)}
                  onChange={(event) => patchDevice({ [key]: optional(event.target.value) })}
                />
              </label>
            ))}
          </div>
          <div className="rack-form-fields">
            <label>
              Assigned rack
              <select
                value={d.rackId ?? ''}
                disabled={!editable}
                onChange={(event) => {
                  const id = event.target.value || null;
                  patchDevice({
                    rackId: id,
                    startU: id ? (d.startU ?? 1) : null,
                  });
                  if (id) onSelectRack(id);
                }}
              >
                <option value="">Unassigned</option>
                {placements.map((p) => (
                  <option key={p.rackId} value={p.rackId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {d.rackId && (
              <label>
                Starting U
                <input
                  type="number"
                  min="1"
                  max="10000"
                  step="1"
                  value={Number.isFinite(d.startU) ? d.startU : ''}
                  disabled={!editable}
                  onChange={(event) => patchDevice({ startU: numeric(event.target.value) })}
                />
              </label>
            )}
          </div>
          <button
            disabled={!editable}
            onClick={() => {
              patch({
                devices: e.devices.filter((item) => item.deviceId !== selectedId),
              });
              setSelectedId(null);
            }}
          >
            Remove device
          </button>
        </div>
      )}
      </div>
      <label>
        Capacity rack
        <select value={selectedRackId ?? ''} onChange={(event) => onSelectRack(event.target.value || null)}>
          <option value="">Choose a rack</option>
          {placements.map((p) => (
            <option value={p.rackId} key={p.rackId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {rack && (
        <>
          <div hidden={mode === 'equipment'} data-equipment-panel="capacity">
          <h4>{rack.name} capacity limits</h4>
          <RackCapacityCatalog key={rack.rackId} rack={rack} limit={limit} editable={editable} onApply={templateId => {
            if (editable) patch(applyRackCapacityTemplate(e, placements, rack.rackId, templateId));
          }} />
          <label className="rack-lock-field">
            <input
              type="checkbox"
              checked={Boolean(limit)}
              disabled={!editable}
              onChange={(event) =>
                patch({
                  rackLimits: event.target.checked
                    ? [
                        ...e.rackLimits,
                        {
                          rackId: rack.rackId,
                          maxWeightKg: model?.maxWeightKg ?? null,
                          maxPowerKw: model?.maxPowerKw ?? null,
                          maxCoolingKw: model?.maxCoolingKw ?? null,
                        },
                      ]
                    : e.rackLimits.filter((l) => l.rackId !== rack.rackId),
                })
              }
            />
            Use plan-assumed capacity limits
          </label>
          <p className="rack-muted">
            {limit
              ? 'All three limits below use this plan assumption and equipment reference.'
              : 'Using model limits; the demo models have unknown limits.'}{' '}
            Cabinet position lock does not lock equipment assignments.
          </p>
          {limit && (
            <div className="rack-form-fields">
              {dimensions.map(([, key, label, unit]) => (
                <label key={key}>
                  {label} limit ({unit})
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="any"
                    placeholder="Unknown"
                    value={Number.isFinite(limit[key]) ? limit[key] : ''}
                    disabled={!editable}
                    onChange={(event) =>
                      patch({
                        rackLimits: e.rackLimits.map((l) =>
                          l.rackId === rack.rackId ? { ...l, [key]: optional(event.target.value) } : l,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {summary && (
            <div className="rack-capacity-summary">
              <p>
                {summary.occupiedU}/{summary.heightU} U occupied · {summary.freeU} U free · {summary.uStatus}
              </p>
              <div className="rack-table-scroll">
                <table>
                  <caption>{rack.name} capacity summary</caption>
                  <thead>
                    <tr>
                      <th>Dimension</th>
                      <th>Demand</th>
                      <th>Limit</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dimensions.map(([key, , label]) => {
                      const c = summary.capacities[key];
                      return (
                        <tr key={key}>
                          <th>
                            {label} ({c.unit})
                          </th>
                          <td>
                            {c.unknownDevices
                              ? `≥ ${display(c.knownSubtotal)} (${c.unknownDevices} unknown)`
                              : display(c.total)}
                          </td>
                          <td>{display(c.limit)}</td>
                          <td>{c.status}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </div>
          <div hidden={mode === 'capacity'}>
          <RackElevation
            rack={rack}
            model={model}
            devices={e.devices}
            selectedId={selectedId}
            onSelect={selectDevice}
          />
          </div>
        </>
      )}
      </div>
      <div className="rack-equipment-report" aria-label="Equipment diagnostics">
        {inputError ? (
          <p role="alert" className="rack-error">
            {inputError}
          </p>
        ) : pending ? (
          <p role="status">Checking current equipment…</p>
        ) : checkError ? (
          <p role="status">Equipment checks unavailable; use Retry checks above.</p>
        ) : report ? (
          <>
            <p role="status">
              Equipment: {report.status} · {report.installedDevices}/{report.devicesChecked} installed ·{' '}
              {report.unassignedDeviceIds.length} unassigned
            </p>
            {report.coverage === 'UNKNOWN' && (
              <p className="rack-muted">Inventory coverage is unknown; listed demand may be incomplete.</p>
            )}
            <ul>
              {report.diagnostics.map((issue, i) => (
                <li key={i}>
                  <button
                    className="rack-diagnostic"
                    onClick={() => {
                      onSelectRack(issue.rackId);
                      setSelectedId(issue.deviceIds[0] ?? null);
                    }}
                  >
                    {issue.code}: {issue.rackId === null ? 'Room budget' : placements.find((p) => p.rackId === issue.rackId)?.name} ·{' '}
                    {issue.deviceIds
                      .map((id) => e.devices.find((item) => item.deviceId === id)?.name ?? id)
                      .join(' ↔ ')}{' '}
                    · {issue.message}
                  </button>
                </li>
              ))}
            </ul>
            <p className="rack-muted">
              Unchecked: {report.uncheckedRules.join(', ')}. This does not certify power distribution, cooling
              or the whole plan.
            </p>
          </>
        ) : (
          <p role="status">Equipment has not been checked.</p>
        )}
      </div>
    </section>
  );
}
