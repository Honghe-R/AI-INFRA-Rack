import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withTenant } from '@ai-infra/db';
import {
  CATALOG,
  EVIDENCE_BUCKETS,
  PENDING_ACTIONS,
  READ_TOOLS,
  SURFACE_KEY,
  TOOL_SURFACE_VERSION,
  applyChangeSet,
  createFacilityToolSurface,
  createToolRegistry,
  defineTool,
  ensureEtag,
  unexplainedConstraints,
  unreadEvidenceBuckets,
} from '../index.js';
import { seedBaseline } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : 'DATABASE_URL is not set';

let pool;

before(() => {
  if (!databaseUrl) return;
  pool = createPool({ connectionString: databaseUrl, max: 4 });
});

after(async () => {
  if (pool) await pool.end();
});

/** The action half is stubbed here; the reads never touch it. */
const stubService = () => ({
  requestValidation: async () => ({ mode: 'sync', runId: randomUUID(), scope: 'FULL', status: 'COMPLETED' }),
  grantWaiver: async () => ({ waiverId: randomUUID(), status: 'GRANTED' }),
  revokeWaiver: async () => ({ waiverId: randomUUID(), status: 'REVOKED' }),
});

/** A surface whose tenant seam runs against the client the caller supplies. */
function surfaceOn(client, { authorize = async () => true, onAudit = null, tenant } = {}) {
  return createFacilityToolSurface({
    pool,
    validationService: stubService(),
    authorize,
    onAudit,
    runInTenant: tenant ?? ((_projectId, fn) => fn(client)),
  });
}

/* ============================================================== the contract */

test('every evidence bucket the catalog declares has a reader', () => {
  assert.deepEqual(
    unreadEvidenceBuckets(),
    [],
    `a constraint whose evidence no read tool can read is nameable but not explainable:\n  ${unexplainedConstraints().join('\n  ')}`,
  );
  assert.equal(EVIDENCE_BUCKETS.length, 24);
});

test('no catalog constraint is left unexplained', () => {
  assert.deepEqual(unexplainedConstraints(), []);
  assert.equal(CATALOG.length, 74);
});

test('the surface declares its shape and every read carries an axis', () => {
  assert.equal(SURFACE_KEY, 'facility');
  assert.equal(TOOL_SURFACE_VERSION, '1');
  assert.equal(READ_TOOLS.length, 32);
  for (const tool of READ_TOOLS) {
    assert.ok(tool.axis, `${tool.name} has no axis`);
    assert.equal(tool.access, 'read', `${tool.name} is not a read`);
    assert.ok(tool.description.length > 20, `${tool.name} has no usable description`);
  }
});

test('every tool that is specified but unbuilt is recorded with an owning tier', () => {
  assert.ok(PENDING_ACTIONS.length > 0);
  const registered = new Set(READ_TOOLS.map((tool) => tool.name));
  for (const action of PENDING_ACTIONS) {
    assert.ok(action.tier, `${action.name} names no owning tier`);
    assert.equal(registered.has(action.name), false, `${action.name} is pending and must not be registered`);
  }
});

/* --------------------------------------------------------------- descriptors */

test('a descriptor never carries executable code', () => {
  const registry = createToolRegistry({ tools: READ_TOOLS });
  const descriptors = registry.describe();
  assert.equal(descriptors.length, READ_TOOLS.length);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.handler, undefined);
    assert.equal(descriptor.surface, SURFACE_KEY);
  }
});

test('a write tool must declare confirmation, and defineTool refuses one that does not', () => {
  assert.throws(
    () =>
      defineTool({
        name: 'bad_write',
        axis: 'ACTION',
        access: 'write',
        description: 'A write that forgot to require confirmation.',
        handler: async () => ({}),
      }),
    /must declare confirmation: required/,
  );
});

test('defineTool refuses an unknown axis, an unknown access, a missing handler, and a bad name', () => {
  const base = { name: 'x', access: 'read', description: 'd', handler: async () => ({}) };
  assert.throws(() => defineTool({ ...base, axis: 'MAGIC' }), /unknown axis/);
  assert.throws(() => defineTool({ ...base, axis: 'STATE', access: 'mutate' }), /unknown access/);
  assert.throws(() => defineTool({ ...base, axis: 'STATE', handler: undefined }), /no handler/);
  assert.throws(() => defineTool({ ...base, name: 'NotSnake', axis: 'STATE' }), /snake_case/);
  assert.throws(() => defineTool({ ...base, axis: 'STATE', description: '' }), /no description/);
});

test('a second tool may not reuse a name', () => {
  assert.throws(() => createToolRegistry({ tools: [READ_TOOLS[0], READ_TOOLS[0]] }), /Duplicate tool name/);
});

/* ---------------------------------------------------------------- selection */

test('selection drops a tool whose required keys are not all granted', () => {
  const registry = createToolRegistry({ tools: READ_TOOLS });
  const readOnly = registry.select({ granted: new Set(['facility.read']) });
  assert.equal(
    readOnly.length,
    READ_TOOLS.length - 2,
    'only the two binding reads also need asset.read: a binding names an asset version, so reading one is reading the asset layer',
  );
  assert.equal(readOnly.some((tool) => tool.name === 'get_asset_binding'), false);
  assert.equal(readOnly.some((tool) => tool.name === 'list_asset_bindings'), false);

  const withAsset = registry.select({ granted: new Set(['facility.read', 'asset.read']) });
  assert.equal(withAsset.length, READ_TOOLS.length);

  assert.equal(registry.select({ granted: new Set() }).length, 0, 'no key means no tool');
});

