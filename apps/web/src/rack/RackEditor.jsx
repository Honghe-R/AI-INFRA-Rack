import { useEffect, useRef, useState } from 'react';
import { RackConstraints } from './RackConstraints.jsx';
import { RackEquipment } from './RackEquipment.jsx';
import { useRackCatalog } from '../catalog/useRackCatalog.js';
import { RoomFloorplan } from './RackRoomView.jsx';
import { RackPlanOverview } from './RackSections.jsx';
import { RackInputs } from './RackInputs.jsx';
import { RackOptions } from './RackOptions.jsx';
import { RackDemandDesign } from './RackDemandDesign.jsx';
import { RackAllocation } from './RackAllocation.jsx';
import { RackWorkbench } from './RackWorkbench.jsx';
import { RackAddDialog } from './RackAddDialog.jsx';
import { RackCheckHistory } from './RackCheckHistory.jsx';
import { RackBulkRemoval } from './RackBulkRemoval.jsx';
import { bulkRemoval, unlockRacks } from './bulk-removal.js';
import { RACK_COMMANDS, rackCommandReason, addPlanObject } from './rack-commands.js';
import {
  beginLayoutDraft,
  layoutCheckBody,
  validateEditorPlacements,
  defaultEditorConstraints,
  validateEditorConstraints,
  defaultEditorEquipment,
  validateEditorEquipment,
} from './edit-layout-state.js';
import { rackError, uncertainCreation } from './rack-plan-state.js';

