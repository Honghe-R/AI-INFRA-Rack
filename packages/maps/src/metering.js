import { ApiError } from '@ai-infra/core';

/**
 * Tile usage metering.
 *
 * One counter per organization, project, user, provider, and period, in the
 * `map_tile_usage` row created by migration 001 and scoped by migration 005. The
 * quota check and the increment are one transaction with the counter row locked,
 * so the count cannot drift from the enforcement decision (storage-shape, "Map
 * Tile Cache and Usage Metering").
 *
 * Usage counts upstream requests. A cache hit never reaches the provider and is
 * therefore not billed, so it is not counted.
 */
export class QuotaExceededError extends ApiError {
  constructor({ tileCount, quotaLimit, periodEnd }) {
    super('MAP_QUOTA_EXCEEDED', 'The tile quota for this project and provider is exhausted.', {
      status: 429,
      details: [{ tile_count: tileCount, quota_limit: quotaLimit, period_end: periodEnd }],
    });
    this.name = 'QuotaExceededError';
  }
}

/** UTC calendar month containing `at`. */
export function currentPeriod(at = new Date()) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { periodStart: start, periodEnd: end };
}

/**
 * Consumes one tile from the quota. Runs inside the caller's transaction and
 * returns the new count, or throws `QuotaExceededError` without incrementing.
 */
export async function consumeTile(client, {
  organizationId,
  projectId,
  scenarioId = null,
  userId = null,
  provider,
  periodStart,
  periodEnd,
  quotaLimit = null,
  actorId = null,
}) {
  const locked = await client.query(
    `SELECT map_tile_usage_id, tile_count, quota_limit
       FROM map_tile_usage
      WHERE organization_id = $1 AND project_id = $2
        AND user_id IS NOT DISTINCT FROM $3
        AND provider = $4 AND period_start = $5
      FOR UPDATE`,
    [organizationId, projectId, userId, provider, periodStart],
  );

  if (locked.rows.length === 0) {
    const { rows } = await client.query(
      `INSERT INTO map_tile_usage
         (organization_id, project_id, scenario_id, user_id, provider, period_start, period_end, tile_count, quota_limit, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)
       RETURNING tile_count, quota_limit`,
      [organizationId, projectId, scenarioId, userId, provider, periodStart, periodEnd, quotaLimit, actorId],
    );
    return { tileCount: Number(rows[0].tile_count), quotaLimit: rows[0].quota_limit === null ? null : Number(rows[0].quota_limit) };
  }

  const row = locked.rows[0];
  const count = Number(row.tile_count);
  const limit = row.quota_limit === null ? null : Number(row.quota_limit);
  if (limit !== null && count >= limit) {
    throw new QuotaExceededError({ tileCount: count, quotaLimit: limit, periodEnd });
  }

  const { rows } = await client.query(
    `UPDATE map_tile_usage
        SET tile_count = tile_count + 1, quota_limit = COALESCE($2, quota_limit), updated_at = now(), updated_by = $3
      WHERE map_tile_usage_id = $1
      RETURNING tile_count, quota_limit`,
    [row.map_tile_usage_id, quotaLimit, actorId],
  );
  return { tileCount: Number(rows[0].tile_count), quotaLimit: rows[0].quota_limit === null ? null : Number(rows[0].quota_limit) };
}

export async function readUsage(client, { projectId, periodStart }) {
  const { rows } = await client.query(
    `SELECT provider, user_id, tile_count, quota_limit, period_start, period_end
       FROM map_tile_usage
      WHERE project_id = $1 AND period_start = $2
      ORDER BY provider, user_id NULLS FIRST`,
    [projectId, periodStart],
  );
  return rows.map((row) => ({
    provider: row.provider,
    userId: row.user_id,
    tileCount: Number(row.tile_count),
    quotaLimit: row.quota_limit === null ? null : Number(row.quota_limit),
    periodStart: row.period_start,
    periodEnd: row.period_end,
  }));
}
