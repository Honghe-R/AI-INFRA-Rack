# Chat Surface + LLM Backend — Architecture Blueprint

A vendor-neutral architectural reference for building an in-app assistant: a browser chat
surface backed by a server-side *agentic* orchestrator that loops over typed tools and returns
both prose and a small set of allow-listed browser effects.

This document describes **patterns, boundaries, contracts and invariants**, not a detailed
design specification. It deliberately omits product names, domain data, deployment values,
vendor endpoints, credentials, storage names and concrete identifiers. Adapt the names; keep
the seams.

---

## 1. Scope and how to read it

The subject is a chat assistant embedded in a rich client (a map/workspace UI) with a separate
application server. The distinctive properties worth copying are:

- The model never talks to the browser directly. The browser talks to one server endpoint; the
  server owns provider selection, prompting, tool execution, budgets and persistence.
- The model's output is a **strict structured envelope**, and the browser-facing reply is
  derived from it — the protocol wrapper is never rendered.
- Domain capabilities are declared once as **surfaces**, exposed to the model as **typed
  tools**, and mirrored to the browser as a separate, allow-listed set of **UI actions**.
- The server, not the model, knows which domain object a name refers to; it rewrites references
  into links and ships the resolved objects alongside the turn.
- Conversations are persisted as **immutable whole turns** in private object storage, which
  makes new envelope fields survive reloads with no schema or endpoint change.

Sections 2–4 describe the moving parts. Sections 5–7 state the contracts, the hard-won
invariants, and a porting checklist.

---

## 2. System overview

```
+--------------------------------------------------------------- Browser (rich client)
|  Chat surface (presentational shell)
|    |-- session/history cache  <-->  GET /sessions, GET /history
|    |-- transport hook         <-->  POST /chat            (auth'd, JSON)
|    |-- agentic loop hook      -->  UI-action dispatcher --> allow-listed handlers
|    |-- entity link renderer   -->  domain-object highlight resolver
|    '-- composer: text, attachments, availability, usage
+--------------------------------------|--------------------------------------
                                       v
+--------------------------------------------------------------- Application server
|  HTTP route
|    1 context resolution + authorization
|    2 quota pre-check
|    3 session index ensure (+ best-effort title generation)
|    4 orchestrator.runTurn(...)
|         provider loop  <-->  provider adapter  <-->  external LLM (HTTP)
|         tool execution <-->  MCP tool host     <-->  domain services
|    5 reply normalization for the client
|    6 usage accounting + turn persistence (post-response, best-effort)
+------------------|----------------------------|-------------------------------
                   v                            v
        provider credentials,          session index (relational)
        model config                   turn + manifest objects (private object storage)
```

Two persistence planes are used on purpose:

- a **relational index** for what must be listed and queried (sessions, titles, timestamps,
  the usage ledger, legacy log rows);
- **immutable blob objects** for the transcript itself, one object per turn plus a small
  manifest per session. Blobs are content, not schema; indexes are keys and metadata.

---

## 3. Frontend chat surface

### 3.1 Layering

Keep four responsibilities in four places; mixing them is what makes a chat component
unmaintainable.

| Layer | Responsibility | Knows about |
|---|---|---|
| Presentational shell | Layout, transcript rendering, composer, resize/minimize, local UI state | Theme, props, DOM |
| Agentic loop hook | Drives the multi-round turn: send → run browser effects → send tool result → repeat | Transport, dispatcher |
| Transport hook | One HTTP call, transcript compaction, auth, cancellation | Endpoint shape only |
| Session cache (context provider) | Session list + per-session history, dedup, optimistic cache | Endpoints, per-context namespacing |

The shell is exposed via an imperative handle so host containers can drive it without lifting
its state: `sendUserMessage`, `sendSystemMessage`, `sendAgentMessage`, `startNewSession`,
`getMessages`, `clearState`, `activate`, session-panel toggles. That keeps the chat embeddable
in a docked panel and a floating window simultaneously.

### 3.2 Conversation namespacing

Every conversation belongs to a **context key** that encodes scope and (where relevant) the
workspace and the surface, e.g. `scope:surface`, `workspace:<id>:surface`,
`scope:<id>`. Sessions, history, and cache entries are all keyed by it. Consequences to keep:

- A context key is also the server-side authorization unit; the client must not be able to
  widen it by sending a different scope than the route resolves.
