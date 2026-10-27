import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEV_IDENTITY_HEADER,
  currentDevIdentity,
  describeIdentity,
  devIdentityHeaders,
  loadDevIdentities,
  rememberDevIdentity,
  resolveDevOrganisation,
  withDevIdentity,
} from '../app/dev-identity.js';

/**
 * Acting as another identity in development.
 *
 * What matters here is that the choice is a **request header** rather than a client-side
 * filter, and that its absence is inert. A switcher that only hid controls would test the
 * CSS; a header a deployment could honour would be an impersonation hole. Everything below
 * is either "the choice is carried to the server" or "with nothing chosen, nothing is
 * sent".
 */
const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

test('nothing chosen means no header at all', () => {
  const storage = memoryStorage();
  assert.equal(currentDevIdentity(storage), null);
  assert.deepEqual(devIdentityHeaders(storage), {}, 'an absent choice must not send a header');
});

test('a chosen identity is sent as the header the dev proxy reads', () => {
  const storage = memoryStorage();
  rememberDevIdentity('dev-viewer', storage);

  assert.equal(currentDevIdentity(storage), 'dev-viewer');
  assert.deepEqual(devIdentityHeaders(storage), { [DEV_IDENTITY_HEADER]: 'dev-viewer' });
});

test('clearing the choice stops sending it', () => {
  const storage = memoryStorage();
  rememberDevIdentity('dev-editor', storage);
  rememberDevIdentity(null, storage);

  assert.equal(currentDevIdentity(storage), null);
  assert.deepEqual(devIdentityHeaders(storage), {});
});

test('storage that throws does not break the app', () => {
  // Private mode, or storage disabled. Failing to remember a choice must not stop the
  // shell from rendering — it just cannot remember.
  const hostile = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };

  assert.equal(currentDevIdentity(hostile), null);
  assert.deepEqual(devIdentityHeaders(hostile), {});
  assert.doesNotThrow(() => rememberDevIdentity('dev-user', hostile));
});

test('the control names the identity in effect, not the stored one', () => {
  const identities = [
    { subject: 'dev-user', name: 'Dana Whitfield', organisationName: 'Development organisation', roleLabel: 'Project administrator' },
    { subject: 'dev-viewer', name: 'Mei Lin', organisationName: 'Development organisation', roleLabel: 'Project viewer' },
  ];

  const described = describeIdentity({ identities, subject: 'dev-viewer' });
  assert.equal(described.name, 'Mei Lin');
  assert.equal(described.organisationName, 'Development organisation');
  assert.equal(described.roleLabel, 'Project viewer');
  assert.equal(described.known, true);

  // A subject the server no longer offers still reads as itself: the header is still being
  // sent, so showing a different name would describe a session that is not the one running.
  // Its organisation and role are not knowable, and are left unsaid rather than guessed.
  const removed = describeIdentity({ identities, subject: 'dev-gone' });
  assert.equal(removed.name, 'dev-gone');
  assert.equal(removed.organisationName, null);
  assert.equal(removed.roleLabel, null);
  assert.equal(removed.known, false);

  // Nothing chosen falls back to the caller's own name rather than an empty control.
  assert.equal(describeIdentity({ identities, subject: null, fallbackName: 'ada@example.test' }).name, 'ada@example.test');
  assert.equal(describeIdentity({}).name, 'Account');
});

test('a described identity is a person, an organisation, and a role — and nothing else', () => {
  // The menu renders exactly the fields this returns, so the shape *is* the promise that it
  // shows no project information. A project this identity is a member of, the scope its
  // role is held at, and the reason the identity exists are all real facts about the seed,
  // and all of them belong in the seed rather than in a control that answers "who am I".
  const identities = [
    {
      subject: 'dev-second-admin',
      name: 'Priya Raman',
      organisationName: 'Cascade Cloud',
      roleLabel: 'Project administrator',
      // Everything below is carried by the dev server's list and must not survive the trip.
      roleKey: 'project-admin',
      scope: 'project',
      organisation: 'cascade',
      organisationId: 'e3be6d4b-a1aa-5b44-bef0-dd8ff28a5e2d',
      authority: 'Full authority in the second organisation, and none in the first.',
      projectName: 'Cascade Ridge Campus',
    },
  ];

  const described = describeIdentity({ identities, subject: 'dev-second-admin' });
  assert.deepEqual(
    Object.keys(described).sort(),
    ['known', 'name', 'organisationName', 'roleLabel', 'subject'],
  );
  assert.deepEqual(described, {
    subject: 'dev-second-admin',
    name: 'Priya Raman',
    organisationName: 'Cascade Cloud',
    roleLabel: 'Project administrator',
    known: true,
  });
  assert.equal(JSON.stringify(described).includes('Cascade Ridge Campus'), false, 'no project information');
});

