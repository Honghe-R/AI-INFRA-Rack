import { ApiError, errors } from '@ai-infra/core';
import { assertUuid, withTenant } from '@ai-infra/db';
import { createRateLimiter, createTileCache } from './cache.js';
import { consumeTile, currentPeriod, readUsage } from './metering.js';
import { buildTileUrl, createProviderRegistry } from './providers.js';

/**
 * The basemap tile proxy.
 *
 * The client never contacts a tile provider: it asks this service, which holds the
 * credential, meters the request, enforces the quota, honours the provider's cache
 * and attribution policy, and returns bytes (D16). Provider credentials are
 * resolved from the secret manager at request time and never appear in a response,
 * a cache key, or a log line.
 *
 * A provider that is missing, unlicensed, over quota, or unavailable degrades the
 * canvas to the plan-only grid: the caller gets a typed error, never a partial or
 * substituted tile.
 */
export function createMapTileService({
  pool,
  secrets,
  registry = createProviderRegistry(),
  fetchImpl = globalThis.fetch,
  cache = createTileCache(),
  rateLimiter = createRateLimiter({ limit: 600, windowMs: 60_000 }),
  limits = {},
  logger = null,
  now = () => new Date(),
} = {}) {
  if (!pool) throw new Error('createMapTileService requires a database pool.');
  if (!secrets) throw new Error('createMapTileService requires a secret provider.');
  const effective = {
    upstreamTimeoutMs: limits.upstreamTimeoutMs ?? 5_000,
    maxTileBytes: limits.maxTileBytes ?? 2 * 1024 * 1024,
    cacheMaxEntries: limits.cacheMaxEntries ?? 500,
  };

  async function availability(provider) {
    if (provider.status !== 'ACTIVE') return { available: false, reason: `provider is ${provider.status.toLowerCase()}` };
    if (!provider.credentialSecretName) return { available: true, reason: null };
    const credential = await secrets.get(provider.credentialSecretName).catch(() => undefined);
    return credential
      ? { available: true, reason: null }
      : { available: false, reason: 'no provider credential is configured' };
  }

  /** Provider metadata for the client: attribution included, credential excluded. */
  async function listProviders() {
    const described = [];
    for (const provider of registry.list()) {
      const { available, reason } = await availability(provider);
      described.push(registry.describe(provider, { available, reason }));
    }
    return described;
  }

  async function getProjectSettings({ projectId }) {
    assertUuid(projectId);
    return withTenant(
      pool,
      projectId,
      async (client) => {
        const { rows } = await client.query(
          `SELECT provider_id, style, tile_quota, attribution_text, updated_at
             FROM project_map_settings WHERE project_id = $1`,
          [projectId],
        );
        return rows[0]
          ? {
              providerId: rows[0].provider_id,
              style: rows[0].style,
              tileQuota: rows[0].tile_quota === null ? null : Number(rows[0].tile_quota),
              attributionText: rows[0].attribution_text,
              updatedAt: rows[0].updated_at,
            }
          : null;
      },
      { readOnly: true },
    );
  }

  async function setProjectSettings({ projectId, providerId, style = null, tileQuota = null, actorId = null }) {
    assertUuid(projectId);
    const provider = registry.get(providerId);
    if (!provider) throw errors.notFound('The requested basemap provider was not found.');
    if (provider.status !== 'ACTIVE') {
      throw new ApiError('MAP_PROVIDER_NOT_LICENSED', 'That basemap provider is not selectable.', { status: 403 });
    }
    if (style && provider.styles.length > 0 && !provider.styles.includes(style)) {
      throw new ApiError('VALIDATION_FAILED', `Unknown style "${style}" for this provider.`, {
        status: 400,
        details: [{ field: 'style', allowed: provider.styles }],
      });
    }
    if (tileQuota !== null && (!Number.isInteger(tileQuota) || tileQuota < 0)) {
      throw new ApiError('VALIDATION_FAILED', 'tile_quota must be a non-negative integer.', { status: 400 });
    }

    return withTenant(pool, projectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO project_map_settings (project_id, provider_id, style, tile_quota, attribution_text, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id) DO UPDATE
           SET provider_id = EXCLUDED.provider_id,
               style = EXCLUDED.style,
               tile_quota = EXCLUDED.tile_quota,
               attribution_text = EXCLUDED.attribution_text,
               updated_at = now(),
               updated_by = EXCLUDED.created_by
         RETURNING provider_id, style, tile_quota, attribution_text, updated_at`,
        [projectId, provider.providerId, style, tileQuota, provider.attributionText, actorId],
      );
      return {
        providerId: rows[0].provider_id,
        style: rows[0].style,
        tileQuota: rows[0].tile_quota === null ? null : Number(rows[0].tile_quota),
        attributionText: rows[0].attribution_text,
        updatedAt: rows[0].updated_at,
      };
    });
  }

  async function getUsage({ projectId, at = now() }) {
    assertUuid(projectId);
    const { periodStart, periodEnd } = currentPeriod(at);
    const rows = await withTenant(pool, projectId, (client) => readUsage(client, { projectId, periodStart }), { readOnly: true });
    return { periodStart, periodEnd, counters: rows };
  }

  /**
   * Fetches one tile. A cache hit is served without contacting the provider and
   * without consuming quota, because the provider is never billed for it.
   */
  async function fetchTile({ projectId, userId = null, scenarioId = null, providerId, style = null, z, x, y }) {
    assertUuid(projectId);
    const provider = registry.get(providerId);
    if (!provider) throw errors.notFound('The requested basemap provider was not found.');
    if (provider.status !== 'ACTIVE') {
      throw new ApiError('MAP_PROVIDER_NOT_LICENSED', 'That basemap provider is no longer selectable.', { status: 403 });
    }
    assertTileCoordinates({ z, x, y, provider });

    const { available, reason } = await availability(provider);
    if (!available) {
      throw new ApiError('MAP_PROVIDER_NOT_LICENSED', `The basemap provider is unavailable: ${reason}.`, { status: 403 });
    }

    const limit = rateLimiter.check(`${projectId}:${userId ?? 'anonymous'}:${provider.providerId}`);
    if (!limit.allowed) {
      throw new ApiError('RATE_LIMITED', 'Too many tile requests; slow down.', {
        status: 429,
        details: [{ retry_after_ms: Math.ceil(limit.retryAfterMs) }],
      });
    }

    const coordinates = { providerId: provider.providerId, style, z, x, y };
    const cached = cache.get(coordinates);
    if (cached) {
      return { ...cached, cache: 'hit', attribution: attributionFor(provider) };
    }

    const credential = provider.credentialSecretName
      ? await secrets.get(provider.credentialSecretName).catch(() => undefined)
      : null;

    // Quota is consumed before the upstream call, in its own transaction, so an
    // exhausted project never reaches the provider.
    const { periodStart, periodEnd } = currentPeriod(now());
    await withTenant(pool, projectId, async (client) => {
      const settings = await client.query('SELECT tile_quota FROM project_map_settings WHERE project_id = $1', [projectId]);
      const project = await client.query('SELECT organization_id FROM projects WHERE project_id = $1', [projectId]);
      await consumeTile(client, {
        organizationId: project.rows[0].organization_id,
        projectId,
        scenarioId,
        userId,
        provider: provider.providerId,
        periodStart,
        periodEnd,
        quotaLimit: settings.rows[0]?.tile_quota ?? null,
        actorId: userId,
      });
    });

    const upstream = buildUpstreamRequest(provider, { z, x, y, style }, credential);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effective.upstreamTimeoutMs);

    let response;
    try {
      response = await fetchImpl(upstream.url, { headers: upstream.headers, signal: controller.signal });
    } catch (error) {
      logger?.warn?.('map.upstream_failed', { providerId: provider.providerId, error: error?.message });
      throw new ApiError('MAP_PROVIDER_UNAVAILABLE', 'The basemap provider could not be reached.', { status: 503 });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ApiError('MAP_PROVIDER_UNAVAILABLE', `The basemap provider answered ${response.status}.`, {
        status: 503,
        details: [{ provider_status: response.status }],
      });
    }
    const mediaType = (response.headers?.get?.('content-type') ?? provider.mediaType).split(';')[0].trim();
    if (!mediaType.startsWith('image/')) {
      throw new ApiError('MAP_PROVIDER_UNAVAILABLE', 'The basemap provider returned a non-image response.', { status: 503 });
    }

    const declaredLength = Number(response.headers?.get?.('content-length') ?? 0);
    if (declaredLength > effective.maxTileBytes) {
      throw new ApiError('MAP_PROVIDER_UNAVAILABLE', 'The tile exceeded the size cap.', { status: 503 });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > effective.maxTileBytes) {
      throw new ApiError('MAP_PROVIDER_UNAVAILABLE', 'The tile exceeded the size cap.', { status: 503 });
    }

    const value = { bytes, mediaType, cacheMaxAgeSeconds: provider.cacheTtlSeconds };
    if (provider.cachePermitted && provider.cacheTtlSeconds > 0) cache.set(coordinates, value, provider.cacheTtlSeconds);

    return { ...value, cache: 'miss', attribution: attributionFor(provider) };
  }

  return { listProviders, getProjectSettings, setProjectSettings, getUsage, fetchTile, limits: effective, cache, rateLimiter };
}

function assertTileCoordinates({ z, x, y, provider }) {
  for (const [field, value] of [['z', z], ['x', x], ['y', y]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ApiError('VALIDATION_FAILED', `Tile coordinate "${field}" must be a non-negative integer.`, {
        status: 400,
        details: [{ field }],
      });
    }
  }
  if (z < provider.minZoom || z > provider.maxZoom) {
    throw new ApiError('VALIDATION_FAILED', `Zoom ${z} is outside this provider's range.`, {
      status: 400,
      details: [{ field: 'z', min: provider.minZoom, max: provider.maxZoom }],
    });
  }
  const bound = 2 ** z;
  if (x >= bound || y >= bound) {
    throw new ApiError('VALIDATION_FAILED', 'Tile coordinates are outside the zoom level.', { status: 400 });
  }
}

/**
 * Places the credential where the provider expects it, and adds the non-secret
 * headers a provider's policy requires. The credential is never part of the cache
 * key, the response, or a log line; `requestHeaders` never reaches a client either.
 */
function buildUpstreamRequest(provider, coordinates, credential) {
  const url = new URL(buildTileUrl(provider, coordinates));
  const headers = { accept: 'image/*', ...provider.requestHeaders };
  if (credential && provider.credentialPlacement === 'query') url.searchParams.set(provider.credentialParam, credential);
  if (credential && provider.credentialPlacement === 'header') headers[provider.credentialParam] = credential;
  return { url: url.toString(), headers };
}

function attributionFor(provider) {
  return { text: provider.attributionText, url: provider.attributionUrl };
}