test('a read-only scope removes every write, including a confirmed one', () => {
  const write = defineTool({
    name: 'run_validation',
    axis: 'ACTION',
    access: 'write',
    description: 'Run validation.',
    requiredFunctions: ['facility.validate.run'],
    confirmation: 'required',
    handler: async () => ({}),
  });
  const registry = createToolRegistry({ tools: [...READ_TOOLS, write] });
  assert.equal(registry.select({ readOnly: true }).some((tool) => tool.access === 'write'), false);
  assert.equal(registry.select({ readOnly: false }).some((tool) => tool.access === 'write'), true);
});

/* ======================================================== execution contract */

test('an unknown tool is refused with 404', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  await assert.rejects(
    () => surface.execute({ name: 'no_such_tool', args: {}, context: { projectId: randomUUID() } }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
  );
});

test('an unknown argument is refused rather than ignored', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  await assert.rejects(
    () =>
      surface.execute({
        name: 'list_phases',
        args: { revision_id: randomUUID(), severity: 'ERROR' },
        context: { projectId: randomUUID(), revisionId: randomUUID() },
      }),
    (error) =>
      error.code === 'VALIDATION_FAILED' &&
      error.details.some((detail) => detail.field === 'severity' && detail.reason === 'unknown_property'),
  );
});

test('a missing required argument is refused and named', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  await assert.rejects(
    () => surface.execute({ name: 'list_phases', args: {}, context: { projectId: randomUUID(), revisionId: randomUUID() } }),
    (error) => error.details.some((detail) => detail.field === 'revision_id' && detail.reason === 'required'),
  );
});

test('an argument naming another revision is a 403, never a silent rewrite', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  await assert.rejects(
    () =>
      surface.execute({
        name: 'list_phases',
        args: { revision_id: randomUUID() },
        context: { projectId: randomUUID(), revisionId: randomUUID() },
      }),
    (error) => error.code === 'CONTEXT_MISMATCH' && error.status === 403,
  );
});

test('a denied permission is refused at the handler, not only at selection', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) }, { authorize: async () => false });
  const revisionId = randomUUID();
  await assert.rejects(
    () => surface.execute({ name: 'list_phases', args: { revision_id: revisionId }, context: { projectId: randomUUID(), revisionId } }),
    (error) =>
      error.code === 'INSUFFICIENT_PERMISSION' &&
      error.details.some((detail) => detail.function_key === 'facility.read' && detail.allowed === false),
  );
});

test('a tool with no authorization answer available is refused rather than allowed', async () => {
  const surface = createFacilityToolSurface({
    pool,
    validationService: stubService(),
    runInTenant: (_projectId, fn) => fn({ query: async () => ({ rows: [] }) }),
  });
  const revisionId = randomUUID();
  await assert.rejects(
    () => surface.execute({ name: 'list_phases', args: { revision_id: revisionId }, context: { projectId: randomUUID(), revisionId } }),
    (error) => error.code === 'INSUFFICIENT_PERMISSION' && error.status === 403,
  );
});

test('a write in a read-only scope is refused before its arguments are even considered', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  await assert.rejects(
    () =>
      surface.execute({
        name: 'run_validation',
        args: { revision_id: randomUUID() },
        context: { projectId: randomUUID(), revisionId: randomUUID(), readOnly: true },
      }),
    (error) => error.code === 'REVISION_IMMUTABLE' && error.status === 409,
  );
});

test('an unconfirmed write returns CONFIRMATION_REQUIRED carrying the call it would make', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  const revisionId = randomUUID();
  await assert.rejects(
    () =>
      surface.execute({
        name: 'run_validation',
        args: { revision_id: revisionId, scope: 'FULL' },
        context: { projectId: randomUUID(), revisionId },
      }),
    (error) =>
      error.code === 'CONFIRMATION_REQUIRED' &&
      error.status === 409 &&
      error.details[0].tool === 'run_validation' &&
      error.details[0].arguments.scope === 'FULL',
  );
});

test('a confirmed write delegates to the domain service and states its consequence', async () => {
  let received = null;
  const surface = createFacilityToolSurface({
    pool,
    authorize: async () => true,
    validationService: {
      ...stubService(),
      requestValidation: async (input) => {
        received = input;
        return { mode: 'job', jobId: 'job-1', runId: 'run-1', scope: input.scope, status: 'QUEUED' };
      },
    },
    runInTenant: (_projectId, fn) => fn({ query: async () => ({ rows: [] }) }),
  });

  const revisionId = randomUUID();
  const result = await surface.execute({
    name: 'run_validation',
    args: { revision_id: revisionId, scope: 'FULL', base_etag: 'sum-1' },
    context: { projectId: randomUUID(), revisionId, userId: 'u-1', correlationId: 'c-1', confirmed: true },
  });

  assert.equal(received.scope, 'FULL');
  assert.equal(received.baseEtag, 'sum-1');
  assert.equal(received.actorId, 'u-1');
  assert.equal(received.correlationId, 'c-1');
  assert.equal(result.mode, 'job');
  assert.match(result.consequence, /freezes this revision as VALIDATED/);
});

test('an unresolvable waiver policy is refused, so no waiver cites a policy that does not exist', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  const revisionId = randomUUID();
  await assert.rejects(
    () =>
      surface.execute({
        name: 'grant_waiver',
        args: { revision_id: revisionId, diagnostic_ids: [randomUUID()], policy_id: 'made-up-policy', reason: 'x' },
        context: { projectId: randomUUID(), revisionId, confirmed: true },
      }),
    (error) =>
      error.code === 'VALIDATION_FAILED' &&
      error.details.some((detail) => detail.field === 'policy_id' && detail.reason === 'policy_reference_not_pinned'),
  );
});

