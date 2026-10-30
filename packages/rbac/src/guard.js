import { ApiError } from '@ai-infra/core';
import { SYSTEM_KEYS } from './catalog.js';
import { REASON, messageFor, toResult } from './decision.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = () => new ApiError('NOT_FOUND', 'The requested resource was not found.', { status: 404 });
const UNAUTHENTICATED = () =>
  new ApiError('UNAUTHENTICATED', 'Authentication is required.', { status: 401 });

/**
 * The permission guard factory (blueprint §7).
 *
 * Scope ids are read from **route params, then body, then query** — that order is
 * part of the contract, because a mismatch between the parameter a route declares
 * and the parameter the guard reads produces a silent null scope: either a silent
 * denial or a broadened check.
 *
 * A scoped identifier that does not resolve is a 404, never a null scope.
 * System-level keys skip scope resolution entirely, so no scoped role can grant
 * them and a meaningless scope cannot turn into a spurious 404.
 *
 * Denial contract, mapped onto this platform's standard error envelope:
 *
 *   no authenticated user     401  UNAUTHENTICATED
 *   scoped entity not found   404  NOT_FOUND
 *   unknown key               403  UNKNOWN_FUNCTION
 *   insufficient permission   403  INSUFFICIENT_PERMISSION
 *   evaluator threw           500  INTERNAL_ERROR
 *
 * The blueprint's `{ allowed:false, functionKey }` body is carried in `details`,
 * so a client never has to parse the human sentence.
 *
 * @param {object} options
 * @param {object} options.evaluator   From `createEvaluator`.
 * @param {object} [options.repository] Used only to resolve scoped identifiers.
 * @param {object} [options.logger]
 */
export function createPermissionGuard({ evaluator, repository = null, logger = null } = {}) {
  if (!evaluator) throw new Error('createPermissionGuard requires an evaluator.');

  function readRawScope(ctx, options) {
    const { projectParam = 'projectId', organisationParam = 'organisationId' } = options ?? {};
    const sources = [ctx?.params, ctx?.body, ctx?.query];
    const pick = (name) => {
      for (const source of sources) {
        const value = source?.[name];
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return null;
    };
    return { projectId: pick(projectParam), organisationId: pick(organisationParam) };
  }

  /** Resolves public identifiers to internal ones, or throws 404. */
  async function resolveScope(ctx, options) {
    let { projectId, organisationId } = readRawScope(ctx, options);
    if (organisationId && (typeof organisationId !== 'string' || !UUID.test(organisationId))) throw NOT_FOUND();

    if (projectId) {
      if (typeof projectId !== 'string' || !UUID.test(projectId)) throw NOT_FOUND();
      const project = repository?.getProject ? await repository.getProject(projectId) : { projectId, organisationId: null };
      if (!project) throw NOT_FOUND();
      projectId = project.projectId;
      // A caller-supplied organisation cannot lend its grants to another tenant's project.
      if (organisationId && project.organisationId && organisationId.toLowerCase() !== project.organisationId.toLowerCase()) throw NOT_FOUND();
      organisationId = project.organisationId ?? organisationId ?? null;
    }

    if (organisationId) {
      if (typeof organisationId !== 'string' || !UUID.test(organisationId)) throw NOT_FOUND();
      if (repository?.getOrganization) {
        const organisation = await repository.getOrganization(organisationId);
        if (!organisation) throw NOT_FOUND();
      }
    }

    return { projectId, organisationId };
  }

  async function check(requiredKey, ctx, options) {
    const user = ctx?.user ?? null;
    if (!user?.userId) throw UNAUTHENTICATED();
    if (!requiredKey) {
      throw new ApiError('FUNCTION_REQUIRED', 'A permission key is required.', {
        status: 403,
        details: [{ allowed: false, function_key: null }],
      });
    }

    const scope = SYSTEM_KEYS.has(requiredKey)
      ? { projectId: null, organisationId: null }
      : await resolveScope(ctx, options);

    let decision;
    try {
      decision = await evaluator.evaluate({
        userId: user.userId,
        key: requiredKey,
        projectId: scope.projectId,
        organisationId: scope.organisationId,
      });
    } catch (cause) {
      logger?.error('rbac.guard_evaluator_error', { error: cause?.message, functionKey: requiredKey }, ctx?.correlationId ?? null);
      throw new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.', { status: 500 });
    }

    if (decision?.evaluationError) {
      // The evaluator failed closed. Report an outage, not a policy decision.
      throw new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.', {
        status: 500,
        details: [{ allowed: false, function_key: requiredKey }],
      });
    }

    const result = toResult(decision, requiredKey);
    if (!result.allowed) throw denialError(result);
    return result;
  }

  return {
    check,
    resolveScope,
    /** Middleware form: `require(key, options)` returns `(ctx) => Promise<result>`. */
    require(requiredKey, options) {
      return (ctx) => check(requiredKey, ctx, options);
    },
  };
}

function denialError(result) {
  const reason = result.reason ?? REASON.INSUFFICIENT_PERMISSION;
  const status = reason === REASON.UNAUTHENTICATED ? 401 : 403;
  return new ApiError(reason, messageFor(result), {
    status,
    details: [{ allowed: false, function_key: result.functionKey ?? null }],
  });
}
