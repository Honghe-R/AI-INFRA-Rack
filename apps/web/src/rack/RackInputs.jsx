import { useId, useState } from 'react';
import { INPUT_NODES, INPUT_EDGES, inputImpact, rackInputSummary } from './rack-inputs.js';

export function RackInputs({ layout, placements, constraints, equipment, draft, spatialReport, equipmentReport, onNavigate }) {
  const [selected, setSelected] = useState('room');
  const markerId = useId();
  const summary = rackInputSummary(layout, placements, constraints, equipment, draft);
  const reached = inputImpact(selected);
  const node = id => INPUT_NODES.find(n => n.id === id);
  const source = layout.sourceStatus?.status ?? 'UNKNOWN';
  const facts = {
    room: source,
    racks: `${placements.length} racks · ${placements.filter(p => p.locked).length} locked`,
    rules: `${constraints.obstacles.length} exclusion zones`,
    devices: `${equipment.devices.length} devices · ${summary.assignedDevices} assigned`,
    limits: `${equipment.rackLimits.length} rack overrides`,
    spatial: spatialReport?.status ?? 'Not currently checked',
    equipment: equipmentReport?.status ?? 'Not currently checked',
    save: `Saved v${layout.version}${draft ? ' · draft open' : ''}`,
  };
  return <section className="rack-inputs" aria-label="Rack inputs and change impact">
    <h3>Inputs & impact</h3>
    <p>Trace the selected plan from room geometry to racks, devices and checks. Select a node to highlight downstream consumers.</p>
    <p className={source === 'UNCHANGED' ? 'rack-notice' : 'rack-warning'} role="status">
      Facility source: {source}. {source === 'UNCHANGED'
        ? 'Matches the pinned reference at the last layout read; the server rechecks before saving.'
        : 'New writes are blocked until the source can be reviewed. The fixed room input is retained.'}
      {layout.sourceStatus?.reasons?.length > 0 && ` ${layout.sourceStatus.reasons.join(', ')}`}
    </p>
    <div className="rack-input-picker" aria-label="Inspect input impact">
      {INPUT_NODES.map(n => <button key={n.id} aria-pressed={selected === n.id} onClick={() => setSelected(n.id)}>{n.label}</button>)}
    </div>
    <div className="rack-input-map">
      <svg viewBox="0 0 900 455" role="img" aria-label={`Input dependency map: ${node(selected).label} and downstream consumers`}>
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {INPUT_EDGES.map(([from, to]) => {
          const a = node(from), b = node(to);
          return <path key={`${from}-${to}`} className={reached.has(from) ? 'is-active' : ''} markerEnd={`url(#${markerId})`}
            d={`M ${a.x + 220} ${a.y + 32} C ${a.x + 270} ${a.y + 32}, ${b.x - 50} ${b.y + 32}, ${b.x - 5} ${b.y + 32}`} />;
        })}
        {INPUT_NODES.map(n => <g key={n.id} transform={`translate(${n.x} ${n.y})`} className={`rack-input-node${reached.has(n.id) ? ' is-active' : ''}`}>
          <rect width="220" height="64" rx="8" />
          <text x="12" y="25">{n.label}{summary.changed.includes(n.id) ? ' *' : ''}</text>
          <text className="rack-input-detail" x="12" y="47">{facts[n.id]}</text>
        </g>)}
      </svg>
    </div>
    <div className="rack-card" aria-live="polite">
      <strong>{node(selected).label}</strong>
      <p>Downstream: {INPUT_NODES.filter(n => n.id !== selected && reached.has(n.id)).map(n => n.label).join(', ') || 'No downstream node in this view.'}</p>
      {selected === 'room' ? <a href={`#${markerId}-references`}>View fixed input references</a>
        : <button onClick={() => onNavigate(node(selected).route)}>Open {node(selected).label}</button>}
    </div>
    <p className="rack-muted">Arrows describe input dependencies, not physical cables or a floor map. Highlighting is a conservative impact guide; actual errors come from the server checks. Every save rechecks the entire plan, permissions, source and version.</p>
    <div className="rack-editor-columns">
      <section className="rack-card" aria-label="Draft input changes">
        <h3>Draft compared with saved v{layout.version}</h3>
        {draft && draft.baseVersion !== layout.version && <p className="rack-warning">Version conflict: comparison is against the newly read saved version, not the original draft base v{draft.baseVersion}.</p>}
        {summary.changed.length ? <><ul>{summary.changed.map(id => <li key={id}>{node(id).label} · unsaved changes</li>)}</ul>
          <p>Affected checks: {['spatial', 'equipment'].filter(id => summary.affected.has(id)).map(id => node(id).label).join(', ')}</p></>
          : <p>{draft ? 'No input differences in the current draft.' : 'Viewing saved inputs. No draft is open.'}</p>}
        <p className="rack-muted">Includes metadata and coverage changes; no persistent history or upstream event subscription.</p>
      </section>
      <section id={`${markerId}-references`} className="rack-card" aria-label="Fixed input references">
        <h3>Fixed input references</h3>
        <dl className="rack-facts">
          <dt>Facility revision</dt><dd><code>{layout.facilityInput.revisionId}</code></dd>
          <dt>HALL</dt><dd><code>{layout.facilityInput.containerId}</code></dd>
          <dt>Pinned ETag</dt><dd><code>{layout.facilityInput.revisionEtag}</code></dd>
          <dt>Room snapshot</dt><dd><code>{layout.snapshot.snapshotId}</code></dd>
          <dt>Spatial input coverage</dt><dd>{constraints.obstacleCoverage}</dd>
          <dt>Device inventory coverage</dt><dd>{equipment.coverage}</dd>
          <dt>Whole-plan validation</dt><dd>{layout.validationState}</dd>
        </dl>
      </section>
    </div>
    <section className="rack-card" aria-label="Device model dependencies">
      <h3>Device model versions</h3>
      <p>{summary.customDevices} custom assumption device(s). {summary.pins.reduce((n, pin) => n + pin.count, 0)} catalog-bound device(s).</p>
      {summary.pins.length > 0 ? <div className="rack-table-scroll"><table className="rack-input-table"><thead><tr><th>Model ID</th><th>Pinned version</th><th>Devices</th></tr></thead>
        <tbody>{summary.pins.map(pin => <tr key={JSON.stringify([pin.modelId, pin.version])}><td><code>{pin.modelId}</code></td><td>{pin.version}</td><td>{pin.count}</td></tr>)}</tbody></table></div>
        : <p>No catalog model pins in the current inputs.</p>}
      <p className="rack-muted">Catalog entries are synthetic, version-pinned references checked on save. Custom specs and capacity limits are planning assumptions. Formal room budgets, rebinding and cross-tool Network/Power/Thermal links remain planned.</p>
    </section>
  </section>;
}