test('a waiver on a pinned policy reports whether that policy promotes coverage', async () => {
  const surface = surfaceOn({ query: async () => ({ rows: [] }) });
  const revisionId = randomUUID();
  const result = await surface.execute({
    name: 'grant_waiver',
    args: {
      revision_id: revisionId,
      diagnostic_ids: [randomUUID()],
      policy_id: 'coverage-promoting-waiver@1',
      reason: 'Reviewed by the design authority.',
    },
    context: { projectId: randomUUID(), revisionId, confirmed: true },
  });
  assert.equal(result.policy.coveragePromotingWaivers, true);
  assert.match(result.effect, /evidence is unchanged/);
});

test('every call emits one credential-free audit record, including a failed one', async () => {
  const records = [];
  const surface = surfaceOn({ query: async () => ({ rows: [] }) }, { onAudit: (record) => records.push(record) });

  await surface.execute({
    name: 'list_policies',
    args: {},
    context: { projectId: randomUUID(), userId: 'u-1', correlationId: 'c-1' },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'ok');
  assert.equal(records[0].correlation_id, 'c-1');
  assert.equal(records[0].access, 'read');
  assert.equal(typeof records[0].duration_ms, 'number');

  await assert.rejects(() =>
    surface.execute({
      name: 'list_phases',
      args: {},
      context: { projectId: randomUUID(), revisionId: randomUUID() },
    }),
  );
  assert.equal(records.length, 2);
  assert.equal(records[1].outcome, 'failed');
  assert.equal(records[1].tool, 'list_phases', 'a failed call is still attributed to its tool');

  for (const record of records) {
    assert.doesNotMatch(JSON.stringify(record), /secret|signed|object-store|bucket|password/i);
  }
});

test('a result over the byte cap degrades with a notice instead of failing', async () => {
  const surface = createFacilityToolSurface({
    pool,
    validationService: stubService(),
    authorize: async () => true,
    runInTenant: () => ({
      items: Array.from({ length: 400 }, (_, index) => ({ id: index, blob: 'x'.repeat(200) })),
      total: 400,
      returned: 400,
      truncated: false,
    }),
  });
  const revisionId = randomUUID();
  const result = await surface.execute({
    name: 'list_impact_notices',
    args: { revision_id: revisionId },
    context: { projectId: randomUUID(), revisionId },
  });
  assert.equal(result.truncated, true);
  assert.match(result.notice, /truncated/);
  assert.ok(result.items.length < 400);
  assert.equal(result.next_cursor, null, 'a degraded result never promises a cursor');
});

/* ==================================================== reads over the store */

class Rollback extends Error {
  constructor(value) {
    super('rollback');
    this.value = value;
  }
}

/** Seeds the baseline inside one transaction and runs `fn` against that client. */
async function withBaseline(fn, surfaceOptions = {}) {
  const projectId = randomUUID();
  const scenarioId = randomUUID();
  const revisionId = randomUUID();
  try {
    await withTenant(pool, projectId, async (client) => {
      const userId = randomUUID();
      await client.query('INSERT INTO users (user_id, subject) VALUES ($1, $2)', [userId, `tools-${userId}`]);
      const organizationId = randomUUID();
      await client.query('INSERT INTO organizations (organization_id, name) VALUES ($1, $2)', [organizationId, 'Tools org']);
      await client.query('INSERT INTO projects (project_id, organization_id, name) VALUES ($1, $2, $3)', [
        projectId,
        organizationId,
        'Tools project',
      ]);
      await client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
        scenarioId,
        projectId,
        'Baseline',
      ]);
      await client.query(
        `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
         VALUES ($1, $2, $3, 'DRAFT', 'Draft 1')`,
        [revisionId, projectId, scenarioId],
      );
      const ids = await seedBaseline(client, { projectId, scenarioId, revisionId, actorId: userId });
      const surface = surfaceOn(client, surfaceOptions);
      const scope = { surface, client, projectId, scenarioId, revisionId, userId, ids };
      throw new Rollback(await fn(scope));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value;
    throw error;
  }
}

const ctx = (scope, extra = {}) => ({
  projectId: scope.projectId,
  scenarioId: scope.scenarioId,
  revisionId: scope.revisionId,
  confirmed: true,
  ...extra,
});

test('the verification reads serve the seeded graph', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface } = scope;
    return {
      buildingId: scope.ids.building,
      context: await surface.execute({ name: 'get_revision_context', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      coverage: await surface.execute({ name: 'get_coverage', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      phases: await surface.execute({ name: 'list_phases', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      requirements: await surface.execute({
        name: 'list_resilience_requirements',
        args: { revision_id: scope.revisionId },
        context: ctx(scope),
      }),
      profile: await surface.execute({
        name: 'get_environmental_profile',
        args: { revision_id: scope.revisionId, profile_id: scope.ids.profile },
        context: ctx(scope),
      }),
      envConstraints: await surface.execute({
        name: 'list_environmental_constraints',
        args: { revision_id: scope.revisionId },
        context: ctx(scope),
      }),
      assumptions: await surface.execute({ name: 'list_assumptions', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      domains: await surface.execute({ name: 'list_failure_domains', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      sources: await surface.execute({ name: 'list_utility_sources', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      interfaces: await surface.execute({ name: 'list_utility_interfaces', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      namedEntities: await surface.execute({
        name: 'list_entities',
        args: { revision_id: scope.revisionId, name: 'BUILDING' },
        context: ctx(scope),
      }),
      reserves: await surface.execute({ name: 'list_storage_reserves', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
      entity: await surface.execute({
        name: 'get_entity',
        args: { revision_id: scope.revisionId, entity_id: scope.ids.building },
        context: ctx(scope),
      }),
      binding: await surface.execute({
        name: 'get_asset_binding',
        args: { revision_id: scope.revisionId, binding_id: scope.ids.binding },
        context: ctx(scope),
      }),
      waivers: await surface.execute({ name: 'list_waivers', args: { revision_id: scope.revisionId }, context: ctx(scope) }),
    };
  });

  assert.equal(result.context.lifecycleState, 'DRAFT');
  assert.equal(result.context.readOnly, false);
  assert.equal(result.context.contentChecksum, null);
  assert.equal(result.context.freshness.available, false, 'this fixture creates no token row, and the read says so');
  assert.equal(result.context.capabilityCoverage.length, 8, 'coverage is complete over every capability');

  assert.equal(result.coverage.coverage.length, 8);
  assert.ok(result.coverage.coverage.every((entry) => entry.derived === false), 'underived is stated, not implied');

  assert.ok(result.phases.items.length >= 2);
  assert.ok(result.phases.items[0].capabilityAvailability.length >= 1, 'phase availability is joined in');
  assert.ok(result.phases.items.some((phase) => phase.dependencies.length >= 1), 'the dependency edge is attached');

  assert.ok(result.requirements.items.length >= 1);
  assert.ok(Array.isArray(result.requirements.items[0].appliesTo), 'the resource_kind[] cast yields a real array');
  assert.equal(result.requirements.items[0].policyId, 'corp-dc-standard@3');

  assert.ok(result.profile.profileId, 'the profile resolves by id');
  assert.ok(result.envConstraints.items.length >= 1);
  assert.ok(result.assumptions.items.length >= 1);
  assert.ok(result.domains.items.length >= 2);
  assert.ok(result.sources.items.length >= 4);
  // The name is the handle a caller can reproduce: a model copies a label and not an id, and
  // without it four sources were distinguishable only by an opaque identifier.
  assert.equal(result.sources.items[0].displayName, 'UTILITY_SOURCE', 'the source read carries the registered display name');
  assert.ok(result.interfaces.items.length >= 4);
  assert.equal(result.interfaces.items[0].displayName, 'UTILITY_INTERFACE', 'so does the interface read');
  assert.equal(result.interfaces.items[0].source.displayName, 'UTILITY_SOURCE', 'and the source it belongs to, as its own object');
  assert.equal(result.interfaces.items[0].source.utilitySourceId, result.interfaces.items[0].utilitySourceId);
  // The read the entity resolver uses: an exact display-name filter, not a scan to page through.
  assert.equal(result.namedEntities.items.length, 1, 'only the building is named BUILDING');
  assert.equal(result.namedEntities.items[0].entityId, result.buildingId);
  assert.ok(result.reserves.items.length >= 1);

  assert.ok(result.entity.geometryRoles.length >= 1, 'geometry roles come with the entity');
  assert.equal(result.entity.entityType, 'BUILDING');

  assert.ok(result.binding.bindingId, 'the binding resolves');
  assert.equal(result.binding.mappingsInReview, 0, 'the fixture mapping is reviewed');
  assert.equal(result.binding.authoritative, true);
  // A clean baseline has no waivers: the fixture records one only when a mutation
  // asks for it, so an empty list here is the absence of a governance act.
  assert.equal(result.waivers.items.length, 0);
});

test('compare_revisions refuses a revision it cannot find instead of reading it as "no changes"', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const attempt = (args) =>
      scope.surface
        .execute({ name: 'compare_revisions', args, context: ctx(scope) })
        .then((value) => ({ value }))
        .catch((error) => ({ error }));

    return {
      missing: await attempt({ base_revision_id: randomUUID(), target_revision_id: scope.revisionId }),
      itself: await attempt({ base_revision_id: scope.revisionId, target_revision_id: scope.revisionId }),
    };
  });

  // A revision that does not exist reads as no rows. Diffed against the real revision
  // that would report the whole graph as added, and against another missing revision as
  // *identical* — both fabrications. A bad identifier must come back as a refusal.
  assert.equal(result.missing.error.status, 404);
  assert.equal(result.missing.error.code, 'NOT_FOUND');
  assert.deepEqual(result.missing.error.details.map((entry) => entry.field), ['base_revision_id']);

  // Comparing a revision with itself is the one honest zero, and it says so rather than
  // reading as "nothing was ever edited".
  assert.equal(result.itself.value.totalChanges, 0);
  assert.equal(result.itself.value.isEqual, true);
  assert.equal(result.itself.value.identical, true);
  assert.match(result.itself.value.notice, /same revision/);
  assert.equal(result.itself.value.baseRevision.name, 'Draft 1', 'the real revision identity is echoed back');
});

test('compare_revisions refuses to diff two revisions of different scenarios', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const otherScenario = randomUUID();
    const otherRevision = randomUUID();
    await scope.client.query('INSERT INTO scenarios (scenario_id, project_id, name) VALUES ($1, $2, $3)', [
      otherScenario,
      scope.projectId,
      'Second scenario',
    ]);
    await scope.client.query(
      `INSERT INTO revisions (revision_id, project_id, scenario_id, lifecycle_state, name)
       VALUES ($1, $2, $3, 'DRAFT', 'Other draft')`,
      [otherRevision, scope.projectId, otherScenario],
    );
    return scope.surface
      .execute({
        name: 'compare_revisions',
        args: { base_revision_id: scope.revisionId, target_revision_id: otherRevision },
        context: ctx(scope),
      })
      .then((value) => ({ value }))
      .catch((error) => ({ error }));
  });

  assert.equal(result.error.status, 422);
  assert.equal(result.error.code, 'VALIDATION_FAILED');
  assert.deepEqual(result.error.details.map((entry) => entry.reason), ['scenario_mismatch', 'scenario_mismatch']);
});

test('get_revision_activity reports the committed change sets that advanced the draft', { skip }, async () => {
  // The outbox is the only change history a draft has: it is edited in place, so there
  // are no per-edit revisions to diff and one commit is one event.
  const result = await withBaseline(async (scope) => {
    const { surface, client, projectId, scenarioId, revisionId, userId, ids } = scope;
    const token = await ensureEtag({ client, projectId, revisionId, scenarioId, actorId: userId });
    const containerId = randomUUID();
    const committed = await applyChangeSet({
      client,
      projectId,
      revisionId,
      scenarioId,
      actorId: userId,
      baseRevisionId: ids.envelope,
      etag: token.etag,
      previewDiagnostics: false,
      changes: [
        {
          kind: 'create_container',
          payload: { container_id: containerId, container_kind: 'BUILDING', name: 'History Hall', scope_id: ids.scope },
        },
      ],
    });

    return {
      committed,
      containerId,
      actorId: userId,
      activity: await surface.execute({ name: 'get_revision_activity', args: { revision_id: revisionId }, context: ctx(scope) }),
      unrelated: await surface.execute({
        name: 'get_revision_activity',
        args: { revision_id: revisionId, change_kind: 'remove_entity' },
        context: ctx(scope),
      }),
    };
  });

  assert.equal(result.activity.items.length, 1, 'one commit is one activity event');
  const [event] = result.activity.items;
  assert.equal(event.eventType, 'facility.revision.changed.v1');
  assert.equal(event.actorId, result.actorId, 'the commit records who made it');
  assert.deepEqual(event.changeSet.changeKinds, ['create_container']);
  assert.equal(event.changeSet.etag, result.committed.etag, 'the event carries the token the commit produced');
  assert.equal(event.changeSet.etagVersion, result.committed.etagVersion);
  assert.ok(
    event.changeSet.changedEntityRefs.some((ref) => ref.entity_id === result.containerId),
    'the changed entity is named',
  );

  // A filter that matches no event yields no events, rather than an event whose change
  // set is empty and could be read as "this commit changed nothing".
  assert.equal(result.unrelated.items.length, 0);
});

test('list_waivers reports a recorded waiver and never hides a revoked or expired one', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface, client, projectId, scenarioId, revisionId, userId } = scope;
    const insert = (waiverId, reason, expiresAt, status, grantedAt = null) =>
      client.query(
        `INSERT INTO waivers
           (waiver_id, project_id, scenario_id, revision_id, diagnostic_ids, scope, granted_by, policy_id,
            reason, granted_at, expires_at, status)
         VALUES ($1, $2, $3, $4, '{}', 'REVISION', $5, 'coverage-promoting-waiver@1', $6,
                 COALESCE($7::timestamptz, now()), $8, $9)`,
        [waiverId, projectId, scenarioId, revisionId, userId, reason, grantedAt, expiresAt, status],
      );

    const live = randomUUID();
    const expired = randomUUID();
    const revoked = randomUUID();
    await insert(live, 'Reviewed by the design authority.', null, 'GRANTED');
    // An expiry must fall after the grant, so the expired record is granted in the
    // past as well: it is an expired waiver, not an impossible one.
    await insert(
      expired,
      'Superseded approval window.',
      new Date(Date.now() - 86_400_000).toISOString(),
      'GRANTED',
      new Date(Date.now() - 10 * 86_400_000).toISOString(),
    );
    await insert(revoked, 'Policy withdrawn.', null, 'REVOKED');

    return {
      all: await surface.execute({ name: 'list_waivers', args: { revision_id: revisionId }, context: ctx(scope) }),
      granted: await surface.execute({
        name: 'list_waivers',
        args: { revision_id: revisionId, status: 'GRANTED' },
        context: ctx(scope),
      }),
      expired,
    };
  });

  assert.equal(result.all.items.length, 3, 'a revoked waiver stays listed');
  assert.equal(result.granted.items.length, 2, 'the status filter is applied');
  assert.equal(
    result.all.items.some((item) => item.status === 'REVOKED'),
    true,
  );
  const expired = result.all.items.find((item) => item.waiverId === result.expired);
  assert.ok(expired.expiresAt, 'expiry is reported so a caller can judge it');
});

test('get_entity reports a type mismatch rather than answering about another entity', { skip }, async () => {
  const error = await withBaseline(async (scope) =>
    scope.surface
      .execute({
        name: 'get_entity',
        args: { revision_id: scope.revisionId, entity_id: scope.ids.building, entity_type: 'PARCEL' },
        context: ctx(scope),
      })
      .then(() => null)
      .catch((thrown) => thrown),
  );
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.details[0].reason, 'type_mismatch');
  assert.equal(error.details[0].actual, 'BUILDING');
});

test('the spatial reads compute rather than assert', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface } = scope;
    return {
      explicit: await surface.execute({
        name: 'query_geometry',
        args: { revision_id: scope.revisionId, entity_id: scope.ids.building, include_geojson: true },
        context: ctx(scope),
      }),
      // No flag at all: the default. The record has to say where it is either way — a null in
      // place of a position read as "there is none" to a live turn, which then reported that
      // coordinate data was not exposed, spent six rounds re-asking, and abandoned the task.
      byDefault: await surface.execute({
        name: 'query_geometry',
        args: { revision_id: scope.revisionId, entity_id: scope.ids.building },
        context: ctx(scope),
      }),
      // A page with nothing on it has no coordinates to offer, so it must not send the caller
      // after an argument that would change nothing.
      empty: await surface.execute({
        name: 'query_geometry',
        args: { revision_id: scope.revisionId, bbox: [0, 0, 0.001, 0.001] },
        context: ctx(scope),
      }),
      distance: await surface.execute({
        name: 'spatial_query',
        args: {
          revision_id: scope.revisionId,
          predicate: 'DISTANCE',
          subject: { entity_id: scope.ids.building },
          target: { entity_id: scope.ids.yard },
        },
        context: ctx(scope),
      }),
      selfIntersects: await surface.execute({
        name: 'spatial_query',
        args: {
          revision_id: scope.revisionId,
          predicate: 'INTERSECTS',
          subject: { entity_id: scope.ids.building },
          target: { entity_id: scope.ids.building },
        },
        context: ctx(scope),
      }),
      unresolved: await surface.execute({
        name: 'spatial_query',
        args: {
          revision_id: scope.revisionId,
          predicate: 'DISTANCE',
          subject: { entity_id: randomUUID() },
          target: { entity_id: scope.ids.yard },
        },
        context: ctx(scope),
      }),
    };
  });

  assert.ok(result.explicit.items.length >= 1);
  assert.ok(result.explicit.items[0].entityId, 'the geometry carries its owning entity');
  assert.equal(result.explicit.items[0].role, 'FOOTPRINT', 'the building footprint is what was asked for');
  assert.ok(result.explicit.items[0].geojson4326, 'the coordinates come back when they are asked for');

  // The summary is what makes a page readable without one, and it is constant size whatever the
  // shape is — which is what stops a boundary with thousands of vertices from being clipped into
  // a shape that is not the shape.
  assert.equal(result.byDefault.items[0].geojson4326, null, 'and not otherwise, because a shape can be large');
  assert.equal(result.byDefault.items[0].bbox4326.length, 4, 'but the record still says where it is');
  assert.ok(result.byDefault.items[0].vertexCount > 0, 'and how much shape is there to read');
  assert.deepEqual(
    result.byDefault.items[0].bbox4326,
    result.explicit.items[0].bbox4326,
    'the summary does not depend on whether the coordinates were asked for',
  );

  // The page tells the caller how to read what it did not return. The description says it too, and
  // the description was not enough: a model read the old null as "there is no coordinate data",
  // spent six rounds re-asking, and abandoned the task.
  assert.match(result.byDefault.coordinates_omitted, /include_geojson: true/, 'the page names the argument that would return them');
  assert.equal(result.explicit.coordinates_omitted, null, 'and says nothing when they are already here');
  assert.equal(result.empty.returned, 0, 'the off-site box matches nothing');
  assert.equal(result.empty.coordinates_omitted, null, 'so an empty page sends the caller after nothing');

  assert.equal(result.distance.predicate, 'DISTANCE');
  assert.equal(result.distance.subjectResolved, true);
  assert.ok(result.distance.distanceM >= 0, 'a real measurement in the projected CRS');
  assert.equal(result.distance.satisfied, null, 'a distance is a measurement, not a gate');

  assert.equal(result.selfIntersects.satisfied, true, 'an entity intersects itself');
  assert.equal(result.selfIntersects.predicate, 'INTERSECTS');

  assert.equal(result.unresolved.subjectResolved, false);
  assert.match(result.unresolved.note, /no geometry/);
});

