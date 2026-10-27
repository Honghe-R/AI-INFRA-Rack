/**
 * Minimal router carrying per-route policy metadata, including path parameters.
 *
 * A route path may name parameters as `:name`, for example
 * `/api/v1/projects/:projectId/scenarios`. A parameter matches exactly one
 * non-empty path segment, so it can never swallow a separator or match nothing
 * at all, and a captured value is percent-decoded: the raw path segment is not
 * the identifier the caller meant.
 *
 * When several patterns match one path, the pattern with the most literal
 * segments wins, so a fixed route is never shadowed by a parameterized neighbour
 * regardless of registration order. Ties keep registration order.
 *
 * Route options understood by the pipeline:
 *   `public: true`      — skip authentication (probes only)
 *   `permission`        — a permission key the guard must allow
 *   `projectParam`      — where the guard finds the project scope
 *   `organisationParam` — where the guard finds the organisation scope
 *   `streamBody`        — the handler consumes the raw request body, so the
 *                         pipeline must not pre-read it as JSON (asset intake)
 */
export function createRouter() {
  const routes = [];

  const api = {
    add(method, path, handler, options = {}) {
      const segments = compile(path);
      routes.push({
        method: method.toUpperCase(),
        path,
        handler,
        options,
        segments,
        literals: segments.filter((segment) => !segment.param).length,
      });
      return api;
    },
    get: (path, handler, options) => api.add('GET', path, handler, options),
    post: (path, handler, options) => api.add('POST', path, handler, options),
    put: (path, handler, options) => api.add('PUT', path, handler, options),
    patch: (path, handler, options) => api.add('PATCH', path, handler, options),
    delete: (path, handler, options) => api.add('DELETE', path, handler, options),

    /**
     * Returns `{found:false}`, `{found:true, allowed:[...]}`, or
     * `{found:true, route, params}`. `params` is empty for a fixed path.
     */
    match(method, pathname) {
      const matches = [];
      for (const route of routes) {
        const params = capture(route.segments, pathname);
        if (params) matches.push({ route, params });
      }
      if (matches.length === 0) return { found: false };

      const wanted = method.toUpperCase();
      const permitted = matches.filter((candidate) => candidate.route.method === wanted);
      if (permitted.length === 0) {
        return {
          found: true,
          allowed: [...new Set(matches.map((candidate) => candidate.route.method))].sort(),
        };
      }

      // Array.prototype.sort is stable, so equal specificity keeps registration
      // order and the choice stays deterministic.
      permitted.sort((a, b) => b.route.literals - a.route.literals);
      return { found: true, route: permitted[0].route, params: permitted[0].params };
    },

    get routes() {
      return routes.slice();
    },
  };

  return api;
}

function compile(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`A route path must be an absolute path; received "${path}".`);
  }
  return path
    .slice(1)
    .split('/')
    .map((segment) =>
      segment.startsWith(':') && segment.length > 1
        ? { param: true, name: segment.slice(1) }
        : { param: false, literal: segment },
    );
}

/**
 * Returns the captured parameters when `pathname` matches, or `null`.
 *
 * Segment counts must be equal, so `/api/v1/projects/` does not match
 * `/api/v1/projects`: a trailing slash is a different path, exactly as it was
 * when matching was literal.
 */
function capture(segments, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;

  const parts = pathname.slice(1).split('/');
  if (parts.length !== segments.length) return null;

  const params = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const value = parts[index];

    if (!segment.param) {
      if (segment.literal !== value) return null;
      continue;
    }

    // An empty segment is a missing parameter, not an empty one.
    if (value === '') return null;
    try {
      params[segment.name] = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding cannot be an identifier; treat it as no match
      // so the caller gets a 404 rather than a throw from the router.
      return null;
    }
  }
  return params;
}
