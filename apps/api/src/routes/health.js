import { errors } from '@ai-infra/core';

/**
 * Liveness and readiness.
 *
 * `/healthz` answers "is the process alive" and never touches a dependency.
 * `/readyz` answers "should this instance receive traffic" and fails closed when
 * the database is missing or unreachable.
 */
export function registerHealthRoutes(router) {
  router.get('/healthz', async () => ({
    data: { status: 'ok' },
    meta: { probe: 'liveness' },
  }), { public: true });

  router.get('/readyz', async ({ pool }) => {
    if (!pool) throw errors.serviceUnavailable('No database is configured.');
    try {
      await pool.query('SELECT 1');
    } catch {
      throw errors.serviceUnavailable('The database is not reachable.');
    }
    return { data: { status: 'ready' }, meta: { probe: 'readiness' } };
  }, { public: true });
}
