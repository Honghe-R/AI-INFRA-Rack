import { useEffect, useRef, useState } from 'react';

const blank = { name: 'My model connection', endpoint: '', model: '', apiKey: '' };

/** Only this explicit settings form handles a key. It never persists it in the browser. */
export function AssistantConnection({ client, forceSetup = false, onChanged = () => {}, disabled = false }) {
  const [expanded, setExpanded] = useState(false);
  const [connection, setConnection] = useState(null);
  const [form, setForm] = useState(blank);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reload, setReload] = useState(0);
  const controllerRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client.getAssistantConnection({ signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      const value = data?.connection ?? null;
      setConnection(value);
      setForm(value ? { name: value.name, endpoint: value.endpoint, model: value.model, apiKey: '' } : blank);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); controllerRef.current?.abort(); };
  }, [client, reload]);
  const change = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice(null);
    setConfirmDelete(false);
  };
  const act = async (work) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true); setError(null); setNotice(null);
    try { await work(controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const save = (event) => {
    event.preventDefault();
    act(async (signal) => {
      const { data } = await client.saveAssistantConnection({ ...form, version: connection?.version ?? null }, { signal });
      if (signal.aborted) return;
      setConnection(data.connection);
      setForm({ name: data.connection.name, endpoint: data.connection.endpoint, model: data.connection.model, apiKey: '' });
      setNotice('Connection saved for future use with this account. The model has not been tested yet.');
      setConfirmDelete(false);
      onChanged();
    });
  };
  const changed = connection && (form.name !== connection.name || form.endpoint !== connection.endpoint || form.model !== connection.model || Boolean(form.apiKey));
  const visible = expanded || forceSetup;
  return <section className="assistant-connection" aria-label="AI model connection">
    <button type="button" className="assistant__new" aria-expanded={visible} onClick={() => {
      setExpanded(!visible);
      setForm((current) => ({ ...current, apiKey: '' }));
    }}>{forceSetup ? 'Set up AI connection' : 'Model connection'}</button>
    {visible ? <div className="assistant-connection__body">
      <p>Configure once for future sessions. The backend encrypts your key outside the repository and browser storage.</p>
      <p>Your messages and relevant plan data will be sent to your selected model service.</p>
      {loading ? <p role="status">Loading your connection…</p> : <form onSubmit={save}>
        <fieldset disabled={busy || disabled}>
          <label>Connection name<input value={form.name} maxLength={80} required onChange={(event) => change('name', event.target.value)} /></label>
          <label>Base URL<input type="url" value={form.endpoint} placeholder="https://api.deepseek.com/v1" maxLength={2048} required onChange={(event) => change('endpoint', event.target.value)} /></label>
          <label>Model ID<input value={form.model} placeholder="Enter the exact model ID from your provider" maxLength={160} required onChange={(event) => change('model', event.target.value)} /></label>
          <label>API Key{connection ? ' (leave blank to keep the saved key)' : ''}<input type="password" value={form.apiKey} autoComplete="off" spellCheck={false} maxLength={8192} required={!connection} onChange={(event) => change('apiKey', event.target.value)} /></label>
          <div className="assistant-connection__actions">
            <button type="submit">{busy ? 'Working…' : 'Save connection'}</button>
            {connection ? <button type="button" disabled={Boolean(changed)} onClick={() => act(async (signal) => {
              const { data } = await client.testAssistantConnection(connection.connectionId, connection.version, { signal });
              if (!signal.aborted) setNotice(data.message);
            })}>Test saved connection</button> : null}
            {connection ? <button type="button" onClick={() => setConfirmDelete(true)}>Delete connection</button> : null}
          </div>
        </fieldset>
        {connection ? <p>Connection saved. {changed ? 'Save your changes before testing.' : 'Testing uses a small number of model tokens with synthetic messages; no plan data is sent.'}</p> : null}
      </form>}
      {confirmDelete ? <div role="group" aria-label="Confirm deletion of personal model connection"><p>You will need to enter your key again. Existing Rack plans will be kept.</p>
        <button type="button" disabled={busy} onClick={() => act(async (signal) => {
          await client.deleteAssistantConnection(connection.version, { signal });
          if (signal.aborted) return;
          setConnection(null); setForm(blank); setConfirmDelete(false); setNotice('Personal connection deleted.'); onChanged();
        })}>Confirm deletion</button> <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
      </div> : null}
      {error ? <p role="alert">{error} <button type="button" disabled={busy} onClick={() => { setReload((value) => value + 1); onChanged(); }}>Reload</button></p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div> : null}
  </section>;
}
