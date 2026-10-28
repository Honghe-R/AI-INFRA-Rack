import { createHash, randomUUID } from 'node:crypto';
import { boundValue, DEFAULT_DIGEST_BYTES, DEFAULT_RESULT_BYTES } from './bounding.js';
import { createExecutionContext } from './context.js';
import { collectEntities, indexEntities, rewriteReply } from './entity-references.js';
import { LlmError, redactDeep } from './errors.js';
import { composeSystemPrompt } from './prompt.js';

/**
 * The orchestrator loop (chatbox blueprint §4.3).
 *
 * Provider-agnostic and dependency-injected. Per turn it resolves and authorizes
 * context, checks quota (fail open), builds the digest once and bounds it once,
 * selects tools, composes the system message, then iterates: call the provider,
 * accumulate usage, and either finalize or invoke tool calls through the MCP host
 * behind a confirmation gate. An over-budget result is shrunk, never fatal; an
 * exceeded iteration budget is an explicit 408, never a silent partial answer.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxIterations: 8,
  maxMessages: 60,
  maxInputBytes: 200_000,
  resultBytes: DEFAULT_RESULT_BYTES,
  digestBytes: DEFAULT_DIGEST_BYTES,
});

export function createOrchestrator({
  provider,
  toolRegistry,
  uiActionRegistry = null,
  contextResolver,
  authorize = async () => true,
  sessionService = null,
  usageService = null,
  auditService = null,
  buildDigest = null,
  promptComposer = composeSystemPrompt,
  limits = {},
  logger = null,
  redact = (value) => value,
  now = () => Date.now(),
  ids = () => randomUUID(),
} = {}) {
  if (!provider) throw new Error('createOrchestrator requires a provider.');
  if (!toolRegistry) throw new Error('createOrchestrator requires a tool registry.');
  if (!contextResolver) throw new Error('createOrchestrator requires a context resolver.');
  const effective = { ...DEFAULT_LIMITS, ...limits };

  async function runTurn({
    messages,
    contextKey,
    context = {},
    sessionId = null,
    confirmations = [],
    // Calls the user already confirmed, exactly as they were shown: `{ callId, name, arguments }`.
    // They are executed, never re-proposed to the model — see the confirmed path below.
    confirmedCalls = [],
    // And the ones the user declined, in the same shape. Nothing runs: the model is told, so a
    // refusal by the reader is something the turn can answer rather than something it repeats.
    deniedCalls = [],
    userRole = null,
    requestId = null,
    signal = null,
    /**
     * Called as each round completes, before the turn returns.
     *
     * The turn is request/response, and stays so: this is an observation hook, not a second
     * contract. A caller that wants the rounds live writes them to a stream; a caller that
     * does not passes nothing and the turn behaves exactly as before. A hook that throws is
     * swallowed — a reporter must never be able to fail the thing it reports on.
     */
    onEvent = null,
    // Already validated against the deployment's allowlist by the route. This layer does
    // not re-check it: the allowlist is a property of the deployment, and the orchestrator
    // has no business inventing a second answer. `null` keeps the configured model.
    model = null,
  } = {}) {
    const startedAt = now();
    const turnRequestId = requestId ?? ids();
    const transcript = normalizeMessages(messages, effective);
    // Only the newly submitted message is persisted per turn (§4.9); replay
    // reconstructs the rest from the client's full transcript.
    const lastUserMessage = [...transcript].reverse().find((entry) => entry.role === 'user') ?? null;

    // 1-2. Context and authorization. Both the guide's entry permission and tool
    // selection are asked through one adapter, so a key can never be checked in one
    // place with the scope and in another without it.
    const chatContext = await contextResolver.resolve({ contextKey, context });
    const authorizeAtScope = (key) =>
      authorize({ key, userId: context.userId, workspaceId: chatContext.workspaceId, organisationId: chatContext.organisationId });
    await contextResolver.authorize({ context: chatContext, authorize: authorizeAtScope });

    const executionContext = createExecutionContext({
      userId: context.userId,
      publicId: context.publicId ?? null,
      workspaceId: chatContext.workspaceId,
      organisationId: chatContext.organisationId,
      scenarioId: chatContext.scenarioId,
      revisionId: chatContext.revisionId,
      baseRevisionId: chatContext.baseRevisionId,
      ifMatch: chatContext.ifMatch,
      readOnly: chatContext.readOnly,
      rackContext: chatContext.rackContext ?? null,
      requestId: turnRequestId,
      sessionId,
    });

    // 3. Quota pre-check: fail open on an accounting outage, never on authorization.
    if (usageService) {
      try {
        const decision = await usageService.precheck({ context: chatContext, executionContext });
        if (decision && decision.allowed === false) {
          throw new LlmError(decision.code ?? 'ASSISTANT_QUOTA_EXCEEDED', decision.message ?? 'Quota is exhausted.', {
            status: decision.status ?? 429,
            details: [decision.quota ?? null],
          });
        }
      } catch (error) {
        if (error instanceof LlmError) throw error;
        logger?.warn?.('assistant.quota_precheck_failed', { error: error?.message });
      }
    }

    // 4. Session index row.
    let session = null;
    if (sessionService) {
      session = await sessionService.ensure({
        sessionId,
        userId: context.userId,
        contextKey,
        surface: chatContext.surface,
        workspaceId: chatContext.workspaceId,
        organisationId: chatContext.organisationId,
      });
    }
    const effectiveSessionId = session?.sessionId ?? sessionId;

    /*
     * Everything below runs inside one try, because everything below can end the turn.
     *
     * The record is written from here rather than at the throw sites. It used to be written at
     * exactly one of them — the iteration budget — so every other way a turn could die left no
     * trace at all: a provider that refused mid-loop, a transcript over the message budget, a
     * refusal the model could not repair. The reader saw the failure once and nothing after a
     * reload, and an operator had no way to see what the turn had done before it stopped. A
     * persisted turn is the only record of a turn, so a turn that is lost here is lost.
     *
     * Catching here rather than at each throw is the point: a new throw site cannot forget to
     * leave a record. The state it needs is hoisted above the try for the same reason — a catch
     * cannot see what a `const` inside the try declared.
     */
    let digest = null;
    let digestMeta = null;
    const usage = emptyUsage();
    // One record per round of the loop. A turn is several provider calls, and today the
    // trace flattened all of them into a list of tool names — the rounds, their durations,
    // and each call's outcome were computed for the audit line and then discarded. They are
    // kept here instead, so a turn can show how its answer was reached rather than only
    // that it was.
    const rounds = [];
    const notices = [];
    const rawResults = [];
    /**
     * The rounds as the reader will read them, at the moment they are handed over.
     *
     * A gated turn returns from the middle of the loop, so its record is built where it stops
     * rather than at the end. The entities are the ones found so far, which is exactly what
     * the model has seen too.
     */
    const narrated = () => narratedRounds(rounds, rawResults);
    const confirmed = new Set(confirmations ?? []);

    /**
     * Persists a turn that ended in an error, so what it did before it stopped is recoverable.
     *
     * Without this a thrown turn left nothing at all: neither the reader nor an operator could
     * see what it had run, what it had spent, or what it had looped on. Persistence never
     * rescues the turn — the error still propagates — it only leaves the record, and a failure
     * to persist is swallowed for the same reason it is everywhere else here.
     *
     * The record is the same shape a completed turn has, so the reader's existing handling of a
     * `failed` turn — its status, its error, its rounds — is what restores it, rather than a
     * second rendering path that would drift.
     */
    async function persistFailure(error) {
      if (sessionService && effectiveSessionId) {
        const failure = {
          status: 'failed',
          requestId: turnRequestId,
          sessionId: effectiveSessionId,
          choices: [],
          uiActions: [],
          entities: [],
          usage,
          error: { code: error.code ?? 'ASSISTANT_TURN_FAILED', message: error.message ?? 'The turn failed.' },
          trace: { requestId: turnRequestId, contextKey, toolCalls: flattenToolCalls(narrated()), rounds: narrated(), digest: digestMeta, notices },
        };
        try {
          await sessionService.appendTurn({
            sessionId: effectiveSessionId,
            requestId: turnRequestId,
            turn: buildStoredTurn({ turnRequestId, contextKey, chatContext, message: { role: 'assistant', content: '' }, response: redactDeep(failure, redact), usage, startedAt, lastUserMessage }),
          });
        } catch {
          // Reporting, never a reason to change what the caller is told.
        }
      }
      if (usageService) {
        try {
          await usageService.record({ context: chatContext, executionContext, usage, requestId: turnRequestId, model: model ?? provider.model ?? null });
        } catch {
          // Reporting, never a reason to fail a turn.
        }
      }
    }

    try {
      // 5. Digest, built once and bounded once.
      if (buildDigest && chatContext.digestAvailable) {
        const raw = await buildDigest({ context: chatContext, executionContext });
        const bounded = boundValue(raw, { limitBytes: effective.digestBytes, kind: 'digest', label: chatContext.surface });
        digest = bounded.value;
        digestMeta = { truncated: bounded.truncated, original_bytes: bounded.originalBytes, notice: bounded.notice };
      }

      // 6. Tool selection is an authorization boundary.
      const selected = await toolRegistry.select({
        surfaceKey: chatContext.surface,
        readOnly: chatContext.readOnly,
        authorize: authorizeAtScope,
      });
      const modelTools = toolRegistry.modelTools(selected);
      const host = toolRegistry.createHost({ selected, executionContext });

      const uiActions = uiActionRegistry ? uiActionRegistry.describe({ surfaceKey: chatContext.surface }) : [];

      const systemMessage = {
        role: 'system',
        content: promptComposer({
          guide: chatContext.guide,
          userRole,
          // The resolved scope is stated to the model because every tool call must name
          // it; it is the server's canonical answer, not the client's claim.
          scope: {
            projectId: chatContext.workspaceId,
            scenarioId: chatContext.scenarioId,
            revisionId: chatContext.revisionId,
            lifecycleState: chatContext.lifecycleState ?? null,
          },
          digest,
          digestNotice: digestMeta?.notice ?? null,
          tools: modelTools,
          uiActions,
        }),
      };

      /**
       * Runs one tool call: gate, execute, bound, audit, and append the tool message the next round
       * reads.
       *
       * Shared by the model's calls and by a call the user already confirmed, so both paths audit and
       * bound a result identically instead of the confirmed path growing a second copy of the rules.
       * Returns `{ error }` for the one refusal that is not the model's to repair (the caller
       * unwinds), `{ confirmationRequired }` when the gate stopped the call, and `{ done: true }`
       * otherwise.
       */
      async function runToolCall(call, round, { forceConfirmed = false } = {}) {
        const toolName = call.function?.name ?? call.name;
        const capability = selected.find((candidate) => candidate.name === toolName) ?? null;
        const callStartedAt = now();
        /*
         * A confirmation given by tool *name* authorises one call, and is spent by it.
         *
         * It used to survive the call it authorised, which meant the next call of the same name in
         * the same turn ran pre-confirmed — with arguments the user never saw. That was invisible
         * while a refused or failed write ended the turn, because there was no next call to make;
         * answering a write's failure in the transcript, as this loop now does, is exactly what
         * creates one. Spending it here is what keeps "the confirmation was for the arguments they
         * saw" true rather than merely intended. A confirmation by call id needs no such care: an
         * id names one call and a new call cannot present it.
         */
        const confirmedByName = !forceConfirmed && confirmed.has(toolName);
        const preConfirmed = forceConfirmed || confirmedByName || confirmed.has(call.id);
        if (confirmedByName) confirmed.delete(toolName);
        let args;
        let outcome;
        try {
          // Inside the try, because a model that emits malformed JSON for its own arguments has
          // made a mistake the model can correct — and it was the one tool-call failure that
          // escaped this handler entirely, so it ended the turn before the rule below could apply.
          args = parseArguments(call);
          outcome = await host.callTool({
            name: toolName,
            arguments: args,
            confirmed: preConfirmed,
          });
        } catch (error) {
          // A refused call is still a call: it is audited either way.
          auditToolCall({ auditService, toolName, capability, args, executionContext, contextKey, turnRequestId, outcome: 'failed', confirmation: preConfirmed ? 'confirmed' : 'none', durationMs: now() - callStartedAt, errorCode: error?.code ?? null });
          // Answered in the transcript rather than unwound, so the model gets another round.
          // Unwinding showed the user the raw refusal — "The arguments are not valid for this
          // tool." — as if it were the answer, and took the rest of the turn with it.
          if (!recoverableToolRefusal(error)) return { error };
          // The reason rides the round, not only the transcript.
          //
          // The transcript is what the model reads and is never stored; the round is what a stored
          // turn keeps. Recording `refused` alone left the one question anyone asks of the log —
          // why — unanswerable: a name that was never on the menu, arguments the registry rejected,
          // and a write the facility itself turned down all read identically. A live turn stored
          // `set_geometry refused` and nothing else, and neither the reader nor an operator could
          // tell which of the three it had been.
          round.calls.push({
            name: toolName,
            ms: now() - callStartedAt,
            outcome: 'refused',
            truncated: false,
            error: { code: error.code ?? 'TOOL_REFUSED', message: error.message ?? 'The tool refused the call.' },
          });
          transcript.push({
            role: 'tool',
            tool_call_id: call.id ?? null,
            name: toolName,
            content: JSON.stringify({
              error: {
                code: error.code ?? 'TOOL_REFUSED',
                message: refusalMessage(error, toolName, { uiActions, registeredTool: Boolean(toolRegistry.get(toolName)) }),
                details: redactDeep(error.details ?? [], redact),
              },
            }),
          });
          return { done: true };
        }

        if (outcome.confirmationRequired) {
          round.calls.push({ name: toolName, ms: now() - callStartedAt, outcome: 'confirmation_required', truncated: false });
          auditToolCall({ auditService, toolName, capability, args, executionContext, contextKey, turnRequestId, outcome: 'confirmation_required', confirmation: 'required', durationMs: now() - callStartedAt });
          return {
            confirmationRequired: {
              callId: call.id ?? null,
              toolName: outcome.toolName,
              arguments: redactDeep(outcome.arguments, redact),
              // The surface's own sentence about the call, for the card. Null when the surface
              // offered none, and the card falls back to words of its own rather than to JSON.
              summary: outcome.summary ?? null,
            },
          };
        }

        // Entity references are collected from the RAW result, before bounding.
        rawResults.push(outcome.result);
        const bounded = boundValue(outcome.result, { limitBytes: effective.resultBytes, kind: 'tool', label: toolName });
        if (bounded.truncated) notices.push(bounded.notice);
        round.calls.push({
          name: toolName,
          ms: now() - callStartedAt,
          outcome: bounded.truncated ? 'degraded' : 'ok',
          truncated: bounded.truncated === true,
          // Whether this call changed the draft. It is what lets the client refresh what it
          // draws: the change is committed server-side inside the turn, so a canvas holding
          // the envelope it read before the turn shows the design as it was and only a page
          // reload would reveal the write — which reads as "the assistant said it moved it
          // and nothing moved".
          wrote: capability?.access === 'write',
        });
        transcript.push({
          role: 'tool',
          tool_call_id: call.id ?? null,
          name: toolName,
          // A result the model repeats becomes user-visible, so the same redaction the reply
          // receives is applied before the result is serialized.
          content: JSON.stringify(redactDeep(bounded.value, redact)),
        });
        auditToolCall({ auditService, toolName, capability, args, executionContext, contextKey, turnRequestId, outcome: bounded.truncated ? 'degraded' : 'ok', confirmation: preConfirmed || capability?.confirmation === 'required' ? 'confirmed' : 'none', durationMs: now() - callStartedAt });
        return { done: true };
      }

      /**
       * A confirmation the user gave is executed as the call they saw.
       *
       * The pending call's name and arguments were returned to the client and shown with the decision
       * card, so the client hands them back and the server runs *those*. Asking the model to
       * re-propose the call instead left room for it to answer "I ran the write" without calling
       * anything: a live turn told the user a move had been applied while the draft ETag never moved
       * and no outbox event was written. After the confirmed calls run, the loop below continues so
       * the model reports the real result.
       */
      if (confirmedCalls.length > 0) {
        const confirmedRound = { iteration: 0, providerMs: 0, tokens: null, calls: [] };
        rounds.push(confirmedRound);
        const reconciled = confirmedCalls.map((entry, index) => ({
          id: entry.callId ?? `confirmed-${index}`,
          type: 'function',
          function: { name: entry.name ?? entry.toolName, arguments: JSON.stringify(entry.arguments ?? {}) },
        }));
        transcript.push({ role: 'assistant', content: '', tool_calls: reconciled });
        for (const call of reconciled) {
          const settled = await runToolCall(call, confirmedRound, { forceConfirmed: true });
          if (settled.error) throw settled.error;
          if (settled.confirmationRequired) {
            emit(onEvent, { type: 'round', round: confirmedRound });
            return {
              status: 'confirmation_required',
              requestId: turnRequestId,
              sessionId: effectiveSessionId,
              pendingConfirmations: [settled.confirmationRequired],
              messages: transcript.filter((entry) => entry.role !== 'system'),
              usage,
              trace: { requestId: turnRequestId, contextKey, toolCalls: flattenToolCalls(narrated()), rounds: narrated(), digest: digestMeta, notices: redactDeep(notices, redact) },
            };
          }
        }
        emit(onEvent, { type: 'round', round: confirmedRound });
      }

      /**
       * A call the reader declined is answered as the call they declined.
       *
       * A denial the model never hears is a denial it proposes again: the reader says no, the turn
       * ends, and the same card is drawn from the same proposal a moment later. So the declined
       * call is replayed as the model's own proposal — the same id, the same arguments — with a
       * tool result saying it was refused, and the loop below continues so the model can offer
       * something else or say why it cannot. Nothing is applied, and no handler is consulted: a
       * denial is a decision about the proposal, not a failure of it.
       */
      if (deniedCalls.length > 0) {
        const deniedRound = { iteration: 0, providerMs: 0, tokens: null, calls: [] };
        rounds.push(deniedRound);
        const declined = deniedCalls.map((entry, index) => ({
          id: entry.callId ?? `denied-${index}`,
          name: entry.name ?? entry.toolName,
          arguments: entry.arguments ?? {},
        }));
        transcript.push({
          role: 'assistant',
          content: '',
          tool_calls: declined.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
        for (const call of declined) {
          const capability = selected.find((candidate) => candidate.name === call.name) ?? null;
          auditToolCall({ auditService, toolName: call.name, capability, args: call.arguments, executionContext, contextKey, turnRequestId, outcome: 'denied', confirmation: 'denied', durationMs: 0 });
          deniedRound.calls.push({ name: call.name, ms: 0, outcome: 'denied', truncated: false });
          transcript.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({
              error: {
                code: 'TOOL_DENIED_BY_USER',
                message: 'The user declined this call, so nothing was applied. Do not run it or ask for it again; offer another way to do what they asked, or explain what you cannot do without it.',
              },
            }),
          });
        }
        emit(onEvent, { type: 'round', round: deniedRound });
      }

      for (let iteration = 1; iteration <= effective.maxIterations; iteration += 1) {
        if (transcript.length > effective.maxMessages) {
          throw new LlmError('ASSISTANT_MESSAGE_BUDGET', 'The conversation exceeded the message budget.', { status: 408 });
        }

        const iterationStartedAt = now();
        const response = await provider.complete({
          messages: [systemMessage, ...transcript],
          tools: modelTools,
          context: { contextKey, surface: chatContext.surface },
          executionContext,
          iteration,
          requestId: turnRequestId,
          signal,
          ...(model ? { model } : {}),
        });

        const choice = response.choices[0] ?? {};
        const message = choice.message ?? { role: 'assistant', content: '' };
        accumulateUsage(usage, response.usage);

        auditService?.record({
          event: 'assistant.provider_request',
          request_id: turnRequestId,
          provider: response.provider ?? provider.name,
          model: response.model ?? model ?? provider.model ?? null,
          user_id: context.userId,
          workspace_id: chatContext.workspaceId,
          organisation_id: chatContext.organisationId,
          context_key: contextKey,
          iteration,
          outcome: 'ok',
          duration_ms: now() - iterationStartedAt,
          tokens: usage.total_tokens,
          cached_tokens: usage.cached_input_tokens + usage.cached_output_tokens,
        });

        emit(onEvent, {
          type: 'round_started',
          iteration,
          model: response.model ?? model ?? provider.model ?? null,
        });
        const narration = roundNarration(message, indexEntities(collectEntities(rawResults)).rewrite);
        rounds.push({
          iteration,
          providerMs: now() - iterationStartedAt,
          // The round's own tokens, not the running total: a reader asking what a round cost
          // means that round, and the accumulated figure is already reported separately.
          tokens: response.usage?.total_tokens ?? null,
          calls: [],
          // What the model said while it worked, which is the only place its approach is
          // stated. Tool names say what it looked at; this says what it was after.
          ...narration,
        });
        const round = rounds[rounds.length - 1];

        transcript.push(message);

        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (calls.length === 0) {
          emit(onEvent, { type: 'round', round });
          return finalize({ message, chatContext, uiActionRegistry, contextKey, turnRequestId, effectiveSessionId, usage, rounds, notices, rawResults, digestMeta, redact, now, startedAt, sessionService, usageService, executionContext, context, lastUserMessage, model: model ?? provider.model ?? null });
        }

        for (const call of calls) {
          const settled = await runToolCall(call, round);
          if (settled.error) throw settled.error;
          if (settled.confirmationRequired) {
            emit(onEvent, { type: 'round', round });
            return {
              status: 'confirmation_required',
              requestId: turnRequestId,
              sessionId: effectiveSessionId,
              pendingConfirmations: [settled.confirmationRequired],
              messages: transcript.filter((entry) => entry.role !== 'system'),
              usage,
              trace: { requestId: turnRequestId, contextKey, toolCalls: flattenToolCalls(narrated()), rounds: narrated(), digest: digestMeta, notices: redactDeep(notices, redact) },
            };
          }
        }
        emit(onEvent, { type: 'round', round });
      }

      // A budget failure says what the turn was doing, because "exceeded its iteration budget" on its
      // own is not diagnosable — not from the chatbox, and not from the stored turn.
      const loopSummary = rounds
        .map((entry) => `round ${entry.iteration}: ${(entry.calls ?? []).map((call) => `${call.name} ${call.outcome}`).join(', ') || 'no calls'}`)
        .join('; ');
      const budgetError = new LlmError(
        'ASSISTANT_ITERATION_BUDGET',
        `The turn used its ${effective.maxIterations}-round budget without answering. What it did — ${loopSummary || 'no tool calls'}.`,
        {
          status: 408,
          details: rounds.map((entry) => ({ iteration: entry.iteration, calls: (entry.calls ?? []).map((call) => ({ name: call.name, outcome: call.outcome })) })),
        },
      );
      // Not persisted here: the catch below is the one place a failure is written, and calling
      // this too counted the turn's usage twice — `appendTurn` is idempotent by request id, the
      // usage ledger deliberately is not.
      throw budgetError;
    } catch (error) {
      // The error still propagates: persisting never rescues a failed turn, it only leaves the
      // record. `persistFailure` swallows its own failure, so this cannot mask the real error.
      await persistFailure(error);
      throw error;
    }
  }

  return { runTurn, limits: effective };
}

