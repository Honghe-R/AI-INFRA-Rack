import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeLinks, collectEntities, indexEntities, rewriteReply } from '../entity-references.js';

test('entities are collected structurally from raw tool results', () => {
  const entities = collectEntities({
    data: {
      containers: [
        { entityId: 'e-1', name: 'Data Hall 01', entityType: 'HALL' },
        { entityId: 'e-2', name: 'Parcel A' },
      ],
      diagnostics: [{ diagnosticId: 'd-1', title: 'West setback' }],
      document: { assetId: 'a-1', filename: 'site.dxf' },
    },
  });

  const byLabel = new Map(entities.map((entity) => [entity.label, entity]));
  assert.equal(byLabel.get('Data Hall 01').kind, 'facility.entity');
  assert.equal(byLabel.get('Data Hall 01').entityType, 'HALL');
  assert.equal(byLabel.get('West setback').kind, 'facility.diagnostic');
  assert.equal(byLabel.get('site.dxf').kind, 'asset');
  // An object with an id but no label is not a reference.
  assert.equal(entities.some((entity) => entity.label === undefined), false);
});

test('a container links to its own entity, never to the phase it belongs to', () => {
  // A revision-scoped row carries the phase it belongs to as well as its own id. Taking
  // `phaseId` as the identity emitted `entity://facility.phase/<phase>` for a building,
  // which is a link to the wrong object.
  const entities = collectEntities({
    items: [
      {
        containerId: 'c-1',
        phaseId: 'phase-9',
        kind: 'BUILDING',
        entityType: 'BUILDING',
        name: 'Data Centre A',
        status: 'PROVISIONAL',
      },
    ],
  });

  const building = entities.find((entity) => entity.label === 'Data Centre A');
  assert.equal(building.kind, 'facility.entity');
  assert.equal(building.id, 'c-1');
  assert.equal(building.entityType, 'BUILDING');
  assert.equal(entities.some((entity) => entity.id === 'phase-9'), false, 'the phase is not the identity');
});

test('a utility interface links to itself and to its source, not the source id under the interface name', () => {
  // A utility-interface row carries both `interfaceId` and `utilitySourceId`, and the source
  // travels as its own nested object so one read identifies both. Before `interfaceId` came
  // first, the flat row took the source id as its identity and paired it with the
  // *interface's* name — a link whose label and target named different objects.
  const entities = collectEntities({
    items: [
      {
        interfaceId: 'i-1',
        utilitySourceId: 's-1',
        displayName: 'Cooling Interface',
        resourceKind: 'COOLING',
        source: { utilitySourceId: 's-1', entityType: 'UTILITY_SOURCE', displayName: 'Central Chiller Plant' },
      },
    ],
  });

  const iface = entities.find((entity) => entity.id === 'i-1');
  assert.equal(iface.kind, 'facility.utility_interface');
  assert.equal(iface.label, 'Cooling Interface');

  const source = entities.find((entity) => entity.label === 'Central Chiller Plant');
  assert.equal(source.kind, 'facility.entity');
  assert.equal(source.id, 's-1');
  assert.equal(source.entityType, 'UTILITY_SOURCE');
  // The flat row is not also emitted as the source carrying the interface's own name.
  assert.equal(entities.filter((entity) => entity.id === 's-1').length, 1);
});

test('labels that are ambiguous, too short, or just an id are not links', () => {
  const { entities, rewrite } = indexEntities([
    { kind: 'facility.entity', id: 'e-1', label: 'Parcel A' },
    { kind: 'facility.entity', id: 'e-2', label: 'Parcel A' },
    { kind: 'facility.entity', id: 'e-3', label: 'ab' },
    { kind: 'facility.entity', id: 'e-4', label: 'e-4' },
    { kind: 'facility.entity', id: 'e-5', label: 'Utility Yard' },
  ]);

  assert.deepEqual(entities.map((entity) => entity.label), ['Utility Yard']);
  assert.equal(rewrite.has('Parcel A'), false, 'an ambiguous label would have to pick a winner');
  assert.equal(rewrite.has('ab'), false);
  assert.equal(rewrite.has('e-4'), false);
});

