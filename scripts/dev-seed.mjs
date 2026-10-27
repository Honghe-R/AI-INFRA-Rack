#!/usr/bin/env node
/**
 * Development seed.
 *
 * Bootstraps everything the shell needs to show a project list for a development
 * identity: the seeded organisations, one project each with its first scenario and
 * a draft revision, and the users the account control offers, each holding the role
 * that makes it worth offering. It then writes the primary organisation id to
 * `apps/web/.env.development.local` so `npm run dev:web` picks it up without manual
 * configuration.
 *
 * There are **two** organisations, and that is deliberate. Tenancy is part of what
 * there is to test: a reference that crosses a tenant, or a permission resolved at
 * the wrong one, is the class of defect row-level security and the tenant-key
 * discipline exist to catch, and one organisation cannot show it. The second
 * organisation has its own project and its own users; no identity belongs to both,
 * so switching between them demonstrates isolation rather than describing it.
 *
 * A workspace context is a project *and* a scenario *and* a revision, so a project
 * with neither cannot be opened; the scenario and draft are seeded for the same
 * reason the project is.
 *
 * It reuses the same repository the API uses, so it cannot drift from the tenancy
 * rules. It is idempotent: running it twice changes nothing.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, withTenant } from '@ai-infra/db';
import { ensureEtag } from '@ai-infra/facility';
import { createRbacRepository } from '@ai-infra/rbac';
import { DEFAULT_DEV_SUBJECT, DEV_IDENTITIES, DEV_ORGANISATIONS, ORGANISATION, PROJECT } from './lib/dev-identities.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const subject = process.env.AUTH_DEV_SUBJECT ?? DEFAULT_DEV_SUBJECT;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required (start the database and run npm run migrate first).');
  process.exit(2);
}

const pool = createPool({ connectionString: databaseUrl, max: 2 });
const repository = createRbacRepository({ pool });

try {
  /**
   * Each seeded organisation with its owner, project, scenario, and draft revision.
   *
   * The primary organisation's owner is the session's subject, so `AUTH_DEV_SUBJECT`
   * still decides who owns the example project. Every other organisation names its
   * owner in the shared list, because there is no session fact that could.
   */
  const seedOrganisations = [];
  for (const definition of DEV_ORGANISATIONS) {
    const ownerSubject = definition.key === 'primary' ? subject : definition.ownerSubject;
    const owner = await ensureUser(ownerSubject, identityName(ownerSubject, 'Development user'));
    const organisation = await ensureOrganisation(definition, owner);
    // The owner administers the organisation, not just its project. The projects list is
    // checked at organisation scope, so an owner holding only a project role cannot find
    // the project they own — and `createOrganization` only does this for the organisation
    // it creates, not for one inserted by id.
    await repository.assignRole({
      userId: owner.userId,
      roleKey: 'organisation-admin',
      scopeKind: ORGANISATION,
      scopeId: organisation.organisationId,
    });
    const project = await ensureProject(organisation.organisationId, definition.projectName);
    const draft = await ensureScenarioAndRevision(project.projectId, owner.userId);
    seedOrganisations.push({ definition, owner, ...organisation, ...project, ...draft });
  }

  /**
   * The identities the account control offers.
   *
   * Each is created and given its role at the scope that role belongs to, so every
   * entry in the menu acts as a real user holding a real role. Without this the menu
   * would offer subjects nobody created, and switching to one would fail
   * authentication rather than showing that role's view — which is the whole point of
   * it.
   *
   * Scopes matter as much as roles. The primary organisation's owner also takes
   * project administration, because `organisation-admin` deliberately carries no
   * project-scoped run, publish, or waiver keys, and without it the shell's own
   * project is read-only to the person who seeded it.
   *
   * All of these writes are idempotent, so re-running the seed converges rather than
   * duplicating.
   */
  const identities = [];
  for (const identity of DEV_IDENTITIES) {
    const target = seedOrganisations.find((entry) => entry.definition.key === identity.organisation);
    if (!target) continue;
    const user = await ensureUser(identity.subject, identity.name);
    await repository.assignRole({
      userId: user.userId,
      roleKey: identity.roleKey,
      scopeKind: identity.scope,
      scopeId: identity.scope === ORGANISATION ? target.organisationId : target.projectId,
    });
    // A project role alone cannot find the project: the list is checked at organisation
    // scope, so without this the identity authenticates and then sees no projects at all.
    if (identity.organisationReadRoleKey) {
      await repository.assignRole({
        userId: user.userId,
        roleKey: identity.organisationReadRoleKey,
        scopeKind: ORGANISATION,
        scopeId: target.organisationId,
      });
    }
    identities.push({ ...identity, userId: user.userId, organisationName: target.definition.name });
  }

  // A session subject that is not one of the listed identities still owns the primary
  // organisation, so it keeps project administration there.
  const primary = seedOrganisations.find((entry) => entry.definition.key === 'primary');
  await repository.assignRole({
    userId: primary.owner.userId,
    roleKey: 'project-admin',
    scopeKind: PROJECT,
    scopeId: primary.projectId,
  });

  const envPath = resolve(REPO_ROOT, 'apps/web/.env.development.local');
  await writeFile(
    envPath,
    `# Written by \`npm run dev:seed\`. Local only; ignored by git.\nVITE_ORGANISATION_ID=${primary.organisationId}\n`,
    'utf8',
  );

  console.log(`session subject ${subject}`);
  console.log(`wrote           ${envPath}`);
  for (const entry of seedOrganisations) {
    console.log('');
    console.log(`organisation    ${entry.organisationId}${entry.created ? ' (created)' : ''} — ${entry.definition.name}`);
    console.log(`project         ${entry.projectId}${entry.projectCreated ? ' (created)' : ''} — ${entry.definition.projectName}`);
    console.log(`scenario        ${entry.scenarioId}${entry.scenarioCreated ? ' (created)' : ''}`);
    console.log(`revision        ${entry.revisionId}${entry.revisionCreated ? ' (created)' : ''}`);
    console.log(`draft etag      ${entry.etag?.etag ?? 'unavailable'}`);
  }
  console.log('\nIdentities the account control offers:');
  for (const identity of identities) {
    const scope = identity.scope === ORGANISATION ? 'organisation' : 'project';
    console.log(`  ${identity.subject.padEnd(20)} ${identity.roleKey.padEnd(20)} ${scope.padEnd(13)} ${identity.organisationName}`);
  }
  console.log('\nNext: npm run dev:seed:facility, then npm run dev:api and npm run dev:web');
} catch (error) {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

/** The person the shared identity list names for a subject, for a user it declares. */
function identityName(seedSubject, fallback) {
  return DEV_IDENTITIES.find((identity) => identity.subject === seedSubject)?.name ?? fallback;
}

/** `createUser` is idempotent, so a re-run returns the existing user. */
async function ensureUser(seedSubject, displayName) {
  return repository.createUser({
    subject: seedSubject,
    email: `${seedSubject}@example.test`,
    displayName,
  });
}

/**
 * The organisation, created once.
 *
 * A named id is inserted directly: a session has to know which organisation it is
 * listing before it has read the database, so the shared list carries the id rather
 * than the seed allocating a fresh one. The primary organisation has no such id — it
 * was allocated before this list existed, and changing it now would strand its
 * project — so it is discovered through its owner's membership, exactly as before.
 */
async function ensureOrganisation(definition, owner) {
  if (definition.organisationId) {
    const existing = await pool.query('SELECT organization_id FROM organizations WHERE organization_id = $1', [
      definition.organisationId,
    ]);
    if (existing.rows[0]) return { organisationId: definition.organisationId, created: false };
    await pool.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [
      definition.organisationId,
      definition.name,
    ]);
    return { organisationId: definition.organisationId, created: true };
  }

  const membership = await pool.query(
    `SELECT organization_id FROM organization_memberships
      WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
    [owner.userId],
  );
  if (membership.rows[0]) return { organisationId: membership.rows[0].organization_id, created: false };

  const organisation = await repository.createOrganization({ name: definition.name, ownerUserId: owner.userId });
  // `createOrganization` returns the American `organizationId` — its other consumers
  // (apps/api/src/routes/admin.js and the package tests) all read that spelling, so the
  // library is not the thing to change here. This function's own return shape is British,
  // and conflating the two silently produced `scopeId: undefined`, which surfaced as a
  // not-null violation deep inside `assignRole` on a fresh database. Stated explicitly
  // because the two spellings live one word apart.
  return { organisationId: organisation.organizationId, created: true };
}

/** Matched by name, so an operator who renamed the project gets a second one. */
async function ensureProject(organisationId, name) {
  const existing = await pool.query(
    'SELECT project_id FROM projects WHERE organization_id = $1 AND name = $2 ORDER BY created_at LIMIT 1',
    [organisationId, name],
  );
  if (existing.rows[0]) return { projectId: existing.rows[0].project_id, projectCreated: false };

  const projectId = randomUUID();
  await pool.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
    projectId,
    organisationId,
    name,
  ]);
  return { projectId, projectCreated: true };
}

/**
 * A scenario and a draft revision, because a workspace context is a project *and* a
 * scenario *and* a revision. Without them the project list would render a row that
 * cannot be opened. Both writes run with the tenant GUC set, so they satisfy the
 * project-isolation policy instead of relying on the seed running as the table owner.
 */
async function ensureScenarioAndRevision(projectId, actorId) {
  return withTenant(pool, projectId, async (client) => {
    const existingScenario = await client.query(
      'SELECT scenario_id FROM scenarios WHERE project_id = $1 ORDER BY created_at LIMIT 1',
      [projectId],
    );

    let scenarioId = existingScenario.rows[0]?.scenario_id ?? null;
    const scenarioCreated = !scenarioId;

    if (!scenarioId) {
      scenarioId = randomUUID();
      await client.query(
        'INSERT INTO scenarios (scenario_id, project_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5)',
        [scenarioId, projectId, 'Baseline', 'Default development scenario.', actorId],
      );
    }

    const existingRevision = await client.query(
      'SELECT revision_id, lifecycle_state FROM revisions WHERE scenario_id = $1 ORDER BY created_at LIMIT 1',
      [scenarioId],
    );

    let revisionId = existingRevision.rows[0]?.revision_id ?? null;
    const revisionCreated = !revisionId;

    if (!revisionId) {
      revisionId = randomUUID();
      // DRAFT is the only mutable state, so it is the only state a fresh seed can
      // legitimately start in; `content_checksum` stays null because a draft has
      // no immutable content to checksum yet.
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name, created_by)
         VALUES ($1, $2, $3, 'DRAFT', $4, $5)`,
        [revisionId, projectId, scenarioId, 'Draft 1', actorId],
      );
    }

    // The draft's concurrency token. Idempotent, so a revision created before the
    // token existed is backfilled rather than left unwritable: a draft write is
    // conditioned on this value, and a revision without one cannot be edited.
    const etag = await ensureEtag({ client, projectId, revisionId, scenarioId, actorId });

    return { scenarioId, scenarioCreated, revisionId, revisionCreated, etag };
  });
}