test('explain_constraint reports applicability from the engine snapshot', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface } = scope;
    return {
      phases: await surface.execute({
        name: 'explain_constraint',
        args: { constraint_id: 'facility.phase.dependency.cycle', revision_id: scope.revisionId },
        context: ctx(scope),
      }),
      geometry: await surface.execute({
        name: 'explain_constraint',
        args: { constraint_id: 'facility.data.geometry.invalid', revision_id: scope.revisionId },
        context: ctx(scope),
      }),
      unknown: await surface.execute({
        name: 'explain_constraint',
        args: { constraint_id: 'facility.not.a.constraint' },
        context: ctx(scope),
      }),
    };
  });

  assert.equal(result.phases.known, true);
  assert.equal(result.phases.evidence, 'phaseDeps');
  assert.equal(result.phases.applicability.evidencePresent, true);
  assert.match(result.phases.applicability.reason, /runs during validation/);
  assert.equal(result.phases.applicability.wouldRun, true);
  assert.ok(result.phases.rule.length > 10, 'the catalog rule text travels with the explanation');

  assert.equal(result.geometry.evidence, 'geometry');
  assert.equal(result.unknown.known, false);
  assert.equal(result.unknown.applicability, null);
});

test('the policy reads resolve a pinned reference and refuse an unpinned one', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface } = scope;
    return {
      pinned: await surface.execute({ name: 'resolve_policy_ref', args: { policy_ref: 'corp-dc-standard@3' }, context: ctx(scope) }),
      unpinned: await surface.execute({ name: 'resolve_policy_ref', args: { policy_ref: 'corp-dc-standard' }, context: ctx(scope) }),
      badVersion: await surface.execute({ name: 'resolve_policy_ref', args: { policy_ref: 'corp-dc-standard@99' }, context: ctx(scope) }),
      list: await surface.execute({ name: 'list_policies', args: {}, context: ctx(scope) }),
    };
  });

  assert.equal(result.pinned.resolved, true);
  assert.equal(result.pinned.policy.coveragePromotingWaivers, false);
  assert.equal(result.unpinned.resolved, false);
  assert.match(result.unpinned.reason, /not pinned/);
  assert.equal(result.badVersion.resolved, false);
  assert.match(result.badVersion.reason, /no registry entry/);
  assert.ok(result.list.policies.length >= 5);
  assert.ok(result.list.policies.every((policy) => policy.reference.includes('@')));
});

