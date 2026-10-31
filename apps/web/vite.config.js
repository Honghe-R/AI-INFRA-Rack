import { execFileSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { SignJWT } from 'jose';
import { fileURLToPath } from 'node:url';
import { clientIdentities, devSubjects } from '../../scripts/lib/dev-identities.mjs';
import { createAccountStore, createRackAuthMiddleware, RACK_GATEWAY_TOKEN } from '../../scripts/lib/rack-auth.mjs';

/** The repository root, where `.env` lives — one level above `apps/web`. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// This config is an object rather than a function, so there is no `mode` argument to
// receive. Vite sets NODE_ENV to match its own mode, which is what this needs.
const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';

/**
 * Development token bridge.
 *
 * The shell has no sign-in surface yet, so the browser cannot obtain a token.
 * Rather than put `AUTH_DEV_SECRET` in the client bundle — where it would be
 * readable by anyone with the page open — the dev server mints a short-lived
 * token and attaches it to proxied API requests. The secret stays in the dev
 * server process.
 *
 * This is a development affordance with no production path: it only exists in
 * `server.proxy`, which `vite build` and `vite preview` never use, and it
 * refuses to attach anything when the secret is absent.
 */
const DEV_TOKEN_TTL_SECONDS = 60 * 60;

function createDevTokenMinter({ secret, issuer, audience, subject }) {
  const key = new TextEncoder().encode(secret);

  async function mint() {
    const now = Math.floor(Date.now() / 1000);
    const builder = new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + DEV_TOKEN_TTL_SECONDS);
    if (audience) builder.setAudience(audience);
    return builder.sign(key);
  }

  return { mint };
}

// Vite loads `.env` files into `import.meta.env` for the client, but that exposes only
// VITE_-prefixed values and never touches `process.env`, which is what this file reads. So
// the repository `.env` is loaded explicitly here, with the real environment taking
// precedence — a deployment, or a one-off export, always wins over the file.
const rootEnv = loadEnv(mode, REPO_ROOT, '');
const readEnv = (name) => process.env[name] ?? rootEnv[name] ?? null;

/**
 * The commit this bundle is built from.
 *
 * Compiled into the bundle rather than read from the API on purpose: the browser has to be
 * able to say which build it is actually running, and a value served by the API describes
 * the server — a cached bundle would report the new one. `GIT_COMMIT` or `SOURCE_VERSION`
 * wins when a build system exports it, because a build from a checkout-less context has no
 * `.git` to ask; otherwise the repository's own HEAD. A build that can resolve neither
 * injects an empty string, and the line is not drawn rather than shown empty.
 */
