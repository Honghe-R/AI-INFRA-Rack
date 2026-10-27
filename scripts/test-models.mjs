#!/usr/bin/env node
/**
 * Probe every model this deployment offers, at two levels.
 *
 * "The model did not work in the chatbox" conflates three failures that need different
 * answers, and a browser cannot tell them apart:
 *
 *   1. **The gateway or model is unreachable or broken.** Nothing the application does
 *      will help.
 *   2. **The model answers, but not in the shape the assistant requires.** The host asks
 *      for a JSON envelope; a model that replies in prose, or wraps its answer in a
 *      ` thinking` block, produces a turn that renders as raw text.
 *   3. **The model answers correctly, but too slowly for the turn budget.** The assistant
 *      sends its whole system prompt and tool catalogue on every turn — measured at roughly
 *      10k prompt tokens for a one-word reply — so a reasoning model pays for a 10k-token
 *      prefill before it starts thinking. A 60s `LLM_TIMEOUT_MS` can expire on a call that
 *      would have succeeded.
 *
 * So each model is called twice:
 *
 *   * **direct** — the gateway's own chat-completions endpoint with a few dozen tokens of
 *     prompt. This measures the model, and nothing else.
 *   * **assistant** — the deployment's `/assistant/chat`, with the same trivial question.
 *     This measures what the chatbox actually does, prompt cost included.
 *
 * The gap between the two columns is the assistant's prompt overhead, and the difference
 * between a failing direct call and a failing assistant call is which of the three
 * problems you have.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/test-models.mjs --project <uuid> [options]
 *
 *   --project <uuid>   the project the assistant turn is scoped to; omit to run only the
 *                      direct probe
 *   --scenario <uuid>  and its scenario and revision. The chatbox sends all three, and a
 *   --revision <uuid>  turn without them is not the turn the chatbox makes: the model is
 *                      told the scope, so a tool that needs a revision id — and every
 *                      facility read does — has nothing to pass, calls it with a missing
 *                      argument, and fails validation. That failure is the probe's, not the
 *                      model's, which is why these are separate options rather than a
 *                      project id pretending to be a scope.
 *   --models a,b,c     override LLM_MODELS
 *   --base <url>       the API or edge to probe (default API_URL, then 127.0.0.1:8787)
 *   --timeout <ms>     per-request ceiling (default LLM_TIMEOUT_MS, then 120000)
 *   --direct-only      skip the assistant probe
 *   --delay <ms>       pause between requests (default 1500)
 *   --retries <n>      attempts per request on a 429 (default 3)
 *   --json             machine-readable output
 *
 * **The gateway rate-limits per API key**, and a probe that ignores that measures the
 * limit instead of the models: the first call succeeds and every later one answers 429,
 * which reads exactly like "every model but the first is broken". Every request therefore
 * waits `--delay` and a 429 is retried after the interval the gateway itself names
 * ("Try again in N seconds"). `deepseek-reasoner` answers 429 for a different reason — no
 * deployment is available for it at all — so the two are reported apart.
 */
import { SignJWT } from 'jose';
import { loadConfig } from '@ai-infra/core';
import { DEFAULT_DEV_SUBJECT } from './lib/dev-identities.mjs';

const config = loadConfig();

