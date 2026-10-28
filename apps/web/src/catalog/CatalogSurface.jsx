import { useState } from 'react';
import { usePermission } from '../permissions/usePermission.jsx';
import { RACK_KEYS } from '../generated/permission-keys.js';
import { rackError } from '../rack/rack-plan-state.js';
import { RackElevation } from '../rack/RackEquipment.jsx';
import { useRackCatalog } from './useRackCatalog.js';
import { filterCatalog, modelKey } from './catalog-state.js';
import '../rack/rack.css';
import './catalog.css';

export function CatalogSurface({ client, context, routeState = {} }) {
  const read = usePermission(RACK_KEYS.READ, { projectId: context.projectId });
  const state = useRackCatalog(client, context.projectId, read.allowed === true);
  if (read.pending) return <p role="status">Checking catalog access…</p>;
  if (read.allowed !== true) return <p role="alert">Rack read access is required for this local equipment catalog.</p>;
  if (state.pending) return <p role="status">Reading equipment catalog…</p>;
  if (state.error) return <div role="alert"><p>{rackError(state.error)}</p><button onClick={state.retry}>Retry catalog</button></div>;
  if (!state.data) return <p role="status">Catalog is unavailable.</p>;
  return <CatalogContent key={`${context.projectId}:${routeState.functionId}`} catalog={state.data} functionId={routeState.functionId} />;
}

const value = (v, unit = '') => v === null ? 'Unknown' : `${v}${unit ? ` ${unit}` : ''}`;
export function CatalogContent({ catalog, functionId = 'models' }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('');
  const [selected, setSelected] = useState(null);
  const [exampleId, setExampleId] = useState(catalog.examples[0]?.exampleId);
  const mode = ['technologies', 'examples'].includes(functionId) ? functionId : 'models';
  const items = mode === 'technologies' ? catalog.technologies : catalog.models;
  const field = mode === 'technologies' ? 'slotType' : 'kind';
  const filtered = filterCatalog(items, query, kind, field);
  const m = catalog.models.find((item) => modelKey(item) === selected) ?? catalog.models[0];
  const example = catalog.examples.find((item) => item.exampleId === exampleId);
  return <section className="rack-surface catalog-surface" aria-label="Equipment catalog">
    <div className="rack-heading"><div><h2>Equipment Catalog</h2><p className="rack-muted">{catalog.models.length} model versions · {catalog.technologies.length} technologies · {catalog.catalogRevision}</p></div><span className="catalog-badge">ASSUMED · LOCAL DEMO</span></div>
    <p className="rack-warning">Synthetic examples for Rack planning. Specifications have not been approved as engineering or vendor data. PSU ratings are not device demand.</p>
    {mode === 'examples' ? <>
      <h3>Rule examples</h3><p>These previews use the same equipment checker as saved Rack plans. They do not modify any plan.</p>
      <div className="catalog-example-tabs">{catalog.examples.map((item) => <button key={item.exampleId} aria-pressed={item.exampleId === exampleId} onClick={() => setExampleId(item.exampleId)}>{item.name}</button>)}</div>
      {example && <div className="catalog-columns"><section className="rack-card"><h3>{example.name}</h3><p>{example.description}</p><p role="status">Equipment: {example.equipmentReport.status} · Whole-plan validation: {example.validationState}</p>
        <ul>{example.equipmentReport.diagnostics.map((d, i) => <li key={i}><strong>{d.code}</strong> · {d.message}</li>)}</ul>
        <dl className="catalog-specs">{Object.entries(example.equipmentReport.racks[0].capacities).map(([dimension, c]) => <div key={dimension}><dt>{dimension}</dt><dd>{c.total === null ? `≥ ${c.knownSubtotal} ${c.unit} (unknown total)` : `${c.total} ${c.unit}`} / {value(c.limit, c.unit)} · {c.status}</dd></div>)}</dl>
        <p className="rack-muted">All limits and demands are declared assumptions. Spatial checks, global asset identity, electrical redundancy and thermal simulation are outside this preview.</p>
      </section><RackElevation rack={example.rack} model={example.rackModel} devices={example.equipment.devices} onSelect={() => {}} /></div>}
    </> : <>
      <div className="catalog-filters"><label>Search catalog<input type="search" value={query} placeholder="Name, ID or type" onChange={(e) => setQuery(e.target.value)} /></label><label>Type<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option>{[...new Set(items.map((item) => item[field]))].map((type) => <option key={type} value={type}>{type}</option>)}</select></label><span>{filtered.length} / {items.length} shown</span></div>
      <div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th>Name</th><th>Pinned ID</th><th>Type</th><th>Status / origin</th><th>{mode === 'models' ? 'Rack demand assumptions' : 'Declares'}</th></tr></thead><tbody>{filtered.map((item) => <tr key={`${item.modelId ?? item.technologyId}@${item.version}`}>
        <td>{mode === 'models' ? <button aria-pressed={modelKey(m) === modelKey(item)} onClick={() => setSelected(modelKey(item))}>{item.name}</button> : item.name}</td>
        <td><code>{item.modelId ?? item.technologyId}@{item.version}</code></td><td>{item[field]}</td><td>{item.status} · Local example</td>
        <td>{mode === 'models' ? `${item.specification.heightU} U · ${value(item.specification.weightKg, 'kg')} · ${value(item.specification.powerKw, 'kW power')} · ${value(item.specification.coolingKw, 'kW cooling')}` : Object.entries(item.declares).map(([key, val]) => `${key}: ${val}`).join(' · ')}</td>
      </tr>)}</tbody></table>{!filtered.length && <p role="status">No matching catalog entries.</p>}</div>
      {mode === 'models' && m && <section className="rack-card catalog-model-detail" aria-label="Selected model composition"><h3>{m.name} · {modelKey(m)}</h3><p>{m.note}</p>
        <div className="catalog-columns"><div><h4>Versioned components</h4><ul className="catalog-composition">{m.components.map((part) => {
          const t = catalog.technologies.find((t) => t.technologyId === part.technologyId && t.version === part.version);
          return <li key={`${part.technologyId}@${part.version}`}><strong>{part.quantity} × {t?.name ?? part.technologyId}</strong><span>{part.technologyId}@{part.version} · {t?.slotType}</span></li>;
        })}</ul></div><div><h4>Rack specification provenance</h4><dl className="catalog-specs">{Object.entries(m.fieldSources).map(([key, origin]) => <div key={key}><dt>{key}</dt><dd>{m.specification[key] ?? 'Unknown'} · {origin}</dd></div>)}</dl><p className="rack-muted">{m.source.reference}</p><p>To use this model, open a Rack plan → Edit layout → Equipment → Add from catalog. The model version and demands are saved with the device.</p></div></div>
      </section>}
    </>}
  </section>;
}