- Switching context **resets** in-memory transcript and LLM context while leaving persisted
  sessions intact.
- A context that accepts no domain actions is still a valid chat; the client enforces a
  read-only posture as defence in depth, but the server is the authority.

### 3.3 Async state ownership

- **Input history** (up/down arrow recall) is per-user local storage; it is a convenience, not
  conversation state.
- **Transcript** is held in the loop hook (`allMessages`) and mirrored into a session cache on
  every change, so closing and reopening the surface restores a just-finished conversation
  without a refetch. Hydration order is cache-first, network-on-miss.
- **Provider usage** is accumulated per open chat, not per message: one user turn is several
  provider calls (see §4.3), and each reports its own usage. Sum them; a single turn's
  intermediate rounds emit no user-visible message but cost real tokens.

### 3.4 Rendering contract

Assistant text is **never** raw HTML or arbitrary Markdown. The renderer accepts a small,
explicit subset:

- bold, bullet lists, inline code, fenced code blocks, tables (GFM plugin required; tables do
  not render without it);
- **not** headings, images, raw HTML, footnotes, or task lists.

Rendering rules that matter:

- Parse the assistant payload tolerantly. Providers occasionally emit envelopes whose payload
  contains literal newlines instead of `\n` escapes, producing invalid JSON. Treat parsing as
  best-effort with a salvage path; a payload that still cannot be parsed must degrade to plain
  text, never leak `{"type":...}` into the bubble.
- Inline code must be distinguished from fenced blocks without relying on a removed library
  prop: infer from a language class or a trailing newline.
- Run **redaction** over every user-visible string (message text, errors, attachment names)
  before display, so a leaked credential in a provider error cannot reach the transcript.
- A reply may reference domain objects. Those references are links with a custom scheme; the
  Markdown renderer must be given a `urlTransform` that permits the scheme (the default blanks
  unknown schemes), and an unresolvable reference must render as plain text — never as a dead
  anchor.

### 3.5 Browser effects (UI actions)

The server returns browser-only effects **separately from assistant text** (see §4.6). The
client:

- keeps a **registry** keyed by `type` with a `version`, a handler, and a `failurePolicy`
  (`stop` or `continue`);
- validates the envelope (type, version, payload shape) before dispatch;
- rejects a stale action whose embedded workspace scope no longer matches the current one;
- is **idempotent**: an applied action id is recorded and re-application is a no-op;
- retries only errors explicitly marked retryable, up to a small cap;
- on failure, emits a short system message rather than throwing into the transcript.

### 3.6 Domain-object references

A reply names an object in prose; the client lets the reader **preview** (hover) and **pin**
(click) that object in the workspace.

- Preview is debounced (tens of milliseconds) and must **restore** prior state; it stays out of
  undo history.
- Pin goes through the normal dispatched action so it is undoable.
- One resolver is used for both: match by the object's identity from the turn's entity list,
  fall back to a name search across all layers. Do not add a second name→highlight path.
- Entity identity is carried in the link target and in a per-message `entities` array, never in
  the prose.

### 3.7 Composer

- Files are uploaded **when picked**, not when sent. An entry carries its own state
  (`uploading` → `ready` / `error`); sending is blocked while any upload is in flight, and a
  file-only message is legitimate.
- One format filter drives all three of the picker's `accept`, the post-pick validation, and
  the human-readable refusal, so the surface cannot advertise one set and enforce another.
- Availability is **probed by the chat itself**, not by a status badge that may be unmounted
  elsewhere: a lightweight health call on a cadence that depends on the last result (faster
  retry when offline, slower refresh when online). Sending is gated on a healthy probe.
- The composer owns its own width measurement and hides non-essential controls (e.g. usage
  reporting) below a width threshold rather than overflowing.
- The send control doubles as stop; interrupting aborts the in-flight request and posts a
  system notice.

### 3.8 Usage display

Usage is shown at two scopes and they are not the same number:

- **session**: what this open chat has spent, plus the subset of prompt tokens the provider
  served from its own cache (billed cheaper; already included in the total);
- **account/period**: the month's quota, fetched from an accounting endpoint.

A popover should be portalled out of a container with `overflow: hidden`, or it will be
clipped.

---

## 4. Backend LLM support

### 4.1 Request lifecycle

One authenticated endpoint per turn. On each call:

