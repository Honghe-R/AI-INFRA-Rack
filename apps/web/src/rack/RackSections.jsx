import { RACK_SECTIONS } from './rack-sections.js';

const readiness = { AVAILABLE: 'Available', PARTIAL: 'Partial scope', PLANNED: 'Planned' };
export function RackSectionGuide({ onNavigate }) {
  return <section className="rack-section-guide" aria-label="Rack workflow overview">
    <p>新建方案 → 复核机房输入 → 填设备数量与约束 → 比较自动设计 → 采用为草稿并微调 → 检查并保存。</p>
    <div className="rack-module-grid">{RACK_SECTIONS.filter((s) => s.functionId !== 'overview').map((s) =>
      <button key={s.functionId} className="rack-module-card" onClick={() => onNavigate(s.functionId)}>
        <span><strong>{s.label}</strong><span className={`rack-module-status is-${s.status.toLowerCase()}`}>{readiness[s.status]}</span></span>
        <span>{s.description}</span>
      </button>)}</div>
    <p className="rack-muted">Partial scope means the listed workflow is available with explicit limitations. Layout options relocate existing racks and design empty plans from equipment quantities. Candidate history and persisted dependency history remain to be implemented.</p>
    <aside className="rack-card" aria-label="Rack Assistant">
      <h3>Rack Assistant</h3><p>Keep the Rack tab active and select a saved plan, then open the workspace Assistant. Try: “查询各机柜剩余 U 位和功率容量”, “解释当前方案的检查结果”, or “比较两种布局策略”.</p>
      <p className="rack-muted">The Assistant reads saved data and can generate temporary option summaries. Save or discard local edits before planning. Map preview, confirmation and saving stay in Layout options. A configured model provider is required; unavailable providers are reported as errors.</p>
    </aside>
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

