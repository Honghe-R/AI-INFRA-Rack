/**
 * The bucket of objects that have no geometry.
 *
 * A feature on the map is built from a geometry record, so an entity without one produces no
 * feature and cannot be seen, selected, or fixed by clicking it. These objects are therefore
 * unreachable from the canvas, and this palette is the only place they appear.
 *
 * It exists only when there is something in it. An empty bucket has nothing to say, and a
 * permanent panel saying "nothing is missing" is furniture.
 *
 * Placement differs by the geometry the object owes, and the palette says which: a
 * `CONNECTION_POINT` is a point and drops where it is released, while a `FOOTPRINT` or
 * `BOUNDARY` is a polygon and cannot be carried by a drop — releasing it arms a draw for that
 * object, and the shape is completed in the site's normal way. The badge on each row states
 * the kind of placement so the two behaviours are not a surprise.
 */
export function CanvasPalette({ items = [], onDragStart = null, onDragEnd = null }) {
  if (items.length === 0) return null;

  return (
    <aside className="canvas-palette" aria-label="Objects without geometry">
      <p className="canvas-palette__title">
        <span className="canvas-palette__count">{items.length}</span>
        {items.length === 1 ? 'object to place' : 'objects to place'}
      </p>
      <ul className="canvas-palette__list">
        {items.map((item) => (
          <li key={item.entityId}>
            <div
              className="canvas-palette__item"
              // Native drag rather than a pointer gesture: the map surface already claims
              // pointer events for panning, and a drag the browser owns is not something the
              // surface can mistake for a pan.
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('text/plain', item.entityId);
                onDragStart?.(item);
              }}
              onDragEnd={() => onDragEnd?.(item)}
              title={`${item.name ?? item.entityId} — ${item.geometryType === 'POINT' ? 'drop on the map' : 'drop to start drawing'}`}
            >
              <span className="canvas-palette__name">{item.name ?? item.entityId}</span>
              <span className="canvas-palette__kind">{item.entityType.toLowerCase().replace(/_/g, ' ')}</span>
              <span className={`canvas-palette__shape canvas-palette__shape--${item.geometryType.toLowerCase()}`}>
                {item.geometryType === 'POINT' ? 'point' : 'outline'}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