1. **Resolve context.** Derive scope/surface from the context key and explicit fields; resolve
   workspace and organisation identifiers to canonical ones; check the entry permission for the
   surface; attach a **contextual guide**; mark scopes read-only where appropriate. An
   unresolvable context is a 4xx, not a fallback to a privileged default.
2. **Quota pre-check** with an estimated cost. A quota failure is a structured 429 (or a
   subscription-specific payload), not a generic error.
3. **Ensure the session index row**, then kick off **title generation** asynchronously from the
   first user message. Title generation is best-effort and must never block or fail the turn.
4. **Run the orchestrator** (the provider loop; §4.3).
5. **Normalize the result for the client** — parse the envelope, expose `structured_content`,
   surface `uiActions` and `entities`, and report usage.
6. **Post-response work** (do not block the reply on it): record usage, persist the turn, emit
   audit events. Errors here are logged, never surfaced as chat failures.

Additional read endpoints: list sessions for a context, and load one session's history. Both
verify that the session belongs to the caller *and* matches the requested context.

### 4.2 Provider abstraction

The server owns provider selection. **A request payload must never be able to choose a
provider implementation.**

Contract:

```
provider = {
  name,
  complete({ messages, tools, modelOptions, context, executionContext, iteration, requestId, signal })
    -> { choices: [ { message } ], usage, model, provider }
}
```

- A factory reads deployment configuration (provider name, endpoint, model, timeout, key) and
  constructs the provider. Key material is read from the environment, never from a request.
- A generic factory (`createLlmProvider`) wraps a `complete` function, normalizes the request,
  and validates the response shape (`choices` must be an array) so callers can rely on it.
- Provider errors are normalized to one error type carrying `{ code, status, provider,
  retryable, details }`, mapping cancellation → 499, timeout → 504, rate limit → 429/`LLM_
  RATE_LIMITED`, other upstream failures → 502. Missing credentials are a 503, never a crash.
- Only an explicit allow-list of model options is forwarded to the provider; do not spread
  arbitrary caller options into the upstream payload.
- **Retry policy is deliberately narrow.** Retry only failures that *prove the request never
  reached the provider* — name resolution and connection establishment (`EAI_*`, `ENOTFOUND`,
  `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`), with exponential backoff and jitter budget.
  A timeout or any provider response is **never** retried: completions are not idempotent from
  a billing standpoint, and a retry can pay twice. An aborted signal stops retrying.
- Wrap name resolution with a bounded lookup and use keep-alive agents, because a stalled
  resolver can hang a request far past its own timeout, and the request timeout does not cover
  name resolution.
- Validate the configured provider at construction: an unknown provider name is a startup
  configuration error (`LLM_PROVIDER_UNSUPPORTED`, 500), and a provider restricted to a
  non-production environment must refuse to construct elsewhere.

### 4.3 Orchestrator loop

The orchestrator is the heart. It is provider-agnostic and dependency-injected (context
resolver, guide resolver, context builder, prompt composer, tool registry/host, UI-action
registry, session service, quota service, audit service, limits).

Per turn:

1. Normalize the request into a non-empty message list; reject over-large inputs.
2. Resolve context, then **authorize** the actor for the guide's required entry permissions.
3. Build an **execution context** once and pass it to every tool call:
   `{ principal: { type: 'service', name }, initiatedBy: { type: 'user', userId, publicId? },
   workspaceId, organisationId, requestId, sessionId }`. The optional non-secret **public
   identifier** matters wherever stored objects are addressed by public id (uploads, avatars),
   so the object owner can be compared against the caller. Validation requires a service
   principal and an initiating user, and re-asserts that the context's scope matches the
   resource being touched. The context is shallow-copied with the tool name before each
   invocation. It carries identity and scope only — never credentials.
4. Run quota pre-check and ensure the session.
5. Build the **project digest once** and bound it once. It is injected into the system message
   of *every* iteration, so an over-budget digest is paid for repeatedly; bound it at turn
   start and label it a snapshot that tools re-read after any write. The digest is deliberately
   detail-free: every field names the tool that returns the full data. A typical starting
   budget is a few kilobytes with item and string-length caps. Over-budget degrades to a
   self-describing digest-of-digest and emits a `CONTEXT_DIGEST_TRUNCATED` notice — it does not
   fail the turn.
6. **Select tools** for this turn (surface filter, read-only filter, per-tool required
   permissions). Convert to model tool definitions.