/**
 * Whether a refused tool call is answered in the transcript or ends the turn.
 *
 * **Everything a tool call can raise is answered in the transcript**, because a tool call is
 * the model's own action and the model is the only party that can do anything about it: re-send
 * it with valid arguments, use a different tool, or answer without it. The reader had no move at
 * all — a raw refusal was shown as if it were the reply, and the work the turn had already done
 * went with it.
 *
 * The rule used to be a list of statuses per access mode, which got both halves wrong. It read
 * `403` as an authority denial the model could not fix, so a name that was simply not on this
 * turn's menu ended the turn — a live turn called `show_finding`, a UI action it had been told
 * to return in the envelope, and lost everything it had done to a refusal the reader could not
 * act on. And it let a **write**'s own refusal unwind to protect a confirmation, which is now
 * protected where the confirmation is spent instead: see `runToolCall`, where a confirmation
 * given by tool name is consumed by the call it authorised. That is the invariant that matters —
 * "the confirmation was for the arguments they saw" — and it holds whether or not the turn
 * continues, so the turn no longer has to die to keep it.
 *
 * The one exception is not about a tool call at all. `ASSISTANT_CONTEXT_INVALID` means this
 * server failed to build the execution context a handler would run under; there is no principal
 * to run as, no answer that would be true, and a bug in this process rather than anything the
 * model did. It unwinds, and the caller gets a `500`.
 *
 * The budgets are the other terminations, and they are deliberately not here: they are raised by
 * the loop, not by a call, and they exist because a model that will not stop asking must not
 * spend without bound. See the note on `ASSISTANT_ITERATION_BUDGET`.
 */
