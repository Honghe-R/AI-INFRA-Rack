import { createServer } from 'node:http';
import { createAssetService } from '@ai-infra/assets';
import { createLogger, loadConfig } from '@ai-infra/core';
import { createPool } from '@ai-infra/db';
import { createFacilityToolSurface, createFacilityValidationService, createValidationWorker } from '@ai-infra/facility';
import { createAuthenticator, createHmacVerifier, createJwtVerifier, createUserDirectory } from '@ai-infra/identity';
import { createDefaultRegistry, createImportPipeline, createSandbox } from '@ai-infra/imports';
import { createDefaultProviders, createMapTileService, createProviderRegistry } from '@ai-infra/maps';
import { createEvaluator, createPermissionGuard, createRbacRepository } from '@ai-infra/rbac';
import { createSecretProvider } from '@ai-infra/secrets';
import { createStorage } from '@ai-infra/storage';
import { createApp } from './app.js';
import { createAssistantHostFor } from './assistant-host.js';
import { createRouter } from './router.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerFacilityRoutes } from './routes/facility.js';
import { registerFacilityCapacityRoutes } from './routes/facility-capacity.js';
import { registerFacilityGovernanceRoutes } from './routes/facility-governance.js';
import { registerFacilityImportRoutes } from './routes/facility-imports.js';
import { registerFacilityLifecycleRoutes } from './routes/facility-lifecycle.js';
import { registerFacilityValidationRoutes } from './routes/facility-validation.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMapRoutes } from './routes/map.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSelfRoutes } from './routes/me.js';
import { registerRackRoutes } from './routes/rack.js';

const config = loadConfig();
const logger = createLogger({
  service: config.service,
  version: config.serviceVersion,
  level: config.logLevel,
});

const secrets = createSecretProvider({
  source: config.secretSource,
  directory: config.secretFileDir,
});

const pool = config.databaseUrl
  ? createPool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      statementTimeoutMs: config.databaseStatementTimeoutMs,
      applicationName: config.service,
    })
  : null;

const router = createRouter();
registerHealthRoutes(router);

let authenticator = null;
let guard = null;
let assetService = null;
let mapService = null;
let validationService = null;
let toolSurface = null;
let validationWorker = null;
let assistantAvailable = false;

// Object storage is shared by the asset intake and by the facility tool surface,
// where it is what reads an import's FEATURES representation and what the frozen
// published envelope is written to. It is optional at startup so the rest of the
// platform still serves on a machine with no bucket configured.
let storage = null;
try {
  storage = createStorage(config);
} catch (error) {
  logger.warn('startup.storage_unavailable', { reason: error?.message });
}

if (pool) {
  const repository = createRbacRepository({ pool });
  const evaluator = createEvaluator({ repository, logger });
  guard = createPermissionGuard({ evaluator, repository, logger });
  const directory = createUserDirectory({ repository, autoProvision: config.autoProvision });

  authenticator = createAuthenticator({ verifier: buildVerifier({ config, logger }), directory, logger });

  registerSelfRoutes(router, { repository, guard });
  registerAdminRoutes(router, { repository, evaluator });
  registerProjectRoutes(router, { pool });
  registerFacilityRoutes(router, { pool });
  registerRackRoutes(router, { pool, guard });

  // Validation: the service serves the reads and the local runs, and the worker
  // drains queued FULL batches.
  validationService = createFacilityValidationService({
    pool,
    logger,
    maxDiagnostics: config.validationMaxDiagnostics,
  });

  // The facility tool surface is the one path to facility data: the routes below
  // adapt HTTP to it, and the assistant host will call the same tools. Its
  // authorizer re-asks the same permission guard the router uses, so a tool call
  // from any caller is authorized identically.
  toolSurface = createFacilityToolSurface({
    pool,
    logger,
    validationService,
    storage,
    authorize: async ({ key, userId, workspaceId }) => {
      if (!key) return true;
      try {
        await guard.check(key, { user: { userId }, params: { projectId: workspaceId } }, { projectParam: 'projectId' });
        return true;
      } catch {
        return false;
      }
    },
    onAudit: (record) => logger.info('tool.invoked', record),
  });

  registerFacilityValidationRoutes(router, { toolSurface, validationService });
  registerFacilityImportRoutes(router, { toolSurface });
  registerFacilityCapacityRoutes(router, { toolSurface });
  registerFacilityGovernanceRoutes(router, { toolSurface });
  registerFacilityLifecycleRoutes(router, { toolSurface, pool });

  assetService = createAssetServiceFor(config, pool, logger);
  if (assetService) registerAssetRoutes(router, { assetService });

  mapService = createMapServiceFor(config, pool, secrets, logger);
  if (mapService) registerMapRoutes(router, { mapService });

  // The assistant host is optional: a deployment with no LLM endpoint still serves
  // the rest of the platform, and the router says why the chat is unavailable.
  let assistant = null;
  try {
    assistant = await createAssistantHostFor({ config, pool, secrets, guard, logger, toolSurface });
    assistantAvailable = true;
    registerAssistantRoutes(router, assistant);
  } catch (error) {
    logger.warn('startup.assistant_unavailable', { reason: error?.message });
  }
} else {
  logger.warn('startup.no_database', {
    reason: 'DATABASE_URL is not set; readiness fails closed and protected routes are unavailable.',
  });
}

