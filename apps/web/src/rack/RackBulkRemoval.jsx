import { useState } from 'react';
import { bulkRemoval, removalItems, filterRemovalItems } from './bulk-removal.js';

const PAGE_SIZE = 50;

export function RackBulkRemoval({ kind, placements, equipment, savedPlacements = placements, editable, onApply, onUnlock }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState([]);
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const items = removalItems(kind, placements, equipment, savedPlacements);
  const existing = new Set(items.map(i => i.id));
  const selected = new Set(selection.filter(id => existing.has(id)));
  const filtered = filterRemovalItems(items, kind, query, filter);
  const eligible = filtered.filter(i => !i.blocked);
  const blockedCount = filtered.length - eligible.length;
  const unlockableIds = kind === 'racks' ? filtered.filter(i => placements.some(r => r.rackId === i.id && r.locked)).map(i => i.id) : [];
  const pendingUnlocks = kind === 'racks' ? filtered.filter(i => i.blocked && !placements.find(r => r.rackId === i.id)?.locked).length : 0;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const currentReview = review && review.placements === placements && review.equipment === equipment && review.savedPlacements === savedPlacements;
  const hiddenCount = [...selected].filter(id => !filtered.some(i => i.id === id)).length;
  function choose(ids) { setSelection(ids); setReview(null); setError(null); }
  function preview() {
    if (!editable) return;
    try {
      const ids = [...selected];
      const result = bulkRemoval({ kind, ids, placements, equipment, savedPlacements });
      setReview({ ids, result, placements, equipment, savedPlacements });
      setError(null);
    } catch (e) { setError(e.message); }
  }
  function confirm() {
    if (!editable || !currentReview) return;
    try {
      // The parent rechecks against its current editable draft before changing it.
      onApply(review.ids);
      choose([]);
    } catch (e) { setError(e.message); setReview(null); }
  }
  return <details className="rack-bulk-removal" open>
    <summary>Bulk remove {kind}</summary>
    <p className="rack-muted">{kind === 'racks'
      ? 'Remove unlocked racks and keep their devices as unassigned inventory. Locked racks must be unlocked and saved first.'
      : 'Remove selected devices from this plan, including installed devices.'} Changes enter the draft; Save layout to persist or Discard changes to undo.</p>
    {!editable && <p role="status">Bulk removal requires an editable draft.</p>}
    <div className="rack-bulk-filters">
      <label>Search {kind}<input type="search" value={query} placeholder="Name, ID or model"
        onChange={e => { setQuery(e.target.value); setPage(0); setReview(null); }} /></label>
      <label>{kind === 'racks' ? 'Rack status' : 'Device location'}<select value={filter}
        onChange={e => { setFilter(e.target.value); setPage(0); setReview(null); }}>
        <option value="all">All {kind}</option>
        {kind === 'racks' ? <option value="unlocked">Unlocked racks</option> : <>
          <option value="unassigned">Unassigned devices</option>
          {placements.map(r => <option key={r.rackId} value={r.rackId}>{r.name}</option>)}
        </>}
      </select></label>
    </div>
    {kind === 'racks' && blockedCount > 0 && <div className="rack-notice" role="status">
      <p>{blockedCount} position-locked racks excluded from selection. Position locks protect racks from moving or deletion; they do not lock devices.</p>
      {onUnlock && <button disabled={!editable || !unlockableIds.length} onClick={() => {
        if (!editable || !unlockableIds.length) return;
        try { onUnlock(unlockableIds); setReview(null); setError(null); } catch (e) { setError(e.message); }
      }}>Unlock filtered racks ({unlockableIds.length})</button>}
      <p>{pendingUnlocks > 0 ? `${pendingUnlocks} unlocks pending save. ` : ''}Save layout after unlocking, then select the racks and delete them.</p>
    </div>}
    <div className="rack-bulk-toolbar">
    <div className="rack-actions">
      <button disabled={!editable || !eligible.length} onClick={() => choose([...new Set([...selected, ...eligible.map(i => i.id)])])}>Select filtered ({eligible.length})</button>
      <button disabled={!selected.size} onClick={() => choose([])}>Clear selection</button>
      <button className="rack-bulk-delete" disabled={!editable || !selected.size} onClick={preview}>Delete selected {kind} ({selected.size})</button>
    </div>
    <p role="status">{selected.size} selected{hiddenCount ? ` · ${hiddenCount} outside current filter` : ''}. Select filtered includes all matching pages.</p>
    {error && <p role="alert" className="rack-error">{error}</p>}
    {review && <div className="rack-bulk-review" role="group" aria-label="Confirm bulk removal">
      <p><strong>Delete {review.result.removedCount} {kind}?</strong> {kind === 'racks'
        ? `${review.result.unassignedCount} installed devices will become unassigned. No devices will be deleted.`
        : 'Selected devices will be removed from inventory and U slots.'}</p>
      <p>{items.filter(i => review.ids.includes(i.id)).slice(0, 10).map(i => i.name).join(', ')}{review.ids.length > 10 ? `, and ${review.ids.length - 10} more` : ''}</p>
      {!currentReview && <p role="alert">The layout changed. Review the selection again.</p>}
      <div className="rack-actions"><button className="rack-bulk-delete" disabled={!editable || !currentReview} onClick={confirm}>Confirm deletion ({review.result.removedCount} {kind})</button>
        <button onClick={() => setReview(null)}>Cancel</button></div>
      <p className="rack-muted">Deletion enters the draft. Save layout to persist, or Discard changes to undo.</p>
    </div>}
    </div>
    <ul className="rack-bulk-list" aria-label={`${kind} bulk selection`}>
      {visible.map(item => <li key={item.id}><label>
        <input type="checkbox" checked={selected.has(item.id)} disabled={!editable || item.blocked}
          onChange={e => choose(e.target.checked ? [...selected, item.id] : [...selected].filter(id => id !== item.id))} />
        <span><strong>{item.name}</strong><small>{item.detail}</small></span>
      </label></li>)}
    </ul>
    {!filtered.length && <p>No matching {kind}.</p>}
    <div className="rack-actions">
      <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span>Page {currentPage + 1} of {pages} · {filtered.length} matching {kind}</span>
      <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div>
  </details>;
}
