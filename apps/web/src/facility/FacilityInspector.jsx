import { useEffect, useRef, useState } from 'react';
import { Watermark } from '../shell/Watermark.jsx';
import { describeFeature } from '../map/SiteFacilityCanvas.jsx';
import { INSPECTOR_TABS } from '../assistant/ui-actions.js';

/**
 * The inspector for the selected entity.
 *
 * It reads what the envelope already carries and stages changes; it never writes. Every
 * edit is added to the pending set and only leaves the browser on commit, which is what
 * keeps one change set per action rather than a request per keystroke.
 *
 * What is editable is decided by entity type, because the graph is not uniform: a
 * container carries a name, a level and elevations, while a utility source carries a
 * capacity state. Offering a field the store would refuse is worse than not offering it,
 * so the fields follow the change kinds that exist.
 *
 * The tab bar (ui-pattern.md, "Context inspector") is what the assistant's
 * `open_inspector` action addresses. Every panel stays in the DOM and only the active
 * one is unhidden, so a tab switch is a presentation change rather than a second
 * mounting path for the same fields. A `field_path` scrolls to and focuses the named
 * field once, then is reported consumed.
 */
const TAB_LABELS = Object.freeze({
  OVERVIEW: 'Overview',
  UTILITIES: 'Utilities',
  ENVIRONMENT: 'Environment',
  PHASING: 'Phasing',
  ASSUMPTIONS: 'Assumptions',
  DOCUMENTS: 'Documents',
});

/**
 * The change kinds name a field in snake_case and the store rows arrive camelCase. The
 * form is the one place the two meet, so the mapping is stated rather than relied on:
 * reading `container.level_number` off a mapped row always returns nothing, which made
 * every existing level and elevation look unset.
 */
const CONTAINER_FIELD_COLUMNS = Object.freeze({
  name: 'name',
  level_number: 'levelNumber',
  elevation_base_m: 'elevationBaseM',
  elevation_top_m: 'elevationTopM',
});

/**
 * The draft belongs to the entity it was typed against.
 *
 * The inspector is not remounted when the selection moves, so an un-staged draft would
 * otherwise ride along to the next object: a level number typed while a floor was
 * selected would be applied when a building is edited next, and the store would refuse
 * an edit the user never made. The owner is carried with the values and a draft for
 * another entity is treated as absent — derived rather than cleared in an effect, so
 * there is no frame in which the previous entity's values are visible.
 */
export function draftForEntity(draft, entityId = null) {
  if (!draft || !entityId) return null;
  return draft.entityId === entityId ? draft : null;
}

