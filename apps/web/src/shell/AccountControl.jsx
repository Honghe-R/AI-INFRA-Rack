import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';

// Wide enough for the widest row — a person's name on the left and a twenty-character
// `x-dev-subject` in mono on the right, with the role beneath them. The organisation used to
// be on every row, which is what needed 360px; it is a group heading now, so the rows are
// narrower than the panel was.
const MENU_WIDTH_PX = 320;
const MENU_MARGIN_PX = 8;

/**
 * The identities, grouped by the organisation they belong to, in the order the dev server
 * lists them.
 *
 * Grouped because each organisation holds one identity of every role: eight entries that
 * repeat four role names, four of them under each organisation. Repeated four times down the
 * list, the organisation stops distinguishing anything and starts being noise, and the two
 * tenants are only comparable if they are laid out the same way. A heading per organisation
 * says it once.
 *
 * The grouping is presentational. Every option still carries its whole identity in its
 * accessible name, so a screen reader hears the organisation on each entry rather than
 * depending on having heard a heading.
 */
/**
 * A person's avatar: their picture when the identity carries one, their initials when
 * it does not.
 *
 * Nothing in this deployment supplies a picture — the demo identities are seeded, not
 * federated — so in practice every one of them takes the fallback. That is the point of
 * having a fallback rather than an empty circle: a blank placeholder says "no data",
 * while initials say who is acting, which is the question the control exists to answer.
 * A `picture` claim from a real OIDC issuer would be carried through `identity.avatarUrl`
 * unchanged the day one exists.
 *
 * `aria-hidden` because the name is always adjacent in the same control — announcing it
 * twice makes a screen reader say the person's name and then a letter.
 */
