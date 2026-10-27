import { withTenant } from '@ai-infra/db';
import { executeRun, RUN_REASON } from './engine.js';
import { defaultPolicyRegistry } from './policies.js';

/**
 * The validation worker.
 *
 * The queue is the `jobs` table, so a queued validation survives a restart: a job
 * is claimed with `FOR UPDATE SKIP LOCKED`, which lets several workers run
 * without coordinating, and the claim and the state change commit together so a
 * crashed worker leaves a `RUNNING` row rather than losing the job.
 *
 * The claim sweeps across projects, so the worker must run as a role that owns
 * the tables (row-level security is enabled but not forced — see the migration's
 * RLS section) or as one granted `BYPASSRLS`. The execution itself runs under the
 * tenant GUC like every other write.
 */
export function createValidationWorker({
  pool,
  logger = null,
  policies = defaultPolicyRegistry,
  pollIntervalMs = 1000,
  batchSize = 1,
  maxDiagnostics = 100_000,
} = {}) {
  if (!pool) throw new Error('createValidationWorker requires a database pool.');

  let timer = null;
  let running = false;

  /** Claims up to `batchSize` queued jobs and executes them. Returns the outcomes. */
  async function runOnce() {
    const claimed = (
      await pool.query(
        `WITH claimed AS (
           SELECT job_id, project_id FROM jobs
            WHERE state = 'QUEUED' AND job_type = 'VALIDATION'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE jobs j
            SET state = 'RUNNING', started_at = now(), progress_pct = 1, updated_at = now()
           FROM claimed c
          WHERE j.job_id = c.job_id AND j.project_id = c.project_id
          RETURNING j.job_id, j.project_id, j.scenario_id, j.revision_id, j.payload`,
        [Math.min(Math.max(batchSize, 1), 16)],
      )
    ).rows;

    const outcomes = [];
    for (const job of claimed) {
      outcomes.push(await executeJob(job));
    }
    return outcomes;
  }

  async function executeJob(job) {
    const payload = job.payload ?? {};
    const runId = payload.validation_run_id ?? null;
    try {
      const result = await withTenant(pool, job.project_id, (client) =>
        executeRun({
          client,
          projectId: job.project_id,
          scenarioId: job.scenario_id,
          revisionId: job.revision_id,
          scope: payload.scope === 'AFFECTED_SUBGRAPH' ? 'AFFECTED_SUBGRAPH' : 'FULL',
          reason: payload.reason === RUN_REASON.PUBLISH ? RUN_REASON.PUBLISH : RUN_REASON.VALIDATION,
          requestedCapabilities: payload.requested_capabilities ?? null,
          baseEtag: payload.base_etag ?? null,
          actorId: payload.actor_id ?? null,
          policies,
          maxDiagnostics,
          runId: runId ?? undefined,
        }),
      );

      await pool.query(
        `UPDATE jobs
            SET state = 'SUCCEEDED', progress_pct = 100, completed_at = now(), updated_at = now(),
                result = $3::jsonb
          WHERE job_id = $1 AND project_id = $2`,
        [
          job.job_id, job.project_id,
          JSON.stringify({
            validation_run_id: result.runId,
            scope: result.scope,
            error_count: result.errorCount,
            warning_count: result.warningCount,
            not_checked_capabilities: result.notCheckedCapabilities,
            lifecycle_state: result.lifecycleState,
            incomplete: result.incomplete,
          }),
        ],
      );
      logger?.info?.('validation.job.succeeded', { jobId: job.job_id, runId: result.runId });
      return { jobId: job.job_id, state: 'SUCCEEDED', runId: result.runId };
    } catch (error) {
      await pool.query(
        `UPDATE jobs
            SET state = 'FAILED', completed_at = now(), updated_at = now(), error_message = $3
          WHERE job_id = $1 AND project_id = $2`,
        [job.job_id, job.project_id, error?.message ?? 'validation failed'],
      ).catch(() => {});
      logger?.warn?.('validation.job.failed', { jobId: job.job_id, error: error?.message });
      return { jobId: job.job_id, state: 'FAILED', error: error?.message ?? null };
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      runOnce()
        .catch((error) => logger?.warn?.('validation.worker.tick_failed', { error: error?.message }))
        .finally(() => {
          running = false;
        });
    }, pollIntervalMs);
    // A worker must not keep a shutting-down process alive on its own.
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, isRunning: () => timer !== null };
}