7. Compose the **system message** (base prompt + contextual guide + user role + digest + tool
   rules + UI-action rules).
8. Iterate up to a hard cap:
   - call the provider with the transcript;
   - accumulate usage from every response;
   - push the assistant message into the transcript;
   - if it has **no tool calls**: finalize;
   - otherwise, for each call: validate, honor a confirmation gate, invoke via the MCP host,
     keep the **raw** result for entity collection, bound the result for the model, record a
     truncation notice if bounded, and append a `tool` message;
   - if the transcript outgrows the message cap mid-loop, fail cleanly.
9. Exceeding the iteration budget is an explicit error (`budget exceeded`, 408), not a silent
   partial answer.
10. Finalize: rewrite entity references, extract allow-listed UI actions, attach usage and a
    **trace** (request id, context key, tool calls, digest meta, notices), audit, persist the
    turn, record usage.

Notable behaviors:

- **Confirmation gate.** A tool descriptor may require confirmation. If the caller has not
  confirmed that call (by call id or tool name), return `confirmation_required` with the tool
  name and arguments instead of executing. This is a separate response status, not an error.
- **Bounding over failing.** An over-budget tool result or digest is an expected condition:
  shrink it to a self-describing digest, keep the loop alive, add a `notices[]` entry, mark the
  audit outcome `degraded`, and let the model disclose the truncation. Sanitize first — cycles,
  excessive depth, `BigInt`, buffers, maps/sets, invalid dates, and even hostile getters must
  become explicit markers rather than a thrown serialization error. Then, if still over budget,
  apply progressively harsher shrink profiles (fewer items, shorter strings, fewer keys) until
  it fits, each time producing an envelope that states it was truncated, why, which tool, the
  original and limit sizes, total vs returned item counts, and a model-facing note to disclose
  the truncation and narrow the query. Fall back to a metadata-only envelope and finally a hard
  clamp, so content can never exceed the limit. Budgets are expressed in serialized-string
  length units and applied consistently.
- **Usage is summed across rounds** (including cached input/output token subsets), and only
  then recorded against quota.

### 4.4 Tool model (surfaces → MCP tools)

Domain capabilities are declared once and adapted, never hand-registered per caller.

- A **surface** is `{ key, version, digest?, capabilities[] }`, defined by a small contract
  helper that freezes the object and its capability list.
- A **capability** (tool descriptor) is `{ name, description, inputSchema, handler, access:
  'read'|'write', surfaces: [surfaceKey], requiredFunctions: [permissionKey], confirmation }`.
  A write tool defaults to requiring confirmation.
- A **registry** validates and freezes descriptors (identifier-shaped names, valid access,
  valid confirmation, object schema), rejects duplicate names, keys surfaces case-insensitively,
  and lists/filters by surface, access, and read-only mode. `describe()` strips the handler, so
  executable code can never leak into the prompt or the wire.
- **Selection order** is itself an authorization boundary: ask for candidates scoped to the
  active surface with writes included only when the context is not read-only; drop tools whose
  non-empty surface list excludes the active surface (empty = visible everywhere); then require
  **every** entry in `requiredFunctions` to be authorized at the current scope — any denial
  drops the tool entirely. Only then project to model tool definitions (name, description,
  parameters).
- An **adapter** turns each surface into an MCP-shaped server whose tools wrap the handler with
  the surface's own options and the turn's execution context. The orchestrator talks to an
  **in-process MCP host**, so the same descriptors could later be served over a real MCP
  transport without changing the loop. The host re-checks that the named tool is registered and
  that the execution context is valid before calling the handler.
- **Handlers are caller-aware and re-assert their own permission.** Selection and validation
  protect the model path; the handler check protects any other caller that reaches the domain
  service directly.
- **Call validation** is layered: the tool must be in the *selected set* (not merely known),
  arguments must be a JSON object within a size cap, required properties must be present, and
  any workspace/organisation id in the arguments must match the resolved context (a scope
  mismatch is a 403). Selecting and validating are both authorization boundaries.
- **A digest is optional.** A surface whose data is only reachable through tools declares none;
  the orchestrator then performs no context query for it.

> Important operational constraint: registries are frozen at module import. Adding or changing
> a capability requires a **server restart**; it will not appear live.

### 4.5 Context, guides and authorization

