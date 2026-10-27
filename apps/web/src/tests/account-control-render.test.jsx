import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountControl, AccountMenu } from '../shell/AccountControl.jsx';
import { clientIdentities, DEV_ORGANISATIONS } from '../../../../scripts/lib/dev-identities.mjs';

/**
 * What the account control says about the identity in effect.
 *
 * The menu answers one question — who is acting — and the failure this guards against is
 * that it answers a different one. A development identity is easy to describe by its role
 * ("the project administrator"), by its scope ("organisation"), by which project it belongs
 * to, or by the reason it exists ("read-only, so every write control should be absent"), and
 * every one of those has been in this menu at some point. None of them is a fact about a
 * person, and a menu of them cannot be used to tell who you are looking at the app as.
 *
 * So these assert the three facts that *are* the identity — person, organisation, role —
 * that the organisation is stated once per group rather than once per entry, and that
 * nothing else reaches the markup. The list under test is the real one the dev server
 * serves, projected exactly as it serves it, because the balance between the two
 * organisations is itself the requirement.
 */

const IDENTITIES = clientIdentities();

/** The chunks of the menu that follow each organisation heading. */
function groupsFrom(html) {
  return html
    .split('<p class="account__group-name"')
    .slice(1)
    .map((chunk) => ({
      name: chunk.slice(chunk.indexOf('>') + 1, chunk.indexOf('</p>')),
      subjects: [...chunk.matchAll(/class="account__option-subject">([^<]*)</g)].map((match) => match[1]),
      roles: [...chunk.matchAll(/class="account__option-note">([^<]*)</g)].map((match) => match[1]),
    }));
}

const renderMenu = (props = {}) =>
  renderToStaticMarkup(
    <AccountMenu
      identities={IDENTITIES}
      currentSubject="dev-user"
      placement={{ left: 0, bottom: 0, width: 360 }}
      {...props}
    />,
  );

test('each organisation offers one of every role, and the menu shows them that way', () => {
  const html = renderMenu();
  const groups = groupsFrom(html);

  assert.deepEqual(
    groups.map((group) => group.name),
    DEV_ORGANISATIONS.map((organisation) => organisation.name),
    'one group per organisation, in the order the seed creates them',
  );

  const organisationRoles = ['Project administrator', 'Project editor', 'Project viewer', 'Organisation administrator'];
  for (const group of groups) {
    assert.equal(group.subjects.length, 4, `${group.name} must offer as many identities as the other`);
    assert.deepEqual(group.roles, organisationRoles, `${group.name} must cover every role, in the same order`);
  }

  // The same count and the same roles on both sides is the point: a role missing from one
  // organisation is a question the second tenant cannot be asked.
  assert.equal(groups[0].subjects.length, groups[1].subjects.length);
  assert.deepEqual(groups[0].roles, groups[1].roles);
});

test('the organisation is stated once per group, not once per entry', () => {
  const html = renderMenu();
  const groups = groupsFrom(html);

  // The headings carry the organisation; the entries carry a role and nothing else, or the
  // organisation would be repeated four times down each group and stop distinguishing
  // anything.
  for (const group of groups) {
    assert.equal(group.roles.some((role) => role.includes(group.name)), false, `${group.name} is not repeated per entry`);
  }
  assert.equal((html.match(/<p class="account__group-name"/g) ?? []).length, 2);
});

test('each option names a person, their role, and their dev login', () => {
  const html = renderMenu();

  assert.match(html, /Mei Lin/);
  assert.match(html, /dev-viewer/);
  assert.match(html, /Ines Alvarado/);
  assert.match(html, /dev-second-editor/);
  assert.match(html, /Project editor/);
});

test('the same role in two organisations is told apart by the group it is under', () => {
  const groups = groupsFrom(renderMenu());

  const admins = groups.map((group) => group.subjects[0]);
  assert.notDeepEqual(admins[0], admins[1], 'both administrators cannot be the same person');
  assert.deepEqual(admins, ['dev-user', 'dev-second-admin']);
  // Every role appears exactly twice in the menu, once in each group.
  const allRoles = groups.flatMap((group) => group.roles);
  assert.equal(allRoles.length, 8);
  assert.equal(new Set(allRoles).size, 4);
});