/* ------------------------------------------------- diagnostics derivation */

const DIAGNOSTIC_INSERT = `
  INSERT INTO facility_diagnostics
    (diagnostic_id, project_id, scenario_id, revision_id, validation_run_id, constraint_id, severity, status,
     entity_refs, geometry_refs, source_values, computed, remediation_category, remediation_hint)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '[]'::jsonb, $10::jsonb, '{}'::jsonb, $11, $12)`;

test('a diagnostic carries the evidence model and gating capability the catalog supplies', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface, client, projectId, scenarioId, revisionId, ids } = scope;
    // A diagnostic must cite the run that produced it, so the run is created here.
    const runId = randomUUID();
    await client.query(
      `INSERT INTO validation_runs
         (validation_run_id, project_id, scenario_id, revision_id, envelope_id, scope, status, error_count,
          warning_count, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'FULL', 'COMPLETED', 0, 0, now(), now())`,
      [runId, projectId, scenarioId, revisionId, ids.envelope],
    );

    const insert = (id, constraintId, severity, status, entityRefs, remediation) =>
      client.query(DIAGNOSTIC_INSERT, [
        id,
        projectId,
        scenarioId,
        revisionId,
        runId,
        constraintId,
        severity,
        status,
        JSON.stringify(entityRefs),
        JSON.stringify([]),
        remediation,
        'fixture hint',
      ]);

    // A resource-gated finding whose source is a POWER source: the capability is
    // recoverable from the store even though the row does not record it.
    const resourceId = randomUUID();
    await insert(
      resourceId,
      'facility.utility.source.state_not_firm',
      'WARNING',
      'OPEN',
      [{ entity_type: 'UTILITY_SOURCE', entity_id: ids.powerA }],
      'ADD_DATA',
    );
    // A geometry-gated finding, whose gate is unambiguous from the catalog.
    const geometryId = randomUUID();
    await insert(geometryId, 'facility.data.geometry.role_missing', 'ERROR', 'OPEN', [], 'ADD_DATA');
    // A replaced record: history, not a current finding.
    const supersededId = randomUUID();
    await insert(supersededId, 'facility.site.height.exceeded', 'ERROR', 'SUPERSEDED', [], 'CORRECT_GEOMETRY');

    return {
      live: await surface.execute({ name: 'list_diagnostics', args: { revision_id: revisionId }, context: ctx(scope) }),
      all: await surface.execute({
        name: 'list_diagnostics',
        args: { revision_id: revisionId, include_superseded: true },
        context: ctx(scope),
      }),
      errors: await surface.execute({
        name: 'list_diagnostics',
        args: { revision_id: revisionId, severity: 'ERROR' },
        context: ctx(scope),
      }),
      byCapability: await surface.execute({
        name: 'list_diagnostics',
        args: { revision_id: revisionId, capability: 'POWER' },
        context: ctx(scope),
      }),
      byId: await surface.execute({
        name: 'list_diagnostics',
        args: { revision_id: revisionId, diagnostic_id: resourceId },
        context: ctx(scope),
      }),
      byEntity: await surface.execute({
        name: 'list_diagnostics',
        args: { revision_id: revisionId, entity_id: ids.powerA },
        context: ctx(scope),
      }),
      ids: { resourceId, geometryId, supersededId },
    };
  });

  const byConstraint = new Map(result.live.items.map((item) => [item.constraintId, item]));
  const resource = byConstraint.get('facility.utility.source.state_not_firm');
  assert.ok(resource, 'the live resource finding is listed');
  assert.equal(resource.evidence, 'sources', 'the evidence model comes from the catalog');
  assert.equal(resource.gates, 'RESOURCE');
  assert.equal(resource.resourceKind, 'POWER', 'the resource kind is recovered from the referenced source');
  assert.deepEqual(resource.capabilities, ['POWER']);
  assert.equal(resource.capabilityExact, true);

  const geometry = byConstraint.get('facility.data.geometry.role_missing');
  assert.equal(geometry.gates, 'GEOMETRY');
  assert.deepEqual(geometry.capabilities, ['GEOMETRY']);
  assert.equal(geometry.evidence, 'entities');
  assert.equal(geometry.remediationHint, 'fixture hint');

  assert.equal(result.live.items.some((item) => item.status === 'SUPERSEDED'), false, 'history is hidden by default');
  assert.equal(result.all.items.some((item) => item.status === 'SUPERSEDED'), true, 'and revealed on request');

  assert.ok(result.errors.items.every((item) => item.severity === 'ERROR'));
  assert.equal(result.errors.items.some((item) => item.constraintId === 'facility.site.height.exceeded'), false);

  assert.equal(result.byCapability.items.length, 1, 'the capability filter is exact, not a prefix guess');
  assert.equal(result.byCapability.items[0].constraintId, 'facility.utility.source.state_not_firm');

  assert.equal(result.byId.items.length, 1, 'a diagnostic is addressable by identity');
  assert.equal(result.byId.items[0].diagnosticId, result.ids.resourceId);

  assert.equal(result.byEntity.items.length, 1, 'a diagnostic is addressable by the entity it references');
});