- The resolver turns a client context key into a canonical object: scope, surface, canonical
  workspace/organisation ids, a display name, read-only flag, and the guide. It rejects unknown
  contexts and contexts that require a workspace but lack one.
- **Contextual guides** are versioned policy records per surface: `instructions`,
  `operatingPrinciples`, `workflow`, `stateSignals`, `guardrails`, and
  `requiredEntryFunctions`. They are prompt prose *and* policy metadata, but the prose is never
  treated as an authorization decision — the permission keys are.
- Guides are frozen and list fields are copied, so a caller cannot mutate the registry through
  a returned reference.
- Read-only scopes drop write tools during selection; the prompt also tells the model not to
  claim a mutation succeeded without a successful tool result. This is defense in depth on top
  of server-side enforcement, not a substitute.

### 4.6 UI-action protocol

Browser effects are a **separate, mirrored registry** on each side of the wire.

Server side holds descriptors `{ type, version, surfaces, description, inputSchema }` with:

- payload validation per type (required fields, coordinate bounds, array length caps);
- surface gating;
- version matching;
- `normalize()` producing a frozen envelope `{ id, type, version, context: { surface,
  contextKey, workspaceId }, payload, confirmation }`;
- `describe()` used when composing the prompt, so the model is told exactly which
  `type@version` values it may request and is forbidden from returning JavaScript or frontend
  function calls.

Client side holds the handlers and mirrors the type/version set. The two registries are kept
comparable by contract tests; the model never sees handler code.

The prompt should instruct the model to prefer a specific action for its canonical intent
(e.g. a "find/locate" request maps to a find action, an explicit "highlight" request to a
highlight action) and to pass names verbatim even when the digest does not contain them,
because the browser searches all layers and is the authority on existence.

### 4.7 Entity references

Purpose: convert the plain names in prose into references the workspace can resolve by
identity.

Process, server-side, after the final assistant message:

1. **Collect** candidate `{ kind, id, label }` objects by walking every raw tool result of the
   turn structurally (bounded depth, visited count, and count). Do not use a per-tool schema;
   a new tool then becomes linkable with no change here. Accept several common id and label
   field names, and require both. Skip objects whose label is just their id unless the kind
   declares names to be identifiers. Carry extra identity fields when a kind needs them.
2. **Index labels**, dropping labels that are too short, too long, or **ambiguous** (shared by
   more than one object): linking an ambiguous label would have to pick a winner, and
   highlighting the wrong object is worse than leaving plain text.
3. **Rewrite** the reply so each exactly-once label becomes `[**label**](entity://kind:id)`,
   protecting code spans, fenced blocks, and existing links. Use longest-match-first and require
   name boundaries so a longer name is never split into a shorter one.
4. Handle both envelope and plain-prose shapes; a valid JSON envelope stays valid JSON, with
   only human-readable fields rewritten.
5. Collect entities from **pre-bounding** results, so a truncated result can still yield
   identities.
6. Return the resolved entity list with the turn so the client can resolve links without a
   fresh reply, and so it persists with the turn.

The identifier lives in the link target only. The prose rule "never show internal identifiers"
continues to hold.

### 4.8 Prompt composition

The system prompt is assembled from ordered, independently owned parts:

1. a base role/protocol prompt (strict JSON envelope; no surrounding markdown or prose; the
   user-visible Markdown subset; never reveal internal identifiers or implementation commands);
2. the contextual guide sections (instructions, operating principles, workflow, state signals,
   guardrails), labelled with the guide version;
3. the user's role;
4. the bounded workspace digest, explicitly labelled a turn-start snapshot with the tools that
   return the same data live;
5. tool rules: use only the supplied typed tools, do not invent tools/SQL/permissions/completed
   mutations, list the available tool names;
6. UI-action rules: only the listed `type@version` values, returned in a separate array, never
   JavaScript.

All prompt text lives behind a composer function so it can be injected in tests and versioned
independently of the loop.

### 4.9 Session and turn persistence

Two-plane model:

- **Index (relational).** One row per session: `session_id`, owner, context key, title,
  created/last-activity timestamps. Used to list sessions and to authorize/scope history loads.
- **Content (private object storage).** Per session, a gzipped `manifest.json.gz` listing turn
  object keys, and one gzipped object per turn.

Turn object shape (schema-versioned):

```
{
  schemaVersion, turnNumber, requestId, contextKey, surface, guideVersion,
  messages: [ <only the newly submitted message> ],
  response: <the client-facing response including structured content + entities>,
  toolCalls: [...], usage: {...}, createdAt
}
```

