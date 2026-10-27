import { errors } from '@ai-infra/core';
import { MAP_KEYS } from '@ai-infra/rbac';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Basemap tile proxy routes (D16).
 *
 * The client never contacts a tile provider: it reads provider metadata here, and
 * every tile passes through the proxy, which holds the credential and meters the
 * request. The tile response is bytes, not JSON, so the handler writes the
 * response directly and the pipeline leaves it alone.
 *
 * Provider metadata is project-scoped because a project selects its provider and
 * carries its own quota, so `project_id` is part of the read.
 */
export function registerMapRoutes(router, { mapService }) {
  if (!mapService) throw new Error('registerMapRoutes requires a map tile service.');

  router.get(
    '/api/v1/map/providers',
    async ({ query }) => {
      assertUuidParam(query.project_id, 'project_id');
      const [providers, settings] = await Promise.all([
        mapService.listProviders(),
        mapService.getProjectSettings({ projectId: query.project_id }),
      ]);
      return { data: { providers, settings } };
    },
    { permission: MAP_KEYS.READ, projectParam: 'project_id' },
  );

  router.put(
    '/api/v1/projects/:projectId/map/provider',
    async ({ params, body, user }) => {
      const settings = await mapService.setProjectSettings({
        projectId: params.projectId,
        providerId: body.provider_id,
        style: body.style ?? null,
        tileQuota: body.tile_quota ?? null,
        actorId: user?.userId ?? null,
      });
      return { data: settings };
    },
    { permission: MAP_KEYS.MANAGE, projectParam: 'projectId' },
  );

  /**
   * One proxied tile. `project_id` rides in the query because the route is
   * provider-addressed, and the guard reads params, then body, then query.
   */
  router.get(
    '/api/v1/map/tiles/:provider/:z/:x/:y',
    async ({ params, query, user, response }) => {
      const tile = await mapService.fetchTile({
        projectId: query.project_id,
        userId: user?.userId ?? null,
        scenarioId: query.scenario_id ?? null,
        providerId: params.provider,
        style: query.style ?? null,
        z: Number.parseInt(params.z, 10),
        x: Number.parseInt(params.x, 10),
        y: Number.parseInt(params.y, 10),
      });

      response.writeHead(200, {
        'content-type': tile.mediaType,
        'content-length': tile.bytes.length,
        // A provider that forbids caching gets `no-store`, so no intermediary
        // retains the tile either.
        'cache-control': tile.cacheMaxAgeSeconds > 0 ? `public, max-age=${tile.cacheMaxAgeSeconds}` : 'no-store',
        // Attribution travels with the tile so a surface cannot show one without
        // the other. The values are ASCII-encoded because headers are latin-1.
        'x-map-provider': params.provider,
        'x-map-cache': tile.cache,
        'x-map-attribution': encodeURIComponent(tile.attribution.text),
        ...(tile.attribution.url ? { 'x-map-attribution-url': tile.attribution.url } : {}),
      });
      response.end(tile.bytes);
    },
    { permission: MAP_KEYS.READ, projectParam: 'project_id' },
  );

  router.get(
    '/api/v1/projects/:projectId/map/usage',
    async ({ params }) => {
      const usage = await mapService.getUsage({ projectId: params.projectId });
      return { data: usage };
    },
    { permission: MAP_KEYS.USAGE_READ, projectParam: 'projectId' },
  );
}

function assertUuidParam(value, field) {
  if (!UUID.test(value ?? '')) {
    // A malformed scope identifier is a 404, never a null scope.
    throw errors.notFound('The requested resource was not found.');
  }
}
