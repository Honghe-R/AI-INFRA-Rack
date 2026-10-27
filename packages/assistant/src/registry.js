import { LlmError } from './errors.js';

/**
 * Surfaces, capabilities, the in-process MCP host, and UI actions
 * (chatbox blueprint §4.4 and §4.6).
 *
 * A capability is declared once here and adapted for the model. Selection is an
 * authorization boundary: a tool is offered only when the active surface scopes
 * it, the scope is not read-only for a write, and **every** required permission is
 * authorized. `describe()` strips the handler, so executable code never reaches
 * the prompt or the wire.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_ACTIONS = 50;

export function defineSurface({ key, version = 1, digest = null, capabilities = [] }) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('A surface requires a key.');
  return Object.freeze({ key, version, digest, capabilities: Object.freeze([...capabilities]) });
}

export function defineCapability(descriptor) {
  const access = descriptor.access ?? 'read';
  if (!IDENTIFIER.test(descriptor.name ?? '')) throw new Error(`Invalid capability name "${descriptor.name}".`);
  if (!['read', 'write'].includes(access)) throw new Error(`Capability "${descriptor.name}" has an invalid access mode.`);
  if (typeof descriptor.handler !== 'function') throw new Error(`Capability "${descriptor.name}" needs a handler.`);
  if (!descriptor.inputSchema || descriptor.inputSchema.type !== 'object') {
    throw new Error(`Capability "${descriptor.name}" needs an object inputSchema.`);
  }
  const confirmation = descriptor.confirmation ?? (access === 'write' ? 'required' : 'none');
  if (!['none', 'required'].includes(confirmation)) throw new Error(`Capability "${descriptor.name}" has an invalid confirmation.`);
  // `null` is how a capability that has neither hook spells "none", and the registry re-defines
  // capabilities that arrive already defined — so absence and an explicit null are the same thing.
  if (descriptor.describe != null && typeof descriptor.describe !== 'function') {
    throw new Error(`Capability "${descriptor.name}" has a describe that is not a function.`);
  }
  if (descriptor.confirmable != null && typeof descriptor.confirmable !== 'function') {
    throw new Error(`Capability "${descriptor.name}" has a confirmable that is not a function.`);
  }
  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description ?? '',
    inputSchema: descriptor.inputSchema,
    handler: descriptor.handler,
    access,
    surfaces: Object.freeze([...(descriptor.surfaces ?? [])]),
    requiredFunctions: Object.freeze([...(descriptor.requiredFunctions ?? [])]),
    confirmation,
    /**
     * The call in a person's words, for the card that asks them to allow it.
     *
     * The gate hands the client `{ toolName, arguments }`, and a card built from those shows a
     * function name and a JSON blob: the reader is asked to approve something they cannot read,
     * about an object named by a uuid. Only the surface knows what its arguments mean and what
     * the objects are called, so only the surface can say it. Optional, and a description that
     * throws costs the card its sentence and nothing else — never the confirmation.
     */
    describe: descriptor.describe ?? null,
    /**
     * Whether asking is still worth it, checked at the moment the gate would ask.
     *
     * A confirmation is offered at one time and answered at another, and a write conditioned on
     * the draft it was prepared against can stop being executable in between — the very write the
     * reader confirmed a moment ago moves that draft. The gate is before the handler, so the
     * handler's precondition is not reached and the reader is handed a button that cannot work;
     * they press it, it fails, the model re-reads and proposes again, and the same thing happens.
     * A capability that can tell says so here and throws, and the refusal is answered in the
     * transcript like any other, so the model corrects itself instead of the reader retrying.
     */
    confirmable: descriptor.confirmable ?? null,
  });
}

