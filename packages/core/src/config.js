/**
 * Runtime configuration, resolved once at process start.
 *
 * Values come from the environment so that a deployment injects them instead of
 * baking them into an image. Nothing here reads a secret value: secrets are
 * resolved through `@ai-infra/secrets` at the point of use.
 */
export function loadConfig(env = process.env) {
  return Object.freeze({
    env: env.NODE_ENV ?? 'development',
    service: env.SERVICE_NAME ?? 'ai-infra-api',
    serviceVersion: env.SERVICE_VERSION ?? '0.1.0',
    port: toInteger(env.PORT, 8787),
    logLevel: env.LOG_LEVEL ?? 'info',
    corsOrigin: env.CORS_ORIGIN ?? null,

    databaseUrl: env.DATABASE_URL ?? null,
    databasePoolMax: toInteger(env.DATABASE_POOL_MAX, 10),
    databaseStatementTimeoutMs: toInteger(env.DATABASE_STATEMENT_TIMEOUT_MS, 30_000),

    secretSource: env.SECRET_SOURCE ?? 'env',
    secretFileDir: env.SECRET_FILE_DIR ?? null,

    authIssuer: env.AUTH_ISSUER ?? 'https://identity.local',
    authAudience: env.AUTH_AUDIENCE ?? null,
    authJwksUri: env.AUTH_JWKS_URI ?? null,
    authDevSecret: env.AUTH_DEV_SECRET ?? null,
    autoProvision: env.AUTO_PROVISION !== 'false',

    migrationDir: env.MIGRATION_DIR ?? 'data-scripts',
    bodyLimitBytes: toInteger(env.BODY_LIMIT_BYTES, 1024 * 1024),
    // Project asset intake streams to storage and enforces this ceiling while the
    // bytes arrive, so it does not use `bodyLimitBytes`. The default matches the
    // documented 2 GiB import limit; @ai-infra/assets applies the hard ceiling.
    assetMaxBytes: toInteger(env.ASSET_MAX_BYTES, 2 * 1024 * 1024 * 1024),

    // Object storage. The same keys address a local S3-compatible store and a cloud
    // bucket, so the only difference between development and deployment is the endpoint
    // and the credentials — never the code path (see packages/storage).
    storageDriver: env.STORAGE_DRIVER ?? 's3',
    storageBucket: env.STORAGE_BUCKET ?? null,
    storageEndpoint: env.STORAGE_ENDPOINT ?? null,
    storageRegion: env.STORAGE_REGION ?? 'us-east-1',
    storageAccessKeyId: env.STORAGE_ACCESS_KEY_ID ?? null,
    storageSecretAccessKey: env.STORAGE_SECRET_ACCESS_KEY ?? null,
    // Path-style addressing is what a local S3-compatible store needs; real S3 uses
    // virtual-host style unless a custom endpoint is set.
    storageForcePathStyle: env.STORAGE_FORCE_PATH_STYLE
      ? env.STORAGE_FORCE_PATH_STYLE !== 'false'
      : Boolean(env.STORAGE_ENDPOINT),
    storageRoot: env.STORAGE_ROOT ?? null,

    // Basemap tile proxy (D16). The upstream timeout bounds one provider call; a
    // breach degrades the canvas to the plan-only grid rather than hanging it.
    mapUpstreamTimeoutMs: toInteger(env.MAP_UPSTREAM_TIMEOUT_MS, 5_000),
    mapMaxTileBytes: toInteger(env.MAP_MAX_TILE_BYTES, 2 * 1024 * 1024),
    // The public OSM tile server requires an identifying User-Agent and an
    // accurate Referer (D26); the proxy sends whatever a deployment names here.
    mapOsmUserAgent: env.MAP_OSM_USER_AGENT ?? null,
    // Absent means the deployment has no self-hosted tile server, and the provider is
    // therefore not offered at all (see `createDefaultProviders`).
    mapSelfHostedTileUrl: env.MAP_SELF_HOSTED_TILE_URL ?? null,
    mapOsmReferer: env.MAP_OSM_REFERER ?? null,

    // Assistant host (chatbox blueprint §4.2 and §4.3). The server owns provider
    // selection: a request never names one, and the key is a *name* resolved
    // through the secret manager, never a value in this configuration.
    llmProvider: env.LLM_PROVIDER ?? null,
    llmEndpoint: env.LLM_ENDPOINT ?? null,
    llmModel: env.LLM_MODEL ?? null,
    // The models a caller may choose between. Empty means "no choice": the deployment
    // runs the configured model and the composer offers no selector. A model named by a
    // request is honoured only if it appears here, so the client can pick within the
    // deployment's menu but can never widen it — the endpoint and the credential stay
    // server-side, which is what "the server owns provider selection" has to mean once
    // a model becomes selectable.
    llmModels: parseModelList(env.LLM_MODELS),
    llmApiKeySecret: env.LLM_API_KEY_SECRET ?? null,
    // A gateway that authenticates by network position needs no bearer key; the
    // flag is explicit so a missing credential is otherwise a loud 503.
    llmAllowNoKey: env.LLM_ALLOW_NO_KEY === 'true',
    llmTimeoutMs: toInteger(env.LLM_TIMEOUT_MS, 60_000),
    assistantMaxIterations: toInteger(env.ASSISTANT_MAX_ITERATIONS, 8),
    assistantMaxMessages: toInteger(env.ASSISTANT_MAX_MESSAGES, 60),
    assistantMaxInputBytes: toInteger(env.ASSISTANT_MAX_INPUT_BYTES, 200_000),
    assistantResultBytes: toInteger(env.ASSISTANT_RESULT_BYTES, 32_768),
    assistantDigestBytes: toInteger(env.ASSISTANT_DIGEST_BYTES, 8_192),
    // Monthly token quotas per scope. Unset means no limit, so a deployment opts in.
    assistantUserMonthlyTokens: optionalInteger(env.ASSISTANT_USER_MONTHLY_TOKENS),
    assistantWorkspaceMonthlyTokens: optionalInteger(env.ASSISTANT_WORKSPACE_MONTHLY_TOKENS),
    assistantOrganisationMonthlyTokens: optionalInteger(env.ASSISTANT_ORGANISATION_MONTHLY_TOKENS),

    // Validation. A FULL batch is a job; the worker claims queued jobs from the
    // `jobs` table. It runs inside the API process by default so a development
    // stack needs no second process, and `npm run dev:worker` runs the same loop
    // on its own for a deployment that scales it separately.
    validationWorker: env.VALIDATION_WORKER !== 'false',
    validationWorkerIntervalMs: toInteger(env.VALIDATION_WORKER_INTERVAL_MS, 1000),
    validationMaxDiagnostics: toInteger(env.VALIDATION_MAX_DIAGNOSTICS, 100_000),
  });
}

/** `LLM_MODELS=a,b` → `['a','b']`; unset or blank → no choice at all. */
function parseModelList(value) {
  const listed = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (listed.length > 0) return Object.freeze([...new Set(listed)]);
  // No list configured: the deployment still runs its model, it is simply not offered as
  // one of several, and the composer hides the control rather than showing a menu of one.
  return Object.freeze([]);
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A quota is either a positive integer or absent; absent means unlimited. */
function optionalInteger(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