function recoverableToolRefusal(error) {
  return error?.code !== 'ASSISTANT_CONTEXT_INVALID';
}

/**
 * The refusal as the model has to read it.
 *
 * `Tool "show_finding" is not available in this context.` is true and leaves the model nothing
 * to do differently: it reads as "that tool is missing", so the next move is to try another
 * name, and the turn spends its rounds renaming the call until the iteration budget ends it —
 * terminated, later, and still without an answer. Only this layer holds both registries, so
 * only this layer can say which one the name belongs to.
 *
 * A name that *is* a registered tool was withheld rather than misplaced — by a permission, or
 * by a surface that does not offer it — and this layer cannot tell which of those it was, so
 * the hint stays off rather than naming the wrong registry. The hint rides only on the refusal
 * it explains; every other one keeps its own words.
 */
function refusalMessage(error, toolName, { uiActions = [], registeredTool = false } = {}) {
  const base = error?.message ?? 'The tool refused the call.';
  if (error?.code !== 'ASSISTANT_TOOL_NOT_SELECTED') return base;
  if (registeredTool) return base;
  if (!uiActions.some((action) => action.type === toolName)) return base;
  return `${base} "${toolName}" is a UI action, not a tool: return it in the reply's "uiActions" array instead of calling it.`;
}

/**
 * Reports an event, and never lets the reporting fail the turn.
 *
 * A stream that has gone away — the reader closed the tab, the socket died — must not turn
 * into a failed turn on the server: the work is already done, and the alternative is an
 * error path that only exists because a reporter was watching.
 */
