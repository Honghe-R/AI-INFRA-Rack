> **Confidential — internal architecture material.**
> Do not copy, quote, summarize, or transmit this document outside the workspace.

# Map Adapters — Architecture Blueprint

A vendor-neutral architectural reference for the layer that turns stored domain records into
map-consumable payloads, and turns imported map data back into records, as exposed through a
"workspace" resource route.

This is a blueprint, not a design specification. It describes the seam, the adapter roles, the
output contracts, the normalization rules and the failure modes — the parts worth copying or
deliberately changing. It omits product names, domain vocabulary, real entity/type names,
identifiers, storage names and credentials. Adapt the names; keep the seams.

---

## 1. What a "map adapter" is

A map adapter is any code that crosses the boundary between **stored records** and
**map-consumable payloads**. There are two directions:

- **Egress (read models / projections)** — stored rows → a JSON payload a browser map can draw
  (feature collections, typed resource buckets, graph/adjacency structures, per-object resolved
  details).
- **Ingress (import adapters)** — uploaded/imported map data → validated, typed records in the
  canonical tables, with provenance.

The important architectural finding in the subject system is that there is **no single adapter
module**. The projection is split between route-level normalizers, domain read models and pure
resolvers. The consistent seam is:

```
HTTP route handler
    -> domain read model or pure resolver     (queries, joins, derived structure)
        -> row normalizer                     (row -> domain-shaped object)
            -> JSON envelope                   (typed, versioned, id-normalized)
```

Whether to centralize this into one adapter layer or leave it as a convention is the first
porting decision. The subject leaves it as a convention; §14 lists the cost of doing so.

---

## 2. The layering

| Layer | Responsibility | Must know |
|---|---|---|
| Route / HTTP adapter | Auth, scope decode, filters, status codes, envelope shape | HTTP, permissions, path params |
| Read model / resolver | Query canonical tables; derive graph/structure; assemble the envelope | Domain tables, business derivation |
| Row normalizer | Row → object: parse JSON columns, normalize geometry, hide internal ids | Column names, geometry rules |
| Client map layer | Reverse-adapt payload → features, style, projection, viewport | Payload contract, map library |

Two rules keep this honest:

1. **The route does not shape geometry.** It may choose *which* read model and *which* filters,
   but row→object normalization belongs one layer down, where it can be unit-tested and reused.
2. **One read model, two consumers.** An HTTP route and an internal capability/surface adapter
   should call the *same* read model. If they each project the data, they will drift.

---

## 3. Adapter roles

A mature map surface usually needs most of these. Name them generically; each is a seam.

- **Topology read model** — queries the map entity tables (point-like, linear, relational),
  normalizes each row, and wraps them in one typed envelope with a version stamp. This is the
  spine most other adapters build on.
- **Pure resolver** — a side-effect-free function that composes several read models into a
  derived answer (e.g. resolve each floating object to its nearest valid attachment point given
  a policy). It persists nothing and is recomputed per request, which is what makes it safe to
  call from multiple consumers.
- **Planning/routing read model** — resolves an *active result version*, loads its stored
  artifact, and projects routes/spans/coverage/diagnostics. Because it has a compatibility
  obligation, a legacy projection re-adds aliases and derived fields for older clients.
- **Resource / layer projection** — reads the point and line tables and buckets rows into
  **named layer categories** the client uses directly, plus a related file listing.
- **Marker-asset adapter** — normalizes arbitrary uploaded geometry into a filtered,
  point-only feature collection, stores it as a private object, and reads it back verbatim.
- **Graph / read adapters** — derived structures (adjacency, connectivity, revision lists) that
  are computed on read rather than stored.
- **Reverse (ingestion) adapters** — layer import and legacy feature-sync envelopes that map
  feature properties and geometry into typed rows.

> **A false friend to flag explicitly.** Utilities named "projections"/"projector" that build
> role-based *SQL column whitelists* are **not** map adapters. They are a field-level
> authorization/redaction concern (which columns a role may receive), and they only resemble map
> projection by name. Keep the two concepts separate: **field projection controls what fields
> exist; map projection controls what geometry and structure the map receives.** Conflating them
> makes both hard to reason about.

---

## 4. Output contracts

Contracts are the adapter's interface. Pin them down and treat them as versioned.

### Entity envelope (topology read)

```
{
  entities:  [ <point entity> | <linear entity> ],
  relations: [ <relation entity> ],
  metadata:  { version, updatedAt, updatedBy, clientCommitVersion },
  planning:  { ... }
}
```

- **Point entity** — `{ id, tenantId, type, name, location: [x, y], metadata, group,
  actorDisplay, timestamps }`.
- **Linear entity** — `{ id, type, name, geometry, path, spanIds, logicalLinkId, length, origin,
  locked, startPoint, endPoint, status, properties, metadata, actorDisplay, timestamps }`.
