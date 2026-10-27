import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, LlmError, normalizeProviderError, redactDeep } from '../errors.js';
import { createLlmProvider, createOpenAiCompatibleProvider, createProviderFromConfig } from '../provider.js';

test('a malformed provider response is normalized, never passed through', async () => {
  const provider = createLlmProvider({ name: 'test', complete: async () => ({ choices: 'nope' }) });
  await assert.rejects(provider.complete({ messages: [] }), (error) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'LLM_PROVIDER_ERROR');
    assert.equal(error.status, 502);
    return true;
  });
});

test('only allow-listed model options are forwarded', async () => {
  let seen = null;
  const provider = createLlmProvider({
    name: 'test',
    modelOptions: ['temperature'],
    complete: async (args) => {
      seen = args.modelOptions;
      return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
    },
  });
  await provider.complete({ messages: [], modelOptions: { temperature: 0.2, api_key: 'leak', tools: [] } });
  assert.deepEqual(seen, { temperature: 0.2 });
});

test('a connection failure is retried, a provider response is not', async () => {
  let attempts = 0;
  const flaky = createLlmProvider({
    name: 'test',
    complete: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
      return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
    },
  });
  const response = await flaky.complete({ messages: [] });
  assert.equal(attempts, 2);
  assert.equal(response.choices[0].message.content, 'ok');

  let billed = 0;
  const failing = createLlmProvider({
    name: 'test',
    complete: async () => {
      billed += 1;
      throw Object.assign(new Error('upstream'), { status: 502 });
    },
  });
  await assert.rejects(failing.complete({ messages: [] }), (error) => error.code === 'LLM_PROVIDER_ERROR');
  assert.equal(billed, 1, 'a provider response is never retried');
});

test('provider errors map to codes, including cancellation and timeout', () => {
  assert.equal(normalizeProviderError(Object.assign(new Error('x'), { name: 'AbortError' })).status, 499);
  assert.equal(normalizeProviderError(Object.assign(new Error('x'), { code: 'LLM_TIMEOUT' })).status, 504);
  assert.equal(normalizeProviderError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).retryable, true);
  assert.equal(normalizeProviderError(Object.assign(new Error('x'), { status: 429 })).code, 'LLM_RATE_LIMITED');
  assert.equal(normalizeProviderError(Object.assign(new Error('x'), { status: 503 })).code, 'LLM_PROVIDER_ERROR');
});

test('a connection failure wrapped by fetch is still recognized as retryable', () => {
  // Node's fetch reports a refused connection as a TypeError whose cause is an
  // AggregateError of per-address failures, so the plain `cause.code` lookup
  // would misread it as a provider response and refuse to retry.
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })], 'All promises were rejected'),
  });
  const normalized = normalizeProviderError(refused);
  assert.equal(normalized.code, 'LLM_UNREACHABLE');
  assert.equal(normalized.status, 503);
  assert.equal(normalized.retryable, true);
  assert.deepEqual(normalized.details, [{ cause: 'ECONNREFUSED' }]);
});

test('a 429 keeps what the gateway said, including the interval it named', () => {
  // The turn path threw the body away, so an operator saw "The provider is rate limiting" with
  // no interval and no reason — which reads the same for a burst limit, an exhausted quota, and
  // a model with no deployment available. The gateway's own sentence is the only thing that
  // says which it was, and how long it asked us to wait.
  const body = JSON.stringify({ error: { message: 'Rate limit exceeded for api_key: demo. Try again in 5 seconds' } });
  const normalized = normalizeProviderError(Object.assign(new Error('provider request failed'), { status: 429, body }));

  assert.equal(normalized.code, 'LLM_RATE_LIMITED');
  assert.equal(normalized.status, 429);
  assert.match(normalized.details[0].provider_message, /Try again in 5 seconds/);
  assert.equal(normalized.details[0].retry_after_ms, 5500, 'the interval it named, plus the half-second the probe adds');
});