function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(event);
  } catch {
    // Deliberately swallowed. See above.
  }
}

/**
 * How much of a round's own words ride the record.
 *
 * The record exists to show how the model approached the problem, and the model's own
 * narration is the only thing that states an approach: tool names say what it looked at, not
 * what it was after. So this is a guard against a pathological round, not a reading limit —
 * a bound tight enough to cut a real reasoning trace defeats the record, because the thinking
 * *is* the thing being read. At fifty thousand characters a single round holds a full
 * reasoning trace of the kind this surface produces; past it the round says it was cut.
 */
const ROUND_NARRATION_CHARS = 50000;

/**
 * What a round's message said, without the reply envelope around it.
 *
 * The model answers in `{ type, payload }`, and the payload is the sentence. A round that
 * calls tools usually says nothing at all, and saying nothing must stay nothing: an empty
 * string is not a message.
 */
function spokenText(content) {
  const raw = typeof content === 'string' ? content : '';
  const parsed = tryParse(raw);
  return parsed && typeof parsed.payload === 'string' ? parsed.payload : raw;
}

/** The provider's separate thinking channel, when the deployment's model has one. */
function reasoningOf(message) {
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof message?.[key] === 'string' && message[key].trim().length > 0) return message[key];
  }
  return '';
}

function boundNarration(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= ROUND_NARRATION_CHARS) return { value: text, truncated: false };
  return { value: `${text.slice(0, ROUND_NARRATION_CHARS)}…`, truncated: true };
}