function parseArgs(argv) {
  const options = { models: null, project: null, scenario: null, revision: null, base: null, timeout: null, delay: null, retries: null, directOnly: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[(index += 1)];
    if (flag === '--project') options.project = value();
    else if (flag === '--scenario') options.scenario = value();
    else if (flag === '--revision') options.revision = value();
    else if (flag === '--models') options.models = value().split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--base') options.base = value();
    else if (flag === '--timeout') options.timeout = Number(value());
    else if (flag === '--direct-only') options.directOnly = true;
    else if (flag === '--delay') options.delay = Number(value());
    else if (flag === '--retries') options.retries = Number(value());
    else if (flag === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const interRequestDelayMs = options.delay ?? 1500;
const maxAttempts = (options.retries ?? 3) + 1;
const models = options.models ?? config.llmModels ?? [];
const timeoutMs = options.timeout ?? config.llmTimeoutMs ?? 120_000;
const base = (options.base ?? process.env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

if (models.length === 0) {
  console.error('No models to probe. Set LLM_MODELS, or pass --models a,b,c.');
  process.exit(2);
}
if (!config.llmEndpoint) {
  console.error('LLM_ENDPOINT is not set, so the direct probe has nowhere to call.');
  process.exit(2);
}

/** The gateway credential, resolved through the same name the server uses. */
const apiKey = config.llmApiKeySecret ? process.env[config.llmApiKeySecret] ?? null : null;
if (!apiKey && !config.llmAllowNoKey) {
  console.error(`No credential: ${config.llmApiKeySecret ?? '(no LLM_API_KEY_SECRET)'} is not set in the environment.`);
  process.exit(2);
}

/**
 * A dev token, so the probe works against the API directly as well as through the edge.
 * The edge replaces this header with its own, so sending it is harmless either way.
 */
async function mintToken() {
  if (!config.authDevSecret) return null;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(process.env.AUTH_DEV_SUBJECT ?? DEFAULT_DEV_SUBJECT)
    .setIssuer(config.authIssuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(config.authDevSecret));
}

/**
 * One timed request. Never throws: a probe reports failures, and an exception would end the
 * run at the first slow model rather than showing which of them are slow.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The interval the gateway names in its 429, or null when it names none. */
function retryAfterMs(body, text) {
  const match = /try again in (\d+)\s*second/i.exec(body?.error?.message ?? text ?? '');
  return match ? Number(match[1]) * 1000 + 500 : null;
}

/**
 * One timed request, retried on a 429.
 *
 * `ms` is the time of the attempt that produced the reported result, so a model that
 * needed three tries is not credited with the two waits. Never throws: a probe reports
 * failures, and an exception would end the run at the first slow model rather than showing
 * which of them are slow.
 */
async function timed(label, url, init) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Left null; the caller reports the status and the head of the body.
      }
      last = { label, ms: Date.now() - started, status: response.status, body, raw: text.slice(0, 160), attempts: attempt };
    } catch (error) {
      const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return {
        label,
        ms: Date.now() - started,
        status: aborted ? `timeout>${timeoutMs}ms` : 'failed',
        body: null,
        raw: error?.message ?? String(error),
        attempts: attempt,
      };
    }

    if (last.status !== 429 || attempt === maxAttempts) return last;
    // Back off for as long as the gateway asked; the interval it names is authoritative,
    // and guessing a shorter one just spends another attempt.
    await sleep(retryAfterMs(last.body, last.raw) ?? 5000 * attempt);
  }
  return last;
}

/** The direct probe: the model alone, with a prompt small enough to be free of overhead. */
async function probeDirect(model) {
  const result = await timed('direct', config.llmEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 32,
      stream: false,
    }),
  });

  const message = result.body?.choices?.[0]?.message ?? null;
  const usage = result.body?.usage ?? null;
  // A reasoning model returns its thinking in `reasoning_content`; it is worth reporting,
  // because it is the field the assistant's envelope parser does not read.
  const reasoning = Boolean(message?.reasoning_content) || /<think/i.test(message?.content ?? '');

  return {
    ...result,
    ok: result.status === 200 && Boolean(message),
    content: (message?.content ?? '').trim(),
    reasoning,
    completionTokens: usage?.completion_tokens ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
  };
}

