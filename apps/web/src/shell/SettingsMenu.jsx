import { BuildVersion } from './BuildVersion.jsx';
import { Icon } from './icons.jsx';
import { useAnchoredMenu } from './useAnchoredMenu.js';

/**
 * The appearance and layout controls, in the sidebar's bottom band.
 *
 * These were scattered before: the colour scheme had a control in the project context bar,
 * and the sidebar pin had one in this band, which was replaced when the account control
 * moved here. Both are properties of how the workspace looks to *this* person rather than of
 * the project, so they belong together and away from the project identity.
 *
 * The band is where they live because it is never dropped — the context bar sheds its least
 * load-bearing controls as the workspace narrows, and an appearance control that vanishes at
 * some window width is one a user cannot reach at all.
 *
 * Colour scheme offers all three of its values rather than a binary toggle. "System" is the
 * default and the state a user is most likely to want back, and a two-state switch cannot
 * express it: the old toggle could only ever move between light and dark, so once pressed
 * there was no way back to following the system.
 *
 * The build the browser is running closes the menu. It is the one line here that reports
 * rather than controls, and it is asked for exactly when something looks wrong — so it sits
 * where a reader already is, not behind a second dialog.
 */
export function SettingsMenu({
  // The *preference*, which is one of SYSTEM, LIGHT, or DARK — not the scheme on screen.
  // Passing only the resolved scheme would make "System" and "Light" indistinguishable, and
  // the menu could not show which of the three is selected.
  colorScheme = 'SYSTEM',
  // What that preference currently resolves to, which is the only way to say what "System"
  // means right now.
  resolvedColorScheme = null,
  onSetColorScheme = () => {},
  pinned = false,
  onTogglePin = null,
  onAbout = null,
  compact = false,
}) {
  const menu = useAnchoredMenu();

  return (
    <div className="settings" ref={menu.containerRef}>
      <button
        type="button"
        className="sidebar__settings settings__trigger"
        title="Settings"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Icon name="sliders" />
        <span className="visually-hidden">Settings</span>
        {compact ? null : <span className="sidebar__label">Settings</span>}
      </button>

      {menu.open && menu.menuStyle ? (
        <div className="settings__menu account__menu" role="menu" aria-label="Settings" style={menu.menuStyle}>
          <p className="account__heading">Appearance</p>
          <div className="settings__group" role="group" aria-label="Colour scheme">
            {[
              { value: 'SYSTEM', label: 'System', icon: 'sliders' },
              { value: 'LIGHT', label: 'Light', icon: 'sun' },
              { value: 'DARK', label: 'Dark', icon: 'moon' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={colorScheme === option.value}
                className={`settings__option${colorScheme === option.value ? ' settings__option--current' : ''}`}
                onClick={() => {
                  onSetColorScheme(option.value);
                  menu.close();
                }}
              >
                <Icon name={option.icon} size={14} />
                {option.label}
              </button>
            ))}
          </div>

          {onTogglePin ? (
            <>
              <p className="account__heading settings__heading">Layout</p>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={pinned}
                className={`settings__option settings__option--wide${pinned ? ' settings__option--current' : ''}`}
                onClick={() => onTogglePin()}
              >
                <Icon name="pin" size={14} />
                {pinned ? 'Unpin sidebar' : 'Pin sidebar'}
              </button>
            </>
          ) : null}

          {/* Only meaningful while following the system: otherwise the choice above already
              says which scheme is on. */}
          {colorScheme === 'SYSTEM' && resolvedColorScheme ? (
            <p className="account__note">
              Following the system, which is {resolvedColorScheme === 'DARK' ? 'dark' : 'light'} right now.
            </p>
          ) : null}

          {/* Separated: everything above is a control that changes how the workspace
              looks, and this one only reports. */}
          {onAbout ? (
            <>
              <p className="account__heading settings__heading">About</p>
              <button
                type="button"
                role="menuitem"
                className="settings__option settings__option--wide"
                onClick={() => onAbout()}
              >
                <Icon name="info" size={14} />
                About this application
              </button>
            </>
          ) : null}

          <BuildVersion />
        </div>
      ) : null}
    </div>
  );
}