test('the menu says nothing about projects, scopes, or permissions', () => {
  const html = renderMenu();

  // The fields that exist for the seed and the session record, and must not be rendered.
  assert.equal(html.includes('project-viewer'), false, 'the role key is not the role name');
  assert.equal(html.includes('project-admin'), false);
  assert.equal(html.includes('organisationReadRoleKey'), false);
  assert.equal(html.includes('organisationId'), false);
  assert.equal(html.includes('Northern DC Campus'), false);
  assert.equal(html.includes('Cascade Ridge Campus'), false);
  assert.doesNotMatch(html, /\bscope\b/i);
});

test('the dev login stays visible, because it is how the identity is assumed', () => {
  const html = renderMenu();

  // Not part of the identity, but without it there is no way to know which subject the
  // proxy will mint a token for, and a subject is what an authentication error names.
  assert.match(html, /dev-user/);
  assert.match(html, /dev-second-org-admin/);
});

test('the chosen identity is marked, and only the chosen one', () => {
  const html = renderMenu();

  assert.equal(html.match(/aria-checked="true"/g)?.length, 1);
  assert.equal(html.match(/aria-checked="false"/g)?.length, 7);
  assert.match(html, /account__option--current/);
});

test('an option reads as its whole identity, including the organisation above it', () => {
  const html = renderMenu();

  // The organisation is in the accessible name as well as in the heading, so an entry read
  // on its own — as a screen reader reads it — still says where the person works.
  assert.match(html, /aria-label="Dana Whitfield — dev-user — Development organisation · Project administrator"/);
  assert.match(html, /aria-label="Priya Raman — dev-second-admin — Cascade Cloud · Project administrator"/);
  // And the heading itself is out of the accessible tree, so the organisation is not read
  // twice for every entry.
  assert.match(html, /<p class="account__group-name" aria-hidden="true">Cascade Cloud<\/p>/);
});

test('the control names the person, and keeps the rest in the label and the tooltip', () => {
  const html = renderToStaticMarkup(
    <AccountControl
      devIdentity={{
        available: true,
        identities: IDENTITIES,
        current: { subject: 'dev-viewer', name: 'Mei Lin', organisationName: 'Development organisation', roleLabel: 'Project viewer', known: true },
        choose: () => {},
      }}
    />,
  );

  // The band is one narrow line, so it carries the name; an accessible name and a tooltip
  // have room for the organisation and the role.
  assert.match(html, /<span class="sidebar__label">Mei Lin<\/span>/);
  assert.match(html, /aria-label="Account: Mei Lin — Development organisation · Project viewer. Switch identity."/);
  assert.match(html, /title="Acting as Mei Lin — Development organisation · Project viewer"/);
});

test('a deployment with no switcher is a label, not a menu', () => {
  const html = renderToStaticMarkup(<AccountControl accountLabel="ada@example.test" />);

  assert.match(html, /Signed in as ada@example.test/);
  assert.equal(html.includes('account__menu'), false);
  assert.equal(html.includes('role="menu"'), false);
});

test('an identity with no known organisation or role still renders, without a half-line', () => {
  // A subject that was chosen and has since been removed from the dev server's list. Its
  // organisation and role are not knowable, so there is no group to head and no role to
  // state: "· Project viewer" or "Cascade Cloud ·" would give half of something as the whole.
  const html = renderToStaticMarkup(
    <AccountMenu identities={[{ subject: 'dev-gone', name: 'dev-gone' }]} currentSubject="dev-gone" />,
  );

  assert.match(html, /dev-gone/);
  assert.equal(html.includes('account__group-name'), false);
  assert.equal(html.includes('account__option-note'), false);
  assert.equal(html.includes(' · '), false);
});

test('a list whose organisations are interleaved is still grouped, not repeated', () => {
  // The dev server lists identities grouped by organisation, but the menu must not depend on
  // that: two organisations interleaved would otherwise produce two headings for each.
  const html = renderMenu({
    identities: [IDENTITIES[0], IDENTITIES[4], IDENTITIES[1], IDENTITIES[5]],
    currentSubject: null,
  });

  const groups = groupsFrom(html);
  assert.deepEqual(groups.map((group) => group.name), ['Development organisation', 'Cascade Cloud']);
  assert.deepEqual(groups.map((group) => group.subjects), [['dev-user', 'dev-editor'], ['dev-second-admin', 'dev-second-editor']]);
});
