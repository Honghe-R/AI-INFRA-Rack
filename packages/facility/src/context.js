/**
 * One revision's graph, loaded once per validation run.
 *
 * A run evaluates up to 74 checks against the same revision, so the context is
 * read once and every check is handed the same snapshot. Rows keep the store's
 * own shape: this package is the tool's own domain layer, and a second naming
 * scheme between the database and the checks would be a place for the two to
 * drift.
 *
 * `evidence` is what strict applicability consults. A bucket is a count of the
 * rows a check needs; zero means the check cannot run and is recorded as **not
 * checked**, never as a pass.
 *
 * The statements themselves live in `stores.js`, because the tool surface reads
 * the same stores and must not answer "what is in this revision" differently.
 */
import { REVISION_STORES, readEnvelope } from './stores.js';

export async function loadRevisionContext({ client, projectId, scenarioId, revisionId }) {
  const revision = [projectId, revisionId];

  const envelope = await readEnvelope({ client, projectId, revisionId });

  const [scopes, containers, geometry, spatialConstraints, sources, interfaces, budgets, allocations,
    demand, reserves, requirements, domains, phases, phaseDeps, phaseAvailability, profiles,
    envConstraints, assumptions, waivers, attestations, bindings, mappings, entities] = await Promise.all([
    client.query(REVISION_STORES.scopes, revision),
    client.query(REVISION_STORES.containers, revision),
    client.query(REVISION_STORES.geometry, revision),
    client.query(REVISION_STORES.spatialConstraints, revision),
    client.query(REVISION_STORES.sources, revision),
    client.query(REVISION_STORES.interfaces, revision),
    client.query(REVISION_STORES.budgets, revision),
    client.query(REVISION_STORES.allocations, revision),
    client.query(REVISION_STORES.demand, revision),
    client.query(REVISION_STORES.reserves, revision),
    client.query(REVISION_STORES.requirements, revision),
    client.query(REVISION_STORES.domains, revision),
    client.query(REVISION_STORES.phases, revision),
    client.query(REVISION_STORES.phaseDeps, revision),
    client.query(REVISION_STORES.phaseAvailability, revision),
    client.query(REVISION_STORES.profiles, revision),
    client.query(REVISION_STORES.envConstraints, revision),
    client.query(REVISION_STORES.assumptions, revision),
    client.query(REVISION_STORES.waivers, revision),
    client.query(REVISION_STORES.attestations, revision),
    client.query(REVISION_STORES.bindings, revision),
    client.query(REVISION_STORES.mappings, revision),
    client.query(REVISION_STORES.entities, revision),
  ]);

  const rows = {
    scopes: scopes.rows,
    containers: containers.rows,
    geometry: geometry.rows,
    spatialConstraints: spatialConstraints.rows,
    sources: sources.rows,
    interfaces: interfaces.rows,
    budgets: budgets.rows,
    allocations: allocations.rows,
    demand: demand.rows,
    reserves: reserves.rows,
    requirements: requirements.rows,
    domains: domains.rows,
    phases: phases.rows,
    phaseDeps: phaseDeps.rows,
    phaseAvailability: phaseAvailability.rows,
    profiles: profiles.rows,
    envConstraints: envConstraints.rows,
    assumptions: assumptions.rows,
    waivers: waivers.rows,
    attestations: attestations.rows,
    bindings: bindings.rows,
    mappings: mappings.rows,
    entities: entities.rows,
  };

  const evidence = {
    envelope: envelope ? 1 : 0,
    entities: rows.entities.length,
    containers: rows.containers.length,
    geometry: rows.geometry.length,
    routes: rows.geometry.filter((row) => row.role === 'ROUTE').length,
    spatialConstraints: rows.spatialConstraints.length,
    quantities: rows.sources.length + rows.budgets.length + rows.reserves.length + rows.envConstraints.length,
    sources: rows.sources.length,
    interfaces: rows.interfaces.length,
    budgets: rows.budgets.length,
    allocations: rows.allocations.length,
    demand: rows.demand.length,
    reserves: rows.reserves.length,
    requirements: rows.requirements.length,
    domains: rows.domains.length,
    phases: rows.phases.length,
    phaseDeps: rows.phaseDeps.length,
    profiles: rows.profiles.length,
    envConstraints: rows.envConstraints.length,
    assumptions: rows.assumptions.length,
    waivers: rows.waivers.length,
    attestations: rows.attestations.length,
    bindings: rows.bindings.length,
    mappings: rows.mappings.length,
  };

  return {
    client,
    projectId,
    scenarioId,
    revisionId,
    envelopeId: envelope?.envelope_id ?? null,
    envelope,
    evidence,
    ...rows,
    /** Convenience lookups that several checks share. */
    phaseById: new Map(rows.phases.map((phase) => [phase.phase_id, phase])),
    domainById: new Map(rows.domains.map((domain) => [domain.failure_domain_id, domain])),
    containerById: new Map(rows.containers.map((container) => [container.container_id, container])),
  };
}

/** The set of revisions that still count as "the current draft" is the caller's. */
export function currentDraftRevision(revisions) {
  return revisions.find((revision) => revision.lifecycle_state === 'DRAFT')?.revision_id ?? null;
}