function resolveBuildCommit() {
  const declared = readEnv('GIT_COMMIT') ?? readEnv('SOURCE_VERSION');
  if (declared) return String(declared).trim();
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const buildCommit = resolveBuildCommit();

const devSecret = readEnv('AUTH_DEV_SECRET');
const devSubject = readEnv('AUTH_DEV_SUBJECT') ?? 'dev-user';
const issuer = readEnv('AUTH_ISSUER') ?? 'https://identity.local';
const authMode = readEnv('RACK_AUTH_MODE') ?? 'password';
if (!['password', 'demo'].includes(authMode)) throw new Error('RACK_AUTH_MODE must be password or demo.');
const demoAuth = authMode === 'demo' && mode === 'development';
const webPort = Number(readEnv('WEB_PORT') ?? 5173);
const accountStore = createAccountStore({ file: fileURLToPath(new URL('../../.local-runtime/auth/accounts.json', import.meta.url)) });
async function mintSessionToken(subject) {
  if (!devSecret) throw new Error('The local authentication gateway is not configured.');
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(subject).setIssuer(issuer)
    .setIssuedAt().setExpirationTime('5m')
    .setAudience(readEnv('AUTH_AUDIENCE') || 'ai-infra-local').sign(new TextEncoder().encode(devSecret));
}

/**
 * One token per identity, minted up front.
 *
 * The proxy's request hook is synchronous — it has to be, because the upstream request is
 * already in flight — so a token cannot be minted on demand there. Minting every subject
 * at startup keeps that hook a map lookup, and there are four of them.
 *
 * `devSubjects` is the shared list, which is also what the seed creates users for and what
 * the account menu offers, so a subject can never be selectable without a token.
 */
const tokensBySubject = new Map();
const subjects = devSubjects({ include: devSubject });
if (devSecret && demoAuth) {
  const minters = subjects.map((subject) => ({
    subject,
    minter: createDevTokenMinter({ secret: devSecret, issuer, audience: readEnv('AUTH_AUDIENCE'), subject }),
  }));

  const refresh = async () => {
    for (const { subject, minter } of minters) {
      try {
        tokensBySubject.set(subject, await minter.mint());
      } catch {
        // A failure leaves the previous token in place; the next tick tries again.
      }
    }
  };

  await refresh();
  // Refresh well before expiry so a long dev session does not start failing.
  setInterval(refresh, DEV_TOKEN_TTL_SECONDS * 1000 * 0.75).unref?.();
}

/**
 * The identity a request asked to act as.
 *
 * This is a development affordance and nothing else, which is why it lives in a Vite dev
 * server: `server.proxy` does not exist in a build, and the whole block above is skipped
 * when there is no dev secret, so a deployment has neither the header nor the tokens. The
 * header is deleted before the request is forwarded, so the API never sees it and cannot
 * be talked into trusting it.
 */
const IDENTITY_HEADER = 'x-dev-subject';

function identityMiddleware() {
  return {
    name: 'dev-identities',
    // `configureServer` returning a function runs it *after* Vite's internal middleware,
    // and the proxy is internal — so this must be a pre-hook to be reachable at all. The
    // path is deliberately not under /api, which the proxy owns.
    configureServer(server) {
      if (demoAuth && !['127.0.0.1', 'localhost', '::1'].includes(server.config.server.host ?? 'localhost'))
        throw new Error('Demo impersonation requires a loopback-bound server.');
      if (!demoAuth) server.middlewares.use(createRackAuthMiddleware({
        store: accountStore, mint: mintSessionToken,
        allowedOrigins: (readEnv('RACK_AUTH_ORIGINS') ?? `http://localhost:${webPort},http://127.0.0.1:${webPort}`).split(',').map(s => s.trim()).filter(Boolean),
        secure: readEnv('RACK_AUTH_COOKIE_SECURE') === 'true',
        validateAccount: async account => {
          const response = await fetch(`${apiTarget}/api/v1/me/permissions`, { headers: { authorization: `Bearer ${await mintSessionToken(account.subject)}` }, signal: AbortSignal.timeout(5000) });
          if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Account name or password is incorrect.'), { status: 401, code: 'INVALID_CREDENTIALS' });
          if (!response.ok) throw new Error('Backend identity service is unavailable.');
        },
      }));
      else server.middlewares.use('/__auth/session', (request, response) => {
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ data: { mode: 'demo', account: null } }));
      });
      server.middlewares.use('/__dev/identities', (request, response) => {
        if (!devSecret || !demoAuth) {
          response.statusCode = 404;
          response.end('{}');
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        // Projected rather than the whole record: the seed's list carries the role key, the
        // scope it is held at, and the organisation-scope read role, and the menu answers a
        // question none of those are about. See `clientIdentity`.
        response.end(JSON.stringify({ data: { defaultSubject: devSubject, identities: clientIdentities() } }));
      });
    },
  };
}

const apiTarget = readEnv('API_URL') ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), identityMiddleware()],
  // The build identity the Settings menu draws (`src/app/build-info.js`). A bare identifier
  // rather than a `VITE_`-prefixed one because the value is computed here, not loaded from
  // `.env`: declaring it as `import.meta.env.*` would collide with the values Vite already
  // substitutes from the environment.
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  // Vitest resolves its own Vite/esbuild transform rather than the app build's
  // oxc path, so the JSX runtime must be stated for the test runner. Without it
  // JSX compiles to `React.createElement` and every component test fails with
  // "React is not defined". The app build ignores this option (it warns as much)
  // and gets the automatic runtime from the React plugin instead.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.{js,jsx}'],
  },
  server: {
    host: readEnv('HOST') ?? '127.0.0.1',
    port: webPort,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-runtime/**'] },
    // Vite's default is to move to the next free port, which quietly puts the shell
    // somewhere other than where the documentation, the README, and your bookmark say it
    // is. Failing loudly is the kinder behaviour.
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, request) => {
            // Read the cached token synchronously: the proxy does not await this handler,
            // so an await here would race the request.
            const asked = request.headers[IDENTITY_HEADER];
            const token = demoAuth ? tokensBySubject.get(asked) ?? tokensBySubject.get(devSubject) : request[RACK_GATEWAY_TOKEN];
            proxyReq.removeHeader('authorization');
            if (token) proxyReq.setHeader('authorization', `Bearer ${token}`);
            // The API authenticates on the bearer token and must never see this, or a
            // client could name its own identity against the real service.
            proxyReq.removeHeader(IDENTITY_HEADER);
          });
        },
      },
    },
  },
});