export function FacilityInspector({
  feature = null,
  facility = {},
  phases = [],
  pendingFor = () => [],
  canWrite = false,
  blockedReason = null,
  tab = null,
  onTabChange = null,
  fieldPath = null,
  onFieldPathConsumed = null,
  onStage = () => {},
  onClear = () => {},
}) {
  const [draft, setDraft] = useState(null);
  const [removeCascade, setRemoveCascade] = useState('NONE');
  const [ownTab, setOwnTab] = useState('OVERVIEW');
  const rootRef = useRef(null);

  const activeTab = TAB_LABELS[tab] ? tab : TAB_LABELS[ownTab] ? ownTab : 'OVERVIEW';

  const chooseTab = (next) => {
    if (onTabChange) onTabChange(next);
    else setOwnTab(next);
    // A tab chosen by hand supersedes a focused field; the focus is one-shot.
    onFieldPathConsumed?.();
  };

  /**
   * Scrolls to the field `open_inspector.field_path` named and puts focus in it.
   *
   * The path is validated against the allowlist before it ever reaches here, so the
   * attribute selector cannot be tricked into selecting something else. The panel is
   * unhidden first (the tab change above has already rendered), which is why this runs
   * in an effect keyed on the path and the active tab.
   */
  useEffect(() => {
    if (!fieldPath) return;
    const node = rootRef.current?.querySelector?.(`[data-field-path="${fieldPath}"]`) ?? null;
    if (node) {
      node.scrollIntoView?.({ block: 'center' });
      const focusable = node.matches?.('input, select, button') ? node : node.querySelector?.('input, select, button');
      focusable?.focus?.();
    }
    onFieldPathConsumed?.();
  }, [fieldPath, activeTab, onFieldPathConsumed]);

  if (!feature) return null;

  const container = (facility.containers ?? []).find((item) => item.containerId === feature.entityId) ?? null;
  const directSource = (facility.utilitySources ?? []).find((item) => item.utilitySourceId === feature.entityId) ?? null;
  // A utility source carries no geometry, so it cannot be picked on the canvas. An
  // interface can, and it resolves to exactly one source — so editing the capacity state
  // through the interface is how supply actually becomes firm. Without this the source
  // branch would be unreachable from the map.
  const utilityInterface =
    (facility.utilityInterfaces ?? []).find((item) => item.interfaceId === feature.entityId) ?? null;
  const source =
    directSource ??
    (utilityInterface
      ? (facility.utilitySources ?? []).find((item) => item.utilitySourceId === utilityInterface.utilitySourceId) ?? null
      : null);
  const sourceViaInterface = !directSource && Boolean(source);
  const editable = canWrite && !blockedReason;
  const staged = pendingFor(feature.entityId);
  // Only a FLOOR and a HALL carry a level number — the store has a check constraint for
  // it — so the field is offered for exactly those kinds. Offering it for a parcel let a
  // user type a value the store refused, which is a form that cannot succeed.
  const carriesLevel = container?.kind === 'FLOOR' || container?.kind === 'HALL';

  // Only this entity's own draft is ever read or extended, so a value typed for the
  // previously selected object cannot reach this one's patch.
  const activeDraft = draftForEntity(draft, feature?.entityId ?? null);
  const editDraft = (key, value) => setDraft({ ...activeDraft, entityId: feature.entityId, [key]: value });

  const field = (key) => activeDraft?.[key] ?? (container ? container[CONTAINER_FIELD_COLUMNS[key] ?? key] ?? '' : '');

  const patchFromDraft = () => {
    const patch = {};
    if (!activeDraft) return patch;
    for (const key of ['name', 'level_number', 'elevation_base_m', 'elevation_top_m', 'phase_id']) {
      if (activeDraft[key] !== undefined && activeDraft[key] !== '') {
        patch[key] = key === 'name' || key === 'phase_id' ? activeDraft[key] : Number(activeDraft[key]);
      }
    }
    return patch;
  };

  const stageEdit = () => {
    const patch = patchFromDraft();
    if (Object.keys(patch).length === 0) return;
    onStage({ kind: 'update_entity', entity_ref: { entity_id: feature.entityId, entity_type: feature.entityType }, payload: { patch } });
    setDraft(null);
  };

  const stageRemove = () => {
    onStage({ kind: 'remove_entity', entity_ref: { entity_id: feature.entityId, entity_type: feature.entityType }, payload: { cascade: removeCascade } });
  };

  const stagePhase = (phaseId) => {
    if (!phaseId) return;
    onStage({ kind: 'assign_phase', entity_ref: { entity_id: feature.entityId, entity_type: feature.entityType }, payload: { phase_id: phaseId } });
  };

  const stageSourceState = (capacityState) => {
    onStage({
      kind: 'set_utility_source',
      payload: {
        // The *source's* id, not the selected entity's: when this is reached through an
        // interface the selection is the interface, and writing its id here would name a
        // source that does not exist.
        utility_source_id: source.utilitySourceId,
        name: source?.displayName ?? feature.displayName ?? 'Utility source',
        kind: source.kind,
        capacity_value: source.capacityValue === null ? undefined : Number(source.capacityValue),
        capacity_unit: source.capacityUnit,
        capacity_basis: source.capacityBasis,
        capacity_state: capacityState,
        failure_domain_id: source.failureDomainId,
        phase_id: source.phaseId,
      },
    });
  };

  return (
    <aside className="inspector" aria-label="Selected entity" ref={rootRef}>
      <Watermark />
      <div className="inspector__head">
        <div>
          <h2 className="inspector__title">{feature.displayName ?? feature.entityType}</h2>
          <p className="inspector__kind">
            {feature.entityType} · {feature.role}
          </p>
        </div>
        <button type="button" className="inspector__close" onClick={onClear}>
          Clear
        </button>
      </div>

      <dl className="inspector__facts">
        {describeFeature(feature, facility).map((line) => (
          <dd key={line} className="inspector__fact">
            {line}
          </dd>
        ))}
      </dl>

      {staged.length > 0 ? (
        <p className="inspector__staged" role="status">
          {staged.length} pending change(s) for this entity.
        </p>
      ) : null}

      {blockedReason ? <p className="inspector__blocked">{blockedReason}</p> : null}

      <div className="inspector__tabs" role="tablist" aria-label="Inspector sections">
        {INSPECTOR_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`inspector-tab-${name}`}
            aria-selected={activeTab === name}
            aria-controls={`inspector-panel-${name}`}
            className={`inspector__tab${activeTab === name ? ' inspector__tab--active' : ''}`}
            onClick={() => chooseTab(name)}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      <section
        className="inspector__panel"
        id="inspector-panel-OVERVIEW"
        role="tabpanel"
        aria-labelledby="inspector-tab-OVERVIEW"
        hidden={activeTab !== 'OVERVIEW'}
      >
        {editable && container ? (
          <div className="inspector__form">
            <label className="inspector__field" data-field-path="name">
              <span>Name</span>
              <input type="text" value={field('name')} onChange={(event) => editDraft('name', event.target.value)} />
            </label>
            {carriesLevel ? (
              <label className="inspector__field" data-field-path="level_number">
                <span>Level number</span>
                <input
                  type="number"
                  value={field('level_number')}
                  onChange={(event) => editDraft('level_number', event.target.value)}
                />
              </label>
            ) : (
              <p className="inspector__hint">
                Only a floor or a hall carries a level number, so this {container.kind.toLowerCase().replace(/_/g, ' ')} does
                not offer one.
              </p>
            )}
            <label className="inspector__field" data-field-path="elevation_base_m">
              <span>Base elevation (m)</span>
              <input
                type="number"
                value={field('elevation_base_m')}
                onChange={(event) => editDraft('elevation_base_m', event.target.value)}
              />
            </label>
            <label className="inspector__field" data-field-path="elevation_top_m">
              <span>Top elevation (m)</span>
              <input
                type="number"
                value={field('elevation_top_m')}
                onChange={(event) => editDraft('elevation_top_m', event.target.value)}
              />
            </label>

            <button type="button" className="inspector__stage" disabled={!activeDraft} onClick={stageEdit}>
              Stage edit
            </button>

            <div className="inspector__danger">
              <label className="inspector__field">
                <span>Remove</span>
                <select value={removeCascade} onChange={(event) => setRemoveCascade(event.target.value)}>
                  <option value="NONE">This entity only</option>
                  <option value="CHILDREN">This entity and its children</option>
                </select>
              </label>
              <button type="button" className="inspector__remove" onClick={stageRemove}>
                Stage removal
              </button>
            </div>
          </div>
        ) : (
          <p className="inspector__empty">
            {container
              ? 'This entity has no editable container fields for the current scope.'
              : 'Overview shows identity, parent, and geometry role. This entity carries no editable container fields.'}
          </p>
        )}
      </section>

      <section
        className="inspector__panel"
        id="inspector-panel-UTILITIES"
        role="tabpanel"
        aria-labelledby="inspector-tab-UTILITIES"
        hidden={activeTab !== 'UTILITIES'}
      >
        {editable && source ? (
          <div className="inspector__form">
            <p className="inspector__hint">
              {sourceViaInterface
                ? 'This interface is supplied by '
                : 'The catalog refuses to treat a non-firm source as firm availability, so this is how a '}
              {sourceViaInterface ? (
                <>
                  <strong>{source.displayName ?? 'a utility source'}</strong>, and setting that source&apos;s
                  capacity state is how a POWER, COOLING, WATER, FUEL or NETWORK_ENTRY finding is cleared.
                </>
              ) : (
                'POWER, COOLING, WATER, FUEL or NETWORK_ENTRY finding is cleared.'
              )}
            </p>
            <div className="inspector__field" data-field-path="capacity_state">
              <span>Capacity state</span>
              <div className="inspector__choices">
                {['FIRM', 'COMMISSIONED', 'CONTRACTUAL', 'PLANNED'].map((capacityState) => (
                  <button
                    key={capacityState}
                    type="button"
                    className={`inspector__choice${source.capacityState === capacityState ? ' inspector__choice--current' : ''}`}
                    onClick={() => stageSourceState(capacityState)}
                  >
                    {capacityState}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <p className="inspector__empty">This entity carries no utility source or interface to edit.</p>
        )}
      </section>

      <section
        className="inspector__panel"
        id="inspector-panel-ENVIRONMENT"
        role="tabpanel"
        aria-labelledby="inspector-tab-ENVIRONMENT"
        hidden={activeTab !== 'ENVIRONMENT'}
      >
        <p className="inspector__empty">
          Environmental profiles and limits are not recorded for this entity in this revision.
        </p>
      </section>

      <section
        className="inspector__panel"
        id="inspector-panel-PHASING"
        role="tabpanel"
        aria-labelledby="inspector-tab-PHASING"
        hidden={activeTab !== 'PHASING'}
      >
        {editable && phases.length > 0 ? (
          <label className="inspector__field" data-field-path="phase_id">
            <span>Assign to phase</span>
            <select value="" onChange={(event) => stagePhase(event.target.value)}>
              <option value="">Choose a phase…</option>
              {phases.map((phase) => (
                <option key={phase.phaseId} value={phase.phaseId}>
                  {phase.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="inspector__empty">
            {phases.length === 0 ? 'No facility phases are available in this revision.' : 'Assigning a phase needs write access to this revision.'}
          </p>
        )}
      </section>

      <section
        className="inspector__panel"
        id="inspector-panel-ASSUMPTIONS"
        role="tabpanel"
        aria-labelledby="inspector-tab-ASSUMPTIONS"
        hidden={activeTab !== 'ASSUMPTIONS'}
      >
        <p className="inspector__empty">No assumption names this entity in this revision.</p>
      </section>

      <section
        className="inspector__panel"
        id="inspector-panel-DOCUMENTS"
        role="tabpanel"
        aria-labelledby="inspector-tab-DOCUMENTS"
        hidden={activeTab !== 'DOCUMENTS'}
      >
        <p className="inspector__empty">No document is attached to this entity in this revision.</p>
      </section>
    </aside>
  );
}