test('prose is rewritten, longest label first, while code and links are protected', () => {
  const { rewrite } = indexEntities([
    { kind: 'facility.entity', id: 'e-1', label: 'Data Hall' },
    { kind: 'facility.entity', id: 'e-2', label: 'Data Hall 01' },
  ]);

  const text = 'Data Hall 01 is provisional.\nData Hall is provisional too.\nUse `Data Hall 01` literally.\n```\nData Hall 01\n```\nSee [Data Hall 01](https://example.test).';
  const output = rewriteReply(text, rewrite);

  assert.ok(output.includes('[**Data Hall 01**](entity://facility.entity/e-2)'), 'the longer label wins');
  assert.ok(output.includes('[**Data Hall**](entity://facility.entity/e-1)'));
  assert.ok(output.includes('`Data Hall 01` literally'), 'inline code is untouched');
  assert.ok(output.includes('```\nData Hall 01\n```'), 'a fenced block is untouched');
  assert.ok(output.includes('[Data Hall 01](https://example.test)'), 'an existing link is untouched');
});

test('a link the model wrote with an invented id is retargeted to the collected one', () => {
  // A live turn cited `entity://facility.entity/e6a9be8b-96f7-5a33-b838-55d241fbbfe1` for an entity
  // whose id ended `-988c-5b0e-a9f8-ceb1a0de9e72`. The client renders an unresolved reference as
  // plain text — so that citation showed as unlinked prose while the same name written plainly in
  // the sentence beside it became a working link. A model copies a label reliably and an id not at
  // all, so the label is what the target is looked up by.
  const { rewrite } = indexEntities([{ kind: 'facility.entity', id: 'e-1', label: 'Central Chiller Plant' }]);

  const output = rewriteReply('Moving the [Central Chiller Plant](entity://facility.entity/e6a9be8b-96f7-5a33-b838-55d241fbbfe1) into the yard.', rewrite);

  assert.ok(
    output.includes('[Central Chiller Plant](entity://facility.entity/e-1)'),
    `the target was not retargeted: ${output}`,
  );
  assert.ok(!output.includes('96f7-5a33'), 'the invented id is gone');
  // The label is the model's prose and is left exactly as written — no bold is added, because the
  // emphasis is this pass's own decoration and the model had not asked for it.
  assert.ok(output.includes('Moving the [Central Chiller Plant]'));
});

test('a link whose label names nothing collected is left alone', () => {
  const { rewrite } = indexEntities([{ kind: 'facility.entity', id: 'e-1', label: 'Central Chiller Plant' }]);

  // There is no identity to check this against, and inventing one would be worse than the plain
  // text the client renders.
  const text = '[Some Other Campus](entity://facility.entity/deadbeef-dead-4dead-8dead-deaddeadbeef)';
  assert.equal(canonicalizeLinks(text, rewrite), text);
});

test('a correct link is not rewritten, and emphasis in the label still matches', () => {
  const { rewrite } = indexEntities([{ kind: 'facility.entity', id: 'e-1', label: 'Data Hall 01' }]);

  // The shape this pass itself emits, arriving back through it.
  assert.equal(
    canonicalizeLinks('[**Data Hall 01**](entity://facility.entity/e-1)', rewrite),
    '[**Data Hall 01**](entity://facility.entity/e-1)',
    'an already-canonical link is untouched',
  );
  // Emphasis and collapsed whitespace are decoration, not part of the name.
  assert.equal(
    canonicalizeLinks('[Data Hall\n01](entity://facility.entity/wrong)', rewrite),
    '[Data Hall\n01](entity://facility.entity/e-1)',
    'the label still resolves, and keeps its own formatting',
  );
});

test('a JSON envelope stays valid JSON with only human-readable fields rewritten', () => {
  const { rewrite } = indexEntities([{ kind: 'facility.entity', id: 'e-1', label: 'Data Hall 01' }]);
  const envelope = JSON.stringify({ type: 'final_output', payload: 'Data Hall 01 is provisional.', trace: { id: 'e-1' } });
  const output = rewriteReply(envelope, rewrite);

  const parsed = JSON.parse(output);
  assert.equal(parsed.type, 'final_output');
  assert.equal(parsed.payload, '[**Data Hall 01**](entity://facility.entity/e-1) is provisional.');
  assert.equal(parsed.trace.id, 'e-1', 'a non-prose field is not rewritten');
});