- **Relation entity** — `{ id, fromEntityId, toEntityId, endpoints: { src, dst }, routeId,
  status, properties, metadata, timestamps, actors }`.

### Resource / layer projection

```
{
  pointSets:  { points: [...], lines: [...] },        // a flat, geometry-first view
  layerCategories: { <category>: [ ... ], ... },      // one array per drawable layer
  hasInfra: boolean,
  hasPhysicalInfra: boolean,
  files: [ ... ]
}
```

Each entry is `{ id, name, location | coords, raw }` — a *display* object, not the domain row.

### Feature collection (normalized import / marker asset)

```
{
  type: 'FeatureCollection',
  metadata: { assetId, featureCount, normalizedAt },
  features: [ {
    type: 'Feature',
    id,
    properties: { ...original, name, sourceFeatureId, sourceFileName },
    geometry: { type: 'Point', coordinates: [x, y] }
  } ]
}
```

A multi-point source expands to one feature per point; ids derive from the source id plus a
positional suffix, else random. This is the shape the client can hand straight to a GeoJSON
parser.

### Derived answer (pure resolver)

A resolver's contract is a record plus the revisions it was computed from, and a completeness
flag:

```
{
  records: [ { subjectId, resolvedFromId, resolvedCoord, entry { ... }, method, pinned, policy } ],
  revisions: { topologyVersion, intentVersion, zoningRevision, ... },
  complete: boolean,
  diagnostics: [ ... ]
}
```

Carrying the input revisions is what lets a caller tell whether the derived answer still applies
after a write, without the resolver being persisted.

### Coordinates

Pick one canonical order and enforce it everywhere. The subject uses **`[x, y]` degrees** on
the wire. Legacy `{ lat, lon }` inputs are reordered at the edge. Invalid, non-finite or
out-of-range values become `null` — never a plausible-looking wrong coordinate. Import intake
is stricter still: it rejects non-point geometry and coordinates outside finite ±180/±90.

---

## 5. Composition and mounting

- A large **workspace router** owns the workspace-scoped endpoints; sibling **sub-routers** for
  related concerns are mounted under the workspace path prefix *before* the general router (the
  order matters only if paths can overlap).
- Heavy commit logic is often a **factory that receives injected operations** from the parent
  module (patch apply, map-by-id, sort, prune, upsert, delete, snapshot read/write). This keeps
  the sub-router testable and lets the parent own the data access.
- **Permission per direction**, not per resource only:
  - read endpoints → the read key;
  - derive/preview endpoints → a compute key (they are cheap but not free);
  - commit/import → the commit key, plus a shared "read-only workspace" guard and a body-size
    limit;
  - asset list/read → a file-download key; create/update → file-upload; delete → file-delete,
    with an owner-self allowance followed by a re-check.
- The **middleware order** to standardize:
  token verify → decode the public workspace id to the internal id (attach the workspace) →
  permission guard bound to the path param → read-only guard → route-scoped body parser →
  handler.

---

## 6. Inputs and identification

- The workspace is named by a **public id in the path**, decoded to an internal row id once, at
  the middleware boundary. Responses recursively rewrite internal ids back to public ids.
  Internal ids must never leak; public ids must be substituted everywhere they appeared.
- **Filter and version parameters** are part of the contract. Typical ones: a device-type
  filter (accept exactly one value, else 400, and return a reduced payload); a version path
  parameter for history; a result-version selector plus include/diagnostics flags; a resolution
  policy; a limit and a run id for archives; resource flags (include geometry, include files,
  include the existence flag, filter by upload id).
- **Commits are optimistic.** The body carries a base version; the server returns a 409 with the
  current version, the full server state and a `canAutoRebase` hint when it does not match.
  Support whole-state and patch commits; the patch path is what keeps large workspaces usable.

---

## 7. Versioning planes

Map data is not one version. Expect several independent planes, each with its own cadence:

| Plane | Nature |
|---|---|
| Entity/topology version | Monotonic, row-locked, incremented on commit |
| Snapshot objects | One private, compressed object per version + a pointer row |
| Derived result versions | Allocated per run; artifacts addressed by type + version |
| Resource revisions | Immutable, with a "current" flag |
| Planning/verification revisions | Separate counters that gate downstream consumption |

Rules that make this work:

- **A read resolves the active result, but falls back** to the newest artifact on the same base
  version when the active result has none. Without the fallback, an interrupted run makes the
  workspace unreadable.
- **Some adapters are deliberately unversioned.** A pure resolver recomputes each call; an
  in-place asset is replaced under a stable id and the old object deleted. Document which
  adapters are versioned and which are not, so callers know what "stale" means.
