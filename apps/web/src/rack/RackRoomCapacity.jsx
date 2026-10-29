const format = n => n === null ? 'Unknown' : Number(n.toFixed(4)).toLocaleString();
export function RackRoomCapacity({ equipment, report, editable, onChange }) {
  const budget = equipment.roomBudget ?? null, room = report?.roomCapacity;
  const update = patch => { if (editable) onChange({ ...equipment, roomBudget: { ...budget, ...patch } }); };
  return <section className="rack-card rack-room-capacity" aria-label="Room power and cooling budget">
    <h3>Room power & cooling budget</h3>
    <p>This plan’s installed devices across all racks share one assumed room budget. Includes locked racks. This does not reserve Facility capacity or account for other Rack plans in the same room.</p>
    <label><input type="checkbox" checked={Boolean(budget)} disabled={!editable} onChange={e => {
      if (editable) onChange({ ...equipment, roomBudget: e.target.checked ? { maxPowerKw: null, maxCoolingKw: null, source: { kind: 'ASSUMED', reference: 'Room planning budget assumption — record your source.' } } : null });
    }} />Use an assumed room budget for this plan</label>
    {budget && <>
      <label>Room budget reference<textarea value={budget.source.reference} maxLength={512} disabled={!editable}
        onChange={e => update({ source: { kind: 'ASSUMED', reference: e.target.value } })} /></label>
      <div className="rack-form-fields">{[['maxPowerKw','Room power limit (kW)'],['maxCoolingKw','Room cooling limit (kW)']].map(([key,label]) => <label key={key}>{label}
        <input type="number" min="0" max="1000000" step="any" placeholder="Unknown" disabled={!editable} value={Number.isFinite(budget[key]) ? budget[key] : ''}
          onChange={e => update({ [key]: e.target.value === '' ? null : Number(e.target.value) })} /></label>)}</div>
    </>}
    {!budget && <p className="rack-warning">Room budget not recorded. Per-rack checks cannot establish room capacity. Automatic allocation keeps its per-rack-only scope until a room budget is explicitly enabled.</p>}
    {room ? <>
      <p role="status">Room scope: {room.status} · {room.installedDevices} installed · {room.unassignedDevices} unassigned · Inventory coverage: {room.coverage}</p>
      <div className="rack-table-scroll"><table className="rack-input-table"><caption>Installed demand is checked; inventory demand includes unassigned devices for planning</caption>
        <thead><tr><th>Resource (kW)</th><th>Installed demand</th><th>Assumed limit</th><th>Remaining</th><th>Status</th><th>All inventory demand</th></tr></thead>
        <tbody>{[['powerKw','Power'],['coolingKw','Cooling']].map(([key,label]) => { const r = room.resources[key];
          return <tr key={key}><th>{label}</th><td>{r.unknownDevices ? `≥ ${format(r.knownSubtotal)} (${r.unknownDevices} unknown)` : format(r.total)}</td>
            <td>{format(r.limit)}</td><td>{format(r.remaining)}</td><td>{r.status}</td><td>{r.inventory.unknownDevices ? `≥ ${format(r.inventory.knownSubtotal)} (${r.inventory.unknownDevices} unknown)` : format(r.inventory.total)}{r.inventoryExceedsLimit && ' · above budget if all installed'}</td></tr>;
        })}</tbody></table></div>
      {room.diagnostics.length > 0 && <ul>{room.diagnostics.map(d => <li key={d.dimension}>{d.code}: {d.message} ({format(d.knownSubtotal)} / {format(d.limit)} {d.unit})</li>)}</ul>}
    </> : <p>Run the current layout checks to see the room totals.</p>}
    <p className="rack-muted">Null means unknown, zero is explicit. Unknown inventory coverage remains incomplete. Rack idle power, upstream allocations, feed redundancy, airflow, floor loading and engineering validity are outside this check. No global room weight limit is inferred.</p>
  </section>;
}
