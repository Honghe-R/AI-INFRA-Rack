import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { assertUuid } from '@ai-infra/db';
import { LlmError } from './errors.js';

/**
 * Session and turn persistence (chatbox blueprint §4.9).
 *
 * Two planes: a relational index row per session for listing and authorization,
 * and gzipped turn objects in the private object store for content. Only the newly
 * submitted message is persisted per turn; replay reconstructs the rest. Turns are
 * deduplicated by request id, so a retried request never appends twice.
 */
export function createSessionService({ pool = null, storage, now = () => new Date(), ids = () => randomUUID() } = {}) {
  if (!storage) throw new Error('createSessionService requires a storage adapter.');

  function baseKey(userId, sessionId) {
    return `assistant/${segment(userId)}/${segment(sessionId)}`;
  }

  async function ensure({ sessionId = null, userId, contextKey, surface, workspaceId = null, organisationId = null }) {
    if (!userId) throw new LlmError('ASSISTANT_SESSION_OWNER_REQUIRED', 'A session requires an owner.', { status: 500 });
    if (!pool) throw new Error('createSessionService without a pool cannot ensure a session.');

    if (sessionId) {
      assertUuid(sessionId, 'session_id');
      const existing = await pool.query(
        `SELECT session_id, user_id, context_key, surface, workspace_id, organisation_id, title, turn_count, last_activity_at
           FROM assistant_sessions WHERE session_id = $1`,
        [sessionId],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.user_id !== userId) {
          // Refuse rather than silently adopting another user's session.
          throw new LlmError('ASSISTANT_SESSION_FORBIDDEN', 'That session belongs to another user.', { status: 403 });
        }
        if (row.context_key !== contextKey) {
          return create({ userId, contextKey, surface, workspaceId, organisationId });
        }
        return mapSession(row);
      }
      return create({ userId, contextKey, surface, workspaceId, organisationId, sessionId });
    }
    return create({ userId, contextKey, surface, workspaceId, organisationId });
  }

  async function create({ userId, contextKey, surface, workspaceId, organisationId, sessionId = null }) {
    const id = sessionId ?? ids();
    const { rows } = await pool.query(
      `INSERT INTO assistant_sessions (session_id, user_id, context_key, surface, workspace_id, organisation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO NOTHING
       RETURNING session_id, user_id, context_key, surface, workspace_id, organisation_id, title, turn_count, last_activity_at`,
      [id, userId, contextKey, surface, workspaceId, organizationOrNull(organisationId)],
    );
    return rows.length > 0 ? mapSession(rows[0]) : mapSession((await pool.query('SELECT * FROM assistant_sessions WHERE session_id = $1', [id])).rows[0]);
  }

  /** Appends one turn, deduplicated by request id. Returns the stored turn number or null. */
  async function appendTurn({ sessionId, requestId, turn }) {
    if (!pool) throw new Error('createSessionService without a pool cannot append a turn.');
    assertUuid(sessionId, 'session_id');
    assertUuid(requestId, 'request_id');

    const session = (await pool.query('SELECT session_id, user_id, context_key FROM assistant_sessions WHERE session_id = $1', [sessionId])).rows[0];
    if (!session) throw new LlmError('ASSISTANT_SESSION_NOT_FOUND', 'The session was not found.', { status: 404 });

    const claimed = await pool.query(
      `INSERT INTO assistant_turns (session_id, turn_number, request_id)
       SELECT $1, COALESCE(MAX(turn_number), 0) + 1, $2 FROM assistant_turns WHERE session_id = $1
       ON CONFLICT (session_id, request_id) DO NOTHING
       RETURNING turn_number`,
      [sessionId, requestId],
    );
    if (claimed.rows.length === 0) return null; // A retry, already stored.

    const turnNumber = claimed.rows[0].turn_number;
    const key = `${baseKey(session.user_id, sessionId)}/turns/${pad(turnNumber)}-${segment(requestId)}.json.gz`;
    await storage.putObject({ key, body: gzipSync(Buffer.from(JSON.stringify(turn))), contentType: 'application/gzip' });

    const manifestKey = `${baseKey(session.user_id, sessionId)}/manifest.json.gz`;
    const current = await readManifest(manifestKey);
    current.turns = [...current.turns.filter((entry) => entry.turnNumber !== turnNumber), { turnNumber, requestId, key }].sort((left, right) => left.turnNumber - right.turnNumber);
    await storage.putObject({ key: manifestKey, body: gzipSync(Buffer.from(JSON.stringify(current))), contentType: 'application/gzip' });

    await pool.query(
      `UPDATE assistant_turns SET storage_key = $3 WHERE session_id = $1 AND request_id = $2`,
      [sessionId, requestId, key],
    );
    await pool.query(
      `UPDATE assistant_sessions
          SET turn_count = (SELECT count(*) FROM assistant_turns WHERE session_id = $1),
              last_activity_at = now(), updated_at = now()
        WHERE session_id = $1`,
      [sessionId],
    );
    return turnNumber;
  }

  async function list({ userId, contextKey = null }) {
    if (!pool) return [];
    const { rows } = await pool.query(
      `SELECT session_id, user_id, context_key, surface, workspace_id, organisation_id, title, turn_count, last_activity_at
         FROM assistant_sessions
        WHERE user_id = $1 AND ($2::text IS NULL OR context_key = $2)
        ORDER BY last_activity_at DESC NULLS LAST, created_at DESC`,
      [userId, contextKey],
    );
    return rows.map(mapSession);
  }

  /**
   * Loads visible history. Owner or context mismatch returns an empty history, not
   * an error, and system messages never leave the store.
   */
  async function load({ sessionId, userId, contextKey }) {
    if (!pool) return { sessionId, turns: [] };
    const row = (await pool.query('SELECT * FROM assistant_sessions WHERE session_id = $1', [sessionId])).rows[0];
    if (!row || row.user_id !== userId || row.context_key !== contextKey) {
      return { sessionId, contextKey, turns: [] };
    }

    const manifest = await readManifest(`${baseKey(userId, sessionId)}/manifest.json.gz`);
    const turns = [];
    for (const entry of manifest.turns) {
      const object = await storage.getObject({ key: entry.key });
      if (!object) continue;
      const chunks = [];
      for await (const chunk of object.body) chunks.push(chunk);
      turns.push({ turnNumber: entry.turnNumber, requestId: entry.requestId, ...JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8')) });
    }
    return { sessionId, contextKey, turnCount: turns.length, turns };
  }

  async function readManifest(key) {
    const object = await storage.getObject({ key }).catch(() => null);
    if (!object) return { schemaVersion: 1, turns: [] };
    const chunks = [];
    for await (const chunk of object.body) chunks.push(chunk);
    try {
      return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
    } catch {
      return { schemaVersion: 1, turns: [] };
    }
  }

  return { ensure, appendTurn, list, load };
}

function mapSession(row) {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    contextKey: row.context_key,
    surface: row.surface,
    workspaceId: row.workspace_id,
    organisationId: row.organisation_id,
    title: row.title,
    turnCount: row.turn_count,
    lastActivityAt: row.last_activity_at,
  };
}

function pad(value) {
  return String(value).padStart(6, '0');
}

/** Every key segment is sanitized so a hostile id cannot escape its prefix. */
function segment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function organizationOrNull(value) {
  return value ?? null;
}