const server = createServer(
  createApp({
    config,
    logger,
    pool,
    secrets,
    router,
    authenticator,
    guard,
    // With no database the tool, self, and admin routes are not registered, so
    // the router has no match to offer. Answer with the reason rather than a 404,
    // and name the reason for the path the caller actually asked for.
    unavailableReason: (path) => {
      if (!pool) return 'The API is running without a database, so this endpoint is unavailable. Set DATABASE_URL and restart.';
      if (path.startsWith('/api/v1/assistant') && !assistantAvailable) {
        return 'No LLM provider is configured, so assistant endpoints are unavailable. Set LLM_ENDPOINT and LLM_MODEL and restart.';
      }
      if (!assetService) return 'Object storage is not configured, so asset endpoints are unavailable. Set STORAGE_* and restart.';
      if (!mapService) return 'The basemap service could not be configured, so map endpoints are unavailable.';
      return null;
    },
  }),
);

server.listen(config.port, process.env.HOST, () => {
  logger.info('server.listening', { port: config.port, env: config.env });
});

// The validation worker runs inside this process by default, so the development
// loop needs no third terminal. `npm run dev:worker` runs the same loop on its
// own for a deployment that scales jobs separately; the queue is the `jobs`
// table, so either arrangement is the same code path.
if (pool && config.validationWorker && validationService) {
  validationWorker = createValidationWorker({
    pool,
    logger,
    pollIntervalMs: config.validationWorkerIntervalMs,
    maxDiagnostics: config.validationMaxDiagnostics,
  });
  validationWorker.start();
  logger.info('startup.validation_worker', { intervalMs: config.validationWorkerIntervalMs });
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { signal });
  validationWorker?.stop();
  server.close(async () => {
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * The asset service needs both the database and object storage. Object storage is
 * optional at startup so the API still serves projects and RBAC on a machine with
 * no bucket configured; the asset routes are then absent and the router says why.
 */
function createAssetServiceFor(config, pool, logger) {
  try {
    const storage = createStorage(config);
    // The import framework is the asset service's representation producer. It is
    // injected rather than imported by the asset package, so the asset layer
    // carries no format knowledge and W4 can evolve independently.
    const processor = createImportPipeline({
      pool,
      storage,
      registry: createDefaultRegistry(),
      sandbox: createSandbox({ timeoutMs: config.importTimeoutMs ?? undefined, maxOldSpaceMb: config.importMaxOldSpaceMb ?? undefined }),
      logger,
    });
    return createAssetService({
      pool,
      storage,
      limits: { maxBytes: config.assetMaxBytes },
      logger,
      processor,
    });
  } catch (error) {
    logger.warn('startup.assets_unavailable', { reason: error?.message });
    return null;
  }
}

/**
 * The basemap proxy needs the database (quota and metering) and the secret
 * manager (provider credentials). It has no optional dependency, so a failure to
 * construct it makes only the map routes unavailable.
 */
function createMapServiceFor(config, pool, secrets, logger) {
  try {
    // The public OSM provider identifies this deployment to the tile server, as
    // its usage policy requires (D26); the identity is configuration, not code.
    const registry = createProviderRegistry({
      providers: createDefaultProviders({
        ...(config.mapOsmUserAgent ? { osmUserAgent: config.mapOsmUserAgent } : {}),
        osmReferer: config.mapOsmReferer,
        selfHostedTileUrl: config.mapSelfHostedTileUrl,
      }),
    });
    return createMapTileService({
      pool,
      secrets,
      registry,
      logger,
      limits: { upstreamTimeoutMs: config.mapUpstreamTimeoutMs, maxTileBytes: config.mapMaxTileBytes },
    });
  } catch (error) {
    logger.warn('startup.maps_unavailable', { reason: error?.message });
    return null;
  }
}

/**
 * OIDC is the deployed path. A shared secret exists only so a local stack can
 * run; it refuses to be constructed in production, and the fallback below is
 * loud because it is insecure by construction.
 */
function buildVerifier({ config: cfg, logger: log }) {
  const audience = cfg.authAudience || undefined;

  if (cfg.authJwksUri) {
    return createJwtVerifier({ issuer: cfg.authIssuer, audience, jwksUri: cfg.authJwksUri });
  }
  if (cfg.authDevSecret) {
    return createHmacVerifier({ secret: cfg.authDevSecret, issuer: cfg.authIssuer, audience });
  }
  if (cfg.env === 'production') {
    throw new Error('No authentication is configured. Set AUTH_JWKS_URI before running in production.');
  }

  log.warn('startup.insecure_auth', {
    reason: 'No AUTH_JWKS_URI or AUTH_DEV_SECRET is set; using a well-known development secret.',
  });
  return createHmacVerifier({ secret: 'dev-only-insecure-secret', issuer: cfg.authIssuer, audience });
}
