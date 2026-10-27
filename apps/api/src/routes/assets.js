import { errors } from '@ai-infra/core';
import { PLATFORM_KEYS } from '@ai-infra/rbac';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project asset endpoints (doc/workspace/project-assets.md, "Asset API").
 *
 * These are workspace-level routes shared by every tool. Uploads stream through
 * the API (D23): the content route declares `streamBody`, so the pipeline hands
 * the handler the raw request and never buffers the object. Downloads are the
 * only signed-URL path, and a read grant carries no write capability.
 *
 * Every route is scoped to one project by the guard, so an unreachable or
 * malformed project id is a 404 from the guard rather than a null scope.
 */
export function registerAssetRoutes(router, { assetService }) {
  if (!assetService) throw new Error('registerAssetRoutes requires an asset service.');

  router.get(
    '/api/v1/projects/:projectId/assets',
    async ({ params, query, user }) => {
      const assets = await assetService.listAssets({
        projectId: params.projectId,
        actorId: user?.userId ?? null,
        kind: query.kind ?? null,
        status: query.status ?? null,
        mediaType: query.media_type ?? null,
        query: query.q ?? null,
        limit: query.limit ? Number.parseInt(query.limit, 10) : 100,
      });
      return { data: assets };
    },
    { permission: PLATFORM_KEYS.ASSET_READ, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/assets',
    async ({ params, body, user, correlationId }) => {
      const result = await assetService.reserveAsset({
        projectId: params.projectId,
        actorId: user?.userId ?? null,
        name: body.name,
        kind: body.kind ?? null,
        mediaType: body.media_type,
        filename: body.filename ?? null,
        sourceRef: body.source_ref ?? 'user-upload',
        accessClassification: body.access_classification ?? 'PROJECT',
        retentionClass: body.retention_class ?? 'PROJECT_ASSET',
        tags: Array.isArray(body.tags) ? body.tags : [],
        declaredSizeBytes: numberOrNull(body.size_bytes),
        correlationId,
      });
      return { data: result, status: 201 };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/assets/:assetId/versions',
    async ({ params, body, user, correlationId }) => {
      assertUuidParam(params.assetId, 'assetId');
      const result = await assetService.reserveVersion({
        projectId: params.projectId,
        actorId: user?.userId ?? null,
        assetId: params.assetId,
        filename: body.filename ?? null,
        mediaType: body.media_type ?? null,
        sourceRef: body.source_ref ?? 'user-upload',
        declaredSizeBytes: numberOrNull(body.size_bytes),
        correlationId,
      });
      return { data: result, status: 201 };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  /**
   * Content intake. `streamBody` keeps the pipeline out of the way; the service
   * hashes the bytes as they arrive and enforces the size limit while the stream
   * is in flight (D23).
   */
  router.put(
    '/api/v1/projects/:projectId/assets/:assetId/versions/:assetVersionId/content',
    async ({ request, params, user, correlationId }) => {
      assertUuidParam(params.assetId, 'assetId');
      assertUuidParam(params.assetVersionId, 'assetVersionId');
      const declared = numberOrNull(request.headers['content-length']);
      const result = await assetService.intakeContent({
        projectId: params.projectId,
        actorId: user?.userId ?? null,
        assetId: params.assetId,
        assetVersionId: params.assetVersionId,
        body: request,
        contentType: request.headers['content-type'] ?? null,
        declaredSizeBytes: declared,
        correlationId,
      });
      return {
        data: {
          asset: result.asset,
          version: result.version,
          representation: result.representation,
          deduplicated: result.deduplicated,
          scan: result.scan,
        },
        status: result.deduplicated ? 200 : 201,
      };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId', streamBody: true },
  );

  router.get(
    '/api/v1/projects/:projectId/assets/:assetId',
    async ({ params, user }) => {
      assertUuidParam(params.assetId, 'assetId');
      const asset = await assetService.getAsset({
        projectId: params.projectId,
        assetId: params.assetId,
        actorId: user?.userId ?? null,
      });
      if (!asset) throw errors.notFound('The requested resource was not found.');
      return { data: asset };
    },
    { permission: PLATFORM_KEYS.ASSET_READ, projectParam: 'projectId' },
  );

  router.get(
    '/api/v1/projects/:projectId/assets/:assetId/versions/:assetVersionId/download',
    async ({ params, query, user }) => {
      assertUuidParam(params.assetId, 'assetId');
      assertUuidParam(params.assetVersionId, 'assetVersionId');
      const result = await assetService.createDownloadUrl({
        projectId: params.projectId,
        actorId: user?.userId ?? null,
        assetId: params.assetId,
        assetVersionId: params.assetVersionId,
        representationId: query.representation_id ?? null,
      });
      return { data: result };
    },
    { permission: PLATFORM_KEYS.ASSET_READ, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/assets/:assetId/process',
    async ({ params, body, user, correlationId }) => {
      assertUuidParam(params.assetId, 'assetId');
      const result = await assetService.requestProcessing({
        projectId: params.projectId,
        assetId: params.assetId,
        assetVersionId: body.asset_version_id ?? null,
        actorId: user?.userId ?? null,
        force: body.force === true,
        correlationId,
      });
      return { data: result };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  router.patch(
    '/api/v1/projects/:projectId/assets/:assetId',
    async ({ params, body, user }) => {
      assertUuidParam(params.assetId, 'assetId');
      const asset = await assetService.patchAsset({
        projectId: params.projectId,
        assetId: params.assetId,
        actorId: user?.userId ?? null,
        name: body.name ?? null,
        tags: Array.isArray(body.tags) ? body.tags : null,
        accessClassification: body.access_classification ?? null,
        retentionClass: body.retention_class ?? null,
      });
      return { data: asset };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/assets/:assetId/archive',
    async ({ params, body, user }) => {
      assertUuidParam(params.assetId, 'assetId');
      const archived = body.archived !== false;
      const asset = await assetService.setArchived({
        projectId: params.projectId,
        assetId: params.assetId,
        archived,
        actorId: user?.userId ?? null,
      });
      return { data: asset };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  router.delete(
    '/api/v1/projects/:projectId/assets/:assetId',
    async ({ params, user, correlationId }) => {
      assertUuidParam(params.assetId, 'assetId');
      const result = await assetService.deleteAsset({
        projectId: params.projectId,
        assetId: params.assetId,
        actorId: user?.userId ?? null,
        correlationId,
      });
      return { data: result };
    },
    { permission: PLATFORM_KEYS.ASSET_DELETE, projectParam: 'projectId' },
  );

  /**
   * Access grants for a restricted asset. Managing grants needs `asset.write`;
   * holding it does not by itself authorize reading the asset, so `getAsset` and
   * `download` still check the grant (project-assets.md, "Access Control").
   */
  router.get(
    '/api/v1/projects/:projectId/assets/:assetId/grants',
    async ({ params }) => {
      assertUuidParam(params.assetId, 'assetId');
      const grants = await assetService.listGrants({ projectId: params.projectId, assetId: params.assetId });
      return { data: grants };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  router.post(
    '/api/v1/projects/:projectId/assets/:assetId/grants',
    async ({ params, body, user }) => {
      assertUuidParam(params.assetId, 'assetId');
      const grant = await assetService.createGrant({
        projectId: params.projectId,
        assetId: params.assetId,
        granteeId: body.grantee_id,
        actorId: user?.userId ?? null,
      });
      return { data: grant, status: 201 };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  router.delete(
    '/api/v1/projects/:projectId/assets/:assetId/grants/:granteeId',
    async ({ params, user }) => {
      assertUuidParam(params.assetId, 'assetId');
      assertUuidParam(params.granteeId, 'granteeId');
      const revoked = await assetService.revokeGrant({
        projectId: params.projectId,
        assetId: params.assetId,
        granteeId: params.granteeId,
        actorId: user?.userId ?? null,
      });
      return { data: revoked };
    },
    { permission: PLATFORM_KEYS.ASSET_WRITE, projectParam: 'projectId' },
  );

  /**
   * Asset job polling. The specification lists `GET /api/v1/jobs/{jobId}`; that
   * route has no project in its path, so this platform read is project-scoped
   * until the unified job service lands with the tool (T-milestones).
   */
  router.get(
    '/api/v1/projects/:projectId/asset-jobs/:jobId',
    async ({ params }) => {
      assertUuidParam(params.jobId, 'jobId');
      const job = await assetService.getJob({ projectId: params.projectId, jobId: params.jobId });
      if (!job) throw errors.notFound('The requested resource was not found.');
      return { data: job };
    },
    { permission: PLATFORM_KEYS.ASSET_READ, projectParam: 'projectId' },
  );
}

function assertUuidParam(value, field) {
  if (!UUID.test(value ?? '')) throw errors.notFound('The requested resource was not found.');
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