/**
 * What one round said, as the reader will read it.
 *
 * The narration is rewritten exactly like the reply, so an entity the model named while
 * working is the same link it is in the answer.
 */
function roundNarration(message, rewrite) {
  const said = boundNarration(rewriteReply(spokenText(message?.content), rewrite));
  const thought = boundNarration(rewriteReply(reasoningOf(message), rewrite));
  return {
    ...(said.value ? { text: said.value } : {}),
    ...(thought.value ? { reasoning: thought.value } : {}),
    ...(said.truncated || thought.truncated ? { narrationTruncated: true } : {}),
  };
}

/**
 * The rounds as the reader will read them: the model's words with the entities the turn has
 * found linked, exactly as the reply's are.
 */
function narratedRounds(rounds, rawResults) {
  const { rewrite } = indexEntities(collectEntities(rawResults));
  return rounds.map((entry) => {
    if (!entry.text && !entry.reasoning) return entry;
    return {
      ...entry,
      ...(entry.text ? { text: rewriteReply(entry.text, rewrite) } : {}),
      ...(entry.reasoning ? { reasoning: rewriteReply(entry.reasoning, rewrite) } : {}),
    };
  });
}

/**
 * The flat tool-name list, derived from the rounds.
 *
 * Kept because it is the shape readers already have, and derived rather than accumulated
 * so the two can never disagree about what ran.
 */