- **Derive staleness on read; never rewrite stored reports.** Stamping a stored report with a
  freshness verdict mutates history and loses the original evidence.
- **A base-version change invalidates derived artifacts.** Invalidate them explicitly as part of
  the commit path.

---

## 8. Normalization rules

Row normalization is where most bugs hide. Standardize:

- **JSON columns are safe-parsed.** A malformed value yields `null`/`{}`, never a thrown
  request.
- **Malformed geometry yields `null`.** A feature with no usable geometry is dropped from a
  layer projection or represented with a null geometry, never with a fabricated point.
- **Coordinate order is canonicalized** at the edge (§4).
- **Dates/timestamps are canonicalized** to one serialization.
- **Actor identifiers are not exposed.** Emit a display name or null; the internal actor id is
  not the client's business.
- **Write-only legacy keys are accepted on read, stripped on write.** Compatibility is for
  reading old data, not for writing new garbage.
- **Type classification is a heuristic and must be treated as one.** Bucketing a row into a
  layer category by substring-matching its type string is the main coupling between storage and
  the map. It is fast and forgiving, but unknown values fall into a default bucket — a silently
  mis-classified object on the wrong layer. Prefer an explicit type→category map with a logged
  fallback over unbounded substring rules; if you keep substring rules, log every fallback.

---

## 9. Error contract

Adapters should fail with **typed errors** carrying `{ code, status, details }`, mapped at the
route to a stable JSON body `{ code, message, details }`.

| Condition | Status | Notes |
|---|---|---|
| Invalid identifier | 400 | Do not treat it as not-found |
| Missing entity / artifact | 404 | A *missing snapshot* may instead degrade with a warning; decide per artifact |
| Version conflict | 409 | Return current version + full server state + a rebase hint |
| Precondition not satisfied (e.g. unverified input) | 409 | Include the revision/verification details the caller needs |
| Endpoint moved | 410 | Keep old clients working with a clear signal |
| Quota / subscription blocked | delegated | Hand off to the central failure payload |

**Decide deliberately which missing artifacts are fatal.** A read that depends on an optional
snapshot should degrade with a warning and still return the canonical tables; a read whose whole
meaning is the artifact should 404.

---

## 10. Size and bounding

Map payloads are the largest thing an application like this returns. Two lessons:

- **There is usually no pagination, viewport or bounding-box filter** on map payloads — the
  payload is "whatever the workspace holds". That is acceptable until it is not. Adding a
  viewport/bbox filter and a response cap is the natural next step; a cap without a filter just
  truncates the map.
- **Bound the request bodies.** Commit bodies and import bodies need explicit limits (the
  subject uses tens of MB for commits and single-digit MB for imports). The system needed a
  server-side verification mode because a fully staged payload once exceeded the JSON body
  limit — if a large aggregate can be both read and written, plan for a server-side path rather
  than shipping the whole thing through the browser.

Make the commit response **metadata-only** (version + derived intents) instead of echoing the
whole network back; echo only what the client needs to rebase.

---

## 11. Ingestion (reverse) adapters

Import is the mirror image and needs its own discipline.

- **The input envelope** is typically `[{ name, resourceType, uploadId, geojson }]` — a list of
  named layers, each a feature collection, each with provenance.
- **Classify the layer first.** Map `resourceType` to a small closed set of point kinds and
  linear kinds. Unknown resource types are **skipped**, not guessed.
- **Extract properties defensively.** A name may be `name` or a title-like key; status may have
  a default; depth/capacity may be optional and stored as JSON. Use an ordered candidate list
  with fallbacks.
- **Validate geometry per kind.** A point needs finite coordinates (or a location property); a
  line needs at least two valid coordinate pairs. Invalid features are skipped, and the skip
  should be counted/logged.
- **Convert to the storage representation.** Points as spatial point values, lines as WKT (or
  the equivalent), and **compute derived measurements** (e.g. geodesic length) at import time
  rather than on every read.
- **Record provenance.** Stamp every inserted row with the upload id and the source layer name,
  so an import can be filtered, audited or rolled back.
- **A legacy feature-sync path** (creates/updates/deletes keyed by type) is common; keep it as a
  compatibility shim that maps a type string to a target table and delegates to the same
  service, not as a second implementation.

The import adapters here are **idempotency-poor**: they insert with fresh ids and mark the
upload as saved. If re-importing the same file is a real scenario, add a natural key or a
replace-by-upload step.

---

## 12. Client-side reverse adaptation

The backend does **not** assemble layers, style, or render tiles for its own data. It normalizes
geometry and buckets rows into named categories. The browser does the rest:

- Fetch the resource payload, read the canonical coordinate order, and project from geographic
  degrees to the map library's projection **at the client boundary**.
