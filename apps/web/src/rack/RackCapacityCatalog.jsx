import { useState } from 'react';
import { RACK_CAPACITY_TEMPLATES } from './capacity-catalog.js';

export function RackCapacityCatalog({ rack, limit, editable, onApply }) {
  const [templateId, setTemplateId] = useState('general');
  const template = RACK_CAPACITY_TEMPLATES.find(t => t.templateId === templateId);
  const matches = limit && ['maxWeightKg', 'maxPowerKw', 'maxCoolingKw'].every(key => limit[key] === template[key]);
  return <fieldset className="rack-catalog-picker" aria-label="Rack capacity catalog">
    <legend>Rack capacity catalog</legend>
    <label>Capacity template<select value={templateId} onChange={event => setTemplateId(event.target.value)}>
      {RACK_CAPACITY_TEMPLATES.map(t => <option key={t.templateId} value={t.templateId}>{t.name} · v{t.version}</option>)}
    </select></label>
    <p><strong>ASSUMED</strong> · {template.maxWeightKg} kg weight · {template.maxPowerKw} kW power · {template.maxCoolingKw} kW cooling</p>
    <p className="rack-muted">{template.note}</p>
    <button disabled={!editable || !rack || Boolean(matches)} onClick={() => {
      if (editable && rack && !matches) onApply(template.templateId);
    }}>Apply to selected rack</button>
    {matches && <p role="status">Current limits match this template.</p>}
    <p className="rack-muted">Replaces all three limits for {rack?.name ?? 'the selected rack'} only. You can adjust them below. Save layout to persist, or Discard changes to undo.</p>
    <p className="rack-muted">Planning assumptions, not vendor ratings. Verify cabinet, floor, PDU and cooling capacity. Cooling is a heat-removal budget equal to power, with no extra margin; room budgets stay unchanged.</p>
  </fieldset>;
}
