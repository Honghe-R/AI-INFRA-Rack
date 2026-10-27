import test from 'node:test';
import assert from 'node:assert/strict';
import { defineAdapter } from '../adapter-contract.js';
import { AdapterRegistrationError } from '../descriptor.js';
import { AdapterResolutionError, createAdapterRegistry, extensionOf, normalizeMediaType } from '../registry.js';

function adapter({
  id = 'test',
  version = '1.0.0',
  mediaTypes = ['image/vnd.test'],
  extensions = ['.tst'],
  status = 'ACTIVE',
  isolation = 'WORKER_SANDBOX',
  fidelity = 'PARTIAL',
  capabilities = [{ name: 'attributes', level: 'PARTIAL' }],
  diagnostics = ['import.feature.unsupported'],
} = {}) {
  return defineAdapter({
    descriptor: {
      adapter_id: id,
      adapter_version: version,
      media_types: mediaTypes,
      extensions,
      extraction_capabilities: capabilities,
      source_crs_declarations: ['LOCAL'],
      source_unit_declarations: ['m'],
      fidelity_level: fidelity,
      supported_range: { min_version: '1', max_version: '1', tested_versions: ['1'] },
      release_level: 'R1',
      status,
      entry_point: 'file:///tmp/test-adapter.js',
      isolation,
      conformance_fixtures: ['fixture-1'],
      required_diagnostics: diagnostics,
    },
    extract: async () => ({}),
  });
}

test('media type and extension resolve to exactly one adapter', () => {
  const registry = createAdapterRegistry({ adapters: [adapter()] });
  assert.equal(registry.resolve({ mediaType: 'image/vnd.test', extension: '.tst' }).descriptor.adapter_id, 'test');
});

test('a sniffed octet-stream is accepted only when the extension also matches', () => {
  const registry = createAdapterRegistry({
    adapters: [adapter({ mediaTypes: ['image/vnd.test', 'application/octet-stream'] })],
  });
  assert.equal(registry.resolve({ mediaType: 'application/octet-stream', extension: '.tst' }).descriptor.adapter_id, 'test');
  assert.throws(
    () => registry.resolve({ mediaType: 'application/octet-stream', extension: '.other' }),
    (error) => error.constraintId === 'import.adapter.unsupported',
  );
});

test('an unknown media type and extension is import.adapter.unsupported', () => {
  const registry = createAdapterRegistry({ adapters: [adapter()] });
  assert.throws(
    () => registry.resolve({ mediaType: 'application/x-nope', extension: '.nope' }),
    (error) => {
      assert.ok(error instanceof AdapterResolutionError);
      assert.equal(error.constraintId, 'import.adapter.unsupported');
      return true;
    },
  );
});

test('a descriptor that declares an unknown diagnostic is rejected at registration', () => {
  const registry = createAdapterRegistry();
  assert.throws(
    () => registry.register(adapter({ diagnostics: ['import.made.up'] })),
    (error) => {
      assert.ok(error instanceof AdapterRegistrationError);
      assert.equal(error.code, 'import.adapter.registration_invalid');
      return true;
    },
  );
});

test('FULL fidelity requires every declared capability to be FULL', () => {
  const registry = createAdapterRegistry();
  assert.throws(
    () => registry.register(adapter({ fidelity: 'FULL', capabilities: [{ name: 'layers', level: 'PARTIAL' }] })),
    (error) => error.code === 'import.adapter.registration_invalid',
  );
  assert.doesNotThrow(() =>
    registry.register(adapter({ fidelity: 'FULL', capabilities: [{ name: 'layers', level: 'FULL' }] })),
  );
});

test('an adapter that parses untrusted input must be sandboxed', () => {
  const registry = createAdapterRegistry();
  assert.throws(
    () => registry.register(adapter({ isolation: 'IN_PROCESS' })),
    (error) => error.code === 'import.adapter.registration_invalid',
  );
});

test('a duplicate adapter id and version is refused', () => {
  const registry = createAdapterRegistry({ adapters: [adapter()] });
  assert.throws(() => registry.register(adapter()), (error) => error.code === 'import.adapter.registration_invalid');
  // A new version of the same adapter is a normal upgrade.
  assert.doesNotThrow(() => registry.register(adapter({ version: '1.1.0' })));
});

test('the higher adapter version wins when both accept a media type', () => {
  const registry = createAdapterRegistry({
    adapters: [adapter({ version: '1.0.0' }), adapter({ version: '2.0.0' })],
  });
  assert.equal(registry.resolve({ mediaType: 'image/vnd.test' }).descriptor.adapter_version, '2.0.0');
});

test('a deprecated adapter resolves with a warning notice', () => {
  const registry = createAdapterRegistry({ adapters: [adapter({ status: 'DEPRECATED' })] });
  const resolved = registry.resolve({ mediaType: 'image/vnd.test' });
  assert.equal(resolved.descriptor.status, 'DEPRECATED');
  assert.deepEqual(resolved.notices.map((notice) => notice.constraintId), ['import.adapter.deprecated']);
});

test('a retired adapter is not offered but stays resolvable by identifier', () => {
  const registry = createAdapterRegistry({ adapters: [adapter({ status: 'RETIRED' })] });
  assert.throws(() => registry.resolve({ mediaType: 'image/vnd.test' }), (error) => error.constraintId === 'import.adapter.unsupported');
  const explicit = registry.resolve({ adapterId: 'test', adapterVersion: '1.0.0' });
  assert.equal(explicit.descriptor.status, 'RETIRED');
});

test('an unknown adapter version is import.adapter.version_unsupported', () => {
  const registry = createAdapterRegistry({ adapters: [adapter()] });
  assert.throws(
    () => registry.resolve({ adapterId: 'test', adapterVersion: '9.9.9' }),
    (error) => error.constraintId === 'import.adapter.version_unsupported',
  );
});

test('an ACTIVE adapter beats a deprecated one of a higher version', () => {
  const registry = createAdapterRegistry({
    adapters: [adapter({ version: '1.0.0', status: 'ACTIVE' }), adapter({ version: '2.0.0', status: 'DEPRECATED' })],
  });
  assert.equal(registry.resolve({ mediaType: 'image/vnd.test' }).descriptor.adapter_version, '1.0.0');
});

test('a source version outside the supported range is refused', () => {
  const registry = createAdapterRegistry({ adapters: [adapter()] });
  const descriptor = registry.get('test').descriptor;
  assert.equal(registry.assertSourceVersion(descriptor, '1'), null);
  assert.throws(
    () => registry.assertSourceVersion(descriptor, '2'),
    (error) => error.constraintId === 'import.adapter.version_unsupported',
  );
});

test('selectable lists only ACTIVE R1 adapters, and helpers normalise input', () => {
  const registry = createAdapterRegistry({
    adapters: [adapter({ id: 'a' }), adapter({ id: 'b', status: 'DEPRECATED', extensions: ['.b'], mediaTypes: ['image/vnd.b'] })],
  });
  assert.deepEqual(registry.selectable().map((descriptor) => descriptor.adapter_id), ['a']);
  assert.equal(normalizeMediaType('Image/VND.Test; charset=utf-8'), 'image/vnd.test');
  assert.equal(extensionOf('Plan.DXF'), '.dxf');
  assert.equal(extensionOf('no-extension'), null);
});
