import { createGuide, createContextResolver, createExecutionContext } from './context.js';
import { createUiActionRegistry, createToolRegistry, defineSurface } from './registry.js';
import { createOrchestrator } from './orchestrator.js';
import { createSessionService } from './sessions.js';
import { createAuditService, createUsageService } from './usage.js';

export { LlmError, createRedactor, normalizeProviderError, redactDeep } from './errors.js';
export { DEFAULT_MODEL_OPTIONS, createLlmProvider, createOpenAiCompatibleProvider, createProviderFromConfig } from './provider.js';
export {
  createToolRegistry,
  createUiActionRegistry,
  defineCapability,
  defineSurface,
} from './registry.js';
export { DEFAULT_DIGEST_BYTES, DEFAULT_RESULT_BYTES, SHRINK_PROFILES, boundValue, byteLength, sanitize } from './bounding.js';
export { collectEntities, indexEntities, rewriteReply } from './entity-references.js';
export { BASE_PROMPT, composeSystemPrompt } from './prompt.js';
export { createContextResolver, createExecutionContext, createGuide } from './context.js';
export { DEFAULT_LIMITS, createOrchestrator, emptyUsage, normalizeUsage } from './orchestrator.js';
export { createSessionService } from './sessions.js';
export { createAuditService, createUsageService } from './usage.js';

/**
 * The surfaces and guides the host knows at startup.
 *
 * The catalogue is generic: the tool packages own their projections and inject the
 * descriptors and the guide, so this module never imports a tool package (that would
 * be the cycle the projection boundary exists to avoid). With no injection it falls
 * back to the minimal W6 declaration — one facility surface with no capabilities —
 * so an un-wired deployment still resolves the context and refuses every tool.
 */
export function createDefaultCatalog({ capabilities = [], uiActions = [], guide = null } = {}) {
  const surfaces = [defineSurface({ key: 'site_facility', version: 1, digest: null, capabilities })];
  const guides = [guide ?? createGuide({
    key: 'site-facility-guide',
    version: 1,
    surface: 'site_facility',
    requiredEntryFunctions: ['facility.read'],
    instructions: [
      'Answer questions about the active project, scenario, and revision.',
      'Ground every answer in tool results, never in the surface declaration alone.',
    ],
    operatingPrinciples: [
      'Report capability coverage exactly as returned: NOT_PROVIDED, PROVISIONAL, or VALIDATED.',
      'Never describe a NOT_PROVIDED capability as feasible.',
    ],
    workflow: ['Read before proposing a change.', 'Name the revision and the entities an answer relies on.'],
    stateSignals: ['lifecycle_state is DRAFT, VALIDATED, or PUBLISHED.', 'A draft is editable; a validated or published revision is immutable.'],
    guardrails: [
      'Never claim a validation, publish, allocation, waiver, or write succeeded without a successful tool result in the same turn.',
      'Never invent a constraint identifier; use the catalog identifiers only.',
      'Never reveal credentials, object-store keys, or internal identifiers in prose.',
    ],
  })];
  return { surfaces, guides, capabilities, uiActions };
}

/**
 * Assembles the host. Tools and UI actions are injected, so a tool package adds
 * capabilities without the host changing.
 */
export function createAssistantHost({
  provider,
  pool = null,
  storage = null,
  surfaces = [],
  guides = [],
  capabilities = [],
  uiActions = [],
  resolveScope,
  authorize = async () => true,
  buildDigest = null,
  limits = {},
  logger = null,
  redact = (value) => value,
  now = () => new Date(),
} = {}) {
  const toolRegistry = createToolRegistry({ capabilities });
  const uiActionRegistry = createUiActionRegistry({ actions: uiActions });
  const contextResolver = createContextResolver({ surfaces, guides, resolveScope });
  const sessionService = storage ? createSessionService({ pool, storage, now }) : null;
  const usageService = pool ? createUsageService({ pool, limits: limits.quota ?? {}, now }) : null;
  const auditService = createAuditService({ logger });

  const orchestrator = createOrchestrator({
    provider,
    toolRegistry,
    uiActionRegistry,
    contextResolver,
    authorize,
    sessionService,
    usageService,
    auditService,
    buildDigest,
    limits,
    logger,
    redact,
    now,
  });

  return { orchestrator, toolRegistry, uiActionRegistry, contextResolver, sessionService, usageService, auditService };
}
