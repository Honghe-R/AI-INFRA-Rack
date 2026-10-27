/**
 * Usage, quota, and audit (chatbox blueprint §4.10).
 *
 * The append-only usage log is the source of truth: every balance view is
 * re-aggregated from it, so reconciliation is a query rather than trust in an
 * incrementing counter. Quota is checked before the turn with an estimate and
 * recorded after it with the actual total. Accounting outages fail **open**;
 * authorization never does.
 */
export function createUsageService({ pool = null, limits = {}, now = () => new Date() } = {}) {
  function scopeFor({ context, executionContext }) {
    if (context.workspaceId) return { scopeKind: 'workspace', scopeId: context.workspaceId };
    if (context.organisationId) return { scopeKind: 'organisation', scopeId: context.organisationId };
    return { scopeKind: 'user', scopeId: executionContext.initiatedBy.userId };
  }

  function currentPeriod(at = now()) {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    return { periodStart: start, periodEnd: end };
  }

  function quotaLimit(scopeKind) {
    const value = limits[`${scopeKind}MonthlyTokens`];
    return Number.isFinite(value) ? value : null;
  }

  /** Cheap stateful pre-check. The caller treats a throw as fail-open. */
  async function precheck({ context, executionContext }) {
    if (!pool) return { allowed: true };
    const scope = scopeFor({ context, executionContext });
    const limit = quotaLimit(scope.scopeKind);
    if (limit === null) return { allowed: true };

    const { periodStart, periodEnd } = currentPeriod();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS used
         FROM assistant_usage_log
        WHERE scope_kind = $1 AND scope_id = $2 AND created_at >= $3 AND created_at < $4`,
      [scope.scopeKind, scope.scopeId, periodStart, periodEnd],
    );
    const used = Number(rows[0].used);
    if (used >= limit) {
      return {
        allowed: false,
        code: 'ASSISTANT_QUOTA_EXCEEDED',
        status: 429,
        message: 'The assistant token quota for this scope is exhausted.',
        quota: { scope_kind: scope.scopeKind, scope_id: scope.scopeId, used_tokens: used, limit_tokens: limit, period_start: periodStart, period_end: periodEnd },
      };
    }
    return { allowed: true, quota: { scope_kind: scope.scopeKind, used_tokens: used, limit_tokens: limit } };
  }

  /** Append-only record of the actual summed usage. */
  async function record({ context, executionContext, usage, requestId, model = null }) {
    if (!pool) return null;
    const scope = scopeFor({ context, executionContext });
    const { rows } = await pool.query(
      `INSERT INTO assistant_usage_log
         (session_id, request_id, user_id, organisation_id, workspace_id, context_key, scope_kind, scope_id, provider, model,
          prompt_tokens, completion_tokens, total_tokens, cached_input_tokens, cached_output_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING usage_id`,
      [
        executionContext.sessionId ?? null,
        requestId,
        executionContext.initiatedBy.userId,
        executionContext.organisationId,
        executionContext.workspaceId,
        context.contextKey,
        scope.scopeKind,
        scope.scopeId,
        context.surface,
        model,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
        usage.cached_input_tokens,
        usage.cached_output_tokens,
      ],
    );
    return rows[0].usage_id;
  }

  async function summary({ scopeKind, scopeId, at = now() }) {
    if (!pool) return { scopeKind, scopeId, totalTokens: 0, turns: 0 };
    const { periodStart, periodEnd } = currentPeriod(at);
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
              COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
              count(*)::int AS turns
         FROM assistant_usage_log
        WHERE scope_kind = $1 AND scope_id = $2 AND created_at >= $3 AND created_at < $4`,
      [scopeKind, scopeId, periodStart, periodEnd],
    );
    return {
      scopeKind,
      scopeId,
      periodStart,
      periodEnd,
      totalTokens: Number(rows[0].total_tokens),
      promptTokens: Number(rows[0].prompt_tokens),
      completionTokens: Number(rows[0].completion_tokens),
      // Cached tokens are reported beside the totals rather than inside them: a cached prompt
      // is the same tokens at a fraction of the price, and "how much of this was free" is the
      // question the number answers.
      cachedInputTokens: Number(rows[0].cached_input_tokens),
      cachedOutputTokens: Number(rows[0].cached_output_tokens),
      turns: rows[0].turns,
      limitTokens: quotaLimit(scopeKind),
    };
  }

  /**
   * The caller's own monthly total across every scope they spent in. The
   * composer's "overall user usage" is per person, not per scope, and the
   * append-only ledger makes this just another query rather than a counter.
   */
  async function userSummary({ userId, at = now() }) {
    if (!pool) return { scopeKind: 'user', scopeId: userId, totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedInputTokens: 0, cachedOutputTokens: 0, turns: 0, limitTokens: null };
    const { periodStart, periodEnd } = currentPeriod(at);
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
              COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
              COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens,
              COALESCE(SUM(cached_output_tokens), 0)::bigint AS cached_output_tokens,
              count(*)::int AS turns
         FROM assistant_usage_log
        WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [userId, periodStart, periodEnd],
    );
    return {
      scopeKind: 'user',
      scopeId: userId,
      periodStart,
      periodEnd,
      totalTokens: Number(rows[0].total_tokens),
      promptTokens: Number(rows[0].prompt_tokens),
      completionTokens: Number(rows[0].completion_tokens),
      // Cached tokens are reported beside the totals rather than inside them: a cached prompt
      // is the same tokens at a fraction of the price, and "how much of this was free" is the
      // question the number answers.
      cachedInputTokens: Number(rows[0].cached_input_tokens),
      cachedOutputTokens: Number(rows[0].cached_output_tokens),
      turns: rows[0].turns,
      limitTokens: quotaLimit('user'),
    };
  }

  return { precheck, record, summary, userSummary, scopeFor, currentPeriod };
}

/**
 * The audit sink: one credential-free line per provider request and one per tool call.
 *
 * Both are synchronous log writes; durable aggregates belong to a separate job, not the
 * request path. A tool line never carries an argument value — only its digest and the
 * named scope identifiers — so a geometry payload or an attachment body cannot land in
 * the audit trail.
 */
export function createAuditService({ logger = null } = {}) {
  function record(entry) {
    logger?.info?.('assistant.provider_request', {
      event: entry.event,
      request_id: entry.request_id,
      provider: entry.provider,
      model: entry.model,
      user_id: entry.user_id,
      workspace_id: entry.workspace_id,
      organisation_id: entry.organisation_id,
      context_key: entry.context_key,
      iteration: entry.iteration,
      outcome: entry.outcome,
      duration_ms: entry.duration_ms,
      tokens: entry.tokens,
      cached_tokens: entry.cached_tokens,
      error_code: entry.error_code ?? null,
    });
  }

  function recordToolCall(entry) {
    logger?.info?.('assistant.tool_call', {
      event: entry.event ?? 'assistant.tool_call',
      tool: entry.tool,
      access: entry.access ?? null,
      principal: entry.principal ?? null,
      user_id: entry.user_id ?? null,
      project_id: entry.project_id ?? null,
      scenario_id: entry.scenario_id ?? null,
      revision_id: entry.revision_id ?? null,
      context_key: entry.context_key ?? null,
      confirmation: entry.confirmation ?? null,
      outcome: entry.outcome ?? null,
      duration_ms: entry.duration_ms ?? null,
      correlation_id: entry.correlation_id ?? null,
      argument_digest: entry.argument_digest ?? null,
      scope_ids: entry.scope_ids ?? null,
      error_code: entry.error_code ?? null,
    });
  }

  return { record, recordToolCall };
}
