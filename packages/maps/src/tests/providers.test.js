import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDERS,
  OSM_MINIMUM_CACHE_SECONDS,
  ProviderError,
  buildTileUrl,
  createDefaultProviders,
  createProviderRegistry,
  defineProvider,
} from '../providers.js';

test('a provider descriptor is validated and normalised', () => {
  const provider = defineProvider({
    providerId: 'p',
    label: 'Provider',
    tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
    attributionText: '© Test',
    cacheTtlSeconds: 60,
  });
  assert.equal(provider.cachePermitted, true);
  assert.equal(provider.cacheTtlSeconds, 60);
  assert.equal(provider.maxZoom, 22);
});

test('a provider that forbids caching is normalised to a zero lifetime', () => {
  const provider = defineProvider({
    providerId: 'p',
    label: 'Provider',
    tileUrlTemplate: 'https://tiles.test/{z}/{x}/{y}.png',
    attributionText: '© Test',
    cachePermitted: false,
    cacheTtlSeconds: 999,
  });
  assert.equal(provider.cachePermitted, false);
  assert.equal(provider.cacheTtlSeconds, 0, 'a forbidden cache cannot carry a lifetime');
});

test('a malformed descriptor is refused', () => {
  const base = { providerId: 'p', label: 'P', tileUrlTemplate: 'https://t/{z}/{x}/{y}', attributionText: '©' };
  assert.throws(() => defineProvider({ ...base, tileUrlTemplate: 'https://t/{z}' }), ProviderError);
  assert.throws(() => defineProvider({ ...base, credentialSecretName: 'K' }), ProviderError);
  assert.throws(() => defineProvider({ ...base, status: 'NOPE' }), ProviderError);
  assert.throws(() => defineProvider({ ...base, minZoom: 5, maxZoom: 2 }), ProviderError);
});

test('tile URLs substitute coordinates and a style', () => {
  const provider = defineProvider({
    providerId: 'p',
    label: 'P',
    tileUrlTemplate: 'https://t/{style}/{z}/{x}/{y}.png',
    attributionText: '©',
    styles: ['standard', 'terrain'],
  });
  assert.equal(buildTileUrl(provider, { z: 3, x: 4, y: 5, style: 'terrain' }), 'https://t/terrain/3/4/5.png');
});

test('the registry lists providers and describes them without the credential', () => {
  const registry = createProviderRegistry({
    providers: [
      defineProvider({ providerId: 'a', label: 'A', tileUrlTemplate: 'https://a/{z}/{x}/{y}', attributionText: '©A', credentialSecretName: 'KEY', credentialPlacement: 'query', credentialParam: 'key' }),
      defineProvider({ providerId: 'b', label: 'B', tileUrlTemplate: 'https://b/{z}/{x}/{y}', attributionText: '©B', status: 'RETIRED' }),
    ],
  });
  assert.deepEqual(registry.list().map((provider) => provider.providerId), ['a']);
  const described = registry.describe(registry.get('a'));
  assert.equal(described.attributionText, '©A');
  assert.equal(described.credentialSecretName, undefined, 'the credential name never reaches a client projection');
  assert.equal(described.tileUrlTemplate, undefined, 'the licensed URL template never reaches a client projection');
  assert.throws(() => createProviderRegistry({ providers: [registry.get('a'), registry.get('a')] }), ProviderError);
});

test('the public OSM provider carries the obligations its usage policy imposes', () => {
  const [publicOsm] = DEFAULT_PROVIDERS.filter((provider) => provider.providerId === 'osm-public');
  assert.ok(publicOsm, 'the public tile server is a registered provider (D26)');
  assert.equal(publicOsm.tileUrlTemplate, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', 'the policy fixes the URL');
  assert.equal(publicOsm.credentialSecretName, null, 'it needs identification, not a credential');
  assert.match(publicOsm.requestHeaders['user-agent'], /ai-infra-planner/, 'a generic User-Agent is blocked by the policy');
  assert.equal(publicOsm.requestHeaders.accept, 'image/png');
  assert.equal(publicOsm.cachePermitted, true, 'the policy requires caching');
  assert.ok(publicOsm.cacheTtlSeconds >= OSM_MINIMUM_CACHE_SECONDS, 'and at least seven days of it');
  assert.match(publicOsm.attributionText, /OpenStreetMap/, 'attribution is a licence condition');
  assert.equal(publicOsm.maxZoom, 19);
  assert.match(publicOsm.licence, /Tile Usage Policy/);

  // The identity is configuration: a deployment names itself rather than shipping
  // the repository's default.
  const configured = createDefaultProviders({
    osmUserAgent: 'acme-planner/2.1 (+https://acme.test)',
    osmReferer: 'https://acme.test',
  }).find((provider) => provider.providerId === 'osm-public');
  assert.equal(configured.requestHeaders['user-agent'], 'acme-planner/2.1 (+https://acme.test)');
  assert.equal(configured.requestHeaders.referer, 'https://acme.test');
  // By id, not by position: the list is built conditionally, so an index is a claim about
  // the order of a list that no longer has a fixed one.
  const defaultPublicOsm = DEFAULT_PROVIDERS.find((provider) => provider.providerId === 'osm-public');
  assert.equal(configured.requestHeaders.referer && defaultPublicOsm.requestHeaders.referer, undefined, 'the default sends no referer it cannot vouch for');
  assert.throws(() => createDefaultProviders({ osmUserAgent: '   ' }), ProviderError);
});

test('a request header the transport owns, and a header that could split a request, are refused', () => {
  const base = { providerId: 'x', label: 'X', tileUrlTemplate: 'https://x/{z}/{x}/{y}', attributionText: '©X' };
  assert.throws(() => defineProvider({ ...base, requestHeaders: { host: 'elsewhere.test' } }), ProviderError);
  assert.throws(() => defineProvider({ ...base, requestHeaders: { authorization: 'Bearer x' } }), ProviderError);
  assert.throws(() => defineProvider({ ...base, requestHeaders: { 'x-trace': 'a\r\nHost: evil.test' } }), ProviderError);
  assert.throws(() => defineProvider({ ...base, requestHeaders: { 'bad header': 'v' } }), ProviderError);
  assert.throws(() => defineProvider({ ...base, requestHeaders: { 'x-empty': '' } }), ProviderError);
  assert.deepEqual(defineProvider({ ...base, requestHeaders: { 'X-Ident': 'acme/1' } }).requestHeaders, { 'x-ident': 'acme/1' });
});

test('the self-hosted provider exists only when a tile server is configured', () => {
  // Disabled is the absence of a setting, not an option that fails on every tile. A
  // deployment with no operator-hosted server has nothing to point at, and offering the
  // provider anyway means a canvas that reads as broken rather than as unconfigured.
  assert.equal(
    DEFAULT_PROVIDERS.some((provider) => provider.providerId === 'self-hosted'),
    false,
    'the default registers no self-hosted provider',
  );

  const withTiles = createDefaultProviders({
    selfHostedTileUrl: 'https://tiles.acme.test/{z}/{x}/{y}.png',
  }).find((provider) => provider.providerId === 'self-hosted');

  assert.ok(withTiles, 'a configured address registers it');
  assert.equal(withTiles.tileUrlTemplate, 'https://tiles.acme.test/{z}/{x}/{y}.png', 'and is what it serves from');
  // The URL is the operator's, so nothing in the repository hardcodes a localhost address.
  assert.equal(DEFAULT_PROVIDERS.some((provider) => provider.tileUrlTemplate.includes('127.0.0.1')), false);
});
