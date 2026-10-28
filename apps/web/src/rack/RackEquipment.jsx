import { useState } from 'react';

const dimensions = [
  ['weightKg', 'maxWeightKg', 'Weight', 'kg'],
  ['powerKw', 'maxPowerKw', 'Power', 'kW'],
  ['coolingKw', 'maxCoolingKw', 'Cooling', 'kW'],
];
const numeric = (v) => (v === '' ? NaN : Number(v));
const optional = (v) => (v === '' ? null : Number(v));
const display = (v) => (v === null ? 'Unknown' : Number(v.toFixed(4)).toString());

export function RackElevation({ rack, model, devices, selectedId, onSelect }) {
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
}) {
  const [selectedId, setSelectedId] = useState(null);
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
      <h3>Equipment &amp; capacity</h3>
      <p className="rack-muted">
        Plan-local assumed specifications, not a global asset registry. Blank demand/limit means unknown; zero
        is explicit. Changes save together with the layout.
      </p>
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
      <div className="rack-actions">
        <h4>Devices · {e.devices.length}/512</h4>
        <button
          disabled={!editable || e.devices.length >= 512}
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
                disabled={!editable}
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
                  disabled={!editable}
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
          <h4>{rack.name} capacity limits</h4>
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
          <RackElevation
            rack={rack}
            model={model}
            devices={e.devices}
            selectedId={selectedId}
            onSelect={selectDevice}
          />
        </>
      )}
      <div className="rack-equipment-report" aria-label="Equipment diagnostics">
        {inputError ? (
          <p role="alert" className="rack-error">
            {inputError}
          </p>
        ) : pending ? (
          <p role="status">Checking current equipment…</p>
        ) : checkError ? (
          <p role="status">Equipment checks unavailable; retry the layout checks below.</p>
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
                    {issue.code}: {placements.find((p) => p.rackId === issue.rackId)?.name} ·{' '}
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
