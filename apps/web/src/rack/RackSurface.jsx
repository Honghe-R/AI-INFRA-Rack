import { useEffect, useRef, useState } from 'react';
import { RACK_KEYS, FACILITY_KEYS } from '../generated/permission-keys.js';
import { usePermission } from '../permissions/usePermission.jsx';
import { planIntent, rackError, roomSource, samePlanScope, uncertainCreation } from './rack-plan-state.js';
import './rack.css';
import { RackEditor } from './RackEditor.jsx';
import { rackSection } from './rack-sections.js';
import { RackSectionGuide } from './RackSections.jsx';
import { RackPlanActions } from './RackPlanActions.jsx';

export function RackSurface(props) {
  const scope = { projectId: props.context.projectId };
  const read = usePermission(RACK_KEYS.READ, scope);
  const write = usePermission(RACK_KEYS.WRITE, scope);
  const facility = usePermission(FACILITY_KEYS.READ, scope);
  if (read.pending) return <section className="rack-surface" role="status">Checking Rack access…</section>;
  if (read.allowed !== true) return <section className="rack-surface" role="alert">
    {read.unavailable ? 'Rack permissions could not be checked. Reopen this workspace to retry.' : 'You do not have access to Rack plans in this project.'}
  </section>;
  if (!props.client) return <section className="rack-surface" role="alert">The Rack API is unavailable.</section>;
  return <RackWorkspace {...props} canWrite={write.allowed === true} canReadFacility={facility.allowed === true}
    writePending={write.pending} writeUnavailable={write.unavailable}
    facilityPending={facility.pending} facilityUnavailable={facility.unavailable} />;
}

