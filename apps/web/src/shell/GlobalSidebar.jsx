import { useState } from 'react';
import { TOOL_GROUPS, resolveFunctionId, toolsInGroup, visibleTools } from '../state/tool-registry.js';
import { AccountControl } from './AccountControl.jsx';
import { SettingsMenu } from './SettingsMenu.jsx';
import { Watermark } from './Watermark.jsx';
import { Icon, toolIcon } from './icons.jsx';

/**
 * The global sidebar: project entry point, two-level tool navigation,
 * supporting workspaces, settings, and compact status badges.
 *
 * Accessibility commitments from ui-pattern.md, "Sidebar Navigation":
 *  * outer tools and inner functions use nested disclosure semantics
 *    (`aria-expanded` on the outer control, a list of inner functions beneath);
 *  * every icon-only control has an accessible name, not just a tooltip;
 *  * the active tool and function are marked with `aria-current`, so they are
 *    distinguishable without relying on color;
 *  * badges carry their meaning as text, never color alone;
 *  * hover expansion is additive — the pin toggle and the disclosure controls
 *    give keyboard and touch the same reach.
 */
export function GlobalSidebar({
  mode = 'EXPANDED',
  pinned = false,
  hoverExpand = false,
  activeToolId = null,
  activeFunctionId = null,
  badges = {},
  grantedKeys = null,
  onSelectTool = () => {},
  onSelectFunction = () => {},
  accountLabel = null,
  devIdentity = null,
  colorScheme = 'SYSTEM',
  resolvedColorScheme = null,
  onSetColorScheme = () => {},
  onTogglePin = null,
  onAbout = null,
  onOpenProjects = () => {},
  onClose = null,
}) {
  const visible = visibleTools(grantedKeys);
  const visibleIds = new Set(visible.map((tool) => tool.toolId));
  const baseCompact = mode === 'MINIATURE';
  const [hovered, setHovered] = useState(false);

  // Hover expansion is an additive enhancement: it widens the sidebar while the
  // pointer is inside it and never changes the active tool. Keyboard and touch
  // reach the same inner functions through the disclosure controls, so nothing
  // depends on hover.
  const expandedByHover = baseCompact && hoverExpand && hovered && !pinned;
  const compact = baseCompact && !expandedByHover;

  return (
    <nav
      className={`sidebar sidebar--${compact ? 'miniature' : mode.toLowerCase()}`}
      aria-label="Workspace navigation"
      data-sidebar-mode={mode}
      data-hover-expanded={expandedByHover ? 'true' : undefined}
      onMouseEnter={baseCompact && hoverExpand ? () => setHovered(true) : undefined}
      onMouseLeave={baseCompact && hoverExpand ? () => setHovered(false) : undefined}
    >
      <Watermark />
      <div className="sidebar__mark">
        <span className="sidebar__product">AI Infrastructure Planner</span>
        {onClose ? (
          <button type="button" className="sidebar__close" onClick={onClose} aria-label="Close navigation" title="Close navigation">
            <Icon name="close" />
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className="sidebar__projects"
        onClick={onOpenProjects}
        aria-current={activeToolId === null ? 'page' : undefined}
      >
        <span className="sidebar__icon" aria-hidden="true">
          <Icon name="grid" />
        </span>
        {compact ? null : <span className="sidebar__label">Projects</span>}
        {compact ? <span className="visually-hidden">Projects</span> : null}
      </button>

      {TOOL_GROUPS.map((group) => {
        const tools = toolsInGroup(group.groupId).filter((tool) => visibleIds.has(tool.toolId));
        if (tools.length === 0) return null;
        return (
          <section key={group.groupId} className="sidebar__group" aria-label={group.label}>
            {compact ? null : <h2 className="sidebar__group-label">{group.label}</h2>}
            <ul className="sidebar__tools">
              {tools.map((tool) => (
                <SidebarTool
                  key={tool.toolId}
                  tool={tool}
                  active={tool.toolId === activeToolId}
                  expanded={tool.toolId === activeToolId}
                  activeFunctionId={activeFunctionId}
                  badge={badges[tool.toolId] ?? null}
                  compact={compact}
                  onSelectTool={onSelectTool}
                  onSelectFunction={onSelectFunction}
                />
              ))}
            </ul>
          </section>
        );
      })}

      <div className="sidebar__footer">
        {/* The account took the slot the pin control held. The band is never dropped, so
            it is the one place a control that must always be reachable can live. */}
        <AccountControl accountLabel={accountLabel} devIdentity={devIdentity} compact={compact} />
        <SettingsMenu
          colorScheme={colorScheme}
          resolvedColorScheme={resolvedColorScheme}
          onSetColorScheme={onSetColorScheme}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onAbout={onAbout}
          compact={compact}
        />
      </div>
    </nav>
  );
}

function SidebarTool({ tool, active, expanded, activeFunctionId, badge, compact, onSelectTool, onSelectFunction }) {
  const hasFunctions = tool.functions.length > 0;
  const highlighted = active ? resolveFunctionId(tool.toolId, { functionId: activeFunctionId }) : null;

  return (
    <li className="sidebar__tool">
      <button
        type="button"
        className="sidebar__tool-button"
        // In the miniature rail the inner list is not rendered, so the control does
        // not claim to disclose anything: a disclosure that points at nothing is
        // worse than no disclosure. The rail's own expansion (pin, or hover where
        // enabled) brings the list back.
        aria-expanded={hasFunctions && !compact ? expanded : undefined}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelectTool(tool.toolId)}
      >
        <span className="sidebar__icon" aria-hidden="true">
          <Icon name={toolIcon(tool.toolId)} />
        </span>
        {compact ? <span className="visually-hidden">{tool.label}</span> : <span className="sidebar__label">{tool.label}</span>}
        {badge ? <StatusBadge badge={badge} /> : null}
      </button>

      {/* A 64px rail cannot hold a labelled sub-list: measured, it clipped
          "Overview" to "o." and overflowed the rail by 21px. The list appears when
          the rail expands. */}
      {hasFunctions && expanded && !compact ? (
        <ul className="sidebar__functions" aria-label={`${tool.label} functions`}>
          {tool.functions.map((item) => (
            <li key={item.functionId}>
              <button
                type="button"
                className="sidebar__function"
                aria-current={highlighted === item.functionId ? 'page' : undefined}
                onClick={() => onSelectFunction(item.functionId)}
              >
                <span className="sidebar__label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Error, warning, processing, or done — always with text, never color alone. */
function StatusBadge({ badge }) {
  const { errors = 0, warnings = 0, processing = false, done = false } = badge;
  let text = null;
  if (errors > 0) text = `${errors} error${errors === 1 ? '' : 's'}`;
  else if (warnings > 0) text = `${warnings} warning${warnings === 1 ? '' : 's'}`;
  else if (processing) text = 'processing';
  else if (done) text = 'complete';
  if (!text) return null;

  const icon = errors > 0 ? 'alertCircle' : warnings > 0 ? 'alertTriangle' : processing ? 'spinner' : 'check';

  return (
    <span className={`badge badge--${errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'info'}`} aria-label={text}>
      <Icon name={icon} size={12} />
      <span className="badge__text">{text}</span>
    </span>
  );
}

export { StatusBadge };