function flattenToolCalls(rounds) {
  return (rounds ?? []).flatMap((round) => (round.calls ?? []).map((call) => ({ name: call.name, truncated: call.truncated })));
}

/**
 * One append-only, credential-free audit record per tool call.
 *
 * The arguments reach the record only as a SHA-256 digest, and the named scope
 * identifiers travel separately, so a geometry payload or an attachment body can
 * never land in the audit line. The record is emitted for a succeeded, degraded,
 * gated, or refused call.
 */
function auditToolCall({
  auditService,
  toolName,
  capability,
  args,
  executionContext,
  contextKey,
  turnRequestId,
  outcome,
  confirmation,
  durationMs,
  errorCode = null,
}) {
  if (!auditService?.recordToolCall) return;
  auditService.recordToolCall({
    event: 'assistant.tool_call',
    tool: toolName,
    access: capability?.access ?? null,
    principal: executionContext.principal?.name ?? null,
    user_id: executionContext.initiatedBy?.userId ?? null,
    project_id: executionContext.workspaceId ?? null,
    scenario_id: executionContext.scenarioId ?? null,
    revision_id: executionContext.revisionId ?? null,
    context_key: contextKey,
    confirmation,
    outcome,
    duration_ms: durationMs,
    correlation_id: turnRequestId,
    argument_digest: createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex'),
    scope_ids: {
      project_id: executionContext.workspaceId ?? null,
      scenario_id: executionContext.scenarioId ?? null,
      revision_id: executionContext.revisionId ?? null,
    },
    error_code: errorCode,
  });
}