test('a result too large for one page is paged, never silently trimmed', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface, client, projectId, scenarioId, revisionId, ids } = scope;
    const runId = randomUUID();
    await client.query(
      `INSERT INTO validation_runs
         (validation_run_id, project_id, scenario_id, revision_id, envelope_id, scope, status, error_count,
          warning_count, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'FULL', 'COMPLETED', 0, 0, now(), now())`,
      [runId, projectId, scenarioId, revisionId, ids.envelope],
    );

    // Enough payload that no single page can carry them all. Half are current and
    // half are replaced, which is the shape that exposed the original bug: trimming
    // the tail dropped the newest findings and kept the history.
    const total = 60;
    for (let index = 0; index < total; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(DIAGNOSTIC_INSERT, [
        randomUUID(),
        projectId,
        scenarioId,
        revisionId,
        runId,
        'facility.data.geometry.role_missing',
        'ERROR',
        index % 2 === 0 ? 'OPEN' : 'SUPERSEDED',
        JSON.stringify([]),
        JSON.stringify([{ field: 'blob', value: 'x'.repeat(900) }]),
        'ADD_DATA',
        `record ${index}`,
      ]);
    }

    const readAll = async (args) => {
      const items = [];
      let cursor = null;
      let guard = 0;
      const pages = [];
      do {
        // eslint-disable-next-line no-await-in-loop
        const page = await surface.execute({
          name: 'list_diagnostics',
          args: { ...args, limit: 200, cursor },
          context: ctx(scope),
        });
        pages.push(page);
        items.push(...page.items);
        cursor = page.next_cursor;
        guard += 1;
      } while (cursor && guard < 50);
      return { items, pages };
    };

    const all = await readAll({ revision_id: revisionId, include_superseded: true });
    // The current findings, in isolation, must also be complete — this is the read
    // the surface actually serves by default.
    const live = await readAll({ revision_id: revisionId });

    return { pages: all.pages, retrieved: all.items, live, total };
  });

  assert.ok(result.pages.length > 1, 'the set needed more than one page');
  assert.equal(result.pages[0].page_limited_by, 'bytes', 'the first page was bounded by size, not by the item limit');
  assert.match(result.pages[0].notice, /result size cap/);

  assert.equal(result.retrieved.length, result.total, 'every record is retrievable across the pages');
  assert.equal(new Set(result.retrieved.map((item) => item.diagnosticId)).size, result.total, 'no record is duplicated');

  // The bug this guards: a byte-trimmed page kept history and lost current findings.
  assert.equal(result.live.items.length, result.total / 2, 'every current finding survives paging');
  assert.equal(
    result.live.items.every((item) => item.status !== 'SUPERSEDED'),
    true,
  );
});

