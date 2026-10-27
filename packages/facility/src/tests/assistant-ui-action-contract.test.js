import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SITE_FACILITY_UI_ACTIONS } from '../assistant-surface.js';

/**
 * The UI-action registry is mirrored on both sides of the wire, and the two mirrors
 * must stay comparable: the server says which `type@version` values the model may
 * request, and the client refuses anything else. The comparison is deliberately a
 * contract test over the descriptors rather than over any behaviour, because the two
 * halves are written in two schema dialects and a drift between them is exactly what
 * acceptance criterion 12 forbids.
 *
 * The client module is loaded the way `packages/rbac`'s client-parity test loads the
 * generated permission catalog: through a file URL, not a static import. A package
 * must not statically import an application — the browser bundle carries no server
 * code and a package's runtime carries no client code — but a parity test has to read
 * the mirror to compare it, and a file URL keeps that read out of both bundles.
 *
 * `project_id`/`scenario_id` are accepted on every server schema (they are the
 * resolved-context arguments the executor checks) and are not part of the
 * model-facing payload contract, so they are excluded from the field comparison.
 */
const CLIENT_MIRROR = pathToFileURL(resolve(import.meta.dirname, '../../../../apps/web/src/assistant/ui-actions.js')).href;
const { UI_ACTION_TYPES } = await import(CLIENT_MIRROR);

const CONTEXT_FIELDS = new Set(['project_id', 'scenario_id']);

const key = (descriptor) => `${descriptor.type}@${descriptor.version}`;

test('the server and client UI-action registries declare the same type@version set', () => {
  const server = new Set(SITE_FACILITY_UI_ACTIONS.map(key));
  const client = new Set(UI_ACTION_TYPES.map(key));
  assert.deepEqual([...server].sort(), [...client].sort());
  assert.equal(server.size, 6);
  for (const value of server) assert.ok(value.endsWith('@1'), `${value} must be version 1`);
});

test('every UI action is presentation-only on both sides', () => {
  for (const descriptor of SITE_FACILITY_UI_ACTIONS) {
    assert.equal(descriptor.confirmation, 'none', `${key(descriptor)} must be confirmation none`);
  }
  for (const descriptor of UI_ACTION_TYPES) {
    assert.equal(descriptor.confirmation, 'none', `${key(descriptor)} must be confirmation none`);
  }
});

test('the client mirror carries every field and required flag the server declares', () => {
  const clientByKey = new Map(UI_ACTION_TYPES.map((descriptor) => [key(descriptor), descriptor]));
  for (const serverDescriptor of SITE_FACILITY_UI_ACTIONS) {
    const clientDescriptor = clientByKey.get(key(serverDescriptor));
    assert.ok(clientDescriptor, `${key(serverDescriptor)} is missing from the client mirror`);

    const serverProperties = Object.keys(serverDescriptor.inputSchema.properties ?? {}).filter((field) => !CONTEXT_FIELDS.has(field));
    const clientProperties = Object.keys(clientDescriptor.inputSchema ?? {});
    assert.deepEqual(clientProperties.sort(), serverProperties.sort(), `${key(serverDescriptor)} fields differ`);

    const serverRequired = (serverDescriptor.inputSchema.required ?? []).filter((field) => !CONTEXT_FIELDS.has(field));
    const clientRequired = Object.entries(clientDescriptor.inputSchema ?? {})
      .filter(([, field]) => field.required === true)
      .map(([name]) => name);
    assert.deepEqual(clientRequired.sort(), [...serverRequired].sort(), `${key(serverDescriptor)} required fields differ`);

    // Where either side names an enumeration, the allowed values must agree: a value
    // the model may request must be one the browser accepts.
    for (const [field, serverField] of Object.entries(serverDescriptor.inputSchema.properties ?? {})) {
      if (!serverField.enum) continue;
      const clientField = clientDescriptor.inputSchema[field];
      assert.ok(clientField, `${key(serverDescriptor)}.${field} is missing on the client`);
      assert.deepEqual([...clientField.values].sort(), [...serverField.enum].sort(), `${key(serverDescriptor)}.${field} enum differs`);
    }
  }
});