- Build one vector feature set (or one per category), stamp resource metadata onto features, and
  fit the view to the computed extent.
- Keep **category→style mapping on the client**. The server should not send colors or styles.
- Prefer a small **feature ↔ domain serializer** module over ad-hoc field access, so the envelope
  contract lives in one place.
- Be defensive: sanitize coordinate arrays to numeric pairs, and drop features that fail, rather
  than letting one bad geometry break the whole layer.

For editing, the client separately fetches the topology/state envelope, and for overlays it
fetches marker collections; those are different contracts and should not be forced into one
fetch.

---

## 13. Invariants, coupling and extension points

Invariants:

1. **Wire coordinates are `[x, y]` degrees; invalid → `null`, never a wrong value.**
2. **Internal identifiers never leak**; public identifiers are substituted recursively.
3. **Canonical tables are authoritative; snapshots only supplement.** A missing snapshot must
   not block a read *or* a commit.
4. **Reads are side-effect free.** Derived answers are recomputed, not written.
5. **Commits are transactional** with row locks, an optimistic base-version check, transient-lock
   retry, and cleanup of stored objects written for a commit that failed.
6. **A base-version change invalidates derived artifacts** explicitly.
7. **One read model, both consumers.** The HTTP adapter and any internal capability adapter call
   the same projection.
8. **Classification fallbacks are logged.** A silent default bucket is a map that is subtly wrong.

Coupling and extension:

- **Adding a read-only map type is cheap:** source table + row normalizer + a bucket in the layer
  projection + a grant key + a read route + a client layer builder.
- **Adding a commit-able map type is expensive:** the commit path has a fixed multi-collection
  contract (add/update/delete, map-by-id, sort, prune, patch application). A new type touches
  every injected operation and the factory contract. Budget for it, or generalize the contract
  before you have many types.
- The **versioning seam** is the artifact/version service; the **non-HTTP seam** is the internal
  capability registry. Route code should not own either.

---

## 14. The structural discomfort (and what to do differently)

In the subject system the map adapters are mostly **inline helper functions inside one very large
workspace-routes module**, plus one factory-injected sub-router. Consequences:

- They are hard to unit-test in isolation.
- The same projection logic is duplicated as a "legacy" inline path next to the delegated
  canonical path, and the two can diverge.
- A route file becomes the de-facto home of domain shaping.

For a new project, do the opposite:

- One module per adapter role (§3), each exporting a normalizer and a read model.
- The route file contains only HTTP concerns: auth, scope decode, filter parsing, status codes,
  envelope wrapping.
- If a legacy projection is unavoidable, implement it as a **flag inside the canonical adapter**,
  not as a second copy in the route.
- Keep field-level projections (role-based column whitelists) in their own module, named so
  nobody confuses them with map projection.

---

## 15. Porting checklist

1. **Define the canonical coordinate and id conventions** (`[x, y]` degrees; public ids on the
   wire) and enforce them at the edges.
2. **Build the topology/state read model first** — the typed entity envelope is the spine.
3. **Add row normalizers** per entity kind (JSON parse, geometry null-safety, actor display,
   timestamps).
4. **Add the resource/layer projection** with an explicit type→category map and logged
   fallbacks.
5. **Add pure resolvers** for derived answers, carrying their input revisions and a completeness
   flag; keep them persistence-free.
6. **Add version planes and an artifact service**; make the read fall back to the newest artifact
   on the active base version.
7. **Add the reverse adapters** (layer import, legacy sync) with provenance, validation, derived
   length, and skip logging.
8. **Add the route layer** with the standard middleware order, per-direction permission keys, and
   the typed error → JSON contract.
9. **Bound request bodies; plan a viewport/response cap** before the payloads get large; make the
   commit response metadata-only.
10. **Build a client serializer module** and keep styling client-side.

### Explicit non-goals

- Server-side rendering or styling of the application's own map data. The backend normalizes
  geometry and buckets rows; the browser draws.
- Layer assembly on the server. The client decides how categories become layers.
- Real-time streaming of map updates. The contracts here are request/response with version
  stamps.

### Open questions to re-decide for a new project

> **Answered.** These questions were resolved during W0 in [Porting Decisions](porting-decisions.md). The answers there are binding; the questions are kept for provenance.

- Whether to add **viewport/bounding-box filtering and a response cap** up front, and what
  "complete vs truncated" means to the map.
- Whether classification should be an **explicit type→category map** (recommended) or keep
  substring heuristics, and how unknown types are surfaced (default bucket vs an "unclassified"
  layer).
- Whether **marker/asset collections** should be versioned like other artifacts or replaced in
  place.
- Whether a **missing snapshot** degrades or fails, per artifact, and how the client learns which
  happened.
- How **import idempotency** works: natural keys, replace-by-upload, or an explicit rollback.