test('get_revision_context reports the draft token, which is not the content checksum', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const read = () =>
      scope.surface.execute({
        name: 'get_revision_context',
        args: { revision_id: scope.revisionId },
        context: ctx(scope),
      });
    const before = await read();
    const token = await ensureEtag({
      client: scope.client,
      projectId: scope.projectId,
      revisionId: scope.revisionId,
      scenarioId: scope.scenarioId,
      actorId: scope.userId,
    });
    const after = await read();
    return { before, after, token };
  });

  assert.equal(result.before.draftEtag, null, 'a revision predating the token reads as absent, not invented');
  assert.equal(result.before.freshness.available, false);

  assert.equal(result.after.draftEtag, result.token.etag);
  assert.equal(result.after.etagVersion, 0);
  assert.equal(result.after.contentChecksum, null, 'a draft token is not a content checksum');
  assert.equal(result.after.freshness.available, true);
  assert.equal(result.after.freshness.source, 'revision_etags.etag');
  assert.match(result.after.freshness.note, /advances on every committed change/);
});

test('a limit above the documented cap is refused rather than silently clamped', { skip }, async () => {
  const error = await withBaseline(async (scope) =>
    scope.surface
      .execute({
        name: 'list_entities',
        args: { revision_id: scope.revisionId, limit: 5000 },
        context: ctx(scope),
      })
      .then(() => null)
      .catch((thrown) => thrown),
  );
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.details[0].reason, 'above_maximum');
  assert.equal(error.details[0].max, 200);
});

