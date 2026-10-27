import { useEffect, useState } from 'react';
import {
  BINDING_ROLES,
  defaultBindingRole,
  describeBindingAgainstAssets,
  orderRepresentations,
  representationLabel,
  scanStateLabel,
  selectability,
  upgradeAffordance,
} from './asset-state.js';

/**
 * The asset picker a tool uses to consume an existing project asset.
 *
 * A tool selects an exact version and representation and never re-uploads an asset
 * that already exists (ui-pattern.md, "Import Entry Points" 3). Blocked assets are
 * listed with a textual reason rather than hidden (rule 5), and an upgrade is an
 * explicit action that re-enters the tool's review workflow (rule 4).
 *
 * Selection is controlled when the caller passes `selectedAssetId`: the versions and
 * representations of the chosen asset are a second read, so the surface that owns
 * the request has to own the choice. Without it the picker keeps its own, which is
 * what a caller holding every asset already loaded wants.
 */
export function AssetPicker({
  assets = [],
  bindings = [],
  onSelect = () => {},
  onUpgrade = () => {},
  onImportNew = () => {},
  canImport = false,
  selectedAssetId = null,
  onSelectAsset = null,
  detailPending = false,
  pending = false,
  error = null,
  notice = null,
  // The bound list belongs to whichever surface owns the revision's provenance. A
  // caller that renders its own — with the columns it needs — turns this off rather
  // than showing the same facts twice.
  showBoundList = true,
}) {
  const [ownSelectedId, setOwnSelectedId] = useState(assets[0]?.assetId ?? null);
  const [representations, setRepresentations] = useState({});
  const [versions, setVersions] = useState({});
  const [roles, setRoles] = useState({});

  const controlled = onSelectAsset !== null;
  const selectedId = controlled ? selectedAssetId : ownSelectedId;
  const selected = assets.find((asset) => asset.assetId === selectedId) ?? null;

  const choose = (assetId) => {
    if (controlled) onSelectAsset(assetId);
    else setOwnSelectedId(assetId);
  };

  // A new selection starts from the version the asset currently is; the user may
  // then pin an older one, which is the whole reason the control exists.
  useEffect(() => {
    if (!selected) return;
    setVersions((current) =>
      current[selected.assetId] ? current : { ...current, [selected.assetId]: selected.currentVersionId ?? null },
    );
  }, [selected]);

  const versionId = selected ? (versions[selected.assetId] ?? selected.currentVersionId ?? null) : null;
  const chosenVersion = selected?.versions?.find((item) => item.assetVersionId === versionId) ?? null;
  const role = selected ? (roles[selected.assetId] ?? defaultBindingRole(selected)) : null;
  // Representations belong to a version, so they follow the chosen one; a caller that
  // only loaded the newest version's derivatives still gets those. The role orders
  // them, because the derivative a source wants is not the one a reference wants.
  const availableRepresentations = orderRepresentations(
    chosenVersion?.representations ?? selected?.representations ?? [],
    role,
  );
  const representationId =
    representations[selected?.assetId] ?? availableRepresentations[0]?.representationId ?? null;

  const verdict = selectability(selected);
  const bindable = Boolean(selected) && verdict.selectable && Boolean(role);

  return (
    <section className="picker" aria-label="Choose a project asset">
      <h2 className="picker__title">Choose an asset</h2>

      {canImport ? (
        <button type="button" className="picker__import" onClick={() => onImportNew('tool_import')}>
          Import a new file
        </button>
      ) : null}

      {error ? (
        <p className="picker__error" role="alert">
          {error.message ?? 'The project assets could not be read.'}
        </p>
      ) : null}
      {notice ? (
        <p className="picker__notice" role="status">
          {notice}
        </p>
      ) : null}

      {assets.length === 0 ? (
        <p className="picker__empty">
          This project has no assets yet. Import a file to create one; every tool in the project can then use it.
        </p>
      ) : (
        <ul className="picker__list" aria-label="Project assets">
          {assets.map((asset) => {
            const assetVerdict = selectability(asset);
            const scan = scanStateLabel(asset.scanState);
            return (
              <li key={asset.assetId} className="picker__item">
                <label>
                  <input
                    type="radio"
                    name="asset"
                    value={asset.assetId}
                    checked={asset.assetId === selectedId}
                    disabled={!assetVerdict.selectable}
                    onChange={() => choose(asset.assetId)}
                  />
                  <span className="picker__name">{asset.name}</span>
                  <span className="picker__meta">
                    {asset.kind} · {asset.mediaType}
                    {asset.currentVersionNumber ? ` · v${asset.currentVersionNumber}` : ''}
                  </span>
                  <span className="picker__scan" aria-label={scan.text}>
                    <span aria-hidden="true">{scan.icon}</span> {scan.text}
                  </span>
                  {assetVerdict.selectable ? null : <span className="picker__reason"> — {assetVerdict.reason}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {selected && verdict.selectable ? (
        <div className="picker__form">
          {detailPending ? <p className="picker__pending" role="status">Reading versions…</p> : null}

          <label className="picker__field">
            <span>Version</span>
            <select
              value={versionId ?? ''}
              onChange={(event) => {
                setVersions({ ...versions, [selected.assetId]: event.target.value });
                // A representation belongs to one version, so pinning a different
                // version must not carry the previous version's choice across.
                setRepresentations({ ...representations, [selected.assetId]: undefined });
              }}
            >
              {(selected.versions?.length ? selected.versions : [{ assetVersionId: selected.currentVersionId, versionNumber: selected.currentVersionNumber }]).map(
                (version) => (
                  <option key={version.assetVersionId} value={version.assetVersionId}>
                    v{version.versionNumber ?? '?'}
                    {version.assetVersionId === selected.currentVersionId ? ' · current' : ''}
                    {version.status && version.status !== 'CURRENT' ? ` · ${version.status}` : ''}
                  </option>
                ),
              )}
            </select>
          </label>

          <label className="picker__field">
            <span>Representation</span>
            {availableRepresentations.length > 0 ? (
              <select
                value={representationId ?? ''}
                onChange={(event) =>
                  setRepresentations({ ...representations, [selected.assetId]: event.target.value })
                }
              >
                {availableRepresentations.map((representation) => (
                  <option key={representation.representationId} value={representation.representationId}>
                    {representationLabel(representation)}
                    {representation.status && representation.status !== 'READY' ? ` · ${representation.status}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span className="picker__field-note">
                No representation has been produced for this version. The binding pins the version and awaits one.
              </span>
            )}
          </label>

          <label className="picker__field">
            <span>Role</span>
            <select
              value={role}
              onChange={(event) => setRoles({ ...roles, [selected.assetId]: event.target.value })}
            >
              {BINDING_ROLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="picker__field-note">
              {BINDING_ROLES.find((option) => option.value === role)?.hint}
            </span>
          </label>

          <button
            type="button"
            className="picker__bind"
            disabled={!bindable || pending}
            onClick={() =>
              onSelect({
                assetId: selected.assetId,
                assetName: selected.name,
                assetVersionId: versionId,
                representationId,
                role,
              })
            }
          >
            {pending ? 'Binding…' : 'Bind to revision'}
          </button>
        </div>
      ) : null}

      {showBoundList && bindings.length > 0 ? (
        <section className="picker__bindings" aria-label="Bound assets">
          <h3 className="picker__subtitle">Bound in this revision</h3>
          <ul className="picker__bound-list">
            {bindings.map((binding) => {
              const described = describeBindingAgainstAssets(binding, assets);
              const upgrade = upgradeAffordance(binding, assets.find((item) => item.assetId === binding.assetId));
              const scan = described.authoritative
                ? { text: 'Reviewed', icon: '✓' }
                : { text: 'Not reviewed', icon: '!' };
              return (
                <li key={binding.bindingId} className="picker__bound">
                  <span className="picker__bound-name">{described.assetName ?? 'Unknown asset'}</span>
                  <span className="picker__bound-meta">
                    {described.filename ?? '—'}
                    {described.versionNumber ? ` · v${described.versionNumber}` : ''} · {described.role}
                  </span>
                  <span className="picker__bound-state">
                    <span aria-hidden="true">{scan.icon}</span> {scan.text}
                  </span>
                  {upgrade ? (
                    <button type="button" className="picker__upgrade" onClick={() => onUpgrade(upgrade)}>
                      {upgrade.label} — review and upgrade
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