test('a 429 with no usable body still normalizes, and names no interval', () => {
  for (const body of [undefined, '', '<html>gateway</html>', '{}']) {
    const normalized = normalizeProviderError(Object.assign(new Error('x'), { status: 429, body }));
    assert.equal(normalized.code, 'LLM_RATE_LIMITED');
    assert.equal(normalized.details[0].retry_after_ms, null, `no interval is invented for ${JSON.stringify(body)}`);
  }
  // A gateway that answers with prose still gets its sentence read.
  const prose = normalizeProviderError(Object.assign(new Error('x'), { status: 429, body: 'No deployments available for selected model. Try again in 5 seconds' }));
  assert.match(prose.details[0].provider_message, /No deployments available/);
  assert.equal(prose.details[0].retry_after_ms, 5500);
});

test('credentials are redacted from values and nested structures', () => {
  const redact = createRedactor(['sk-super-secret', 'abc']);
  assert.equal(redact('the key sk-super-secret leaked'), 'the key [redacted] leaked');
  assert.equal(redact('abc'), 'abc', 'a value below the minimum length is not treated as a secret');
  assert.deepEqual(redactDeep({ message: 'sk-super-secret', ok: 1 }, redact), { message: '[redacted]', ok: 1 });
});

test('the OpenAI-compatible adapter shapes the request and parses the response', async () => {
  let captured = null;
  const provider = createOpenAiCompatibleProvider({
    endpoint: 'https://llm.test/v1/chat/completions',
    apiKey: 'sk-key',
    model: 'gpt-test',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
        },
      };
    },
  });

  const response = await provider.complete({ messages: [{ role: 'user', content: 'hello' }], tools: [], modelOptions: { temperature: 0 } });
  assert.equal(captured.url, 'https://llm.test/v1/chat/completions');
  assert.equal(captured.options.headers.authorization, 'Bearer sk-key');
  assert.equal(captured.body.model, 'gpt-test');
  assert.equal(captured.body.messages[0].content, 'hello');
  assert.equal(response.usage.total_tokens, 5);
});

test('a per-call model overrides the configured one', async () => {
  // The regression this guards: `createLlmProvider` resolved `args.model ?? configured` and
  // handed it to the adapter, but the adapter read the closure's model instead — so a
  // per-turn choice was computed and then silently discarded, and every turn ran the
  // deployment's default however the caller asked.
  let captured = null;
  const provider = createOpenAiCompatibleProvider({
    endpoint: 'https://llm.test/v1/chat/completions',
    apiKey: 'sk-key',
    model: 'configured-model',
    fetchImpl: async (url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { choices: [{ message: { role: 'assistant', content: 'hi' } }] }; } };
    },
  });

  await provider.complete({ messages: [{ role: 'user', content: 'hello' }], model: 'chosen-model' });
  assert.equal(captured.model, 'chosen-model', 'the call names the model that answers');

  // Omitting it must still fall back to the configured model, or a deployment with no menu
  // would send `undefined` and the gateway would choose instead of the deployment.
  await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(captured.model, 'configured-model', 'no choice means the configured model');
});

test('an upstream HTTP failure becomes a normalized error with a status', async () => {
  const provider = createOpenAiCompatibleProvider({
    endpoint: 'https://llm.test/v1/chat/completions',
    apiKey: 'sk-key',
    model: 'gpt-test',
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'slow down' }),
  });
  await assert.rejects(provider.complete({ messages: [] }), (error) => {
    assert.equal(error.code, 'LLM_RATE_LIMITED');
    assert.equal(error.status, 429);
    return true;
  });
});

test('provider construction refuses an unknown or unconfigured provider', async () => {
  assert.throws(() => createProviderFromConfig({ config: { llmProvider: 'nope' } }), (error) => error.code === 'LLM_PROVIDER_UNSUPPORTED');
  assert.throws(() => createProviderFromConfig({ config: { llmProvider: 'openai-compatible' } }), (error) => error.status === 500);
  assert.throws(
    () => createProviderFromConfig({ config: { llmProvider: 'openai-compatible', llmEndpoint: 'https://x', llmApiKeySecret: 'KEY' } }),
    (error) => error.status === 503,
  );

  const factory = createProviderFromConfig({
    config: { llmProvider: 'openai-compatible', llmEndpoint: 'https://x', llmModel: 'm', llmApiKeySecret: 'KEY' },
    secrets: { async get() { return 'sk-resolved'; } },
  });
  const provider = await factory.build();
  assert.equal(provider.name, 'openai-compatible');
});
