import { ONBOARDING_KEYS, SHOWCASE_READ_KEYS, SYSTEM_KEYS } from './catalog.js';
import { createTtlCache } from './cache.js';
import { REASON, allowed, denied } from './decision.js';

/**
 * The one evaluator (blueprint §5).
 *
 * Contract: `evaluate({ userId, key, projectId, organisationId }) -> decision`.
 *
 * Order, stopping at the first match: project scope, organisation scope, global
 * scope, onboarding, showcase, default deny. There is no deny path and no
 * subtractive rule — a scope that does not grant simply does not match
 * (porting decision R1).
 *
 * @param {object} options
 * @param {object} options.repository  See the port documented below.
 * @param {object} [options.cache]     Injected for tests.
 * @param {object} [options.logger]
 *
 * Repository port:
 *  - `resolveKey(key) -> { id, key, scope } | null`
 *  - `grantedKeys({ userId, scopeKind, scopeId }) -> Promise<Set<string>>`
 *      Must exclude assignments whose membership is not active, which is how
 *      suspension removes permission (porting decision R2).
 *  - `getProject(projectId) -> { projectId, organisationId, showcase } | null`
 *  - `countMemberships(userId) -> number`  (active memberships only)
 */
export function createEvaluator({
  repository,
  cache = createTtlCache({ ttlMs: 30_000 }),
  keyCache = createTtlCache({ ttlMs: 300_000 }),
  logger = null,
} = {}) {
  if (!repository) throw new Error('createEvaluator requires a repository.');

  async function resolveKey(key) {
    const cacheKey = `key:${key}`;
    const cached = keyCache.peek(cacheKey);
    if (cached !== undefined) return cached;

    const resolved = await repository.resolveKey(key);
    // Only positive resolutions are cached. Caching a miss would leave a newly
    // registered key unknown until the TTL expired (blueprint §5).
    if (resolved) keyCache.set(cacheKey, resolved, ['catalog']);
    return resolved;
  }

  async function evaluate({ userId = null, key = null, projectId = null, organisationId = null } = {}) {
    if (!userId) return denied(REASON.UNAUTHENTICATED, { projectId, organisationId });
    if (!key) return denied(REASON.FUNCTION_REQUIRED, { projectId, organisationId });

    // System keys ignore scope entirely, so no scoped role can grant them.
    const systemLevel = SYSTEM_KEYS.has(key);
    const scopedProjectId = systemLevel ? null : projectId;
    let scopedOrganisationId = systemLevel ? null : organisationId;

    try {
      const resolved = await resolveKey(key);
      if (!resolved) return denied(REASON.UNKNOWN_FUNCTION, { projectId: scopedProjectId, organisationId: scopedOrganisationId });

      let project = null;
      if (scopedProjectId) {
        project = await cache.getOrLoad(
          `project:${scopedProjectId}`,
          () => repository.getProject(scopedProjectId),
          [`project:${scopedProjectId}`],
        );
        if (!project) {
          // An unresolved scoped entity fails closed here; the guard turns a
          // resolution failure into a 404 before evaluation.
          return denied(REASON.INSUFFICIENT_PERMISSION, { projectId: scopedProjectId, organisationId: scopedOrganisationId });
        }
        if (scopedOrganisationId && project.organisationId && (typeof scopedOrganisationId !== 'string' || scopedOrganisationId.toLowerCase() !== project.organisationId.toLowerCase())) {
          return denied(REASON.INSUFFICIENT_PERMISSION, { projectId: scopedProjectId, organisationId: project.organisationId });
        }
        scopedOrganisationId = project.organisationId ?? scopedOrganisationId ?? null;
      }

      const tags = [
        `user:${userId}`,
        ...(scopedProjectId ? [`project:${scopedProjectId}`] : []),
        ...(scopedOrganisationId ? [`organisation:${scopedOrganisationId}`] : []),
      ];
      const cacheKey = `decision:${userId}|${resolved.id}|${scopedProjectId ?? '-'}|${scopedOrganisationId ?? '-'}`;

      return await cache.getOrLoad(cacheKey, async () => {
        if (scopedProjectId) {
          const granted = await repository.grantedKeys({ userId, scopeKind: 'project', scopeId: scopedProjectId });
          if (granted.has(key)) {
            return allowed('project', { functionId: resolved.id, projectId: scopedProjectId, organisationId: scopedOrganisationId });
          }
        }

        if (scopedOrganisationId) {
          const granted = await repository.grantedKeys({ userId, scopeKind: 'organisation', scopeId: scopedOrganisationId });
          if (granted.has(key)) {
            return allowed('organisation', { functionId: resolved.id, projectId: scopedProjectId, organisationId: scopedOrganisationId });
          }
        }

        const globalKeys = await repository.grantedKeys({ userId, scopeKind: 'global', scopeId: null });
        if (globalKeys.has(key)) {
          return allowed('global', { functionId: resolved.id, projectId: scopedProjectId, organisationId: scopedOrganisationId });
        }

        if (ONBOARDING_KEYS.has(key) && (await repository.countMemberships(userId)) === 0) {
          return allowed('onboarding', { functionId: resolved.id });
        }

        if (project?.showcase && SHOWCASE_READ_KEYS.has(key)) {
          return allowed('showcase', {
            functionId: resolved.id,
            projectId: scopedProjectId,
            organisationId: scopedOrganisationId,
            showcase: true,
            readOnly: true,
          });
        }

        return denied(REASON.INSUFFICIENT_PERMISSION, { projectId: scopedProjectId, organisationId: scopedOrganisationId });
      }, tags);
    } catch (error) {
      // Fail closed on evaluator errors: a database blip must not open the door.
      // The denial is flagged as an evaluation failure so the guard can answer
      // 500 rather than dressing an outage up as a policy decision.
      logger?.error('rbac.evaluation_failed', { error: error?.message, key, userId });
      return {
        ...denied(REASON.INSUFFICIENT_PERMISSION, { projectId: scopedProjectId, organisationId: scopedOrganisationId }),
        evaluationError: true,
      };
    }
  }

  return {
    evaluate,

    /** Invalidates decisions by user and/or scope. Returns entries dropped. */
    invalidate({ userId = null, projectId = null, organisationId = null } = {}) {
      const tags = [
        ...(userId ? [`user:${userId}`] : []),
        ...(projectId ? [`project:${projectId}`] : []),
        ...(organisationId ? [`organisation:${organisationId}`] : []),
      ];
      return cache.invalidateTags(tags);
    },

    /** Role/key mapping or catalog changes clear everything, including key ids. */
    invalidateCatalog() {
      const removed = cache.clear();
      keyCache.clear();
      return removed;
    },

    stats() {
      return { decisions: cache.size, inflight: cache.inflightCount, keys: keyCache.size };
    },
  };
}