function initialsFor(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function Avatar({ identity = null, name = 'Account' }) {
  const url = identity?.avatarUrl ?? identity?.avatar_url ?? null;
  if (url) {
    return <img className="account__avatar account__avatar--image" src={url} alt="" aria-hidden="true" />;
  }
  return (
    <span className="account__avatar account__avatar--initials" aria-hidden="true">
      {initialsFor(identity?.name ?? name)}
    </span>
  );
}

function organisationGroups(identities) {
  const groups = new Map();
  for (const identity of identities) {
    const name = identity.organisationName ?? null;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(identity);
  }
  return [...groups].map(([name, members]) => ({ name, identities: members }));
}

/**
 * The organisation and role, as one line: "Development organisation · Project editor".
 *
 * Both or neither. A role without an organisation would read as a global role, and an
 * organisation without a role would say where somebody works and not what they may do, so
 * a half-known identity falls back to showing neither.
 */
function roleLine(identity) {
  const parts = [identity?.organisationName, identity?.roleLabel].filter(Boolean);
  return parts.length === 2 ? parts.join(' · ') : null;
}

/**
 * The menu of identities a development session can act as.
 *
 * It offers exactly three facts about each identity: the **person**, the **organisation**
 * they belong to, and the **role** they hold there. Those three are the identity, and they
 * are the whole of it. Everything else a development identity could be described by —
 * which scope its role is held at, which permission it exists to exercise, which project it
 * happens to be a member of — is a fact about what the identity is *for* and not about who
 * is acting. A menu that lists roles and scopes instead of people reads as a list of
 * permissions, and leaves a session unable to say who it is looking at the app as; naming a
 * project is worse still, because it suggests the identity were a property of that project
 * when the same person holds the same role in every project they belong to.
 *
 * The organisation is stated once per group rather than once per row, so each entry is a
 * person and what they may do:
 *
 *     DEVELOPMENT ORGANISATION
 *       ✓ Dana Whitfield        dev-user
 *         Project administrator
 *     CASCADE CLOUD
 *       Priya Raman             dev-second-admin
 *         Project administrator
 *
 * The `x-dev-subject` login stays visible, because the subject is what the dev proxy mints
 * a token for and therefore how a machine says which person it means. It is not part of the
 * identity — it is the mechanism by which the identity is assumed.
 *
 * Split out from the control so that what the menu says can be rendered and asserted
 * without a DOM, which is how the layout of the rest of this shell is tested.
 */
export function AccountMenu({ identities = [], currentSubject = null, onChoose = null, placement = null }) {
  return (
    <div
      className="account__menu"
      role="menu"
      aria-label="Act as"
      style={
        placement
          ? { left: `${placement.left}px`, bottom: `${placement.bottom}px`, width: `${placement.width}px` }
          : undefined
      }
    >
      <p className="account__heading">Act as</p>
      {organisationGroups(identities).map((group) => (
        <div className="account__group" key={group.name ?? 'unknown-organisation'}>
          {group.name ? (
            // Visible, and out of the accessible tree: every option below already names its
            // organisation, and announcing both would read the organisation twice per entry.
            <p className="account__group-name" aria-hidden="true">
              {group.name}
            </p>
          ) : null}
          {group.identities.map((option) => {
            const selected = option.subject === currentSubject;
            const optionRole = roleLine(option);
            return (
              <button
                key={option.subject}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`account__option${selected ? ' account__option--current' : ''}`}
                // The whole identity, in the order the spans are shown. The organisation is
                // in here as well as in the group heading above, so that an entry read on its
                // own — as a screen reader does — says where the person works.
                aria-label={[option.name, option.subject, optionRole].filter(Boolean).join(' — ')}
                onClick={() => onChoose?.(option.subject)}
              >
                <span className="account__option-name">
                  {selected ? <Icon name="check" size={13} /> : null}
                  {option.name}
                </span>
                <span className="account__option-subject">{option.subject}</span>
                {/* The role, and only the role: the organisation is the heading above. Both
                    or neither still holds — an identity whose organisation is not known has
                    nothing to head the group with, and a role shown there would read as a
                    global one. */}
                {group.name && option.roleLabel ? (
                  <span className="account__option-note">{option.roleLabel}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      {/* Stated because the failure is otherwise an authentication error with no clue. */}
      <p className="account__note">
        Development only. These identities come from <code>npm run dev:seed</code>.
      </p>
    </div>
  );
}

/**
 * The account control.
 *
 * In a deployment it names who is signed in. In development it is also the way to act as
 * somebody else, and that is why it changes what the **server** believes the caller is
 * rather than hiding controls on the client: the choice becomes a request header the dev
 * proxy turns into a bearer token for that subject. A switcher that only filtered the UI
 * would demonstrate the CSS and prove nothing about permissions.
 *
 * It renders a menu only when a dev server answered with a list, which a build never does —
 * so in a deployment this is a label, and the header is never sent.
 *
 * It lives in the sidebar's bottom band rather than the project context bar. That band is
 * never dropped: the context bar sheds its least load-bearing controls as the workspace
 * narrows, and an identity switcher that disappears at the very window size a developer
 * uses is a switcher nobody can reach. It also reads as what it is — a property of the
 * session, not of the project.
 */
export function AccountControl({ accountLabel = null, devIdentity = null, compact = false }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(null);
  const containerRef = useRef(null);

  /**
   * Where the menu sits, in viewport coordinates.
   *
   * Fixed rather than absolute because the sidebar clips its overflow horizontally — a menu
   * in the 64px rail would be cut off at the rail's edge — and a fixed element is not
   * clipped by an ancestor's `overflow` unless that ancestor also transforms. Measuring the
   * control keeps the menu anchored to it, and clamping keeps it on screen when the sidebar
   * is against the right edge or the window is narrow.
   */
  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const measure = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(MENU_WIDTH_PX, window.innerWidth - MENU_MARGIN_PX * 2);
      const left = Math.max(MENU_MARGIN_PX, Math.min(rect.left, window.innerWidth - width - MENU_MARGIN_PX));
      setPlacement({ left: Math.round(left), bottom: Math.round(window.innerHeight - rect.top + MENU_MARGIN_PX), width: Math.round(width) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const switchable = devIdentity?.available === true;
  const current = devIdentity?.current ?? null;
  // The person's name, and the whole of it: the sidebar band is one narrow line, and the
  // organisation and role are one hover and one click away.
  const name = current?.name ?? accountLabel ?? 'Account';
  const currentRole = roleLine(current);

  if (devIdentity?.signOut) return <div className="account account--in-sidebar" ref={containerRef}>
    <button type="button" className="sidebar__account account__trigger" aria-label={`Account: ${name}`} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)} title={`Signed in as ${name}`}>
      <Avatar identity={current} name={name}/>{compact ? null : <span className="sidebar__label">{name}</span>}
    </button>
    {open && placement && <div className="account__menu" role="menu" aria-label="Your account"
      style={{left:`${placement.left}px`,bottom:`${placement.bottom}px`,width:`${placement.width}px`}}>
      <p className="account__heading">Your account</p><p className="account__note">{name}<br/>{current?.subject}</p>
      <button type="button" className="account__option" role="menuitem" onClick={devIdentity.signOut}>Sign out</button>
    </div>}
  </div>;

  if (!switchable) {
    return (
      <span className="sidebar__account" title={`Signed in as ${name}`}>
        <Avatar identity={current} name={name} />
        <span className="visually-hidden">Signed in as {name}</span>
        {compact ? null : <span className="sidebar__label">{name}</span>}
      </span>
    );
  }

  return (
    <div className="account account--in-sidebar" ref={containerRef}>
      <button
        type="button"
        className="sidebar__account account__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${[name, currentRole].filter(Boolean).join(' — ')}. Switch identity.`}
        title={currentRole ? `Acting as ${name} — ${currentRole}` : `Acting as ${name}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar identity={current} name={name} />
        {compact ? null : <span className="sidebar__label">{name}</span>}
      </button>

      {open && placement ? (
        <AccountMenu
          identities={devIdentity.identities ?? []}
          currentSubject={current?.subject ?? null}
          placement={placement}
          onChoose={(subject) => {
            setOpen(false);
            devIdentity.choose?.(subject);
          }}
        />
      ) : null}
    </div>
  );
}