Rules that make this robust:

- The client sends the full transcript each call; persist **only the last message** per turn
  and let replay reconstruct the rest.
- **Deduplicate by request id.** Retrying the same request must not append a second turn.
- Derive the storage location from environment (local filesystem in development, private object
  storage in deployed environments); the *stored path scheme* decides how it is read back.
- Use a stable, human-inspectable key layout scoped by owner and session, with a zero-padded,
  monotonic turn number and the request id in the turn key; sanitize every key segment so a
  hostile id cannot escape its prefix. The manifest is rewritten each turn; turn objects are
  immutable.
- On load, verify the index row's owner and context key before returning content; a mismatch
  returns an empty history, not an error. Then stream the turns through the manifest, strip
  system messages, and reconstruct the visible transcript. Compute the common prefix against
  the replayed transcript so a turn that repeats prior context is not duplicated — and make the
  comparison fingerprint ignore render-only fields (raw vs structured content, timestamps,
  display metadata), or every replay will look like new content.
- Keep a legacy relational log during migration as an index and fallback for histories created
  before the blob store existed; fall back to it when no manifest exists.
- **Forward compatibility is the payoff:** because the whole client-facing response is stored,
  a new envelope field (like the entity list) survives a reload with no migration, no new
  column, and no new endpoint.

### 4.10 Usage, quota and audit

- **Quota** is checked before the turn with a rough estimate and recorded after it with the
  actual summed total. Support multiple scopes (user, organisation, workspace) resolved from
  the chat context: a workspace-scoped turn charges the workspace, an organisation-scoped turn
  the organisation, otherwise the user. The pre-check is cheap and stateful (lazily provision a
  missing quota row, roll periods over, evaluate suspended/over-limit at each scope). The
  post-record should be an **append-only usage log**, with every status and balance view
  re-aggregated from that log rather than trusting an incrementing counter — that makes the
  ledger the source of truth and reconciliation a query.
- **Fail open on accounting outages, fail closed on authorization.** If the pre-check throws,
  log and continue rather than blocking chat on an accounting outage; if ownership or scope
  checks fail, refuse.
- Normalize provider usage: prompt, completion, total, and **cached input/output** subsets
  across the several vendor field spellings. Cached tokens are a cheaper subset, not a third
  cost, and must not be double-counted.
- A quota refusal returns a structured, machine-readable payload (`allowed: false`, a code, a
  message, quota info) or a subscription-specific failure, so the client can distinguish
  "out of quota" (typically 429) from "subscription/entitlement lapsed" (typically 402) from
  "server error". Check entitlement **before** raw limits so the more specific failure wins.
- **Audit has two distinct jobs, and they should not be conflated.** A per-provider-request
  audit emits one compact, credential-free JSON line (event, request id, provider, model,
  actor/scope ids, context key, iteration, outcome, status, duration, token counts, cached
  tokens, error code); it is a synchronous log sink, non-durable by design. Expensive *derived
  aggregates* (per-workspace rollups) belong to a separate durable job queue with retries — not
  to the request path. An orchestrator turn whose inputs were truncated is recorded as
  `degraded`.

### 4.11 Attachments

- Files go through **one upload ingress**: a named profile owns the size cap and accept list,
  a temp file is written, the handler stores it and returns a **stored path**, and the temp file
  is cleaned up in a `finally`.
- The upload happens at pick time, so a refusal reaches the user at the control that caused it
  and a sent message never names an object that never landed. The cost is orphaned objects for
  abandoned picks; expire them by prefix rather than sweeping per request.
- On the chat request, normalize the attachment list: drop any path the read tool would refuse
  (e.g. a relative path when the tool only accepts object-storage paths) and cap the count per
  message. **Log every drop** — a silently dropped attachment makes the model truthfully say it
  sees no file, which looks like a model failure and hides a path problem.
- Inject the references into the **last user message content** as a tagged block (name | size |
  type | path), not as a sibling field: the model reads content, and the stored turn keeps
  messages verbatim, so the reference survives a reload with no schema change. The client
  writes the same block into its own copy of the transcript, so later turns can still read the
  file; the server must not append a second copy when the block is already present.
