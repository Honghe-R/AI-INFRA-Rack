import { ApiError } from '@ai-infra/core';
import { withTenant } from '@ai-infra/db';
import { boundResult } from './bounds.js';
import { validateArguments } from './schema.js';

/**
 * The tool registry and its execution contract.
 *
 * A tool is a descriptor plus a handler. The descriptor is what a model or an
 * integration client may see; the handler is what actually touches a store. They
 * are separated so that `describe()` can never leak executable code into a prompt
 * or a wire payload.
 *
 * `execute` is the single choke point every caller passes through — HTTP route,
 * assistant host, worker, or integration — which is what makes the contract
 * hold once rather than once per transport:
 *
 *   * arguments are validated before the handler runs;
 *   * context identity is verified, and a mismatch is a 403, never a rewrite;
 *   * every `requiredFunctions` key is authorized here (the handler re-assertion);
 *   * read-only scope refuses a write;
 *   * the revision is opened under the tenant GUC, so row-level security applies;
 *   * the result is bounded and its truncation is reported;
 *   * one credential-free audit record is emitted per call.
 */

export const SURFACE_KEY = 'facility';
export const TOOL_SURFACE_VERSION = '1';

const AXES = Object.freeze(['STATE', 'RULE', 'COMPUTATION', 'PROVENANCE', 'IMPACT', 'ACTION']);
const ACCESS = Object.freeze(['read', 'write']);

export function defineTool(spec) {
  const {
    name,
    version = 1,
    axis,
    access,
    description,
    stores = [],
    evidence = [],
    remediation = [],
    requiredFunctions = [],
    entryFunctions = null,
    possibleFunctions = null,
    confirmation = 'none',
    input = {},
    requiresRevision = true,
    tenantScoped = true,
    handler,
  } = spec;

  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`A tool needs a snake_case name, got "${name}".`);
  if (!AXES.includes(axis)) throw new Error(`Tool "${name}" declares an unknown axis "${axis}".`);
  if (!ACCESS.includes(access)) throw new Error(`Tool "${name}" declares an unknown access "${access}".`);
  if (typeof handler !== 'function') throw new Error(`Tool "${name}" has no handler.`);
  if (!description) throw new Error(`Tool "${name}" has no description.`);
  if (access === 'write' && confirmation !== 'required') {
    throw new Error(`Write tool "${name}" must declare confirmation: required.`);
  }

  // A tool whose requirement depends on its arguments — a change set needs the union
  // of its change kinds' keys — must say what may be required and what is required to
  // be offered it at all, because selection happens before any arguments exist.
  const dynamicPermissions = typeof requiredFunctions === 'function';
  if (dynamicPermissions && (!Array.isArray(entryFunctions) || !Array.isArray(possibleFunctions))) {
    throw new Error(`Tool "${name}" computes its permissions from arguments, so it must declare entryFunctions and possibleFunctions.`);
  }

  const entry = entryFunctions ?? (dynamicPermissions ? [] : requiredFunctions);
  const possible = possibleFunctions ?? (dynamicPermissions ? [] : requiredFunctions);

  return Object.freeze({
    name,
    version,
    axis,
    access,
    description,
    stores: Object.freeze([...stores]),
    evidence: Object.freeze([...evidence]),
    remediation: Object.freeze([...remediation]),
    requiredFunctions,
    entryFunctions: Object.freeze([...entry]),
    possibleFunctions: Object.freeze([...possible]),
    dynamicPermissions,
    confirmation,
    input: Object.freeze({ ...input }),
    requiresRevision,
    tenantScoped,
    handler,
  });
}

/**
 * The permission keys one call requires.
 *
 * Static for almost every tool; computed from the arguments for a tool whose
 * requirement is the union of what its input contains. The executor calls this, so a
 * dynamic tool keeps the single choke point rather than re-implementing authorization
 * inside its handler.
 */
export function requiredKeysFor(tool, args) {
  if (typeof tool.requiredFunctions === 'function') return tool.requiredFunctions(args ?? {}) ?? [];
  return tool.requiredFunctions;
}

export function createToolRegistry({ tools = [] } = {}) {
  const byName = new Map();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}".`);
    byName.set(tool.name, tool);
  }

  /**
   * The descriptor without its handler. This is the only shape that may reach a
   * prompt, a model, or a client.
   */
  function describe(tool) {
    return {
      name: tool.name,
      version: tool.version,
      axis: tool.axis,
      access: tool.access,
      description: tool.description,
      stores: [...tool.stores],
      evidence: [...tool.evidence],
      remediation: [...tool.remediation],
      required_functions: [...tool.entryFunctions],
      possible_required_functions: [...tool.possibleFunctions],
      dynamic_permissions: tool.dynamicPermissions,
      confirmation: tool.confirmation,
      input: { ...tool.input },
      surface: SURFACE_KEY,
    };
  }

  /**
   * The tools a caller may be offered: every entry key authorized, and no write in a
   * read-only scope. A tool is dropped entirely rather than partially masked.
   *
   * A dynamic-permission tool is offered on its entry keys and refuses a specific
   * call inside the handler on the keys that call actually needs. Offering it is not
   * a promise that every set is permitted — it is a promise that some are.
   */
  function select({ granted = null, readOnly = false } = {}) {
    const keys = granted instanceof Set ? granted : granted ? new Set(granted) : null;
    return [...byName.values()].filter((tool) => {
      if (readOnly && tool.access === 'write') return false;
      if (!keys) return true;
      return tool.entryFunctions.every((key) => keys.has(key));
    });
  }

  return {
    surface: SURFACE_KEY,
    version: TOOL_SURFACE_VERSION,
    list: () => [...byName.values()],
    get: (name) => byName.get(name) ?? null,
    describe: () => [...byName.values()].map(describe),
    describeOne: (name) => {
      const tool = byName.get(name);
      return tool ? describe(tool) : null;
    },
    select,
  };
}

