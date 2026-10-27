import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantHostFor } from '../assistant-host.js';

/**
 * The host assembly is the seam T8 closes: before it, `createDefaultCatalog()` declared
 * a facility surface with no capabilities and the model could call nothing. This test
 * drives the assembly the server actually uses — with the facility tool surface
 * injected — and asserts the model-facing registry is the tool's declaration, not a
 * second hand-written list.
 *
 * The provider factory only needs an endpoint and a credential *name* to construct; the
 * credential itself is resolved lazily on the first turn, so a stub secret manager is
 * enough here and no network is touched.
 */
const providerConfig = {
  llmEndpoint: 'http://127.0.0.1:1',
  llmModel: 'projection-test',
  llmApiKeySecret: 'TEST_KEY',
};
const secrets = { get: async () => null };

function fakeToolSurface() {
  const calls = [];
  return {
    calls,
    execute: async ({ name, args, context }) => {
      calls.push({ name, args, context });
      return { tool: name };
    },
  };
}

test('the assembled host declares the facility projection: 22 capabilities and 6 UI actions', async () => {
  const toolSurface = fakeToolSurface();
  const host = await createAssistantHostFor({ config: providerConfig, pool: null, secrets, guard: null, toolSurface });

  const described = host.toolRegistry.describe();
  assert.equal(described.length, 22);
  assert.ok(described.every((capability) => capability.surfaces.includes('site_facility')));

  const names = described.map((capability) => capability.name);
  for (const expected of ['get_revision_context', 'get_revision_activity', 'list_diagnostics', 'query_geometry', 'apply_asset_binding', 'publish_revision', 'grant_waiver']) {
    assert.ok(names.includes(expected), `${expected} is not declared`);
  }
  // The eight engineering facets are coverage states, never capabilities.
  for (const facet of ['GEOMETRY', 'POWER', 'COOLING', 'WATER', 'FUEL', 'NETWORK_ENTRY', 'ENVIRONMENT', 'PHASING']) {
    assert.ok(!names.includes(facet), `${facet} must not be a capability`);
  }
  // The forbidden operations are valid permission keys and must not be reachable.
  for (const forbidden of ['request_approval', 'decide_allocation', 'create_asset_binding', 'review_import_mapping']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be exposed`);
  }

  assert.equal(host.uiActionRegistry.size(), 6);
  const guide = host.contextResolver.guides()[0];
  assert.equal(guide.key, 'site-facility-guide');
  assert.deepEqual([...guide.requiredEntryFunctions], ['facility.read']);
  assert.ok(guide.guardrails.some((line) => line.includes('NOT_PROVIDED') || line.includes('validation passed')));
});

test('a deployment with no tool surface still resolves a context but exposes no tools', async () => {
  const host = await createAssistantHostFor({ config: providerConfig, pool: null, secrets, guard: null });
  assert.equal(host.toolRegistry.describe().length, 0);
  assert.equal(host.uiActionRegistry.size(), 0);
  // The surface itself still exists, so the context resolves and the assistant can say
  // why nothing is available rather than 404.
  assert.equal(host.contextResolver.surfaces()[0].key, 'site_facility');
});
