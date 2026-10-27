import { DRAWER_MAX_PX, DRAWER_MIN_PX, activeDrawerTab, drawerBadge } from '../state/bottom-drawer.js';
import { Icon } from './icons.jsx';
import { Watermark } from './Watermark.jsx';

/**
 * The bottom drawer: shell-level, cross-cutting panels that stay available while
 * the active tool is open. It does not replace the main-view tab set.
 *
 * The drawer is one row. A separate title bar for the region spent a whole strip of
 * height saying "Panels", so the handle, the tabs, the count, and the resize
 * control share that row instead: the handle is the disclosure control, the tabs
 * are the panel switcher, resizing sits at the trailing edge.
 *
 * ui-pattern.md, "Drawer Behavior": clicking the handle *or selecting a drawer tab*
 * expands the drawer, and a badge on the handle shows concise counts. That is why
 * the tabs stay visible while collapsed — selecting one is an expansion gesture.
 *
 * Resize is a labelled range input rather than a drag handle, so it is keyboard
 * reachable instead of pointer-only. Selecting a tab is an explicit action and never
 * steals focus from an in-progress edit by itself.
 */
export function BottomDrawer({
  drawer,
  onOpen = () => {},
  onClose = () => {},
  onSelectTab = () => {},
  onCloseTab = () => {},
  onResize = () => {},
}) {
  const active = activeDrawerTab(drawer);
  const badge = drawerBadge(drawer);
  const badgeLabel =
    badge.unreadCount > 0 ? `${badge.unreadCount} unread, worst severity ${badge.severity}` : 'no unread items';

  return (
    <section className={`drawer${drawer.open ? ' drawer--open' : ''}`} aria-label="Workspace panels">
      {/* Only while expanded: collapsed, the drawer is a 38px bar and a watermark across it
          would be a smudge rather than a stamp. It sits on the drawer rather than inside
          `.drawer__body` because that element scrolls, and an absolutely-positioned child of
          a scroll container scrolls away with the content it is meant to sit behind. */}
      {drawer.open ? <Watermark /> : null}
      <div className="drawer__bar">
        <button
          type="button"
          className="drawer__handle"
          aria-expanded={drawer.open}
          aria-label={drawer.open ? 'Collapse panels' : 'Expand panels'}
          title={drawer.open ? 'Collapse panels' : 'Expand panels'}
          onClick={() => (drawer.open ? onClose() : onOpen())}
        >
          <Icon name={drawer.open ? 'chevronDown' : 'chevronUp'} size={14} />
          <span className="visually-hidden">Panels</span>
          <span className="drawer__badge" aria-label={badgeLabel}>
            {badge.unreadCount > 0 ? badge.unreadCount : ''}
            {badge.severity === 'ERROR' ? <Icon name="alertCircle" size={12} /> : null}
            {badge.severity === 'WARNING' ? <Icon name="alertTriangle" size={12} /> : null}
          </span>
        </button>

        <div className="drawer__tabs" role="tablist" aria-label="Panel tabs">
          {drawer.tabs.map((tab) => (
            <span
              key={tab.tabId}
              // The tab box is the wrapper, so the label and its close control share
              // one tab shape; the selected state lives here for the same reason.
              className={`drawer__tab-wrap${tab.tabId === drawer.activeTabId ? ' drawer__tab-wrap--active' : ''}`}
            >
              <button
                type="button"
                role="tab"
                className="drawer__tab"
                aria-selected={tab.tabId === drawer.activeTabId}
                aria-label={drawerTabLabel(tab)}
                onClick={() => onSelectTab(tab.tabId)}
              >
                {tab.label}
                {tab.unreadCount > 0 ? <span className="drawer__count"> {tab.unreadCount}</span> : null}
              </button>
              {tab.closeable ? (
                <button
                  type="button"
                  className="drawer__tab-close"
                  aria-label={`Close ${tab.label}`}
                  title={`Close ${tab.label}`}
                  onClick={() => onCloseTab(tab.tabId)}
                >
                  <Icon name="close" size={12} />
                </button>
              ) : null}
            </span>
          ))}
        </div>

        {/* Resizing only means anything while the body is on screen. */}
        {drawer.open ? (
          <label className="drawer__resize">
            <span className="visually-hidden">Panel height</span>
            <input
              type="range"
              min={DRAWER_MIN_PX}
              max={DRAWER_MAX_PX}
              value={drawer.heightPx}
              onChange={(event) => onResize(Number(event.target.value))}
            />
          </label>
        ) : null}
      </div>

      {drawer.open ? (
        <div className="drawer__body">
          <div className="drawer__content" role="tabpanel" aria-label={active?.label ?? 'Panel'}>
            <p className="drawer__placeholder">
              {active ? `${active.label} content is provided by its owning service.` : 'No panel selected.'}
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function drawerTabLabel(tab) {
  const severity = tab.severity && tab.severity !== 'NONE' ? `, severity ${tab.severity}` : '';
  const unread = tab.unreadCount > 0 ? `, ${tab.unreadCount} unread` : '';
  return `${tab.label}${unread}${severity}`;
}