// Async because it persists the turn, and a caller must not be told a turn succeeded
// before that turn is durable.
async function finalize({
  message,
  chatContext,
  uiActionRegistry,
  contextKey,
  turnRequestId,
  effectiveSessionId,
  usage,
  toolCalls,
  notices,
  rawResults,
  digestMeta,
  redact,
  now,
  startedAt,
  sessionService,
  usageService,
  executionContext,
  context,
  lastUserMessage,
  // The model this turn ran on, already resolved by the caller: a per-turn choice when
  // there is one, else the provider's own. `provider` is not in scope here, so the
  // fallback is resolved where it is.
  model,
  rounds = [],
}) {
  const { entities, rewrite } = indexEntities(collectEntities(rawResults));
  const rawContent = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const parsed = tryParse(rawContent);
  // What the model printed rather than requested: the envelope, or the action object itself,
  // written after the prose instead of inside the reply. It is read as a request, and what was
  // read is then taken out of what the reader is shown — an instruction is not an answer.
  const salvage = parsed ? { actions: [], consumed: [] } : salvageActions({ text: rawContent, uiActionRegistry });
  const visibleContent = stripConsumed(rawContent, salvage.consumed);
  // Every round is re-read with the entities the whole turn found, not only the ones known
  // when it landed: a round is streamed the moment it completes, so the live copy names an
  // entity the last read had not returned yet and the settled one links it.
  const narrated = narratedRounds(rounds, rawResults);
  // Derived from the rounds rather than tracked beside them, so a turn that wrote is
  // described by the same record the transcript discloses. A confirmed call runs in its own
  // round, before any model round, so it counts here exactly like a model-proposed one.
  const draftChanged = rounds.some((entry) => (entry.calls ?? []).some((call) => call.wrote === true));

  // The model's requested UI actions are validated against the surface's allow-list.
  // A rejected one becomes a notice; it is never dispatched and never silently kept.
  const uiActions = extractUiActions({
    uiActionRegistry,
    requested: Array.isArray(parsed?.uiActions) ? parsed.uiActions : salvage.actions,
    notices,
    chatContext,
    contextKey,
  });

  const response = {
    status: 'ok',
    requestId: turnRequestId,
    sessionId: effectiveSessionId,
    choices: [
      {
        message: {
          role: 'assistant',
          content: parsed ? rewriteReply(JSON.stringify(parsed), rewrite) : rewriteReply(visibleContent, rewrite),
          raw_content: rewriteReply(rawContent, rewrite),
          structured_content: parsed ? { ...parsed, entities } : undefined,
        },
      },
    ],
    uiActions,
    entities,
    usage,
    // True when a tool with write access succeeded during this turn. The client uses it to
    // re-read what it draws; `trace` alone would leave the reader to infer a write from a
    // tool's name, which is the surface's business and not the envelope's.
    draftChanged,
    // `toolCalls` stays, derived, because it is the shape existing readers expect; the
    // rounds are the full record and the flat list is a projection of them.
    trace: { requestId: turnRequestId, contextKey, toolCalls: flattenToolCalls(narrated), rounds: narrated, digest: digestMeta, notices },
  };

  if (sessionService && effectiveSessionId) {
    try {
      // The persisted turn is redacted too: a stored transcript is as visible as a
      // live one, and an error string can carry a provider credential.
      const stored = redactDeep(response, redact);
      // Awaited, so the turn is durable before the reply is sent. Left unawaited it was
      // fire-and-forget: a client that listed its sessions or history immediately after a
      // turn could be told it had none, and the `catch` below could not see an asynchronous
      // failure at all — a rejected write became an unhandled rejection, and the
      // TURN_PERSIST_FAILED notice it builds was unreachable for the failures it names.
      // Awaiting does not make persistence fail the reply; the catch still absorbs it.
      await sessionService.appendTurn({ sessionId: effectiveSessionId, requestId: turnRequestId, turn: buildStoredTurn({ turnRequestId, contextKey, chatContext, message, response: stored, usage, startedAt, lastUserMessage }) });
    } catch (error) {
      // A failure to persist is reported, never allowed to fail the reply.
      notices.push({ code: 'TURN_PERSIST_FAILED', message: redact(error?.message ?? 'The turn was not persisted.') });
    }
  }
  if (usageService) {
    // Awaited, like the turn itself, and for the same reason. Left as fire-and-forget the
    // client's own refresh — which runs immediately after this reply — read the ledger
    // before this row landed, so "overall user usage" persistently reported less than the
    // conversation the reader was looking at. Reporting still never fails the reply: a
    // ledger write that fails is swallowed here rather than turned into an error.
    //
    // `model` is the model that answered, not null. Usage with no model attached cannot
    // answer the only question anyone asks of it later — which model is slow, or expensive.
    try {
      await usageService.record({ context: chatContext, executionContext, usage, requestId: turnRequestId, model });
    } catch {
      // Reporting, never a reason to fail a turn.
    }
  }

  // One deep pass covers content, raw_content, structured_content, entity labels, UI
  // action payloads, and notices — including a notice appended after persistence.
  return redactDeep(response, redact);
}

/**
 * Extracts the allow-listed UI actions from a parsed model envelope.
 *
 * Each requested action is validated on its own so one unlisted type is recorded and
 * refused without discarding the listed actions beside it. `extract` is the registry's
 * own allow-list check, so an invented type, an unknown version, or a payload missing
 * a required field is a `UI_ACTION_REJECTED` notice rather than a dispatched effect.
 */
function extractUiActions({ uiActionRegistry, requested = [], notices, chatContext, contextKey }) {
  if (!uiActionRegistry) return [];
  const context = { surface: chatContext.surface, contextKey, workspaceId: chatContext.workspaceId };
  const extracted = [];
  for (const item of requested) {
    try {
      extracted.push(...uiActionRegistry.extract([item], context));
    } catch (error) {
      notices.push({
        code: 'UI_ACTION_REJECTED',
        message: error?.message ?? 'A requested UI action is not permitted.',
        details: Array.isArray(error?.details) ? error.details : [],
      });
    }
  }
  return extracted;
}

function buildStoredTurn({ turnRequestId, contextKey, chatContext, message, response, usage, startedAt, lastUserMessage }) {
  return {
    schemaVersion: 1,
    requestId: turnRequestId,
    contextKey,
    surface: chatContext.surface,
    guideVersion: chatContext.guide?.version ?? null,
    messages: lastUserMessage ? [lastUserMessage] : [],
    response,
    usage,
    createdAt: new Date(startedAt).toISOString(),
  };
}

function normalizeMessages(messages, limits) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('ASSISTANT_MESSAGES_REQUIRED', 'A turn requires at least one message.', { status: 400 });
  }
  const normalized = messages
    .filter((message) => message && typeof message.role === 'string')
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    }));
  if (normalized.length === 0) {
    throw new LlmError('ASSISTANT_MESSAGES_REQUIRED', 'A turn requires at least one usable message.', { status: 400 });
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > limits.maxInputBytes) {
    throw new LlmError('ASSISTANT_INPUT_TOO_LARGE', 'The conversation exceeds the input budget.', { status: 413 });
  }
  return normalized;
}