export function createToolRegistry({ capabilities = [] } = {}) {
  const byName = new Map();
  for (const raw of capabilities) {
    const capability = raw.handler ? defineCapability(raw) : raw;
    if (byName.has(capability.name)) throw new Error(`Duplicate capability "${capability.name}".`);
    byName.set(capability.name, capability);
  }

  function describe() {
    return [...byName.values()]
      .map((capability) => ({
        name: capability.name,
        description: capability.description,
        inputSchema: capability.inputSchema,
        access: capability.access,
        surfaces: [...capability.surfaces],
        requiredFunctions: [...capability.requiredFunctions],
        confirmation: capability.confirmation,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Selection order is the authorization boundary. `authorize` is
   * `async (permissionKey) => boolean`.
   */
  async function select({ surfaceKey = null, readOnly = false, authorize = async () => true } = {}) {
    const selected = [];
    for (const capability of byName.values()) {
      if (capability.surfaces.length > 0 && !capability.surfaces.includes(surfaceKey)) continue;
      if (readOnly && capability.access === 'write') continue;
      let allowed = true;
      for (const key of capability.requiredFunctions) {
        // Any denial drops the tool entirely; partial visibility is not a thing.
        if (!(await authorize(key))) {
          allowed = false;
          break;
        }
      }
      if (allowed) selected.push(capability);
    }
    return selected.sort((left, right) => left.name.localeCompare(right.name));
  }

  function modelTools(selected) {
    return selected.map((capability) => ({
      type: 'function',
      function: {
        name: capability.name,
        description: capability.description,
        parameters: capability.inputSchema,
      },
    }));
  }

  function validateCall({ name, args, selected, executionContext }) {
    const capability = selected.find((candidate) => candidate.name === name);
    if (!capability) {
      // The tool may be known but not selected. Both are refusals, never a call.
      throw new LlmError('ASSISTANT_TOOL_NOT_SELECTED', `Tool "${name}" is not available in this context.`, { status: 403 });
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new LlmError('ASSISTANT_TOOL_ARGUMENTS_INVALID', `Tool "${name}" requires an object of arguments.`, { status: 400 });
    }
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) {
      throw new LlmError('ASSISTANT_TOOL_ARGUMENTS_INVALID', `Tool "${name}" arguments exceed the size cap.`, { status: 400 });
    }
    for (const required of capability.inputSchema.required ?? []) {
      if (args[required] === undefined) {
        throw new LlmError('ASSISTANT_TOOL_ARGUMENTS_INVALID', `Tool "${name}" is missing "${required}".`, { status: 400 });
      }
    }
    // A scope identifier in the arguments must match the resolved context.
    for (const [field, expected] of [
      ['workspaceId', executionContext?.workspaceId],
      ['organisationId', executionContext?.organisationId],
    ]) {
      if (args[field] !== undefined && expected !== undefined && args[field] !== expected) {
        throw new LlmError('ASSISTANT_SCOPE_MISMATCH', `Tool "${name}" named a different ${field}.`, { status: 403 });
      }
    }
    return capability;
  }

  /**
   * The in-process MCP host. It re-checks that the name was selected and that the
   * execution context is valid before calling the handler, so a caller that
   * bypasses the loop still cannot reach a tool it was not offered.
   */
  function createHost({ selected, executionContext }) {
    if (!executionContext?.principal?.type || !executionContext?.initiatedBy?.userId) {
      throw new LlmError('ASSISTANT_CONTEXT_INVALID', 'An execution context is required.', { status: 500 });
    }
    const names = new Set(selected.map((capability) => capability.name));
    return {
      listTools: () => modelTools(selected),
      async callTool({ name, arguments: args, confirmed = false }) {
        const capability = validateCall({ name, args, selected, executionContext });
        if (capability.confirmation === 'required' && !confirmed) {
          // Asked before the card is drawn: a call that can no longer be carried out is refused
          // now, in the transcript, rather than offered and then failed in the reader's face.
          if (capability.confirmable) await capability.confirmable({ ...executionContext, toolName: capability.name }, args);
          return {
            confirmationRequired: true,
            toolName: capability.name,
            arguments: args,
            // A description is a courtesy and never a precondition: a surface that cannot name
            // its own entities still gets a working confirmation, it just gets a plainer card.
            summary: await describeCall(capability, { ...executionContext, toolName: capability.name }, args),
          };
        }
        const result = await capability.handler({ ...executionContext, toolName: capability.name }, args);
        return { result };
      },
      has: (name) => names.has(name),
    };
  }

  return { describe, select, modelTools, validateCall, createHost, get: (name) => byName.get(name) ?? null, names: () => [...byName.keys()] };
}

/**
 * The call in a person's words, or null.
 *
 * Never throws. A card without a sentence is a worse card; a card that cannot be drawn because
 * its description failed is a write the reader cannot approve at all, which is worse still.
 */
async function describeCall(capability, executionContext, args) {
  if (!capability.describe) return null;
  try {
    const summary = await capability.describe(executionContext, args);
    return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
  } catch {
    return null;
  }
}

/**
 * UI actions: a mirrored registry on each side of the wire. The server validates
 * and normalizes; it never runs a browser effect.
 */
export function createUiActionRegistry({ actions = [] } = {}) {
  const byType = new Map();
  for (const action of actions) {
    if (typeof action.type !== 'string' || action.type.length === 0) throw new Error('A UI action requires a type.');
    if (!Number.isInteger(action.version) || action.version < 1) throw new Error(`UI action "${action.type}" needs an integer version.`);
    const key = `${action.type}@${action.version}`;
    if (byType.has(key)) throw new Error(`Duplicate UI action "${key}".`);
    byType.set(key, Object.freeze({
      type: action.type,
      version: action.version,
      surfaces: Object.freeze([...(action.surfaces ?? [])]),
      description: action.description ?? '',
      inputSchema: action.inputSchema ?? { type: 'object' },
      confirmation: action.confirmation ?? 'none',
    }));
  }

  function describe({ surfaceKey = null } = {}) {
    return [...byType.values()]
      .filter((action) => action.surfaces.length === 0 || action.surfaces.includes(surfaceKey))
      .map((action) => ({
        type: action.type,
        version: action.version,
        description: action.description,
        inputSchema: action.inputSchema,
        confirmation: action.confirmation,
      }))
      .sort((left, right) => `${left.type}@${left.version}`.localeCompare(`${right.type}@${right.version}`));
  }

  /** Validates one requested action and returns a frozen envelope, or throws. */
  function normalize(request, id) {
    const { type, version, payload = {}, context = {} } = splitIdentity(request);
    const action = byType.get(`${type}@${version}`);
    if (!action) throw new LlmError('ASSISTANT_ACTION_UNKNOWN', `Unknown UI action ${describeIdentity(type, version)}.`, { status: 400 });
    if (context.surface && action.surfaces.length > 0 && !action.surfaces.includes(context.surface)) {
      throw new LlmError('ASSISTANT_ACTION_UNKNOWN', `UI action ${describeIdentity(type, version)} does not apply to this surface.`, { status: 400 });
    }
    for (const required of action.inputSchema.required ?? []) {
      if (payload[required] === undefined) {
        // What it received is the whole diagnostic: `missing "entity_id"` alone does not say
        // whether the model omitted the field or called it something else, and it did call it
        // something else — `name`, `entityName`, and once both beside `type`.
        const received = Object.keys(payload);
        const hint = received.length > 0 ? ` It received ${received.map((name) => `"${name}"`).join(', ')}.` : '';
        throw new LlmError('ASSISTANT_ACTION_INVALID', `UI action ${describeIdentity(type, version)} is missing "${required}".${hint}`, {
          status: 400,
          details: [{ expected: [...(action.inputSchema.required ?? [])], received }],
        });
      }
    }
    return Object.freeze({
      id: id ?? `${type}-${Math.random().toString(36).slice(2, 10)}`,
      type: action.type,
      version: action.version,
      context: Object.freeze({
        surface: context.surface ?? null,
        contextKey: context.contextKey ?? null,
        workspaceId: context.workspaceId ?? null,
      }),
      payload: Object.freeze({ ...payload }),
      confirmation: action.confirmation,
    });
  }

  /** Extracts and validates the allow-listed actions from a model envelope. */
  function extract(requested = [], context = {}) {
    if (!Array.isArray(requested)) return [];
    return requested.slice(0, MAX_ACTIONS).map((item) => normalize({ ...item, context }, undefined));
  }

  return { describe, normalize, extract, get: (type, version) => byType.get(`${type}@${version}`) ?? null, size: () => byType.size };
}

/**
 * Reads the identity as the model stated it.
 *
 * The prompt tells the model the actions as `type@version`, and a model that copies that name
 * whole into `type` has stated the same fact in one field — the version is in the string. The
 * action is well-formed; only the spelling is not, and dropping a highlight over punctuation
 * helps no one. An identity that is neither spelling is left alone to be refused as it stands.
 */
function splitIdentity(request = {}) {
  const { type, version } = request;
  if (version === undefined && typeof type === 'string') {
    const match = /^([^@]+)@(\d+)$/.exec(type.trim());
    if (match) return { ...request, type: match[1], version: Number(match[2]) };
  }
  return request;
}

/**
 * A UI action's identity for a message a person will read.
 *
 * `type@undefined` is what a naive join produces for the one spelling above, and it names
 * nothing: a missing version is simply not printed.
 */
function describeIdentity(type, version) {
  const name = typeof type === 'string' && type.length > 0 ? type : 'unknown';
  return version === undefined || version === null ? `"${name}"` : `"${name}@${version}"`;
}
