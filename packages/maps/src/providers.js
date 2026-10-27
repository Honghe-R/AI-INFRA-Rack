/**
 * Basemap provider registry.
 *
 * Providers are configuration, not rows: a deployment registers the ones it is
 * licensed for, and each descriptor carries the attribution its licence requires
 * and the cache lifetime it permits (D16, D26). An OSM-based basemap goes through
 * a commercial provider, the public tile server under its usage policy, or an
 * operator-hosted tile server.
 *
 * The credential is named, never held: `credentialSecretName` resolves through
 * `@ai-infra/secrets` at request time, and the resolved value is never logged,
 * cached, or returned to a client. `requestHeaders` is the opposite — a small set
 * of **non-secret** headers a provider's policy requires (an identifying
 * User-Agent, say); nothing secret may go there, and it is never sent to a client.
 */
export const PROVIDER_STATUSES = Object.freeze(['ACTIVE', 'DEPRECATED', 'RETIRED']);

/** Headers a proxy must never let a descriptor set: they are the transport's. */
const FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'cookie',
  'authorization',
  'proxy-authorization',
]);

export class ProviderError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ProviderError';
    this.code = 'map.provider.invalid';
    this.details = details;
    Object.freeze(this);
  }
}

export function defineProvider(descriptor) {
  const fail = (message) => {
    throw new ProviderError(message);
  };

  for (const field of ['providerId', 'label', 'tileUrlTemplate', 'attributionText']) {
    if (typeof descriptor?.[field] !== 'string' || descriptor[field].trim().length === 0) {
      fail(`A provider requires a non-empty "${field}".`);
    }
  }
  if (!descriptor.tileUrlTemplate.includes('{z}') || !descriptor.tileUrlTemplate.includes('{x}') || !descriptor.tileUrlTemplate.includes('{y}')) {
    fail('tileUrlTemplate must contain {z}, {x}, and {y}.');
  }
  if (descriptor.credentialSecretName) {
    if (!descriptor.credentialPlacement || !descriptor.credentialParam) {
      fail('A provider with a credential must declare credentialPlacement and credentialParam.');
    }
    if (!['query', 'header'].includes(descriptor.credentialPlacement)) {
      fail('credentialPlacement must be "query" or "header".');
    }
  }

  const requestHeaders = normalizeRequestHeaders(descriptor.requestHeaders, fail);

  const status = descriptor.status ?? 'ACTIVE';
  if (!PROVIDER_STATUSES.includes(status)) fail(`status must be one of ${PROVIDER_STATUSES.join(', ')}.`);

  const minZoom = descriptor.minZoom ?? 0;
  const maxZoom = descriptor.maxZoom ?? 22;
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 24 || minZoom > maxZoom) {
    fail('Zoom bounds must be integers with 0 <= minZoom <= maxZoom <= 24.');
  }
  const cacheTtlSeconds = descriptor.cacheTtlSeconds ?? 0;
  if (!Number.isInteger(cacheTtlSeconds) || cacheTtlSeconds < 0) fail('cacheTtlSeconds must be a non-negative integer.');

  return Object.freeze({
    providerId: descriptor.providerId,
    label: descriptor.label,
    mediaType: descriptor.mediaType ?? 'image/png',
    tileUrlTemplate: descriptor.tileUrlTemplate,
    minZoom,
    maxZoom,
    tileSize: descriptor.tileSize ?? 256,
    attributionText: descriptor.attributionText,
    attributionUrl: descriptor.attributionUrl ?? null,
    // A provider that forbids caching declares cachePermitted false, and the
    // proxy then never stores the tile beyond the request.
    cachePermitted: descriptor.cachePermitted !== false,
    cacheTtlSeconds: descriptor.cachePermitted === false ? 0 : cacheTtlSeconds,
    licence: descriptor.licence ?? null,
    credentialSecretName: descriptor.credentialSecretName ?? null,
    credentialPlacement: descriptor.credentialPlacement ?? null,
    credentialParam: descriptor.credentialParam ?? null,
    requestHeaders,
    styles: Object.freeze([...(descriptor.styles ?? [])]),
    status,
    releaseLevel: descriptor.releaseLevel ?? 'R1',
  });
}

/**
 * Validates the non-secret headers a provider's policy requires. Rejecting rather
 * than sanitizing is deliberate: a header a proxy silently drops is a policy
 * breach the operator cannot see.
 */
function normalizeRequestHeaders(value, fail) {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) fail('requestHeaders must be an object of header names to values.');

  const headers = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.includes(key)) fail(`requestHeaders may not set "${name}"; it belongs to the transport.`);
    if (typeof headerValue !== 'string' || headerValue.trim().length === 0) fail(`requestHeaders["${name}"] must be a non-empty string.`);
    // A newline in a header value is request splitting, not a header.
    if (/[\r\n]/.test(headerValue) || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name)) {
      fail(`requestHeaders["${name}"] is not a valid header.`);
    }
    headers[key] = headerValue;
  }
  return Object.freeze(headers);
}

/**
 * The providers a deployment can register. `tileUrlTemplate` values are the
 * licensed endpoints, and `self-hosted` is the offline or air-gapped option.
 *
 * `osm-public` is the public OpenStreetMap tile server. It needs no credential,
 * and it is not free of obligations: the
 * [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
 * requires an identifying User-Agent, denies prefetch and offline use, requires a
 * cache honouring server headers or at least seven days, offers no availability
 * guarantee, and warns that access may be withdrawn from a commercial service at
 * any point (D26). The identity is configuration so a deployment names itself.
 */
