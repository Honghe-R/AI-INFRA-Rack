import { LlmError, normalizeProviderError } from './errors.js';

/**
 * The provider abstraction.
 *
 * The server owns provider selection: a request payload never chooses one
 * (chatbox blueprint §4.2). The generic wrapper validates the response shape,
 * forwards only an allow-listed set of model options, and retries **only**
 * failures that prove the request never reached the provider — a timeout or any
 * provider response is never retried, because completions are not idempotent from
 * a billing standpoint.
 */
export const DEFAULT_MODEL_OPTIONS = Object.freeze(['temperature', 'max_tokens', 'top_p', 'stop', 'seed']);
const MAX_ATTEMPTS = 3;

export function createLlmProvider({
  name,
  complete,
  model = null,
  modelOptions = DEFAULT_MODEL_OPTIONS,
  timeoutMs = 60_000,
  logger = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('createLlmProvider requires a provider name.');
  if (typeof complete !== 'function') throw new Error('createLlmProvider requires a complete function.');

  const allowed = new Set(modelOptions);

  function pickModelOptions(options = {}) {
    const picked = {};
    for (const [key, value] of Object.entries(options ?? {})) {
      if (allowed.has(key)) picked[key] = value;
    }
    return picked;
  }

  async function attempt(args, attemptNumber) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'LLM_TIMEOUT' })), timeoutMs);
    const signal = args.signal
      ? AbortSignal.any([args.signal, controller.signal])
      : controller.signal;

    try {
      const response = await complete({
        ...args,
        model: args.model ?? model,
        modelOptions: pickModelOptions(args.modelOptions),
        signal,
      });
      if (!response || !Array.isArray(response.choices)) {
        throw new LlmError('LLM_PROVIDER_ERROR', 'The provider returned a malformed response.', { status: 502, provider: name });
      }
      return response;
    } catch (error) {
      const normalized = normalizeProviderError(error, { provider: name });
      const canRetry = normalized.retryable && attemptNumber < MAX_ATTEMPTS && !args.signal?.aborted;
      if (!canRetry) throw normalized;
      const backoff = Math.min(250 * 2 ** (attemptNumber - 1), 2_000) + Math.floor(Math.random() * 100);
      logger?.warn?.('assistant.provider_retry', { provider: name, attempt: attemptNumber, backoff_ms: backoff });
      await new Promise((resolve) => setTimeout(resolve, backoff));
      return attempt(args, attemptNumber + 1);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name,
    model,
    async complete(args = {}) {
      if (typeof args.complete === 'function') return args.complete(args);
      return attempt(args, 1);
    },
  };
}

/**
 * An OpenAI-compatible chat-completions provider. It is the only vendor adapter
 * in R1; a deployment points `endpoint` at a compatible gateway, and the key is
 * read from the secret manager, never from a request.
 */
export function createOpenAiCompatibleProvider({
  endpoint,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  name = 'openai-compatible',
} = {}) {
  if (!endpoint) throw new Error('createOpenAiCompatibleProvider requires an endpoint.');

  return createLlmProvider({
    name,
    model,
    fetchImpl,
    timeoutMs,
    async complete({ messages, tools, model, modelOptions = {}, signal }) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          // `model` here is the *call's* model: `createLlmProvider` resolves
          // `args.model ?? configured` and hands the result down. Reading the closure's
          // model instead silently discarded a per-turn choice, which is why this is
          // destructured rather than left to the surrounding scope.
          model,
          messages,
          ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
          ...modelOptions,
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw Object.assign(new Error('provider request failed'), { status: response.status, body });
      }
      return response.json();
    },
  });
}

/** Reads deployment configuration and constructs the configured provider. */
export function createProviderFromConfig({ config = {}, secrets = null } = {}) {
  const providerName = config.llmProvider ?? 'openai-compatible';
  if (providerName !== 'openai-compatible') {
    throw new LlmError('LLM_PROVIDER_UNSUPPORTED', `Unknown provider "${providerName}".`, { status: 500, provider: providerName });
  }
  if (!config.llmEndpoint) {
    throw new LlmError('LLM_PROVIDER_UNSUPPORTED', 'No provider endpoint is configured.', { status: 500, provider: providerName });
  }
  if ((!config.llmApiKeySecret || !secrets) && !config.llmAllowNoKey) {
    throw new LlmError('LLM_PROVIDER_UNSUPPORTED', 'No provider credential is configured.', { status: 503, provider: providerName });
  }

  return {
    providerName,
    async build() {
      const apiKey = config.llmApiKeySecret && secrets ? await secrets.get(config.llmApiKeySecret) : null;
      if (config.llmApiKeySecret && !apiKey) {
        throw new LlmError('LLM_PROVIDER_UNSUPPORTED', 'The provider credential could not be resolved.', { status: 503, provider: providerName });
      }
      return createOpenAiCompatibleProvider({ endpoint: config.llmEndpoint, apiKey, model: config.llmModel, timeoutMs: config.llmTimeoutMs, name: providerName });
    },
  };
}