/**
 * Builds the executor for a registry.
 *
 * `authorize` is the permission decision the caller already owns (the API's
 * permission guard, the assistant's authorizer); the surface does not invent a
 * second one, it just refuses to run without an answer.
 */
export function createToolExecutor({
  pool,
  registry,
  logger = null,
  authorize = null,
  onAudit = null,
  // The tenant-scoped execution seam. Production uses `withTenant` against the
  // pool; a test injects the client its fixture was seeded on, so a tool reads
  // uncommitted fixture data inside one rolled-back transaction.
  runInTenant = null,
} = {}) {
  if (!pool) throw new Error('The tool executor requires a database pool.');
  if (!registry) throw new Error('The tool executor requires a tool registry.');

  const inTenant = runInTenant ?? ((projectId, fn, options) => withTenant(pool, projectId, fn, options));

  async function authorizeAll({ tool, args, context }) {
    const keys = requiredKeysFor(tool, args);
    if (keys.length === 0) return;
    if (!authorize) {
      throw new ApiError('INSUFFICIENT_PERMISSION', 'No authorization decision is available.', {
        status: 403,
        details: keys.map((key) => ({ function_key: key, allowed: false })),
      });
    }
    const denials = [];
    for (const key of keys) {
      // Sequential rather than parallel: a decision is cached and cheap, and a
      // denial should report keys in declaration order.
      // eslint-disable-next-line no-await-in-loop
      const allowed = await authorize({ key, userId: context.userId ?? null, workspaceId: context.projectId ?? null });
      if (!allowed) denials.push({ function_key: key, allowed: false });
    }
    if (denials.length > 0) {
      throw new ApiError('INSUFFICIENT_PERMISSION', 'The caller is not permitted to perform this operation.', {
        status: 403,
        details: denials,
      });
    }
  }

  function checkContextIdentity({ tool, args, context }) {
    const mismatches = [];
    if (args.project_id && args.project_id !== context.projectId) mismatches.push({ field: 'project_id' });
    if (args.scenario_id && args.scenario_id !== context.scenarioId) mismatches.push({ field: 'scenario_id' });
    if (tool.requiresRevision && args.revision_id && args.revision_id !== context.revisionId) {
      mismatches.push({ field: 'revision_id' });
    }
    if (mismatches.length > 0) {
      throw new ApiError('CONTEXT_MISMATCH', 'The arguments name a different scope than the resolved context.', {
        status: 403,
        details: mismatches,
      });
    }
  }

  /**
   * Runs one tool. Every caller — HTTP route, assistant host, worker, integration
   * — goes through here, which is what makes the contract hold once.
   */
  async function execute({ name, args = {}, context = {} } = {}) {
    const started = Date.now();
    const tool = registry.get(name);
    if (!tool) {
      throw new ApiError('NOT_FOUND', 'No such tool on this surface.', {
        status: 404,
        details: [{ field: 'name', value: name }],
      });
    }

    let outcome = 'ok';
    let failure = null;
    try {
      if (context.readOnly === true && tool.access === 'write') {
        throw new ApiError('REVISION_IMMUTABLE', 'This scope is read-only; the operation is not available.', {
          status: 409,
          details: [{ field: 'name', value: name }],
        });
      }

      const value = validateArguments(tool.input, args);
      checkContextIdentity({ tool, args: value, context });
      await authorizeAll({ tool, args: value, context });

      // A confirmation-gated write admits no caller that has not confirmed this
      // call. The confirmation is a context fact rather than an argument, so a
      // model cannot supply it by inventing a parameter: only the caller that
      // actually asked the user can set it.
      if (tool.confirmation === 'required' && context.confirmed !== true) {
        throw new ApiError('CONFIRMATION_REQUIRED', 'This operation requires explicit confirmation.', {
          status: 409,
          details: [{ tool: tool.name, access: tool.access, arguments: value }],
        });
      }

      if (tool.requiresRevision && !context.revisionId) {
        throw new ApiError('VALIDATION_FAILED', 'This tool requires a revision in context.', {
          status: 400,
          details: [{ field: 'revision_id', reason: 'required' }],
        });
      }

      // A tenant-scoped tool opens the revision under the tenant GUC so
      // row-level security applies. A catalog or policy read touches no tenant
      // data and runs against the pool directly.
      const raw = tool.tenantScoped
        ? await inTenant(context.projectId, (client) => tool.handler({ client, args: value, context }), {
            readOnly: tool.access === 'read',
          })
        : await tool.handler({ client: pool, args: value, context });

      const bounded = boundResult(raw);
      if (bounded.truncated) outcome = 'degraded';
      return bounded.value;
    } catch (error) {
      outcome = 'failed';
      failure = error;
      throw error;
    } finally {
      if (onAudit) {
        try {
          onAudit({
            tool: tool.name,
            version: tool.version,
            access: tool.access,
            axis: tool.axis,
            principal: context.userId ?? null,
            project: context.projectId ?? null,
            scenario: context.scenarioId ?? null,
            revision: context.revisionId ?? null,
            correlation_id: context.correlationId ?? null,
            outcome,
            duration_ms: Date.now() - started,
          });
        } catch (error) {
          logger?.warn?.('tool.audit_failed', { tool: tool.name, error: error?.message });
        }
      }
      if (failure) logger?.debug?.('tool.failed', { tool: tool.name, error: failure.message });
    }
  }

  return {
    registry,
    execute,
    describeFor: (options) => registry.select(options).map((tool) => registry.describeOne(tool.name)),
  };
}

