import { getTool, toolCommands } from '../state/tool-registry.js';
import { Icon, commandIcon } from './icons.jsx';

/**
 * The active-tool toolbar: one stable shell-owned slot.
 *
 * The shell owns placement, overflow, focus, and responsive treatment; the tool
 * supplies commands. A command is hidden when its permission is absent from the
 * resolved key set, and a command that is visible but blocked explains why
 * through `aria-disabled` plus a reason — never through color alone, and never
 * as a silently dead button.
 *
 * The slot stays present when no tool is active so the shell's layout does not
 * jump as tools open and close.
 */
export function ActiveToolToolbar({
  toolId = null,
  grantedKeys = null,
  disabledReasons = {},
  onCommand = () => {},
  projectActions = null,
  // The command whose tool is currently active, or null. The tool itself lives with the
  // surface that owns the viewport and the draft — the shell only reflects it.
  activeCommandId = null,
}) {
  const tool = toolId ? getTool(toolId) : null;
  const commands = toolId ? toolCommands(toolId) : [];
  const granted = grantedKeys instanceof Set ? grantedKeys : grantedKeys ? new Set(grantedKeys) : null;

  const visible = commands.filter((command) => !command.permission || !granted || granted.has(command.permission));
  // "No commands for your role" is a claim about the reader, and it is false when the tool
  // simply declares none — which the Assets workspace does. Saying it there tells a user
  // who holds `asset.write` that they lack it, and sends them to an administrator for a
  // permission that was never the problem.
  const emptyMessage = commands.length === 0
    ? 'This workspace has no commands.'
    : 'No commands are available for your role in this project.';
  const primary = visible.filter((command) => command.variant === 'primary');
  const secondary = visible.filter((command) => command.variant !== 'primary');

  return (
    <div className="toolbar" role="toolbar" aria-label={tool ? `${tool.label} commands` : 'Project commands'}>
      {/*
        The tool's name is deliberately not rendered here. It is already the open-view
        tab directly above, so a second copy on the row below said nothing and cost the
        width the tool's own commands need. The name survives as the toolbar's
        accessible label, which is where it does work.
      */}
      <div className="toolbar__commands">
        {visible.length === 0 ? (
          <span className="toolbar__empty">{tool ? emptyMessage : projectActions}</span>
        ) : null}

        {/*
          Two groups, because they answer different questions. The leading group acts on
          what is on the canvas — adding to it — and sits where the eye starts. The
          trailing group is the governance pair: validating judges the whole revision and
          publishing freezes it, and both are the end of a workflow rather than another
          authoring tool. Trailing is `margin-left: auto`, so the split holds even when
          a role holds none of the leading commands.
        */}
        <div className="toolbar__group">
          {secondary.map((command) => (
            <ToolCommand
              key={command.commandId}
              command={command}
              reason={disabledReasons[command.commandId]}
              onCommand={onCommand}
              active={command.commandId === activeCommandId}
            />
          ))}
        </div>

        <div className="toolbar__group toolbar__group--trailing">
          {primary.map((command) => (
            <ToolCommand
              key={command.commandId}
              command={command}
              reason={disabledReasons[command.commandId]}
              onCommand={onCommand}
              primary
              active={command.commandId === activeCommandId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolCommand({ command, reason, onCommand, primary = false, active = false }) {
  const disabled = Boolean(reason);

  return (
    <button
      type="button"
      className={`toolbar__command${primary ? ' toolbar__command--primary' : ''}${active ? ' toolbar__command--active' : ''}`}
      data-command-id={command.commandId}
      // A tool that stays active while you use it is a toggle, and `aria-pressed` is what
      // says so: the colour marks which command is on, so the state must not live in colour
      // alone. It is not a second `--primary` — that marks Validate and Publish, which are
      // actions rather than modes, and a mode must not wear an action's clothes.
      aria-pressed={active ? 'true' : undefined}
      // The accessible name is stated rather than inherited from the label, because the
      // label is hidden when the row runs out of width. A name that disappears with the
      // CSS would leave an icon-only button with a name made of nothing but its glyph,
      // and the glyph is decoration by design.
      aria-label={command.label}
      // Kept focusable when blocked so the reason stays reachable by keyboard and
      // screen reader, rather than becoming an unreachable dead control.
      aria-disabled={disabled ? 'true' : undefined}
      title={
        disabled
          ? reason
          : active
            // The reader needs to know the tool is still on and how to put it down.
            ? `${command.label} — Escape to stop`
            : command.label
      }
      onClick={() => {
        if (!disabled) onCommand(command.commandId);
      }}
    >
      {/* A heavier weight than body text: these are the row's landmarks, and 1.6px at
          16px reads as hairline next to a 550-weight label. */}
      {commandIcon(command.commandId) ? <Icon name={commandIcon(command.commandId)} size={17} strokeWidth={1.9} /> : null}
      <span className="toolbar__command-label">{command.label}</span>
      {active ? <span className="visually-hidden"> — active</span> : null}
      {disabled ? <span className="visually-hidden"> — unavailable: {reason}</span> : null}
    </button>
  );
}