- Name the stored key so ownership is recoverable from the path alone (owner segment, grouping
  segment, then a uniquified basename). The owner segment is what makes authorization possible
  later, and a timestamp plus random suffix prevents a later same-named file from silently
  repointing an earlier message's reference.
- **Read access is re-authorized, not trusted.** The model supplies a path, so parse it back to
  its owner and compare against the execution context's initiating user (which is why the
  context carries the non-secret public identifier, not only the internal id). A foreign or
  malformed path returns a refusal the model can relay — never a silent empty read. This is the
  prompt-injection boundary.
- **Give the model content through bounded, purpose-built read tools, not raw file access.**
  One tool returns a cheap *fact sheet* from a single sampled head read (sniffed format, size,
  structural facts such as columns, shape, geometry bounds, dimensions), so cost does not scale
  with file size. A second, separate tool returns one metered page of text-like content, gated
  by an explicit format policy that refuses formats that belong to a dedicated import flow.
  Both reads use byte-range reads that assert the path is in the expected private store with an
  explicit positive budget.

### 4.12 Response normalization and error redaction

- Parse the assistant envelope once at the edge: if it is a `{ type, payload }` object with a
  string payload, expose the payload as `content`, retain the raw string as `raw_content`, and
  expose the parsed object as `structured_content`. Carry the entity list into the structured
  content so live and reloaded replies look identical.
- Errors returned to the client pass through **redaction** against the configured credential
  values before serialization; the same redaction runs on the client over any provider message
  it renders. A provider error is mapped to the orchestrator/provider status code, never
  passed through verbatim.

---

## 5. Wire contracts (generic)

These are the shapes to preserve when porting; field names can change.

**Chat request**

```
POST /chat                       (auth required)
{
  messages: [ { role, content, name?, tool_call_id?, tool_calls? } ],
  contextKey, sessionId, context: { surface, scope, workspaceId, organisationId },
  attachments?: [ { path, name, size, contentType } ],
  confirmations?: [ callId | toolName ]
}
```

**Chat response (client-facing)**

```
{
  choices: [ { message: { role: 'assistant', content, type?, uiActions?, entities?,
                           structured_content?, raw_content? } } ],
  uiActions: [ { id, type, version, context, payload, confirmation } ],
  entities:  [ { kind, id, label, ...extra } ],
  usage:     { prompt_tokens, completion_tokens, total_tokens,
               cached_input_tokens, cached_output_tokens },
  trace:     { requestId, contextKey, toolCalls, digest?, notices? }
}
```

**Model envelope** (what the provider must return; parsed leniently at the edge)

```
{ "type": "message" | "final_output" | <legacy command types>,
  "payload": "user-facing text" | { ... },
  "uiActions": [ ... ] }
```

**Tool descriptor**

```
{ name, description, inputSchema, handler,
  access: 'read' | 'write', surfaces: [key], requiredFunctions: [permission],
  confirmation: 'none' | 'required' }
```

**UI action**

```
{ id, type, version, payload, context: { surface, contextKey, workspaceId },
  confirmation: 'none' | 'required' }
```

**Stored turn** — see §4.9.

---

## 6. Invariants and lessons worth inheriting

1. **One envelope, never rendered.** The model returns a single structured object; the protocol
   wrapper is parsed away at the edge. Tolerant parsing with a salvage path prevents wrapper
   leakage into the transcript.
2. **The server owns the provider.** Provider choice comes from deployment configuration; a
   request can never select an implementation, and credentials never reach the browser.
3. **Retry only pre-flight failures.** A completion is not billable-idempotent; retrying a
   timeout or a provider response can pay twice.
4. **Degrade, then disclose.** Over-budget digests and tool results are bounded into
   self-describing digests, recorded as notices, and marked `degraded` in audit — not turned
   into gateway errors.
5. **Budget the right thing at the right time.** The digest is injected into every iteration;
   bound it once per turn. Tool results are bounded per call, but the raw result is kept for
   entity collection.
6. **Selecting is authorizing.** A tool the model can name but the turn did not select is
   rejected, and scope ids in arguments must equal the resolved context's.
7. **Identifiers never reach the prose.** The server knows the identity, puts it in a link
   target, and returns the entity list with the turn. Ambiguous labels stay plain text.
8. **Whole-turn persistence buys forward compatibility.** Store the client-facing response, not
   a normalized projection; new fields then survive reloads with no schema change.
9. **Idempotency everywhere on retry.** Request ids deduplicate persisted turns; action ids
   deduplicate applied browser effects.
