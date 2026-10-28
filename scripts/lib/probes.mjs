/**
 * Readiness probes for the two local services.
 *
 * Shared by `dev-stack.mjs` (which starts them) and `dev.mjs` (which warns when they are
 * missing), so "ready" means the same thing in both places.
 *
 * Both probe **from the host over the published port**, which is the path the application
 * itself takes. Checking health from inside the container would pass while the port mapping
 * is broken.
 */

export const DEFAULT_DB_PORT = () => process.env.AI_INFRA_DB_PORT ?? '55432';
export const DEFAULT_OBJECT_STORE_PORT = () => process.env.AI_INFRA_OBJECT_STORE_PORT ?? '59000';

/**
 * Probes PostgreSQL the way `pg_isready` does: send an SSLRequest, wait for the server's
 * one-byte answer.
 *
 * Waiting for data on a bare socket does not work — the server speaks only after the client
 * opens the conversation, so a naive probe reports a healthy database as unreachable.
 */
export async function databaseReady(port = DEFAULT_DB_PORT()) {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(port) });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => done(false));
    socket.on('error', () => done(false));
    // A starting database can accept TCP then close before answering SSLRequest.
    socket.on('end', () => done(false));
    socket.on('close', () => done(false));
    socket.on('data', () => done(true));
    socket.on('connect', () => {
      const sslRequest = Buffer.alloc(8);
      sslRequest.writeInt32BE(8, 0);
      sslRequest.writeInt32BE(80877103, 4); // the SSLRequest protocol code
      socket.write(sslRequest);
    });
  });
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { reachable: true, status: response.status };
  } catch {
    return { reachable: false, status: null };
  }
}

/**
 * Reachable means "something answered", not "something answered 200".
 *
 * The configured store is MinIO by default, whose health path is definitive. Any other
 * S3-compatible endpoint answers its root with 200 or 403 depending on credentials, and
 * either proves it is listening — which is the only question a readiness check should ask.
 */
export async function objectStoreReady(
  endpoint = process.env.STORAGE_ENDPOINT ?? `http://127.0.0.1:${DEFAULT_OBJECT_STORE_PORT()}`,
) {
  const base = endpoint.replace(/\/+$/, '');
  const health = await responds(`${base}/minio/health/live`);
  if (health.reachable && health.status < 400) return true;
  const root = await responds(`${base}/`);
  return root.reachable;
}