function parseArguments(call) {
  const raw = call.function?.arguments ?? call.arguments ?? '{}';
  if (typeof raw === 'object' && raw !== null) return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new LlmError('ASSISTANT_TOOL_ARGUMENTS_INVALID', 'A tool call carried unparsable arguments.', { status: 400 });
  }
}

export function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_input_tokens: 0, cached_output_tokens: 0 };
}

/** Normalizes the several vendor spellings and never double-counts cached tokens. */
export function normalizeUsage(raw = {}) {
  const prompt = number(raw.prompt_tokens ?? raw.input_tokens);
  const completion = number(raw.completion_tokens ?? raw.output_tokens);
  const total = number(raw.total_tokens ?? prompt + completion);
  const cachedInput = number(raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const cachedOutput = number(raw.cached_output_tokens ?? raw.cache_write_input_tokens ?? raw.completion_tokens_details?.cached_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, cached_input_tokens: cachedInput, cached_output_tokens: cachedOutput };
}

function accumulateUsage(target, raw) {
  if (!raw) return;
  const usage = normalizeUsage(raw);
  target.prompt_tokens += usage.prompt_tokens;
  target.completion_tokens += usage.completion_tokens;
  target.total_tokens += usage.total_tokens;
  target.cached_input_tokens += usage.cached_input_tokens;
  target.cached_output_tokens += usage.cached_output_tokens;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/**
 * The UI actions the model stated in its reply without using the envelope for them.
 *
 * The reply is supposed to carry a `uiActions` array, and this deployment's model keeps
 * printing the request instead: the answer in prose, then a fenced JSON object naming the
 * action with a complete payload. Two live turns did exactly that with `entity_id`,
 * `entity_type` and `label` correct to the letter, highlighted nothing, and told the reader
 * the plant had been highlighted.
 *
 * So both spellings are read: an envelope printed late (its `uiActions`), and an action
 * printed late (the object itself). The second is only read when the surface actually
 * declares that action and it carries a payload, so prose *about* actions cannot become one —
 * and every UI action is presentation-only, so the worst a misread can do is move a highlight
 * the reader did not ask for. Nothing here can change the design.
 */
function salvageActions({ text, uiActionRegistry }) {
  const candidates = [];
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let match = fenced.exec(text);
  while (match) {
    candidates.push({ block: match[0], body: match[1] });
    match = fenced.exec(text);
  }
  // No fence: the object was appended to the prose as it stands, and the whole run of braces is
  // what was written rather than said.
  if (candidates.length === 0) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      const block = text.slice(first, last + 1);
      candidates.push({ block, body: block });
    }
  }

  const actions = [];
  const consumed = [];
  for (const candidate of candidates) {
    const parsed = tryParse(candidate.body);
    if (!parsed) continue;
    if (Array.isArray(parsed.uiActions)) {
      if (parsed.uiActions.length === 0) continue;
      actions.push(...parsed.uiActions);
      // A late envelope's `payload` is the answer it was carrying, so it is kept when the prose
      // does not already contain it.
      consumed.push({ block: candidate.block, keep: typeof parsed.payload === 'string' ? parsed.payload : '' });
      continue;
    }
    if (!uiActionRegistry || !parsed.payload || typeof parsed.payload !== 'object') continue;
    if (!uiActionRegistry.get(parsed.type, parsed.version)) continue;
    actions.push(parsed);
    consumed.push({ block: candidate.block, keep: '' });
  }
  return { actions, consumed };
}

/**
 * The reply as the reader should see it, with the parts read as a request taken out.
 *
 * An instruction is not an answer, and leaving it in the bubble is how a chatbox comes to
 * display its own wire format at the reader: the prose says the plant was highlighted and the
 * fenced object underneath it is the machinery that did it. Only what was *consumed* is
 * removed — a JSON block the model showed the reader stays, because that is content the model
 * chose to write and this is not the layer that decides which answers are allowed to contain
 * braces.
 */
function stripConsumed(text, consumed) {
  let out = text;
  for (const entry of consumed) {
    const remainder = out.replace(entry.block, '');
    const keep = entry.keep && !remainder.includes(entry.keep) ? entry.keep : '';
    out = out.replace(entry.block, keep);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parses the model's reply envelope.
 *
 * Strict first, then with the raw control characters that appear *inside* a JSON string
 * escaped. A provider routinely puts literal newlines in the payload, which makes the whole
 * object invalid, and a discarded envelope takes the reply's `uiActions` with it: a live turn
 * asked for a highlight in a perfectly good envelope that happened to contain a newline, and
 * the action was dropped with no notice at all — the reader saw only the prose. The browser
 * recovers the same way for display (`visibleAssistantText`), and the two cannot share the
 * code because the web app may not import a server package.
 */
function tryParse(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  for (const candidate of [trimmed, escapeControlCharsInStrings(trimmed)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to the repaired candidate; a second failure means giving up.
    }
  }
  return null;
}

/**
 * Escapes raw newlines and tabs that appear *inside* a JSON string literal.
 *
 * The distinction is the whole point: a newline between fields is legal whitespace and is
 * left alone, while a newline inside a quoted payload is what breaks the parse. Backslash
 * escapes are tracked so an escaped quote does not end the string early.
 */
function escapeControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && (char === '\n' || char === '\r' || char === '\t')) {
      out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : '\\t';
      continue;
    }
    out += char;
  }
  return out;
}