function RackWorkspace({ client, context, routeState = {}, onRouteChange, onDirtyChange, canWrite, canReadFacility,
  writePending, writeUnavailable, facilityPending, facilityUnavailable }) {
  const { projectId, scenarioId, revisionId } = context;
  const section = rackSection(routeState.functionId);
  const navigate = (functionId) => onRouteChange({ functionId });
  const draft = routeState.rackDraft ?? null;
  const editDraft = routeState.rackEditDraft ?? null;
  const planAttempt = routeState.rackPlanAttempt ?? null;
  const [deleted,setDeleted]=useState(false);
  const selectedId = routeState.rackPlanId ?? null;
  const [list, setList] = useState({ pending: true, data: null, error: null });
  const [detail, setDetail] = useState({ pending: false, data: null, error: null });
  const [source, setSource] = useState({ pending: false, data: null, error: null });
  const [refresh, setRefresh] = useState(0);
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const [cursors, setCursors] = useState([null]);
  const cursor = cursors.at(-1);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [notice, setNotice] = useState(null);
  const submitting = useRef(false);
  const lifetime = useRef(null);

  useEffect(() => {
    if (!routeState.rackCommand) return;
    const reason = routeState.rackCommand.planId !== selectedId ? 'The selected plan has changed. Choose the action again.' :
      detail.data?.deletedAt ? 'This plan was deleted. Restore it in Plans first.' :
      !facilityPending && !canReadFacility ? 'Facility read access is required for this action.' : null;
    if (reason) { onRouteChange({rackCommand:null}); setNotice(reason); }
  }, [routeState.rackCommand, selectedId, detail.data?.deletedAt, facilityPending, canReadFacility, onRouteChange]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => { onDirtyChange(Boolean(draft || editDraft || planAttempt)); }, [draft, editDraft, planAttempt, onDirtyChange]);
  useEffect(() => {
    if (!draft && !editDraft && !planAttempt) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, editDraft, planAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setList({ pending: true, data: null, error: null });
    client.listRackPlans(projectId, { scenarioId, revisionId, cursor, deleted, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setList({ pending: false, data: result.data, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setList({ pending: false, data: null, error });
    });
    return () => controller.abort();
  }, [client, projectId, scenarioId, revisionId, cursor, deleted, refresh]);

  useEffect(() => {
    if (!canReadFacility) { setSource({ pending: false, data: null, error: null }); return undefined; }
    const controller = new AbortController();
    setSource({ pending: true, data: null, error: null });
    client.getFacilityEnvelope(projectId, revisionId, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setSource({ pending: false, data: result.data, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setSource({ pending: false, data: null, error });
    });
    return () => controller.abort();
  }, [client, projectId, revisionId, canReadFacility, sourceRefresh]);

  useEffect(() => {
    if (!selectedId) { setDetail({ pending: false, data: null, error: null }); return undefined; }
    const controller = new AbortController();
    setDetail({ pending: true, data: null, error: null });
    client.getRackPlan(projectId, selectedId, { signal: controller.signal }).then(result => {
      if (!samePlanScope(result.data, context)) throw new Error('This plan does not belong to the current scenario and Facility revision.');
      if (!controller.signal.aborted) setDetail({ pending: false, data: result.data, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setDetail({ pending: false, data: null, error });
    });
    return () => controller.abort();
  }, [client, projectId, scenarioId, revisionId, selectedId, refresh]);

  const sourceInfo = roomSource(source.data, context);
  const rooms = sourceInfo.rooms;
  const roomName = id => rooms.find(room => room.containerId === id)?.name ?? id;
  const reload = () => { setCursors([null]); setRefresh(value => value + 1); };
  function updateDraft(patch) { onRouteChange({ rackDraft: { ...draft, ...patch } }); }

  async function submit(event) {
    event.preventDefault();
    if (submitting.current || !draft || !canWrite) return;
    let attempt;
    try { attempt = draft.attempt ?? planIntent(draft, context, source.data, crypto.randomUUID()); }
    catch (error) { setCreateError(rackError(error)); return; }
    // Retain the exact body and key before sending. A remount or uncertain
    // response retries this intent instead of minting a second creation key.
    updateDraft({ attempt });
    submitting.current = true;
    setBusy(true);
    setCreateError(null);
    const signal = lifetime.current.signal;
    try {
      const result = await client.createRackPlan(projectId, attempt.body, { idempotencyKey: attempt.key, signal });
      if (signal.aborted) return;
      setDeleted(false);
      onRouteChange({ rackDraft: null, rackPlanId: result.data.planId, functionId:'layout' });
      onDirtyChange(false);
      setNotice(result.meta?.replayed ? 'The saved plan was recovered. No duplicate was created.' : 'Plan created. Next, enter equipment quantities and constraints to generate design candidates, or edit the layout manually.');
      reload();
    } catch (error) {
      if (signal.aborted) return;
      if (!uncertainCreation(error)) updateDraft({ attempt: null });
      setCreateError(uncertainCreation(error)
        ? `The result is unknown. Retry the same request to recover it safely. ${rackError(error)}` : rackError(error));
    } finally {
      submitting.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  return <section className="rack-surface" aria-label={`Rack ${section.label}`}>
    <header className="rack-heading">
      <div><p className="rack-eyebrow">RACK INFRASTRUCTURE</p><h1>{section.label}</h1>
        <p>{section.description}</p></div>
      <div className="rack-actions">
        <button type="button" disabled={Boolean(planAttempt)} onClick={reload}>Refresh plans</button>
        {canWrite && !draft && <button type="button" className="rack-primary" disabled={Boolean(editDraft||planAttempt)} onClick={() => {
          setCreateError(null); setNotice(null); onRouteChange({ functionId: 'plans', rackDraft: { name: '', hallId: '' } });
        }}>New empty plan</button>}
      </div>
    </header>
    {!canWrite && <p className="rack-muted" role="status">{writePending ? 'Checking creation access…'
      : writeUnavailable ? 'Creation permissions could not be checked. Reopen this workspace to retry.'
        : 'Read-only access. Creating plans requires rack.write.'}</p>}
    <p className="rack-scope">Scenario <code>{scenarioId}</code> · Facility revision <code>{revisionId}</code></p>
    {section.functionId === 'overview' && !selectedId && <RackSectionGuide onNavigate={navigate} />}
    {section.functionId !== 'plans' && <div className="rack-plan-switcher">
      <label>Active Rack plan<select value={selectedId ?? ''} disabled={Boolean(draft || editDraft || planAttempt) || list.pending}
        onChange={(event) => { setNotice(null); onRouteChange({ rackPlanId: event.target.value || null }); }}>
        <option value="">Choose a saved plan</option>
        {selectedId && !list.data?.items?.some((p) => p.planId === selectedId) && <option value={selectedId}>{detail.data?.name ?? selectedId}</option>}
        {(list.data?.items ?? []).map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
      </select></label>
      <button onClick={() => navigate('plans')}>Manage plans</button>
      {editDraft && <span className="rack-warning">One unsaved draft is shared across sections. Save or discard before changing plans.</span>}
      {list.error && <p role="alert">{rackError(list.error)}</p>}
    </div>}
    {notice && <p role="status" className="rack-notice">{notice}</p>}
    {!draft&&selectedId&&!detail.data?.deletedAt&&<nav className="rack-journey" aria-label="Plan workflow">{[['layout','① Auto design / Layout'],['equipment','② Equipment allocation'],['constraints','③ Space rules'],['capacity','④ Capacity budgets'],['validate','⑤ Check results'],['plans','Plan management']].map(([id,label])=>
      <button key={id} aria-current={section.functionId===id?'step':undefined} onClick={()=>navigate(id)}>{label}</button>)}</nav>}
    {draft && <form className="rack-card rack-create" onSubmit={submit} aria-label="Create empty Rack plan">
      <h2>Create an empty plan</h2><p>Bind a saved plan to one HALL. Supported room geometry is captured as a fixed input; racks can be added after creation.</p>
      <div className="rack-form-fields">
        <label>Plan name<input value={draft.name} maxLength={160} required disabled={busy || Boolean(draft.attempt)}
          onChange={event => updateDraft({ name: event.target.value })} placeholder="e.g. Hall A — initial plan" /></label>
        <label>Facility HALL<select value={draft.hallId} required disabled={busy || Boolean(draft.attempt) || !sourceInfo.ready || !canWrite}
          onChange={event => updateDraft({ hallId: event.target.value })}>
          <option value="">Choose a HALL</option>{rooms.map(room => <option key={room.containerId} value={room.containerId}>{room.name}</option>)}
        </select></label>
      </div>
      {!canReadFacility ? <p role="status">{facilityPending ? 'Checking Facility access…'
        : facilityUnavailable ? 'Facility permissions could not be checked. Reopen this workspace to retry.'
          : 'Facility read access is required to choose a HALL.'}</p>
        : source.pending ? <p role="status">Reading Facility source…</p>
          : source.error ? <p role="alert" className="rack-error">{rackError(source.error)}</p>
            : !sourceInfo.ready ? <p className="rack-warning">{sourceInfo.reason}</p>
              : <p className="rack-muted">Facility source: DRAFT · {rooms.length} HALL(s) available</p>}
      {createError && <p role="alert" className="rack-error">{createError}</p>}
      {draft.attempt && !busy && <p className="rack-warning">An unconfirmed request is retained. Retry it before changing these fields.</p>}
      <div className="rack-actions">
        <button className="rack-primary" type="submit" disabled={busy || !canWrite || (!draft.attempt && (!sourceInfo.ready || source.pending || !draft.name.trim() || !draft.hallId))}>
          {busy ? 'Saving…' : draft.attempt ? 'Retry same creation' : 'Save empty plan'}</button>
        <button type="button" disabled={busy || Boolean(draft.attempt) || !canReadFacility || source.pending}
          onClick={() => setSourceRefresh(value => value + 1)}>Refresh Facility source</button>
        <button type="button" disabled={busy || Boolean(draft.attempt)} onClick={() => {
          onRouteChange({ rackDraft: null }); onDirtyChange(false); setCreateError(null);
        }}>Cancel</button>
      </div>
    </form>}
    <div className={section.functionId === 'plans' ? 'rack-columns' : 'rack-section-content'}>
      <section hidden={section.functionId !== 'plans'} className="rack-card" aria-label="Saved Rack plans"><h2>{deleted?'Deleted plans':'Saved plans'}</h2>
        <label><input type="checkbox" checked={deleted} disabled={Boolean(draft||editDraft||planAttempt)} onChange={e=>{setDeleted(e.target.checked);setCursors([null]);onRouteChange({rackPlanId:null});}}/>Show deleted plans</label>
        <p className="rack-muted">Newest first · Up to 20 per page</p>
        {list.pending ? <p role="status">Loading plans…</p> : list.error ? <div role="alert">
          <p className="rack-error">{rackError(list.error)}</p><button onClick={reload}>Retry list</button></div>
          : !list.data?.items?.length ? <p className="rack-empty">{deleted?'No deleted plans.':'No saved plans in this scope. Create an empty plan to start.'}</p>
            : <ul className="rack-plan-list">{list.data.items.map(plan => <li key={plan.planId}>
              <button className={selectedId === plan.planId ? 'rack-plan-item is-selected' : 'rack-plan-item'}
                aria-pressed={selectedId === plan.planId} disabled={Boolean(draft || editDraft || planAttempt)} onClick={() => { setNotice(null); onRouteChange({ rackPlanId: plan.planId }); }}>
                <strong>{plan.name}</strong><span>{roomName(plan.facilityInput.containerId)}</span>
                <span>{plan.deletedAt?'Deleted':'DRAFT'} · v{plan.version} · <SourceStatus status={plan.facilityInputStatus?.status} /></span>
              </button></li>)}</ul>}
        <nav className="rack-actions" aria-label="Rack plan pages">
          <button disabled={list.pending || cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}>Previous</button>
          <span>Page {cursors.length}</span><button disabled={list.pending || !list.data?.nextCursor}
            onClick={() => setCursors(value => [...value, list.data.nextCursor])}>Next</button>
        </nav>
      </section>
      <section className="rack-card rack-detail" aria-label="Rack plan details">
        {detail.pending ? <p role="status">Reading saved plan…</p> : detail.error ? <div role="alert">
          <p className="rack-error">{rackError(detail.error)}</p><button onClick={() => setRefresh(value => value + 1)}>Retry detail</button></div>
          : detail.data ? <>
            <div className="rack-heading"><h2>{detail.data.name}</h2><span className="rack-badge">{detail.data.deletedAt?'Deleted':detail.data.state} · v{detail.data.version}</span></div>
            {section.functionId === 'plans' && !draft && <><RackPlanActions key={detail.data.planId} client={client} plan={detail.data} canWrite={canWrite}
              blocked={Boolean(draft||editDraft)} attempt={planAttempt} onAttempt={value=>onRouteChange({rackPlanAttempt:value})}
              onManaged={(value,operation)=>{onRouteChange({rackPlanAttempt:null,rackPlanId:operation==='delete'?null:value.planId,functionId:'plans'});
                setDeleted(false);setNotice(operation==='delete'?'Plan moved to Deleted plans. You can restore it.':operation==='restore'?'Plan restored with its layout and equipment.':'Plan name updated.');reload();}}/>
              {!detail.data.deletedAt&&<div className="rack-actions"><button onClick={() => navigate('layout')}>Open layout</button><button onClick={() => navigate('overview')}>Plan overview</button></div>}</>}
            {detail.data.deletedAt&&<p className="rack-warning">This plan was deleted. Restore it in Plan management before opening or editing the layout.</p>}
            {!draft && !detail.data.deletedAt && <div hidden={section.functionId === 'plans'}><RackEditor key={detail.data.planId} client={client} plan={detail.data} context={context}
              section={section.functionId} onNavigate={navigate}
              commandRequest={routeState.rackCommand} onCommandConsumed={() => onRouteChange({ rackCommand: null })}
              canWrite={canWrite} canReadFacility={canReadFacility} refresh={refresh} draft={editDraft}
              onDraftChange={value => onRouteChange({ rackEditDraft: value })}
              onSaved={version => { setNotice(`Saved layout loaded · v${version}`); reload(); }} /></div>}
            <details open={section.functionId === 'plans'} className="rack-plan-metadata"><summary>Saved plan details</summary>
              <RackPlanDetail plan={detail.data} roomName={roomName(detail.data.facilityInput.containerId)} />
            </details>
          </>
            : <div className="rack-empty"><h2>Select a saved plan</h2><p>View its stored identity, Facility reference, and source freshness here.</p></div>}
      </section>
    </div>
  </section>;
}

export function SourceStatus({ status }) {
  const label = { UNCHANGED: 'Source unchanged', STALE: 'Source changed', UNAVAILABLE: 'Source unavailable' }[status] ?? 'Source unknown';
  return <span className={`rack-source-status ${status === 'UNCHANGED' ? '' : 'rack-warning'}`}>{label}</span>;
}

export function RackPlanDetail({ plan, roomName }) {
  const input = plan.facilityInput;
  const freshness = plan.facilityInputStatus;
  return <>
    <div className="rack-heading"><h2>{plan.name}</h2><span className="rack-badge">{plan.state} · v{plan.version}</span></div>
    <p><SourceStatus status={freshness?.status} /></p>
    {freshness?.status !== 'UNCHANGED' && <p className="rack-warning">The stored Facility reference has not been rebound. Review the source before future editing.</p>}
    <dl className="rack-facts">
      <dt>Plan ID</dt><dd><code>{plan.planId}</code></dd>
      <dt>HALL</dt><dd>{roomName}</dd>
      <dt>HALL ID</dt><dd><code>{input.containerId}</code></dd>
      <dt>Created</dt><dd>{plan.createdAt}</dd>
      <dt>Created by</dt><dd><code>{plan.createdBy}</code></dd>
      <dt>Rack validation</dt><dd>{plan.validationState} · Validation has not been run.</dd>
      <dt>Rack placements</dt><dd>{plan.placements.length} saved</dd>
      <dt>Facility revision</dt><dd><code>{input.revisionId}</code></dd>
      <dt>Saved source ETag</dt><dd><code>{input.revisionEtag}</code></dd>
      <dt>Current source ETag</dt><dd><code>{freshness?.currentRevisionEtag ?? 'Unavailable'}</code></dd>
      <dt>Facility lifecycle</dt><dd>{freshness?.lifecycleState ?? 'Unknown'}</dd>
      {freshness?.reasons?.length > 0 && <><dt>Source reasons</dt><dd>{freshness.reasons.join(', ')}</dd></>}
    </dl>
    <p className="rack-boundary">Room input, rack placements, spatial assumptions and plan-local equipment save separately from Facility. Spatial checks and equipment/U/capacity checks report their own scope. Side clearances, connected access routes and engineering validation remain pending. Rack Assistant tools require a configured model service for conversation.</p>
  </>;
}