10. **Registries are frozen at import.** New tools/actions need a process restart. Make that
    explicit in the deployment checklist rather than discovering it live.
11. **One upload ingress, one format declaration.** The picker's `accept`, the enforcement, and
    the refusal text all read the same filter, or the surface lies about what it accepts.
12. **Redact on both sides.** Redact credential values from server error messages before
    serialization and from client-rendered text before display.
13. **A context key namespaces conversations and is an authorization unit.** Do not let the
    client invent one the server did not resolve.
14. **Trust the browser for existence, the server for identity.** A find action searches every
    layer and reports authoritatively; the server resolves names to identities from tool
    results. Do not let the model claim absence from aggregates.
15. **No mutation claim without a successful tool result.** Enforce read-only scopes by dropping
    write tools, and instruct the model accordingly.
16. **An upload reference is data, never a capability.** Possession of a stored path is not
    authorization to read it; the server re-derives the owner and the allowed read scope every
    time.
17. **Fail open on accounting, fail closed on authorization.** A quota-service outage should
    degrade to "let the turn through and log", never to "deny a legitimate user"; an ownership
    or scope check must never degrade in either direction.

---

## 7. Porting checklist

To stand this up in a new project:

1. **Decide the provider layer.** Implement the `complete()` contract for one
   OpenAI-compatible provider; add the factory, error normalization, narrow pre-flight retry,
   and bounded DNS lookup. Keep the provider behind the interface even with one implementation.
2. **Define surfaces.** For each domain area declare a surface with capabilities tagged by
   access, surface key, and required permission. Keep the digest optional and bounded.
3. **Implement the MCP host** (in-process is fine) and the call validator with scope checks.
4. **Write the contextual guides** per surface: version, entry permissions, instructions,
   principles, workflow (if any), state signals, guardrails.
5. **Mirror UI actions** on both sides with explicit schemas and a contract test that compares
   the type/version sets. Keep handlers out of the server registry.
6. **Stand up the two-plane persistence**: a relational session index and immutable whole-turn
   objects with a manifest and request-id dedupe.
7. **Wire usage and audit**: pre-check estimate, post-record actual summed usage with cached
   subsets, one audit line per provider request, `degraded` outcome on truncation.
8. **Build the upload ingress** with one profile, stored paths, and per-turn attachment
   normalization into the last user message.
9. **Build the client layers**: transport hook, agentic loop hook, session cache, presentational
   shell with imperative handle, tolerant Markdown renderer with a custom-scheme `urlTransform`,
   entity preview/pin, debounced, and a composer with upload-on-pick.
10. **Add the invariants as tests**: envelope parsing and salvage, entity link ambiguity,
    unresolved-scheme degradation, tool scope mismatch rejection, confirmation gate,
    request-id turn dedupe, UI-action idempotency, prompt redaction.

### Explicit non-goals

- Streaming token-by-token output is not part of this design; the turn is request/response with
  a multi-round loop.
- Real MCP transport is not required; the in-process host is an implementation detail that
  keeps the door open.
- The model does not receive credentials, raw HTML, or frontend function references at any
  point.
- Per-user feature flags for individual tools are not modeled; tool availability is a function
  of surface, read-only mode, and permissions.

### Open questions to re-decide for a new project

> **Answered.** These questions were resolved during W0 in [Porting Decisions](porting-decisions.md). The answers there are binding; the questions are kept for provenance.

- Where the token estimate for the pre-check comes from (fixed constant here) and whether
  pre-check refusal should be soft (warn) or hard (block).
- Whether read-only scopes should still be probed by the client at all, or whether the server's
  tool selection is treated as the only control.
- How far the digest should go before details are left to tools; the current design errs toward
  a small snapshot plus read tools.
- Retention and expiry policy for orphaned attachment objects and for turn objects.
- Whether writes will actually exist. The write+confirmation path can be designed, gated and
  tested without a single write tool; exercise it with a real one before trusting it.
- Whether attachments stored via a local/relative path scheme should be reachable by the model
  at all. If the read tool only accepts object-store paths, a deployment that uses relative
  paths silently loses every attachment; either forbid that combination or teach the normalizer
  both schemes.
- Whether the model may invoke a permission-checked capability whose permission was never
  enforced at the route level (i.e. is route pre-check sufficient, or must every tool re-check).