test('a page reports its total and offers a cursor when more remains', { skip }, async () => {
  const result = await withBaseline(async (scope) => {
    const { surface } = scope;
    const first = await surface.execute({
      name: 'list_entities',
      args: { revision_id: scope.revisionId, limit: 5 },
      context: ctx(scope),
    });
    const rest = first.next_cursor
      ? await surface.execute({
          name: 'list_entities',
          args: { revision_id: scope.revisionId, limit: 200, cursor: first.next_cursor },
          context: ctx(scope),
        })
      : null;
    return { first, rest };
  });

  assert.equal(result.first.items.length, 5);
  assert.ok(result.first.total >= 5, 'the total is reported, so a page is not mistaken for the whole set');
  assert.equal(result.first.truncated, true);
  assert.ok(result.first.next_cursor, 'a truncated page offers a cursor');
  assert.ok(result.rest, 'the cursor pages forward');
  assert.equal(result.rest.items.length, result.rest.total - 5);
  assert.equal(result.rest.next_cursor, null, 'the last page offers no cursor');
});

test('a cursor is bound to the revision it was minted for', { skip }, async () => {
  const error = await withBaseline(async (scope) => {
    const first = await scope.surface.execute({
      name: 'list_entities',
      args: { revision_id: scope.revisionId, limit: 2 },
      context: ctx(scope),
    });
    // The same context, a different revision's cursor: paging must not silently
    // walk a graph the cursor was not computed against.
    const otherRevisionId = randomUUID();
    return scope.surface
      .execute({
        name: 'list_entities',
        args: { revision_id: otherRevisionId, cursor: first.next_cursor },
        context: ctx(scope, { revisionId: otherRevisionId }),
      })
      .then(() => null)
      .catch((thrown) => thrown);
  });
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.details[0].reason, 'invalid_cursor');
});