/** The assistant probe: the same question through the turn the chatbox sends. */
async function probeAssistant(model, token) {
  const result = await timed('assistant', `${base}/api/v1/assistant/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      context_key: `model-probe|${model}`,
      context: {
        surface: 'site_facility',
        projectId: options.project,
        ...(options.scenario ? { scenarioId: options.scenario } : {}),
        ...(options.revision ? { revisionId: options.revision } : {}),
      },
      model,
    }),
  });

  const data = result.body?.data ?? null;
  const message = data?.choices?.[0]?.message ?? null;
  // The host parses the model's JSON envelope; `structured_content` exists only when that
  // parse succeeded. Its absence is the difference between a reply and a wall of JSON.
  const parsed = Boolean(message?.structured_content);
  return {
    ...result,
    ok: result.status === 200 && parsed,
    parsed,
    status_: data?.status ?? null,
    content: (message?.content ?? '').trim(),
    promptTokens: data?.usage?.prompt_tokens ?? null,
    completionTokens: data?.usage?.completion_tokens ?? null,
    error: result.body?.error?.code ?? null,
    // The reason, not just the code. A model that calls a tool without a required
    // argument fails validation, and `VALIDATION_FAILED` alone reads like a bad request
    // from the probe rather than a model that cannot fill in the arguments.
    detail: result.body?.error?.details?.[0]
      ? `${result.body.error.details[0].field ?? '?'}: ${result.body.error.details[0].reason ?? '?'}`
      : null,
    message: result.body?.error?.message ?? null,
  };
}

const pad = (value, width) => String(value ?? '—').padEnd(width);
const padStart = (value, width) => String(value ?? '—').padStart(width);

async function main() {
  const token = await mintToken();

  if (!options.json) {
    console.log(`endpoint   ${config.llmEndpoint}`);
    console.log(`api        ${base}`);
    console.log(`timeout    ${timeoutMs} ms per request`);
    console.log(`pacing     ${interRequestDelayMs} ms between requests, up to ${maxAttempts} attempt(s) each`);
    console.log(`models     ${models.join(', ')}`);
    if (!options.project && !options.directOnly) {
      console.log('\nNo --project given: running the direct probe only. Pass --project <uuid> to');
      console.log('also measure a full assistant turn.');
    }
    console.log('');
    console.log(
      pad('model', 20) + padStart('direct', 9) + padStart('status', 8) + padStart('tok', 6) + padStart('think', 7) +
      (options.project && !options.directOnly ? padStart('turn', 9) + padStart('http', 7) + padStart('env', 6) : ''),
    );
    console.log('-'.repeat(options.project && !options.directOnly ? 72 : 50));
  }

  const rows = [];
  // Sequential on purpose: models running concurrently would contend for the same gateway
  // and the same connection pool, and the latency column is the point of this script.
  for (const [index, model] of models.entries()) {
    // Spaced, so the run measures the models rather than the key's rate limit.
    if (index > 0) await sleep(interRequestDelayMs);
    const direct = await probeDirect(model);
    if (options.project && !options.directOnly) await sleep(interRequestDelayMs);
    const assistant = options.project && !options.directOnly ? await probeAssistant(model, token) : null;
    rows.push({ model, direct, assistant });

    if (!options.json) {
      const line =
        pad(model, 20) +
        padStart(`${(direct.ms / 1000).toFixed(1)}s`, 9) +
        padStart(direct.status, 8) +
        padStart(direct.completionTokens, 6) +
        padStart(direct.reasoning ? 'yes' : '-', 7);
      const tail = assistant
        ? padStart(`${(assistant.ms / 1000).toFixed(1)}s`, 9) +
          padStart(assistant.status, 7) +
          padStart(assistant.parsed ? 'yes' : 'no', 6)
        : '';
      console.log(line + tail);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ endpoint: config.llmEndpoint, base, timeoutMs, rows }, null, 2));
    return;
  }

  console.log('');
  for (const { model, direct, assistant } of rows) {
    if (!direct.ok) {
      console.log(`${model}: direct call failed (${direct.status}) ${direct.raw}`);
    } else if (direct.reasoning && direct.content === '') {
      console.log(`${model}: answers, but put everything in a reasoning block; the reply carries no text.`);
    }
    if (assistant && !assistant.ok) {
      console.log(
        assistant.status === 200
          ? `${model}: the turn succeeded but the reply was not a parsed envelope — the chatbox shows raw text.`
          : `${model}: the turn returned ${assistant.status}` +
        `${assistant.error ? ` (${assistant.error}${assistant.detail ? ` — ${assistant.detail}` : ''})` : ''}` +
        `${assistant.message && !assistant.error ? `: ${assistant.message}` : ''}.`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
