import { useEffect, useRef, useState } from 'react';

const blank = { name: '我的模型连接', endpoint: '', model: '', apiKey: '' };

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
      setNotice('已保存。以后在此账号使用时无需重复配置。尚未执行模型测试。');
      setConfirmDelete(false);
      onChanged();
    });
  };
  const changed = connection && (form.name !== connection.name || form.endpoint !== connection.endpoint || form.model !== connection.model || Boolean(form.apiKey));
  const visible = expanded || forceSetup;
  return <section className="assistant-connection" aria-label="AI 模型连接">
    <button type="button" className="assistant__new" aria-expanded={visible} onClick={() => {
      setExpanded(!visible);
      setForm((current) => ({ ...current, apiKey: '' }));
    }}>{forceSetup ? '首次配置 AI 模型连接' : '模型连接'}</button>
    {visible ? <div className="assistant-connection__body">
      <p>首次保存后自动记住。Key 由本机后端加密保存，不进入 Git 或浏览器存储。</p>
      <p>提问内容及必要的方案数据会发送至你选择的模型服务。</p>
      {loading ? <p role="status">正在读取个人连接…</p> : <form onSubmit={save}>
        <fieldset disabled={busy || disabled}>
          <label>连接名称<input value={form.name} maxLength={80} required onChange={(event) => change('name', event.target.value)} /></label>
          <label>Base URL<input type="url" value={form.endpoint} placeholder="https://api.deepseek.com/v1" maxLength={2048} required onChange={(event) => change('endpoint', event.target.value)} /></label>
          <label>模型 ID<input value={form.model} placeholder="填写服务商提供的准确模型 ID" maxLength={160} required onChange={(event) => change('model', event.target.value)} /></label>
          <label>API Key{connection ? '（留空保留已保存的 Key）' : ''}<input type="password" value={form.apiKey} autoComplete="off" spellCheck={false} maxLength={8192} required={!connection} onChange={(event) => change('apiKey', event.target.value)} /></label>
          <div className="assistant-connection__actions">
            <button type="submit">{busy ? '处理中…' : '保存连接'}</button>
            {connection ? <button type="button" disabled={Boolean(changed)} onClick={() => act(async (signal) => {
              const { data } = await client.testAssistantConnection(connection.connectionId, connection.version, { signal });
              if (!signal.aborted) setNotice(data.message);
            })}>测试已保存连接</button> : null}
            {connection ? <button type="button" onClick={() => setConfirmDelete(true)}>删除连接</button> : null}
          </div>
        </fieldset>
        {connection ? <p>连接已保存；{changed ? '修改后请先保存再测试。' : '测试会产生少量模型用量，仅发送合成消息，不读取方案。'}</p> : null}
      </form>}
      {confirmDelete ? <div role="group" aria-label="确认删除个人模型连接"><p>删除后需要重新填写 Key。已有 Rack 方案保持不变。</p>
        <button type="button" disabled={busy} onClick={() => act(async (signal) => {
          await client.deleteAssistantConnection(connection.version, { signal });
          if (signal.aborted) return;
          setConnection(null); setForm(blank); setConfirmDelete(false); setNotice('个人连接已删除。'); onChanged();
        })}>确认删除连接</button> <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
      </div> : null}
      {error ? <p role="alert">{error} <button type="button" disabled={busy} onClick={() => { setReload((value) => value + 1); onChanged(); }}>重新读取</button></p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div> : null}
  </section>;
}
