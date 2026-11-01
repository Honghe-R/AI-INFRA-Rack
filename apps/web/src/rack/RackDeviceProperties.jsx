import { useEffect, useState } from 'react';
import { confirmDeviceProperties, deviceSpecificationFields } from './device-properties.js';

export function RackDeviceProperties({ device, editable, onConfirm }) {
  const initial = () => Object.fromEntries(['name', ...deviceSpecificationFields.map(([key]) => key)]
    .map(key => [key, device[key] ?? '']));
  const [input, setInput] = useState(initial);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const current = JSON.stringify([device.deviceId, device.name, ...deviceSpecificationFields.map(([key]) => device[key])]);
  useEffect(() => { setInput(initial()); setError(null); }, [current]);
  const change = (key, value) => {
    setInput(previous => ({ ...previous, [key]: value }));
    setError(null);
    setStatus(null);
  };
  return <fieldset className="rack-catalog-picker">
    <legend>Device properties</legend>
    {device.catalogRef && <div className="rack-catalog-binding">
      <p>Pinned model: <code>{device.catalogRef.modelId}@{device.catalogRef.version}</code> · ASSUMED local catalog</p>
      <p className="rack-muted">Changing specifications converts this device to custom plan assumptions when confirmed. The catalog model stays unchanged.</p>
    </div>}
    <label>Device name<input value={input.name} maxLength={160} disabled={!editable}
      onChange={event => change('name', event.target.value)} /></label>
    <div className="rack-form-fields">
      {deviceSpecificationFields.map(([key, label]) => <label key={key}>{label}
        <input type="number" min={key === 'heightU' ? 1 : 0} max={key === 'heightU' ? 100 : 1000000}
          step={key === 'heightU' ? 1 : 'any'} placeholder={key === 'heightU' ? undefined : 'Unknown'}
          value={input[key]} disabled={!editable} onChange={event => change(key, event.target.value)} />
      </label>)}
    </div>
    <button type="button" disabled={!editable} onClick={() => {
      if (!editable) return;
      try {
        const confirmed = confirmDeviceProperties(device, input);
        onConfirm(confirmed);
        setError(null);
        setStatus('Device changes confirmed in the draft. Save layout to persist.');
      } catch (cause) { setError(cause.message); setStatus(null); }
    }}>Confirm device changes</button>
    {error && <p role="alert" className="rack-error">{error}</p>}
    {status && <p role="status">{status}</p>}
    <p className="rack-muted">Confirm applies the name and specifications to the draft, then Save layout persists them. Unconfirmed inputs are not saved. Height changes are checked against U positions and rack capacity.</p>
  </fieldset>;
}
