import { useMemo, useState } from 'react';
import { Can } from '../permissions/usePermission.jsx';
import { boundToolLabels, filterAssets, formatBytes, scanStateLabel, selectability } from './asset-state.js';

/**
 * The Assets surface: a supporting workspace, not a design tool.
 *
 * It lists project assets with kind, media type, version, size, uploader, scan
 * state, classification, and the tools that bind them, and it never edits design
 * entities (ui-pattern.md, "Assets Surface"). Scan and processing state are
 * rendered as text plus an icon; blocked rows explain why in words.
 *
 * The table is a real table with column headers so assistive technology can
 * navigate it by row and column rather than reading a grid of buttons.
 */
export function AssetsSurface({
  assets = [],
  projectId = null,
  toolLabels = {},
  kindOptions = [],
  scanOptions = ['ALL', 'CLEAN', 'PENDING', 'INFECTED', 'FAILED', 'NOT_SCANNED'],
  onUpload = () => {},
  onNewVersion = () => {},
  onDownload = () => {},
  onArchive = () => {},
  onDelete = () => {},
  busy = false,
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('ALL');
  const [scanState, setScanState] = useState('ALL');

  const visible = useMemo(() => filterAssets(assets, { query, kind, scanState }), [assets, query, kind, scanState]);

  return (
    <section className="assets" aria-label="Project assets">
      <div className="assets__head">
        <h1 className="assets__title">Assets</h1>
        <Can permission="asset.write" projectId={projectId} fallback={null}>
          <button type="button" className="assets__upload" onClick={() => onUpload('assets_surface')}>
            Upload files
          </button>
        </Can>
      </div>

      <p className="assets__note">
        Assets belong to the project and are shared with every authorized tool. This surface never edits design data.
      </p>

      <div className="assets__filters">
        <label className="assets__search">
          <span className="visually-hidden">Search assets</span>
          <input type="search" placeholder="Search assets..." value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="assets__filter">
          <span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="ALL">All kinds</option>
            {kindOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="assets__filter">
          <span>Scan</span>
          <select value={scanState} onChange={(event) => setScanState(event.target.value)}>
            {scanOptions.map((option) => (
              <option key={option} value={option}>
                {option === 'ALL' ? 'All scan states' : scanStateLabel(option).text}
              </option>
            ))}
          </select>
        </label>
      </div>

      {busy ? <p role="status">Loading assets…</p> : null}

      {visible.length === 0 ? (
        <p className="assets__empty">{assets.length === 0 ? 'No assets yet.' : 'No assets match the current filters.'}</p>
      ) : (
        <table className="assets__table">
          <caption className="visually-hidden">Project assets with version, scan state, classification, and bound tools</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Media type</th>
              <th scope="col">Version</th>
              <th scope="col">Size</th>
              <th scope="col">Uploader</th>
              <th scope="col">Scan</th>
              <th scope="col">Access</th>
              <th scope="col">Bound tools</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((asset) => (
              <AssetRow
                key={asset.assetId}
                asset={asset}
                projectId={projectId}
                toolLabels={toolLabels}
                onNewVersion={onNewVersion}
                onDownload={onDownload}
                onArchive={onArchive}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AssetRow({ asset, projectId = null, toolLabels, onNewVersion, onDownload, onArchive, onDelete }) {
  const scan = scanStateLabel(asset.scanState);
  const verdict = selectability(asset);
  const tools = boundToolLabels(asset, toolLabels);
  const blocked = verdict.selectable ? null : verdict.reason;

  return (
    <tr className={`asset-row${verdict.selectable ? '' : ' asset-row--blocked'}`}>
      <th scope="row" className="asset-row__name">
        {asset.name}
        {blocked ? <span className="asset-row__blocked"> — {blocked}</span> : null}
      </th>
      <td>{asset.kind ?? '—'}</td>
      <td>{asset.mediaType ?? '—'}</td>
      <td>
        v{asset.versionNumber ?? 1}
        {asset.currentVersionNumber && asset.currentVersionNumber !== asset.versionNumber ? ' (older)' : ''}
      </td>
      <td>{formatBytes(asset.sizeBytes)}</td>
      <td>{asset.uploader ?? '—'}</td>
      <td>
        <span className="asset-row__scan" aria-label={scan.text}>
          <span aria-hidden="true">{scan.icon}</span> {scan.text}
        </span>
      </td>
      <td>{asset.classification ?? 'PROJECT'}</td>
      <td>{tools.length > 0 ? tools.join(', ') : 'not bound'}</td>
      <td className="asset-row__actions">
        <button type="button" onClick={() => onNewVersion(asset)} aria-label={`Upload a new version of ${asset.name}`}>
          New version
        </button>
        <button type="button" onClick={() => onDownload(asset)} aria-label={`Download ${asset.name}`}>
          Download
        </button>
        <button type="button" onClick={() => onArchive(asset)} aria-label={`Archive ${asset.name}`}>
          Archive
        </button>
        <Can permission="asset.delete" projectId={projectId} fallback={null}>
          <button type="button" onClick={() => onDelete(asset)} aria-label={`Delete ${asset.name}`}>
            Delete
          </button>
        </Can>
      </td>
    </tr>
  );
}