export function RackEditor({
  client,
  plan,
  context,
  canWrite,
  canReadFacility,
  refresh,
  draft,
  onDraftChange,
  onSaved,
  section = 'layout',
  onNavigate = () => {},
  commandRequest = null,
  onCommandConsumed = () => {},
}) {
  const catalogState = useRackCatalog(client, plan.projectId, canReadFacility);
  const [state, setState] = useState({
    pending: true,
    data: null,
    error: null,
  });
  const [reload, setReload] = useState(0);
  const [checkRetry, setCheckRetry] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedObstacleId, setSelectedObstacleId] = useState(null);
  const [modelId, setModelId] = useState('');
  const [focusRequest, setFocusRequest] = useState(null);
  const [checkState, setCheckState] = useState({
    pending: false,
    report: null,
    error: null,
    body: null,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [notice, setNotice] = useState(null);
  const [captureAttempt, setCaptureAttempt] = useState(null);
  const [addKind, setAddKind] = useState(null);
  const consumedCommand = useRef(null);
  const lifetime = useRef(null),
    sending = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    lifetime.current = c;
    return () => c.abort();
  }, []);
  useEffect(() => {
    if (!canReadFacility) return undefined;
    const c = new AbortController();
    setState({ pending: true, data: null, error: null });
    client
      .getRackLayout(plan.projectId, plan.planId, { signal: c.signal })
      .then(({ data }) => {
        if (
          data.contractVersion !== 1 ||
          data.projectId !== context.projectId ||
          data.planId !== plan.planId ||
          data.scenarioId !== context.scenarioId ||
          data.facilityInput.revisionId !== context.revisionId
        )
          throw new Error('Layout scope does not match this workspace.');
        if (!c.signal.aborted) setState({ pending: false, data, error: null });
      })
      .catch((e) => {
        if (!c.signal.aborted) setState({ pending: false, data: null, error: e });
      });
    return () => c.abort();
  }, [
    client,
    plan.projectId,
    plan.planId,
    context.projectId,
    context.scenarioId,
    context.revisionId,
    canReadFacility,
    refresh,
    reload,
  ]);
  const layout = state.data;
  const placements = draft?.placements ?? layout?.placements ?? [];
  const snapshot = layout?.snapshot;
  const constraints = draft?.constraints ?? layout?.constraints ?? defaultEditorConstraints();
  const equipment = draft?.equipment ?? layout?.equipment ?? defaultEditorEquipment();
  useEffect(() => {
    if (!commandRequest || commandRequest.nonce === consumedCommand.current || !layout || state.pending) return;
    consumedCommand.current = commandRequest.nonce;
    onCommandConsumed();
    setAddKind(null);
    if (commandRequest.planId !== layout.planId) { setError('The selected Plan changed. Choose the command again.'); return; }
    const reason = rackCommandReason({ layout, draft, canWrite, busy }, commandRequest.id);
    if (reason) { setError(reason); return; }
    setError(null);
    if (['rack_add', 'rack_device', 'rack_zone'].includes(commandRequest.id)) setAddKind(commandRequest.id);
    else {
      const command = RACK_COMMANDS.find(c => c.commandId === commandRequest.id);
      if (['rack_constraints', 'rack_capacity'].includes(commandRequest.id) && !draft) onDraftChange(beginLayoutDraft(layout));
      onNavigate(command.section);
    }
  }, [commandRequest, layout, state.pending, draft, canWrite, busy, onCommandConsumed, onDraftChange, onNavigate]);
  const checkBody = snapshot
    ? layoutCheckBody(
        draft
          ? { ...draft, constraints, equipment }
          : {
              snapshotId: snapshot.snapshotId,
              placements,
              constraints,
              equipment,
            },
      )
    : null;
  const checkKey = JSON.stringify(checkBody);
  const equipmentInputError = validateEditorEquipment(equipment, placements);
  const inputError =
    validateEditorPlacements(placements) || validateEditorConstraints(constraints) || equipmentInputError;
  useEffect(() => {
    if (!canReadFacility || !snapshot || inputError) {
      setCheckState({ pending: false, report: null, error: null, body: null });
      return undefined;
    }
    const c = new AbortController();
    setCheckState({ pending: true, report: null, error: null, body: null });
    const timer = setTimeout(() => {
      client
        .checkRackLayout(plan.projectId, plan.planId, JSON.parse(checkKey), {
          signal: c.signal,
        })
        .then(({ data }) => {
          if (!c.signal.aborted)
            setCheckState({
              pending: false,
              report: data.report,
              equipmentReport: data.equipmentReport,
              error: null,
              body: checkKey,
            });
        })
        .catch((e) => {
          if (!c.signal.aborted)
            setCheckState({
              pending: false,
              report: null,
              error: e,
              body: checkKey,
            });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [
    client,
    plan.projectId,
    plan.planId,
    checkKey,
    snapshot?.snapshotId,
    inputError,
    checkRetry,
    canReadFacility,
  ]);

  if (!canReadFacility) return <p role="status">Facility read access is required for this layout.</p>;
  if (state.pending) return <p role="status">Reading saved layout and fixed room input…</p>;
  if (state.error)
    return (
      <div role="alert">
        <p className="rack-error">{rackError(state.error)}</p>
        <button onClick={() => setReload((n) => n + 1)}>Retry layout</button>
      </div>
    );
  const stale = layout.sourceStatus.status !== 'UNCHANGED';
  const versionConflict = Boolean(draft && draft.baseVersion !== layout.version);
  const selected = placements.find((p) => p.rackId === selectedId);
  const selectedModel = layout.models.find((m) => m.modelId === selected?.modelId);
  const selectedPositionLocked =
    selected?.locked || layout.placements.some((p) => p.rackId === selectedId && p.locked);
  const currentReport = checkState.body === checkKey ? checkState.report : null;
  const equipmentReport = checkState.body === checkKey ? checkState.equipmentReport : null;
  const editable = Boolean(
    canWrite && snapshot && draft && !busy && !draft.attempt && !stale && !versionConflict,
  );
  const models = layout.models;
  function unlockFilteredRacks(ids) {
    if (!editable) throw new Error('This draft is not editable.');
    onDraftChange({ ...draft, placements: unlockRacks(placements, ids) });
    setError(null);
    setNotice(`Unlocked ${ids.length} racks in the draft. Save layout first, then select them for deletion.`);
  }
  function removeRacks(ids) {
    if (!editable) throw new Error('This draft is not editable.');
    const result = bulkRemoval({ kind: 'racks', ids, placements, equipment, savedPlacements: layout.placements });
    onDraftChange({ ...draft, placements: result.placements, equipment: result.equipment });
    if (ids.includes(selectedId)) setSelectedId(null);
    setError(null);
    setNotice(`Removed ${result.removedCount} racks from the draft; ${result.unassignedCount} devices kept as unassigned. Save layout to persist.`);
  }
  function removeSelectedRack() {
    if (!editable || !selected || selectedPositionLocked ||
        equipment.devices.some(device => device.rackId === selectedId)) return;
    onDraftChange({
      ...draft,
      placements: placements.filter(placement => placement.rackId !== selectedId),
      equipment: { ...equipment, rackLimits: equipment.rackLimits.filter(limit => limit.rackId !== selectedId) },
    });
    setSelectedId(null);
  }
  function updateRack(id, patch) {
    if (!editable) return;
    if (
      layout.placements.some((p) => p.rackId === id && p.locked) &&
      ['xM', 'yM', 'rotationDeg', 'modelId'].some((key) => key in patch)
    )
      return;
    onDraftChange({
      ...draft,
      placements: placements.map((p) => (p.rackId === id ? { ...p, ...patch } : p)),
    });
  }
  function addRack() {
    if (!editable || placements.length >= 256) return;
    const model = models.find((m) => m.modelId === modelId) ?? models[0];
    const id = crypto.randomUUID();
    // Start next to selected rack for a useful editing scale; arbitrary concave
    // rooms may reject this proposal and the server check will explain it.
    const xM = selected ? selected.xM + model.widthM + 0.2 : snapshot.view.extentM.width / 2;
    const yM = selected ? selected.yM : snapshot.view.extentM.height / 2;
    const item = {
      rackId: id,
      modelId: model.modelId,
      name: `Rack ${placements.length + 1}`,
      xM,
      yM,
      rotationDeg: 0,
      locked: true,
    };
    onDraftChange({ ...draft, placements: [...placements, item] });
    setSelectedId(id);
    setFocusRequest({ rackId: id, nonce: Date.now() });
  }
  async function mutate(operation) {
    if (sending.current || !canWrite) return;
    const existing = operation === 'capture' ? captureAttempt : draft?.attempt;
    const attempt = existing ?? {
      key: crypto.randomUUID(),
      version: operation === 'capture' ? layout.version : draft.baseVersion,
      body:
        operation === 'capture'
          ? { contract_version: 1 }
          : layoutCheckBody({ ...draft, constraints, equipment }),
    };
    if (operation === 'capture') setCaptureAttempt(attempt);
    else onDraftChange({ ...draft, attempt });
    sending.current = true;
    setBusy(true);
    setError(null);
    const signal = lifetime.current.signal;
    try {
      const opts = {
        idempotencyKey: attempt.key,
        version: attempt.version,
        signal,
      };
      const result =
        operation === 'capture'
          ? await client.captureRackRoom(plan.projectId, plan.planId, opts)
          : await client.saveRackLayout(plan.projectId, plan.planId, attempt.body, opts);
      if (signal.aborted) return;
      setState({ pending: false, data: result.data, error: null });
      setCaptureAttempt(null);
      onDraftChange(null);
      setNotice(
        result.meta?.replayed
          ? 'Save recovered safely. Current saved layout loaded.'
          : operation === 'capture'
            ? 'Fixed room input saved. You can now edit racks.'
            : `Layout saved · v${result.data.version}`,
      );
      onSaved(result.data.version);
    } catch (e) {
      if (signal.aborted) return;
      if (!uncertainCreation(e)) {
        if (operation === 'capture') setCaptureAttempt(null);
        else onDraftChange({ ...draft, attempt: null });
      }
      setError(
        `${uncertainCreation(e) ? 'Result unknown. Retry the same request before changing or discarding this draft. ' : ''}${rackError(e)}`,
      );
    } finally {
      sending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  const editorActions = (
<div className="rack-actions rack-editor-actions">
            {!draft && canWrite && (
              <button
                className="rack-primary"
                disabled={stale}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  onDraftChange(beginLayoutDraft(layout));
                }}
              >
                Edit layout
              </button>
            )}
            {draft && (
              <>
                <button
                  className="rack-primary"
                  disabled={
                    busy ||
                    !canWrite ||
                    (!draft.attempt &&
                      (stale ||
                        versionConflict ||
                        inputError ||
                        checkState.pending ||
                        checkState.body !== checkKey ||
                        !currentReport ||
                        currentReport.diagnostics.length > 0 ||
                        !equipmentReport ||
                        equipmentReport.diagnostics.length > 0))
                  }
                  onClick={() => mutate('save')}
                >
                  {busy ? 'Saving…' : draft.attempt ? 'Retry same save' : 'Save layout'}
                </button>
                <button
                  disabled={busy || Boolean(draft.attempt)}
                  onClick={() => {
                    onDraftChange(null);
                    setFocusRequest({ fitRacks: true, nonce: Date.now() });
                    setError(null);
                    setNotice('Unsaved changes discarded. Saved layout restored.');
                  }}
                >
                  Discard changes
                </button>
                <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
                  Reload saved version
                </button>
              </>
            )}
            <span className="rack-muted">
              {draft ? `Editing from v${draft.baseVersion}` : `Saved v${layout.version}`} ·{' '}
              {placements.length}/256 racks
            </span>
          </div>
  );
  return (
    <section className="rack-editor" aria-label="Rack layout editor">
      {addKind && <RackAddDialog key={`${layout.planId}:${addKind}`} kind={addKind} layout={layout} draft={draft}
        catalogState={catalogState} blockedReason={rackCommandReason({ layout, draft, canWrite, busy }, addKind)}
        onClose={() => setAddKind(null)} onApply={values => {
          const reason = rackCommandReason({ layout, draft, canWrite, busy }, addKind);
          if (reason) throw new Error(reason);
          const result = addPlanObject(layout, draft, addKind, values, catalogState.data);
          onDraftChange(result.draft);
          if (addKind === 'rack_add') { setSelectedId(result.selectedId); setFocusRequest({rackId:result.selectedId,showFloor:true,nonce:Date.now()}); }
          if (addKind === 'rack_zone') { setSelectedObstacleId(result.selectedId); setFocusRequest({obstacleId:result.selectedId,nonce:Date.now()}); }
          onNavigate(addKind === 'rack_add' ? 'layout' : addKind === 'rack_zone' ? 'constraints' : 'equipment');
          setNotice('Added to the shared draft. Continue editing, then check and choose Save layout.');
          setAddKind(null);
        }}/>}
      {notice && (
        <p className="rack-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rack-error">
          {error}
        </p>
      )}
      {stale && (
        <p className="rack-warning" role="status">
          Facility source changed. The fixed snapshot and saved racks remain visible; writes are blocked.{' '}
          {layout.sourceStatus.reasons.join(', ')}
        </p>
      )}
      {versionConflict && (
        <p role="alert" className="rack-error">
          The saved plan advanced to v{layout.version}; this draft is based on v{draft.baseVersion}. Your
          input is retained. Discard it to load the current saved layout.
        </p>
      )}
      {!snapshot ? (
        <div className="rack-floor-unavailable">
          <h3>Fix the room input before editing</h3>
          <p>
            This legacy plan has no stored Polygon snapshot. Capture its unchanged Facility boundary once.
          </p>
          {canWrite && (
            <button disabled={busy || (!captureAttempt && stale)} onClick={() => mutate('capture')}>
              {busy ? 'Capturing…' : captureAttempt ? 'Retry same capture' : 'Capture room input'}
            </button>
          )}
          {!canWrite && <p>A project editor must capture the input first.</p>}
        </div>
      ) : (
        <>
          {!['layout','overview'].includes(section) && editorActions}
          {draft && <p className="rack-muted">Layout, equipment, constraints and capacity share this draft and save together.</p>}
          {inputError && <p role="alert" className="rack-error">{inputError}</p>}
          {(checkState.error || (!inputError && currentReport?.diagnostics.length > 0) ||
            (!inputError && equipmentReport?.diagnostics.length > 0)) && <div className="rack-warning" role="status">
            Resolve the current plan checks before saving. <button onClick={() => onNavigate('validate')}>Open checks</button>
            {checkState.error && <button onClick={() => setCheckRetry((n) => n + 1)}>Retry checks</button>}
          </div>}
          {section === 'overview' && <RackPlanOverview layout={layout} equipment={equipment} placements={placements}
            spatialReport={currentReport} equipmentReport={equipmentReport} onNavigate={onNavigate} isDraft={Boolean(draft)} />}
          {section === 'dependencies' && <RackInputs layout={layout} placements={placements} constraints={constraints}
            equipment={equipment} draft={draft} spatialReport={currentReport} equipmentReport={equipmentReport}
            onNavigate={onNavigate} />}
          <div hidden={section !== 'candidates' && !(section === 'layout' && placements.length === 0 && equipment.devices.length === 0)}>
            <RackDemandDesign key={`${layout.planId}:${layout.version}`} client={client} layout={layout} catalogState={catalogState} draft={draft}
              canWrite={canWrite} onDraftChange={value=>{onDraftChange(value);setError(null);setNotice('Design loaded into the shared draft. Review it and choose Save layout.');setFocusRequest({fitRacks:true,nonce:Date.now()});}}
              onNavigate={onNavigate}/>
          </div>
          <div hidden={section !== 'candidates'}><RackOptions client={client} layout={layout} draft={draft}
            canWrite={canWrite} onDraftChange={value => {
              onDraftChange(value); setError(null); setNotice('Selected option loaded as an unsaved draft. Review and Save layout to apply.');
              setFocusRequest({ fitRacks: true, nonce: Date.now() });
            }} onNavigate={onNavigate} /></div>
          <div hidden={section !== 'equipment'}><RackAllocation client={client} layout={layout} draft={draft} canWrite={canWrite}
            onDraftChange={value => { onDraftChange(value); setError(null); setNotice('Device allocation loaded as an unsaved draft. Review and Save layout to apply.'); }} /></div>
          {['layout','overview'].includes(section) && <RackWorkbench key={snapshot.snapshotId} snapshot={snapshot}
            placements={placements} models={models} constraints={constraints} equipment={equipment}
            report={currentReport} equipmentReport={equipmentReport} selectedId={selectedId}
            onSelect={setSelectedId} editable={editable} onMove={updateRack}
            isPositionLocked={id => placements.some(p => p.rackId === id && p.locked) || layout.placements.some(p => p.rackId === id && p.locked)}
            onUpdate={patch => updateRack(selectedId, patch)} onNavigate={onNavigate} focusRequest={focusRequest}
            modelId={modelId} onModelChange={setModelId} onAdd={addRack} onRemove={removeSelectedRack} actions={editorActions}
            feedback={error || inputError || (checkState.error ? rackError(checkState.error) :
              checkState.pending || checkState.body !== checkKey ? 'Checking the current layout…' :
              currentReport?.diagnostics.length || equipmentReport?.diagnostics.length ? 'Checks found conflicts. Resolve them before saving.' : notice)} />}
          {['layout','overview'].includes(section) && <RackBulkRemoval key={`${layout.planId}:${snapshot.snapshotId}`} kind="racks"
            placements={placements} savedPlacements={layout.placements} equipment={equipment} editable={editable} onApply={removeRacks} onUnlock={unlockFilteredRacks} />}
          <div hidden={section !== 'constraints'} data-rack-panel="layout">
          <RoomFloorplan
            key={snapshot.snapshotId}
            room={snapshot.room}
            view={snapshot.view}
            sourceGeometry={snapshot.sourceGeometry}
            constraints={constraints}
            selectedObstacleId={selectedObstacleId}
            onSelectObstacle={setSelectedObstacleId}
            placements={placements}
            models={models}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={editable ? (id, position) => updateRack(id, position) : null}
            report={currentReport}
            equipmentReport={equipmentReport}
            focusRequest={focusRequest}
          />
          </div>
          <details hidden={section !== 'layout'} className="rack-studio-advanced"><summary>Exact coordinates and rack management</summary>
          <div className="rack-editor-columns" data-rack-panel="rack-properties">
            <section className="rack-card" aria-label="Rack inventory">
              <h3>Racks</h3>
              <label>
                Assumed demo model
                <select
                  value={modelId || models[0]?.modelId}
                  disabled={!editable}
                  onChange={(e) => setModelId(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={!editable || placements.length >= 256} onClick={addRack}>
                Add rack
              </button>
              <p className="rack-muted">Assumed sizes; capacities are unknown. No vendor specification.</p>
              <ul className="rack-plan-list">
                {placements.map((p) => (
                  <li key={p.rackId}>
                    <button
                      className={`rack-plan-item${selectedId === p.rackId ? ' is-selected' : ''}`}
                      aria-pressed={selectedId === p.rackId}
                      onClick={() => {
                        setSelectedId(p.rackId);
                        setFocusRequest({
                          rackId: p.rackId,
                          nonce: Date.now(),
                        });
                      }}
                    >
                      <strong>
                        {p.name}
                        {p.locked ? ' · Locked' : ''}
                      </strong>
                      <span>
                        {p.xM.toFixed(3)}, {p.yM.toFixed(3)} m · {p.rotationDeg}°
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rack-card" aria-label="Selected rack properties">
              <h3>Selected rack</h3>
              {selected ? (
                <>
                  <label>
                    Rack name
                    <input
                      value={selected.name}
                      maxLength={160}
                      disabled={!editable}
                      onChange={(e) => updateRack(selected.rackId, { name: e.target.value })}
                    />
                  </label>
                  <div className="rack-form-fields">
                    {['xM', 'yM'].map((axis) => (
                      <label key={axis}>
                        {axis === 'xM' ? 'X centre (m)' : 'Y centre (m)'}
                        <input
                          type="number"
                          step="0.01"
                          min="-10000"
                          max="10000"
                          value={Number.isFinite(selected[axis]) ? selected[axis] : ''}
                          disabled={!editable || selectedPositionLocked}
                          onChange={(e) =>
                            updateRack(selected.rackId, {
                              [axis]: e.target.value === '' ? NaN : Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label>
                    Rotation
                    <select
                      value={selected.rotationDeg}
                      disabled={!editable || selectedPositionLocked}
                      onChange={(e) =>
                        updateRack(selected.rackId, {
                          rotationDeg: Number(e.target.value),
                        })
                      }
                    >
                      {[0, 90, 180, 270].map((deg) => (
                        <option key={deg} value={deg}>
                          {deg}°
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="rack-lock-field">
                    <input
                      type="checkbox"
                      checked={selected.locked}
                      disabled={!editable}
                      onChange={(e) =>
                        updateRack(selected.rackId, {
                          locked: e.target.checked,
                        })
                      }
                    />
                    Position lock (on = locked)
                  </label>
                  <p className="rack-muted">
                    {selectedModel?.widthM} × {selectedModel?.depthM} m · {selectedModel?.heightU}U · Front
                    marked by a thick edge.
                  </p>
                  <div className="rack-actions">
                    <button
                      onClick={() =>
                        setFocusRequest({
                          rackId: selectedId,
                          nonce: Date.now(),
                        })
                      }
                    >
                      Focus rack
                    </button>
                    <button
                      disabled={
                        !editable ||
                        selectedPositionLocked ||
                        equipment.devices.some((d) => d.rackId === selectedId)
                      }
                      onClick={removeSelectedRack}
                    >
                      Delete rack
                    </button>
                  </div>
                  <p className="rack-muted">
                    Save an unlock before moving, replacing or deleting a previously locked rack. Unassign its
                    devices before deleting a rack.
                  </p>
                </>
              ) : (
                <p>Select a rack in the drawing or list.</p>
              )}
            </section>
          </div></details>
          <div hidden={!['equipment', 'capacity', 'validate'].includes(section)} data-rack-panel="equipment">
          <RackEquipment
            mode={section === 'validate' ? 'diagnostics' : section === 'capacity' ? 'capacity' : 'equipment'}
            catalogState={catalogState}
            equipment={equipment}
            placements={placements}
            models={models}
            editable={editable}
            selectedRackId={selectedId}
            onSelectRack={(id) => {
              setSelectedId(id);
              if (id) setFocusRequest({ rackId: id, nonce: Date.now() });
            }}
            onChange={(value) => onDraftChange({ ...draft, equipment: value })}
            report={equipmentReport}
            pending={!inputError && (checkState.pending || checkState.body !== checkKey)}
            inputError={equipmentInputError}
            checkError={checkState.error}
          />
          </div>
          <div hidden={section !== 'constraints'} data-rack-panel="constraints">
          <RackConstraints
            constraints={constraints}
            editable={editable}
            extent={snapshot.view.extentM}
            selectedId={selectedObstacleId}
            onSelect={setSelectedObstacleId}
            onFocus={(id) => setFocusRequest({ obstacleId: id, nonce: Date.now() })}
            onChange={(value) => onDraftChange({ ...draft, constraints: value })}
          />
          </div>
          {section === 'validate' && <RackCheckHistory key={`${layout.projectId}:${layout.planId}:${layout.version}`} client={client} layout={layout} draft={draft} canWrite={canWrite} />}
          <section hidden={!['layout', 'constraints', 'validate'].includes(section)} className="rack-check-panel" aria-label="Spatial diagnostics">
            <h3>Spatial checks</h3>
            {inputError ? (
              <p role="alert" className="rack-error">
                {inputError}
              </p>
            ) : checkState.pending || checkState.body !== checkKey ? (
              <p role="status">Checking {draft ? 'current draft' : 'saved layout'}…</p>
            ) : checkState.error ? (
              <div role="alert">
                <p className="rack-error">{rackError(checkState.error)}</p>
                <button onClick={() => setCheckRetry((n) => n + 1)}>Retry spatial checks</button>
              </div>
            ) : (
              currentReport && (
                <>
                  <p role="status">
                    {currentReport.status} · {currentReport.racksChecked} racks · {currentReport.pairsChecked}{' '}
                    pairs · {currentReport.obstaclesChecked} obstacles · {currentReport.clearanceBandsChecked}{' '}
                    maintenance bands
                  </p>
                  <ul>
                    {currentReport.diagnostics.map((d, i) => (
                      <li key={i}>
                        <button
                          className="rack-diagnostic"
                          onClick={() => {
                            if (d.rackIds.length) {
                              setSelectedId(d.rackIds[0]);
                              setFocusRequest({
                                rackId: d.rackIds[0],
                                nonce: Date.now(),
                              });
                            } else if (d.obstacleIds?.length) {
                              setSelectedObstacleId(d.obstacleIds[0]);
                              setFocusRequest({
                                obstacleId: d.obstacleIds[0],
                                nonce: Date.now(),
                              });
                            }
                          }}
                        >
                          {d.code}:{' '}
                          {d.rackIds
                            .map((id) => placements.find((p) => p.rackId === id)?.name ?? id)
                            .join(' ↔ ')}{' '}
                          {d.side && `[${d.side}] `}
                          {(d.obstacleIds ?? [])
                            .map((id) => constraints.obstacles.find((o) => o.obstacleId === id)?.name ?? id)
                            .join(', ')}{' '}
                          · {d.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="rack-muted">
                    Unchecked in spatial report: {currentReport.uncheckedRules.join(', ')}. Equipment and
                    capacity have a separate report above. No whole-plan validation has run.
                  </p>
                </>
              )
            )}
          </section>
        </>
      )}
    </section>
  );
}
