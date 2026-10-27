import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetPicker } from '../assets/AssetPicker.jsx';
import { describeBindingAgainstAssets, upgradeAffordance } from '../assets/asset-state.js';
import { useAssets } from '../api/useAssets.js';
import { usePermission } from '../permissions/usePermission.jsx';
import { useRouteRequest } from './workspace-effects.js';

/**
 * Import & Map (ui-pattern.md, "Import Flow"), steps 1 and 2.
 *
 * The surface exists to answer one question honestly: which project asset versions
 * does this revision consume, and what exactly did each one pin? It lists the
 * revision's bindings, lets a user bind an existing asset version, and stops there.
 * Transform review, mapping, the merge preview, and apply are later steps with no
 * command behind them yet, and the surface says so rather than offering buttons
 * that would do nothing.
 *
 * Two reads, deliberately separate. Assets are project-scoped and shared by every
 * tool; bindings are revision-scoped and belong to this one. The chosen asset's
 * versions and representations are a third read, issued only for the selection,
 * because a project can hold hundreds of assets and loading every version of every
 * one to render a picker would be a read nobody asked for.
 *
 * Nothing here writes an entity. A binding is provenance: it records where content
 * came from, and applying it later is a change set with its own preview and its own
 * permission (import-adapters.md, "Facility Mapping Rules").
 */
