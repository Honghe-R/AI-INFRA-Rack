export function RackConstraints({
  constraints: c,
  editable,
  onChange,
  selectedId,
  onSelect,
  onFocus,
  extent,
}) {
  const selected = c.obstacles.find((o) => o.obstacleId === selectedId);
  const patch = (value) => {
    if (editable) onChange({ ...c, ...value });
  };
  const patchObstacle = (value) =>
    patch({ obstacles: c.obstacles.map((o) => (o.obstacleId === selectedId ? { ...o, ...value } : o)) });
  const numeric = (value) => (value === '' ? NaN : Number(value));
  return (
    <section className="rack-card rack-constraints" aria-label="Planning constraints">
      <h3>Planning constraints</h3>
      <p className="rack-muted">
        Rack-owned assumptions in local metres. These do not change Facility geometry or establish surveyed
        conditions.
      </p>
      <label>
        Planning input reference
        <textarea
          value={c.source.reference}
          maxLength={512}
          disabled={!editable}
          onChange={(e) => patch({ source: { kind: 'ASSUMED', reference: e.target.value } })}
        />
      </label>
      <label>
        Obstacle coverage
        <select
          value={c.obstacleCoverage}
          disabled={!editable}
          onChange={(e) => patch({ obstacleCoverage: e.target.value })}
        >
          <option value="UNKNOWN">Unknown — unrecorded obstacles may exist</option>
          <option value="DECLARED_COMPLETE">
            I declare this obstacle list complete for this planning assumption
          </option>
        </select>
      </label>
      <label className="rack-lock-field">
        <input
          type="checkbox"
          checked={c.clearance !== null}
          disabled={!editable}
          onChange={(e) => patch({ clearance: e.target.checked ? { frontM: 0, rearM: 0 } : null })}
        />
        Check front/rear maintenance distances
      </label>
      {c.clearance !== null && (
        <div className="rack-form-fields">
          {['frontM', 'rearM'].map((key) => (
            <label key={key}>
              {key === 'frontM' ? 'Front clearance (m)' : 'Rear clearance (m)'}
              <input
                type="number"
                step="0.05"
                min="0"
                max="10"
                value={Number.isFinite(c.clearance[key]) ? c.clearance[key] : ''}
                disabled={!editable}
                onChange={(e) => patch({ clearance: { ...c.clearance, [key]: numeric(e.target.value) } })}
              />
            </label>
          ))}
        </div>
      )}
      <p className="rack-muted">
        Unset means not checked. Zero is an explicit zero requirement. Bands follow each rack's front/rear
        direction; maintenance bands may share space. Access routes and side clearances are unchecked.
      </p>
      <div className="rack-actions">
        <h4>Planning obstacles · {c.obstacles.length}/64</h4>
        <button
          disabled={!editable || c.obstacles.length >= 64}
          onClick={() => {
            const id = crypto.randomUUID();
            patch({
              obstacles: [
                ...c.obstacles,
                {
                  obstacleId: id,
                  name: `Obstacle ${c.obstacles.length + 1}`,
                  xM: extent.width / 2,
                  yM: extent.height / 2,
                  widthM: 1,
                  depthM: 1,
                },
              ],
            });
            onSelect(id);
            onFocus(id);
          }}
        >
          Add obstacle
        </button>
      </div>
      <label>
        Selected obstacle
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            onSelect(e.target.value);
            if (e.target.value) onFocus(e.target.value);
          }}
        >
          <option value="">Choose an obstacle</option>
          {c.obstacles.map((o) => (
            <option key={o.obstacleId} value={o.obstacleId}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <label>
            Obstacle name
            <input
              value={selected.name}
              maxLength={160}
              disabled={!editable}
              onChange={(e) => patchObstacle({ name: e.target.value })}
            />
          </label>
          <div className="rack-form-fields">
            {[
              ['xM', 'Obstacle X centre (m)'],
              ['yM', 'Obstacle Y centre (m)'],
              ['widthM', 'Obstacle width (m)'],
              ['depthM', 'Obstacle depth (m)'],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  step="0.01"
                  min={key === 'xM' || key === 'yM' ? -10000 : 0.001}
                  max="10000"
                  value={Number.isFinite(selected[key]) ? selected[key] : ''}
                  disabled={!editable}
                  onChange={(e) => patchObstacle({ [key]: numeric(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <div className="rack-actions">
            <button onClick={() => onFocus(selectedId)}>Focus obstacle</button>
            <button
              disabled={!editable}
              onClick={() => {
                patch({ obstacles: c.obstacles.filter((o) => o.obstacleId !== selectedId) });
                onSelect(null);
              }}
            >
              Remove obstacle
            </button>
          </div>
        </>
      )}
    </section>
  );
}
