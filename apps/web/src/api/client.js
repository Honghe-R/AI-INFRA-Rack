/**
 * The platform API client.
 *
 * Every response is unwrapped from the documented envelope, and every failure
 * becomes an error carrying the server's machine code, status, details, and
 * correlation id — so the shell never has to parse a human sentence to learn what
 * happened, and a user-facing error can quote the correlation id for support.
 *
 * Uploads are the one place the client sends bytes rather than JSON: intake
 * streams the file to the version's content resource (D23), so no storage
 * credential and no upload URL ever exists on the client.
 */
import { DEV_IDENTITY_HEADER, currentDevIdentity } from '../app/dev-identity.js';

export function createApiClient({ baseUrl = '', fetchImpl = globalThis.fetch, identity = currentDevIdentity } = {}) {
  async function unwrap(response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error?.message ?? `Request failed with status ${response.status}`);
      error.code = payload?.error?.code ?? 'HTTP_ERROR';
      error.status = response.status;
      error.details = payload?.error?.details ?? [];
      error.correlationId = payload?.meta?.correlation_id ?? null;
      throw error;
    }
    return { data: payload?.data ?? null, meta: payload?.meta ?? null };
  }

  async function request(path, { method = 'GET', body = null, headers = {}, signal = null } = {}) {
    // Reading the identity per request rather than once keeps a switch from needing the
    // client to be rebuilt, and keeps a stale subject from outliving the choice.
    const devSubject = identity?.() ?? null;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      // Bypass existing cached lifecycle responses, including a prior 410.
      ...(path.includes('/rack/') || path.includes('/assistant/') || /\/members(?:\/|\?|$)|\/member-candidates(?:\?|$)/.test(path) ? { cache: 'no-store' } : {}),
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        // The dev proxy turns this into a bearer token and strips it before forwarding;
        // a deployment has no proxy and no header, so this is inert there.
        ...(devSubject ? { [DEV_IDENTITY_HEADER]: devSubject } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // A turn is cancellable: the composer's stop control aborts the provider call
      // server-side, and the signal is what carries that intent.
      ...(signal ? { signal } : {}),
    });
    return unwrap(response);
  }

  function assetPath(projectId, suffix = '') {
    return `/api/v1/projects/${encodeURIComponent(projectId)}/assets${suffix}`;
  }

  function facilityRevisionPath(projectId, revisionId, suffix = '') {
    return `/api/v1/projects/${encodeURIComponent(projectId)}/facility/revisions/${encodeURIComponent(revisionId)}${suffix}`;
  }

  return {
    request,
    /** Projects are listed within one organisation; see routes/projects.js. */
    listProjects: (organisationId) =>
      request(`/api/v1/projects?organisation_id=${encodeURIComponent(organisationId)}`),
    /**
     * The scenarios of one project, each with its active revision. Opening a
     * project needs a revision identifier, which only this read provides.
     */
    listScenarios: (projectId) => request(`/api/v1/projects/${encodeURIComponent(projectId)}/scenarios`),
    listProjectMembers: (projectId, { offset = 0, signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/members?offset=${offset}&limit=20`, { signal }),
    findProjectMemberCandidates: (projectId, query = '', { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/member-candidates?q=${encodeURIComponent(query)}&limit=20`, { signal }),
    setProjectMember: (projectId, userId, body, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'PUT', body, signal }),

    getRackCatalog: (projectId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/catalog`, { signal }),
    listRackPlans: (projectId, { scenarioId, revisionId, cursor, limit = 20, deleted = false, signal } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (scenarioId) query.set('scenario_id', scenarioId);
      if (revisionId) query.set('revision_id', revisionId);
      if (cursor) query.set('cursor', cursor);
      if (deleted) query.set('deleted', 'true');
      return request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans?${query}`, { signal });
    },
    manageRackPlan: (projectId, planId, operation, body, { version, idempotencyKey, signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}${operation === 'restore' ? '/restore' : ''}`, {
        method: operation === 'rename' ? 'PATCH' : operation === 'delete' ? 'DELETE' : 'POST', body, signal,
        headers: { 'If-Match': `"${version}"`, 'Idempotency-Key': idempotencyKey },
      }),
    getRackPlan: (projectId, planId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}`, { signal }),
    getRackRoomView: (projectId, planId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/room-view`, { signal }),
    getRackLayout: (projectId, planId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/layout`, { signal }),
    checkRackLayout: (projectId, planId, body, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/layout/check`, {method:'POST',body,signal}),
    listRackCheckRuns: (projectId, planId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/check-runs`, {signal}),
    getRackCheckRun: (projectId, planId, runId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/check-runs/${encodeURIComponent(runId)}`, {signal}),
    recordRackCheckRun: (projectId, planId, body, { idempotencyKey, signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/check-runs`,
        {method:'POST',body,signal,headers:{'Idempotency-Key':idempotencyKey}}),
    getRackReport: (projectId, planId, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/report`, {signal}),
    generateRackOptions: (projectId, planId, body, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/layout/options`, {method:'POST',body,signal}),
    generateRackDesignOptions: (projectId, planId, body, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/layout/design-options`, {method:'POST',body,signal}),
    generateRackEquipmentOption: (projectId, planId, body, { signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/layout/equipment-options`, {method:'POST',body,signal}),
    saveRackLayout: (projectId, planId, body, { version, idempotencyKey, signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/layout`,
        {method:'PUT',body,signal,headers:{'If-Match':`"${version}"`,'Idempotency-Key':idempotencyKey}}),
    captureRackRoom: (projectId, planId, { version, idempotencyKey, signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans/${encodeURIComponent(planId)}/room-snapshot`,
        {method:'POST',body:{contract_version:1},signal,headers:{'If-Match':`"${version}"`,'Idempotency-Key':idempotencyKey}}),
    createRackPlan: (projectId, body, { idempotencyKey, signal } = {}) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/rack/plans`, {
        method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey }, signal,
      }),

    /** Project assets, newest first, with optional filters. */
    listAssets: (projectId, filters = {}) => {
      const query = new URLSearchParams();
      if (filters.kind) query.set('kind', filters.kind);
      if (filters.status) query.set('status', filters.status);
      if (filters.mediaType) query.set('media_type', filters.mediaType);
      if (filters.q) query.set('q', filters.q);
      const suffix = query.size > 0 ? `?${query}` : '';
      return request(assetPath(projectId, suffix));
    },
    getAsset: (projectId, assetId) => request(assetPath(projectId, `/${encodeURIComponent(assetId)}`)),
    createAsset: (projectId, body) => request(assetPath(projectId), { method: 'POST', body }),
    createAssetVersion: (projectId, assetId, body) =>
      request(assetPath(projectId, `/${encodeURIComponent(assetId)}/versions`), { method: 'POST', body }),
    patchAsset: (projectId, assetId, body) =>
      request(assetPath(projectId, `/${encodeURIComponent(assetId)}`), { method: 'PATCH', body }),
    archiveAsset: (projectId, assetId, archived = true) =>
      request(assetPath(projectId, `/${encodeURIComponent(assetId)}/archive`), { method: 'POST', body: { archived } }),
    deleteAsset: (projectId, assetId) =>
      request(assetPath(projectId, `/${encodeURIComponent(assetId)}`), { method: 'DELETE' }),
    downloadAsset: (projectId, assetId, assetVersionId) =>
      request(assetPath(projectId, `/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(assetVersionId)}/download`)),
    getAssetJob: (projectId, jobId) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/asset-jobs/${encodeURIComponent(jobId)}`),

    /**
     * Streams one file to a reserved version. The body is the file itself, so this
     * does not go through `request`'s JSON path; `duplex: 'half'` is what lets
     * fetch send a streaming request body.
     */
    async uploadAssetContent(projectId, assetId, assetVersionId, file) {
      // A streamed body bypasses `request`, so it needs the identity header of its own.
      const devSubject = identity?.() ?? null;
      const response = await fetchImpl(
        `${baseUrl}${assetPath(projectId, `/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(assetVersionId)}/content`)}`,
        {
          method: 'PUT',
          headers: {
            accept: 'application/json',
            'content-type': file.type || 'application/octet-stream',
            ...(devSubject ? { [DEV_IDENTITY_HEADER]: devSubject } : {}),
          },
          body: file,
          duplex: 'half',
        },
      );
      return unwrap(response);
    },

    /**
     * One assistant turn. The server owns the provider, the tools, and the
     * persistence, so the client sends its transcript and reads back the
     * client-facing envelope (choices, entities, uiActions, usage, trace).
     */
    sendAssistantTurn: (body, { signal = null } = {}) =>
      request('/api/v1/assistant/chat', { method: 'POST', body, signal }),

    /**
     * The same turn, with each round delivered as it completes.
     *
     * Newline-delimited JSON rather than SSE: the turn is a POST, and a `fetch` body stream
     * can be read where `EventSource` cannot send one. Every record is one line, the final
     * envelope arrives as `{type:'turn'}`, and a failure after the headers are out arrives as
     * `{type:'error'}` — which is the point of the mode: a turn that times out at 55s still
     * leaves the rounds that completed, where today they are lost with the error.
     */
    async streamAssistantTurn(body, { signal = null, onEvent = null } = {}) {
      const devSubject = identity?.() ?? null;
      const response = await fetchImpl(`${baseUrl}/api/v1/assistant/chat?stream=1`, {
        method: 'POST',
        headers: {
          accept: 'application/x-ndjson',
          'content-type': 'application/json',
          ...(devSubject ? { [DEV_IDENTITY_HEADER]: devSubject } : {}),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

      // Refusals that happen before the turn starts are still a status and a JSON envelope:
      // unknown model, no permission, malformed body. Only failures *inside* the loop arrive
      // as a record, because by then the status is already committed.
      if (!response.ok) {
        await unwrap(response);
        return null;
      }
      if (!response.body) throw new Error('The assistant stream carried no body.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let turn = null;

      const handle = (line) => {
        if (!line) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return; // A truncated line is not worth failing a turn over; the next one is whole.
        }
        if (event.type === 'turn') turn = event.data;
        else if (event.type === 'error') {
          const error = new Error(event.error?.message ?? 'The turn failed.');
          error.code = event.error?.code ?? null;
          throw error;
        } else onEvent?.(event);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          handle(buffered.slice(0, newline).trim());
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
      }
      handle(buffered.trim());
      return turn;
    },
    /** Sessions for one chat context; a different context never lists another's. */
    listAssistantSessions: (contextKey) =>
      request(`/api/v1/assistant/sessions?context_key=${encodeURIComponent(contextKey)}`),
    loadAssistantHistory: (sessionId, contextKey) =>
      request(
        `/api/v1/assistant/sessions/${encodeURIComponent(sessionId)}/history?context_key=${encodeURIComponent(contextKey)}`,
      ),
    getAssistantUsage: () => request('/api/v1/assistant/usage'),
    /**
     * Which provider and model the server is using. The server owns that choice, so the
     * client asks rather than assumes; the composer shows it, so a reviewer can see what
     * is answering without any credential reaching the browser.
     */
    getAssistantProvider: () => request('/api/v1/assistant/provider'),
    getAssistantConnection: ({ signal } = {}) => request('/api/v1/assistant/connection', { signal }),
    saveAssistantConnection: (body, { signal } = {}) => request('/api/v1/assistant/connection', { method: 'PUT', body, signal }),
    deleteAssistantConnection: (version, { signal } = {}) => request('/api/v1/assistant/connection', { method: 'DELETE', body: { version }, signal }),
    testAssistantConnection: (connectionId, version, { signal } = {}) => request('/api/v1/assistant/connection/test', { method: 'POST', body: { connectionId, version }, signal }),

    /**
     * The normalized facility graph for one revision: design scope, containers,
     * geometry (WGS 84 GeoJSON), utility sources and interfaces, and spatial
     * constraints. `capabilityCoverage` is empty until T4 derives it, so a caller
     * must not read the empty list as "validated".
     */
    getFacilityEnvelope: (projectId, revisionId, { signal } = {}) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/facility/revisions/${encodeURIComponent(revisionId)}`,
        { signal },
      ),

    /**
     * The verification surface (verification-requirements.md,
     * backend-api-contracts.md).
     *
     * `requestFacilityValidation` answers two ways: a small `AFFECTED_SUBGRAPH`
     * run replies inline with its diagnostics and coverage, while a `FULL` run is
     * a job — the client gets a `jobId` and polls `getJob` rather than holding a
     * request open (non-functional-requirements.md, "Jobification"). The caller
     * distinguishes them by `mode`, never by which keys happen to be present.
     */
    requestFacilityValidation: (projectId, revisionId, body = {}) =>
      request(facilityRevisionPath(projectId, revisionId, '/validate'), { method: 'POST', body }),

    /** One completed run with its diagnostics and the coverage it derived. */
    getFacilityValidationRun: (projectId, revisionId, runId) =>
      request(facilityRevisionPath(projectId, revisionId, `/validation-runs/${encodeURIComponent(runId)}`)),

    /** Diagnostics for a revision, newest run included; filters are server-side. */
    listFacilityDiagnostics: (projectId, revisionId, filters = {}) => {
      const query = new URLSearchParams();
      if (filters.runId) query.set('run_id', filters.runId);
      if (filters.severity) query.set('severity', filters.severity);
      if (filters.status) query.set('status', filters.status);
      if (filters.constraintId) query.set('constraint_id', filters.constraintId);
      if (filters.capability) query.set('capability', filters.capability);
      // Superseded diagnostics are history and are excluded by default; a caller
      // that shows history behind a toggle asks for them explicitly.
      if (filters.includeSuperseded) query.set('include_superseded', 'true');
      if (filters.cursor) query.set('cursor', filters.cursor);
      if (filters.limit) query.set('limit', String(filters.limit));
      const suffix = query.size > 0 ? `/diagnostics?${query}` : '/diagnostics';
      return request(facilityRevisionPath(projectId, revisionId, suffix));
    },

    /**
     * Derived capability coverage. An unvalidated draft has no rows at all, which
     * is "not derived" — never a passing verdict.
     */
    listFacilityCoverage: (projectId, revisionId) =>
      request(facilityRevisionPath(projectId, revisionId, '/coverage')),

    listFacilityWaivers: (projectId, revisionId) =>
      request(facilityRevisionPath(projectId, revisionId, '/waivers')),

    /**
     * The import path (ui-pattern.md, "Import Flow"): which project asset versions
     * this revision consumes, and pinning one.
     *
     * Binding is not an edit. It creates provenance — no transform, no mapping, no
     * imported entity — so it carries no `If-Match` and returns no new draft token;
     * applying an import is what advances the ETag.
     */
    listFacilityAssetBindings: (projectId, revisionId, filters = {}) => {
      const query = new URLSearchParams();
      if (filters.role) query.set('role', filters.role);
      if (filters.status) query.set('status', filters.status);
      if (filters.assetVersionId) query.set('asset_version_id', filters.assetVersionId);
      const suffix = query.size > 0 ? `/asset-bindings?${query}` : '/asset-bindings';
      return request(facilityRevisionPath(projectId, revisionId, suffix));
    },

    createFacilityAssetBinding: (projectId, revisionId, body) =>
      request(facilityRevisionPath(projectId, revisionId, '/asset-bindings'), { method: 'POST', body }),

    /** Granting a waiver is a governance act, not an edit: its own permission key. */
    grantFacilityWaiver: (projectId, revisionId, body) =>
      request(facilityRevisionPath(projectId, revisionId, '/waivers'), { method: 'POST', body }),

    revokeFacilityWaiver: (projectId, waiverId, body = {}) =>
      request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/facility/waivers/${encodeURIComponent(waiverId)}/revoke`,
        { method: 'POST', body },
      ),

    /**
     * One typed change set, committed atomically. The draft ETag travels in the body and
     * the optional `Idempotency-Key` as a header, so a retry after a network failure
     * returns the first result instead of applying the edit twice.
     */
    applyFacilityChangeSet: (projectId, revisionId, body, { idempotencyKey = null } = {}) =>
      request(facilityRevisionPath(projectId, revisionId, '/changes'), {
        method: 'POST',
        body,
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
      }),

    /** The phase plan, which an inspector needs to offer a phase to assign to. */
    listFacilityPhases: (projectId, revisionId) =>
      request(facilityRevisionPath(projectId, revisionId, '/phases')),

    /**
     * Job polling. The job's project travels as a query parameter by contract, so
     * the server's guard resolves a real project scope instead of checking the key
     * unscoped.
     */
    getJob: (projectId, jobId) =>
      request(`/api/v1/jobs/${encodeURIComponent(jobId)}?project_id=${encodeURIComponent(projectId)}`),

    /** Registered basemap providers and this project's choice (D16). */
    listMapProviders: (projectId) =>
      request(`/api/v1/map/providers?project_id=${encodeURIComponent(projectId)}`),
    setMapProvider: (projectId, body) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/map/provider`, { method: 'PUT', body }),
    getMapUsage: (projectId) =>
      request(`/api/v1/projects/${encodeURIComponent(projectId)}/map/usage`),
  };
}