export function FacilityImport({ client, projectId, revisionId = null, focus = undefined }) {
  const canBind = usePermission('facility.import.initiate', { projectId }).allowed === true;

  // A `facility.asset_binding` / `facility.import` reference routes here and names the
  // binding to show. The request is published before the route changes, so this surface
  // reads it when it mounts.
  const publishedFocus = useRouteRequest('import_map');
  const activeFocus = focus !== undefined ? focus : publishedFocus;
  const rootRef = useRef(null);

  const { assets, pending: assetsPending, error: assetsError } = useAssets({ client, projectId });
  const [bindings, setBindings] = useState([]);
  const [bindingsPending, setBindingsPending] = useState(false);
  const [bindingsError, setBindingsError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [bindPending, setBindPending] = useState(false);

  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailPending, setDetailPending] = useState(false);

  const revisionReady = Boolean(client && projectId && revisionId);

  const reloadBindings = useCallback(async () => {
    if (!revisionReady) {
      setBindings([]);
      return;
    }
    setBindingsPending(true);
    try {
      const { data } = await client.listFacilityAssetBindings(projectId, revisionId);
      setBindings(data?.asset_bindings ?? []);
      setBindingsError(null);
    } catch (error) {
      setBindings([]);
      setBindingsError(error);
    } finally {
      setBindingsPending(false);
    }
  }, [client, projectId, revisionId, revisionReady]);

  useEffect(() => {
    reloadBindings();
  }, [reloadBindings]);

  /**
   * The selected asset's versions and representations.
   *
   * A representation belongs to a version, so the pair the user picks cannot be
   * offered without this read. It is a cache keyed by asset id: going back to an
   * asset the user already opened must not re-issue the request.
   */
  const [details, setDetails] = useState({});
  useEffect(() => {
    if (!selectedAssetId || !client || !projectId) {
      setDetail(null);
      return undefined;
    }
    if (details[selectedAssetId]) {
      setDetail(details[selectedAssetId]);
      return undefined;
    }

    let active = true;
    setDetailPending(true);
    client
      .getAsset(projectId, selectedAssetId)
      .then(({ data }) => {
        if (!active) return;
        setDetails((current) => ({ ...current, [selectedAssetId]: data }));
        setDetail(data);
      })
      .catch((error) => {
        if (active) setBindingsError(error);
      })
      .finally(() => {
        if (active) setDetailPending(false);
      });

    return () => {
      active = false;
    };
  }, [client, projectId, selectedAssetId, details]);

  /**
   * The asset list the picker reads, with the selected asset's versions merged in.
   *
   * The list read carries the current version of each asset; the detail read carries
   * every version of one. Merging them here means the picker has one shape to read
   * and the extra request stays scoped to the selection.
   */
  const assetsWithDetail = useMemo(() => {
    if (!detail) return assets;
    return assets.map((asset) =>
      asset.assetId === detail.assetId
        ? { ...asset, versions: detail.versions, representations: detail.representations }
        : asset,
    );
  }, [assets, detail]);

  const boundVersionIds = useMemo(
    () => new Set(bindings.map((binding) => binding.assetVersionId)),
    [bindings],
  );

  const bind = useCallback(
    async (choice) => {
      if (!revisionReady) return;
      setBindPending(true);
      setNotice(null);
      try {
        await client.createFacilityAssetBinding(projectId, revisionId, {
          asset_version_id: choice.assetVersionId,
          representation_id: choice.representationId ?? null,
          role: choice.role,
        });
        setNotice(
          `${choice.assetName ?? 'The asset'} is bound as ${choice.role}. Review its transform and mappings before anything is applied to the draft.`,
        );
        await reloadBindings();
      } catch (error) {
        setBindingsError(error);
      } finally {
        setBindPending(false);
      }
    },
    [client, projectId, revisionId, revisionReady, reloadBindings],
  );

  const bound = bindings.map((binding) => {
    const described = describeBindingAgainstAssets(binding, assetsWithDetail);
    return {
      ...described,
      // Rule 4: a newer version never changes an existing binding, and the
      // affordance lives with the binding rather than with the picker, because it
      // is about what the revision consumes rather than about what to choose.
      upgrade: upgradeAffordance(binding, assetsWithDetail.find((asset) => asset.assetId === described.assetId)),
    };
  });

  // A binding the assistant asked this route to focus. The row is marked and brought
  // into view; a request that names nothing in this revision says so rather than
  // looking like an unfocused visit.
  const focusedBindingId = activeFocus?.bindingId ?? null;
  useEffect(() => {
    if (!focusedBindingId) return;
    const node = rootRef.current?.querySelector?.(`[data-binding-id="${focusedBindingId}"]`) ?? null;
    node?.scrollIntoView?.({ block: 'center' });
  }, [focusedBindingId, bindings]);

  const focusNotice =
    activeFocus && !bindingsPending && !bindings.some((binding) => binding.bindingId === activeFocus.bindingId)
      ? `No asset binding ${activeFocus.bindingId ?? ''} is recorded for this revision.`
      : null;

  if (!revisionReady) {
    return (
      <section className="import" aria-label="Import and map">
        <p className="import__notice" role="status">
          Import needs an open revision. Open a project and a draft revision, then return here.
        </p>
      </section>
    );
  }

  return (
    <section className="import" aria-label="Import and map" ref={rootRef}>
      <header className="import__head">
        <div>
          <h1 className="import__title">Import &amp; Map</h1>
          <p className="import__lede">
            Bind a project asset version to this revision. The file stays in the project asset store, shared with
            every other tool; this revision records which exact version it consumed.
          </p>
        </div>
        <dl className="import__summary">
          <div>
            <dt>Bound</dt>
            <dd>{bindings.length}</dd>
          </div>
          <div>
            <dt>Awaiting review</dt>
            <dd>{bound.filter((item) => !item.authoritative).length}</dd>
          </div>
          <div>
            <dt>Project assets</dt>
            <dd>{assets.length}</dd>
          </div>
        </dl>
      </header>

      {!canBind ? (
        <p className="import__notice" role="status">
          Binding a source needs <code>facility.import.initiate</code>, which your role does not hold. You can still
          read what this revision consumes.
        </p>
      ) : null}

      {bindingsError ? (
        <p className="import__error" role="alert">
          {bindingsError.message ?? 'The operation failed.'}
        </p>
      ) : null}
      {notice ? (
        <p className="import__result" role="status">
          {notice}
        </p>
      ) : null}
      {focusNotice ? (
        <p className="import__focus-notice" role="status">
          {focusNotice}
        </p>
      ) : null}

      <div className="import__body">
        <AssetPicker
          assets={assetsWithDetail}
          bindings={bindings}
          canImport={false}
          showBoundList={false}
          selectedAssetId={selectedAssetId}
          onSelectAsset={setSelectedAssetId}
          onSelect={bind}
          detailPending={detailPending}
          pending={bindPending}
          error={assetsError}
          notice={assetsPending ? 'Reading project assets…' : null}
        />

        <section className="import__bound" aria-label="Bound in this revision">
          <h2 className="import__subtitle">Bound in this revision</h2>
          {bindingsPending && bindings.length === 0 ? (
            <p className="import__pending" role="status">
              Reading bindings…
            </p>
          ) : null}
          {bindings.length === 0 && !bindingsPending ? (
            <p className="import__empty">
              This revision consumes no project assets. Bound sources appear here with the exact version each one
              pinned.
            </p>
          ) : null}

          {bound.length > 0 ? (
            <table className="import__table">
              <caption className="visually-hidden">Project asset versions bound to this revision</caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col">Version</th>
                  <th scope="col">Role</th>
                  <th scope="col">Review</th>
                </tr>
              </thead>
              <tbody>
                {bound.map((item) => (
                  <tr
                    key={item.bindingId}
                    data-binding-id={item.bindingId}
                    data-focused={focusedBindingId === item.bindingId ? 'true' : undefined}
                    className={focusedBindingId === item.bindingId ? 'import__bound-row--focused' : undefined}
                  >
                    <td>
                      <span className="import__asset-name">{item.assetName ?? 'Unknown asset'}</span>
                      <span className="import__asset-file">{item.filename ?? '—'}</span>
                    </td>
                    <td>
                      {item.versionNumber ? `v${item.versionNumber}` : '—'}
                      {boundVersionIds.has(item.assetVersionId) && item.missingAsset ? (
                        <span className="import__asset-file">version no longer listed</span>
                      ) : null}
                    </td>
                    <td>{item.role}</td>
                    <td>
                      <span className="import__review" data-authoritative={item.authoritative ? 'true' : 'false'}>
                        {item.authoritative ? '✓ Reviewed' : '! Not reviewed'}
                      </span>
                      {item.mappingsInReview > 0 ? (
                        <span className="import__asset-file">{item.mappingsInReview} mapping(s) in review</span>
                      ) : null}
                      {item.upgrade ? (
                        <button
                          type="button"
                          className="import__upgrade"
                          onClick={() =>
                            setNotice(
                              'Upgrading a binding to a newer version re-enters transform and mapping review, which this surface does not have yet.',
                            )
                          }
                        >
                          {item.upgrade.label} — review and upgrade
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <p className="import__note">
            A bound version is provenance, not design content. Nothing reaches the draft until a reviewed transform
            and mapping are applied as one change set, and applying never overwrites user-authored values.
          </p>
        </section>
      </div>
    </section>
  );
}