export const DEFAULT_OSM_USER_AGENT = 'ai-infra-planner/0.1 (+https://github.com/sunweiqiang-coder/ai-infra)';

/** The public tile server's minimum cache lifetime, in seconds. */
export const OSM_MINIMUM_CACHE_SECONDS = 604_800;

/**
 * The providers a deployment registers.
 *
 * `selfHostedTileUrl` is what a self-hosted tile server is reachable at, and the
 * provider is registered **only when it is set**. A deployment that has not stood one
 * up has nothing to point at: offering the provider anyway means an option that fails
 * on every tile, and a canvas that reads as broken rather than as unconfigured. The
 * address is configuration rather than a hardcoded localhost, so "disabled" is the
 * absence of a setting instead of an edit to this file.
 */
export function createDefaultProviders({ osmUserAgent = DEFAULT_OSM_USER_AGENT, osmReferer = null, selfHostedTileUrl = null } = {}) {
  if (typeof osmUserAgent !== 'string' || osmUserAgent.trim().length === 0) {
    throw new ProviderError('The public OSM provider needs a non-empty User-Agent; the policy blocks generic ones.');
  }

  return Object.freeze([
    defineProvider({
      providerId: 'google',
      label: 'Google Maps',
      mediaType: 'image/png',
      // The Map Tiles API tile endpoint; a session token from createSession is
      // required in production, so the deployment template carries it alongside the
      // API key.
      tileUrlTemplate: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}',
      attributionText: 'Google Maps',
      attributionUrl: 'https://www.google.com/intl/en_US/help/terms_maps/',
      licence: 'Google Maps Platform terms; Map Tiles API billing account required.',
      credentialSecretName: 'MAP_GOOGLE_API_KEY',
      credentialPlacement: 'query',
      credentialParam: 'key',
      cachePermitted: false,
      minZoom: 0,
      maxZoom: 22,
      styles: ['roadmap', 'satellite'],
    }),
    defineProvider({
      providerId: 'osm-commercial',
      label: 'OpenStreetMap (commercial tile provider)',
      mediaType: 'image/png',
      tileUrlTemplate: 'https://tiles.example-osm-provider.com/{style}/{z}/{x}/{y}.png',
      attributionText: '© OpenStreetMap contributors',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      licence: 'Provider terms. The SLA-backed alternative to the public tile server.',
      credentialSecretName: 'MAP_OSM_API_KEY',
      credentialPlacement: 'query',
      credentialParam: 'key',
      cachePermitted: true,
      cacheTtlSeconds: 86_400,
      maxZoom: 19,
      styles: ['standard', 'terrain'],
    }),
    defineProvider({
      providerId: 'osm-public',
      label: 'OpenStreetMap (public tile server)',
      mediaType: 'image/png',
      tileUrlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attributionText: '© OpenStreetMap contributors',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      licence:
        'OpenStreetMap Tile Usage Policy: identifying User-Agent, no prefetch or offline use, seven-day minimum cache, no availability guarantee; commercial access may be withdrawn without notice.',
      // No credential: the policy asks to be *identified*, not licensed.
      credentialSecretName: null,
      requestHeaders: {
        'user-agent': osmUserAgent,
        accept: 'image/png',
        // The policy expects an accurate Referer end to end and forbids blanking
        // it when proxying, so it is configured, never invented.
        ...(osmReferer ? { referer: osmReferer } : {}),
      },
      cachePermitted: true,
      cacheTtlSeconds: OSM_MINIMUM_CACHE_SECONDS,
      minZoom: 0,
      maxZoom: 19,
      styles: ['standard'],
    }),
    ...(selfHostedTileUrl
      ? [
          defineProvider({
            providerId: 'self-hosted',
            label: 'Self-hosted tiles',
            mediaType: 'image/png',
            tileUrlTemplate: selfHostedTileUrl,
            attributionText: '© OpenStreetMap contributors',
            attributionUrl: 'https://www.openstreetmap.org/copyright',
            licence: 'Operator-hosted OSM-derived tiles.',
            cachePermitted: true,
            cacheTtlSeconds: 604_800,
            maxZoom: 20,
            styles: ['standard'],
          }),
        ]
      : []),
  ]);
}

export const DEFAULT_PROVIDERS = createDefaultProviders();

export function createProviderRegistry({ providers = DEFAULT_PROVIDERS } = {}) {
  const byId = new Map();
  for (const provider of providers) {
    const normalized = provider.providerId ? provider : defineProvider(provider);
    if (byId.has(normalized.providerId)) throw new ProviderError(`Provider "${normalized.providerId}" is already registered.`);
    byId.set(normalized.providerId, normalized);
  }

  function get(providerId) {
    return byId.get(providerId) ?? null;
  }

  function list({ includeRetired = false } = {}) {
    return [...byId.values()]
      .filter((provider) => includeRetired || provider.status !== 'RETIRED')
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  /** The client-visible projection: no credential name, no URL template. */
  function describe(provider, { available = true, reason = null } = {}) {
    return {
      providerId: provider.providerId,
      label: provider.label,
      mediaType: provider.mediaType,
      minZoom: provider.minZoom,
      maxZoom: provider.maxZoom,
      tileSize: provider.tileSize,
      attributionText: provider.attributionText,
      attributionUrl: provider.attributionUrl,
      styles: [...provider.styles],
      status: provider.status,
      available,
      unavailableReason: reason,
    };
  }

  return { get, list, describe };
}

/** Substitutes tile coordinates, keeping the credential out of the template. */
export function buildTileUrl(provider, { z, x, y, style = null }) {
  return provider.tileUrlTemplate
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{style}', encodeURIComponent(style ?? provider.styles[0] ?? 'standard'));
}