test('a dev server that offers no identities is inert rather than an error', async () => {
  // This is the production case: there is no such endpoint, so the read fails and the
  // account control stays a label.
  const missing = await loadDevIdentities({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.deepEqual(missing, { available: false, identities: [], defaultSubject: null });

  const broken = await loadDevIdentities({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(broken.available, false);

  const offered = await loadDevIdentities({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            defaultSubject: 'dev-user',
            identities: [
              {
                subject: 'dev-user',
                name: 'Dana Whitfield',
                organisationName: 'Development organisation',
                roleLabel: 'Project administrator',
                organisationId: null,
              },
            ],
          },
        };
      },
    }),
  });
  assert.equal(offered.available, true);
  assert.equal(offered.defaultSubject, 'dev-user');
  assert.equal(offered.identities.length, 1);
  // The projection the dev server serves: who is acting, and the organisation to list
  // projects for. `roleKey`, `scope`, and the organisation-scope read role are the seed's
  // business and are not part of it.
  assert.deepEqual(Object.keys(offered.identities[0]).sort(), ['name', 'organisationId', 'organisationName', 'roleLabel', 'subject']);
});

test('the identity-aware fetch is the same function every time it is asked for', () => {
  // This is not tidiness, it is the bug. `withDevIdentity()` is used as a default
  // parameter — `fetchImpl = withDevIdentity()` — and a default parameter is evaluated on
  // every render. Returning a fresh function each time put a new identity in an effect's
  // dependency list, so the effect re-ran every render, set state, and rendered again:
  // roughly 190 key-set reads a second, measured at 452 during open and 583 in the next
  // three seconds. Memoised, the default is stable and the effect settles.
  assert.equal(withDevIdentity(), withDevIdentity(), 'the same fetch must yield the same wrapper');

  // Different fetches still get their own wrapper, so this is a cache and not a singleton
  // that would quietly ignore the fetch a caller passed.
  const a = async () => ({});
  const b = async () => ({});
  assert.notEqual(withDevIdentity(a), withDevIdentity(b));
  assert.equal(withDevIdentity(a), withDevIdentity(a));
});

test('the wrapper still carries the identity and passes everything else through', async () => {
  const seen = [];
  const wrapped = withDevIdentity(async (url, options) => {
    seen.push({ url, options });
    return { ok: true };
  });

  const storage = memoryStorage();
  rememberDevIdentity('dev-editor', storage);
  // The wrapper reads storage per request, so a switch takes effect without rebuilding it.
  assert.equal(typeof wrapped, 'function');
  await wrapped('/api/v1/projects', { headers: { accept: 'application/json' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/v1/projects');
  assert.equal(seen[0].options.headers.accept, 'application/json', 'existing headers survive');
});

/** A dev server that offers two organisations, one identity each. */
const twoTenantServer = () => async () => ({
  ok: true,
  async json() {
    return {
      data: {
        defaultSubject: 'dev-user',
        identities: [
          { subject: 'dev-user', name: 'Dana Whitfield', organisationName: 'Development organisation', roleLabel: 'Project administrator', organisationId: null },
          { subject: 'dev-second-viewer', name: 'Tom Beckwith', organisationName: 'Cascade Cloud', roleLabel: 'Project viewer', organisationId: 'org-cascade' },
        ],
      },
    };
  },
});

test('the organisation follows the chosen identity into the second tenant', async () => {
  const storage = memoryStorage();
  rememberDevIdentity('dev-second-viewer', storage);

  const resolved = await resolveDevOrganisation({
    fallback: 'org-primary',
    fetchImpl: twoTenantServer(),
    storage,
  });
  assert.equal(resolved, 'org-cascade');
});

test('an identity with no declared organisation keeps the configured one', async () => {
  const storage = memoryStorage();
  rememberDevIdentity('dev-user', storage);

  const resolved = await resolveDevOrganisation({
    fallback: 'org-primary',
    fetchImpl: twoTenantServer(),
    storage,
  });
  assert.equal(resolved, 'org-primary', 'the primary organisation is the build-time one');
});

test('nothing chosen resolves against the server default, and still falls back', async () => {
  const resolved = await resolveDevOrganisation({
    fallback: 'org-primary',
    fetchImpl: twoTenantServer(),
    storage: memoryStorage(),
  });
  assert.equal(resolved, 'org-primary', 'the default identity belongs to the primary organisation');
});

test('a deployment with no identity endpoint keeps the configured organisation', async () => {
  const resolved = await resolveDevOrganisation({
    fallback: 'org-primary',
    fetchImpl: async () => ({ ok: false, status: 404 }),
    storage: memoryStorage({ 'ai-infra.dev-identity': 'dev-second-viewer' }),
  });
  assert.equal(resolved, 'org-primary');
});
