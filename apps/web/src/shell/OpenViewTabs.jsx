import { useRef } from 'react';
import { getTool } from '../state/tool-registry.js';
import { Icon, toolIcon } from './icons.jsx';

/**
 * Open-view tabs: a working set, not a second navigation tree.
 *
 * Tabs expose their selected state, unread count, and severity as text so
 * assistive technology can read them (ui-pattern.md, "Responsive and
 * Accessibility Requirements"). An unsaved draft shows a non-color-only
 * indicator. Overflow scrolls rather than compressing labels into illegibility.
 *
 * The open project leads the row as a static marker. It is the one thing every tab is
 * scoped to, so it belongs where the reader already looks to see what is open — and it is
 * deliberately not a control: the project is chosen on the Projects list, so a clickable
 * label here would be a second, quieter route to a context switch.
 */
export function OpenViewTabs({ tabs, activeTabId, projectName = null, onActivate = () => {}, onClose = () => {} }) {
  const listRef = useRef(null);

  function handleKeyDown(event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex((tab) => tab.tabId === activeTabId);
    if (index === -1) return;
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (next) {
      event.preventDefault();
      onActivate(next.tabId);
      listRef.current?.querySelector(`[data-tab-id="${next.tabId}"]`)?.focus();
    }
  }

  return (
    <div className="tabs" role="tablist" aria-label="Open views" ref={listRef} onKeyDown={handleKeyDown}>
      {projectName ? (
        <span className="tabs__project" title={`Project: ${projectName}`}>
          <Icon name="grid" size={13} />
          <span className="tabs__project-name">{projectName}</span>
        </span>
      ) : null}
      {tabs.map((tab) => {
        const tool = getTool(tab.toolId);
        const selected = tab.tabId === activeTabId;
        const label = tool?.label ?? tab.toolId;
        const dirty = tab.dirtyState?.dirty === true;
        const { errors = 0, warnings = 0, processing = false } = tab.badge ?? {};

        return (
          <div key={tab.tabId} className={`tab${selected ? ' tab--active' : ''}`}>
            <button
              type="button"
              role="tab"
              className="tab__label"
              data-tab-id={tab.tabId}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onActivate(tab.tabId)}
            >
              <Icon name={toolIcon(tab.toolId)} size={14} />
              <span>{label}</span>
              {dirty ? (
                <span className="tab__dirty" aria-label="Unsaved changes">
                  <Icon name="dot" size={12} />
                </span>
              ) : null}
              {errors > 0 || warnings > 0 || processing ? (
                <span className="tab__badge" aria-label={badgeText({ errors, warnings, processing })}>
                  <Icon name={errors > 0 ? 'alertCircle' : warnings > 0 ? 'alertTriangle' : 'spinner'} size={12} />
                  <span className="badge__text">{badgeText({ errors, warnings, processing })}</span>
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${label}`}
              title={`Close ${label}`}
              onClick={() => onClose(tab.tabId)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function badgeText({ errors, warnings, processing }) {
  if (errors > 0) return `${errors} error${errors === 1 ? '' : 's'}`;
  if (warnings > 0) return `${warnings} warning${warnings === 1 ? '' : 's'}`;
  if (processing) return 'processing';
  return '';
}
