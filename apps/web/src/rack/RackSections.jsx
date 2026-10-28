import { RACK_SECTIONS } from './rack-sections.js';

const readiness = { AVAILABLE: 'Available', PARTIAL: 'Partial scope', PLANNED: 'Planned' };
export function RackSectionGuide({ onNavigate }) {
  return <section className="rack-section-guide" aria-label="Rack workflow overview">
    <p>Choose a plan → review room inputs → place racks and space rules → assign devices and resources → inspect checks.</p>
    <div className="rack-module-grid">{RACK_SECTIONS.filter((s) => s.functionId !== 'overview').map((s) =>
      <button key={s.functionId} className="rack-module-card" onClick={() => onNavigate(s.functionId)}>
        <span><strong>{s.label}</strong><span className={`rack-module-status is-${s.status.toLowerCase()}`}>{readiness[s.status]}</span></span>
        <span>{s.description}</span>
      </button>)}</div>
    <p className="rack-muted">Partial scope means the listed workflow is available with explicit limitations. Layout options relocate existing racks. Candidate history, persisted dependency history and Rack Assistant tools remain to be implemented.</p>
  </section>;
}

export function RackPlanOverview({ layout, equipment, placements, spatialReport, equipmentReport, onNavigate, isDraft }) {
  return <section className="rack-card" aria-label="Selected plan overview">
    <h3>{isDraft ? 'Current draft' : 'Saved plan'} summary</h3>
    <dl className="rack-overview-stats">
      <div><dt>Racks</dt><dd>{placements.length}</dd></div>
      <div><dt>Devices</dt><dd>{equipment.devices.length}</dd></div>
      <div><dt>Unassigned</dt><dd>{equipment.devices.filter((d) => d.rackId === null).length}</dd></div>
      <div><dt>Saved version</dt><dd>v{layout.version}</dd></div>
      <div><dt>Spatial scope</dt><dd>{spatialReport?.status ?? 'Not currently checked'}</dd></div>
      <div><dt>Equipment scope</dt><dd>{equipmentReport?.status ?? 'Not currently checked'}</dd></div>
    </dl>
    <p>Whole-plan validation: {layout.validationState}. Scope checks do not certify engineering validity.</p>
    <div className="rack-actions"><button onClick={() => onNavigate('layout')}>Open room layout</button><button onClick={() => onNavigate('validate')}>Review all checks</button></div>
  </section>;
}

