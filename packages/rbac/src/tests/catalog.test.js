import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  FACILITY_KEYS,
  PLATFORM_KEYS,
  RACK_KEYS,
  PRESET_KEYS,
  ROLE_PRESETS,
  SHOWCASE_READ_KEYS,
  SYSTEM_KEYS,
  catalogKeys,
  getCatalogEntry,
  isKnownKey,
  presetKeys,
} from '../index.js';

test('catalog keys are unique and well formed', () => {
  const keys = catalogKeys();
  assert.equal(new Set(keys).size, keys.length, 'catalog keys must be unique');
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, `key "${key}" must be dotted lowercase`);
  }
});

test('every catalog entry has a name, a description, and a known scope', () => {
  for (const item of CATALOG) {
    assert.ok(item.name.length > 0, `${item.key} needs a name`);
    assert.ok(item.description.length > 0, `${item.key} needs a description`);
    assert.ok(['system', 'organisation', 'project', 'global'].includes(item.scope), `${item.key} has scope "${item.scope}"`);
  }
});

test('the tool keys declared in the specification are all present', () => {
  const expected = [
    'facility.read', 'facility.draft.create', 'facility.entity.write', 'facility.geometry.write',
    'facility.constraint.write', 'facility.utility.write', 'facility.phase.write',
    'facility.import.initiate', 'facility.import.map', 'facility.import.apply',
    'facility.validate.run', 'facility.capacity.request', 'facility.capacity.allocate',
    'facility.publish', 'facility.approve', 'facility.waiver.grant',
    'facility.document.manage', 'facility.export', 'facility.share',
  ];
  for (const key of expected) assert.ok(isKnownKey(key), `missing declared tool key ${key}`);
});

test('the workspace keys declared in the bundle are all present', () => {
  for (const key of ['asset.read', 'asset.write', 'asset.delete']) {
    assert.ok(isKnownKey(key), `missing declared workspace key ${key}`);
  }
});

test('Rack read/write grants are project-scoped and preserve read-only roles', () => {
  for (const key of Object.values(RACK_KEYS)) assert.equal(getCatalogEntry(key).scope, 'project');
  for (const role of ['project-admin', 'project-editor']) {
    assert.ok(ROLE_PRESETS[role].keys.includes(RACK_KEYS.READ));
    assert.ok(ROLE_PRESETS[role].keys.includes(RACK_KEYS.WRITE));
  }
  for (const role of ['project-viewer', 'organisation-admin']) {
    assert.ok(ROLE_PRESETS[role].keys.includes(RACK_KEYS.READ));
    assert.ok(!ROLE_PRESETS[role].keys.includes(RACK_KEYS.WRITE));
  }
  assert.ok(!ROLE_PRESETS['system-admin'].keys.includes(RACK_KEYS.WRITE));
  for (const key of [RACK_KEYS.DELETE, RACK_KEYS.RESTORE]) {
    assert.ok(ROLE_PRESETS['project-admin'].keys.includes(key));
    for (const role of ['project-editor', 'project-viewer', 'organisation-admin', 'system-admin']) {
      assert.ok(!ROLE_PRESETS[role].keys.includes(key), `${role} must not receive ${key} by default`);
    }
  }
  assert.ok(!SHOWCASE_READ_KEYS.has(RACK_KEYS.READ));
});

test('lookup helpers fail closed for an unknown key', () => {
  assert.equal(isKnownKey('facility.read.typo'), false);
  assert.equal(getCatalogEntry('facility.read.typo'), null);
});

test('invited organisation membership grants discovery without tool-content or management permissions', () => {
  assert.equal(ROLE_PRESETS['organisation-member'].scopeHint, 'organisation');
  assert.deepEqual(ROLE_PRESETS['organisation-member'].keys, [PLATFORM_KEYS.PROJECT_READ]);
});

test('system keys are exactly the system-scoped entries', () => {
  assert.deepEqual([...SYSTEM_KEYS].sort(), [PLATFORM_KEYS.SYSTEM_ADMIN, PLATFORM_KEYS.SYSTEM_CATALOG_MANAGE].sort());
  for (const key of SYSTEM_KEYS) assert.equal(getCatalogEntry(key).scope, 'system');
});

test('showcase exposes only registered read keys', () => {
  assert.equal(SHOWCASE_READ_KEYS.size, 3);
  for (const key of SHOWCASE_READ_KEYS) {
    assert.ok(isKnownKey(key), `showcase key ${key} must be registered`);
    assert.equal(getCatalogEntry(key).scope, 'project');
  }
  assert.ok(!SHOWCASE_READ_KEYS.has(FACILITY_KEYS.PUBLISH), 'showcase must never expose a write key');
});

test('every preset key is registered in the catalog', () => {
  for (const [roleKey, preset] of Object.entries(ROLE_PRESETS)) {
    assert.ok(preset.name && preset.description, `${roleKey} needs a name and description`);
    for (const key of preset.keys) {
      assert.ok(isKnownKey(key), `preset ${roleKey} references unregistered key ${key}`);
    }
    assert.equal(new Set(preset.keys).size, preset.keys.length, `preset ${roleKey} repeats a key`);
  }
});

test('presets never grant a system key from a scoped role', () => {
  for (const [roleKey, preset] of Object.entries(ROLE_PRESETS)) {
    if (preset.scopeHint !== 'system') {
      for (const key of preset.keys) {
        assert.ok(!SYSTEM_KEYS.has(key), `preset ${roleKey} is scoped but grants system key ${key}`);
      }
    }
  }
});

test('there is no all-keys super-role', () => {
  const all = catalogKeys();
  for (const [roleKey, preset] of Object.entries(ROLE_PRESETS)) {
    assert.notEqual(preset.keys.length, all.length, `preset ${roleKey} holds every key`);
  }
  const editor = ROLE_PRESETS['project-editor'];
  assert.ok(!editor.keys.includes(FACILITY_KEYS.PUBLISH), 'an editor must not publish');
  assert.ok(!editor.keys.includes(FACILITY_KEYS.WAIVER_GRANT), 'an editor must not grant waivers');
  assert.ok(!editor.keys.includes(PLATFORM_KEYS.SYSTEM_ADMIN), 'an editor must not be a system admin');
});

test('preset helpers agree with the preset definitions', () => {
  assert.deepEqual(Object.keys(ROLE_PRESETS).sort(), [...PRESET_KEYS].sort());
  assert.deepEqual(presetKeys(), [...new Set(Object.values(ROLE_PRESETS).flatMap((p) => p.keys))].sort());
});
