# AI Network Infrastructure Planner

本 Rack 副本的完整平台：首次执行 `npm ci`、`npm run rack:setup`，再执行 `npm run dev`，打开 http://localhost:5193/ 。
组员请优先按 [本副本运行说明](RACK_LOCAL_SETUP.md)操作；下方原平台 Getting started 保留作上游参考。

Rack 可视化预览：`npm run rack:preview`，打开 http://127.0.0.1:5183/ 。见 [运行说明](RACK_PREVIEW.md)；只读合成样例，无需 Docker。

Rack course extension: see [progress](PROGRESS.md), [foundation decisions](RACK_FOUNDATION.md),
and the [ordered implementation checklist](RACK_PROJECT_TODO.md). The Rack extension
has a domain foundation, [versioned layout API](RACK_API.md), and a
[workspace for plans and manual rack editing](RACK_WORKSPACE.md);
saved plans can display their [bound HALL floorplan in local projected metres](RACK_FLOORPLAN.md).
The [layout editor](RACK_LAYOUT.md) saves fixed room snapshots and placements with Polygon checks.
Equipment, capacity, planner and Rack Assistant integration are pending.

Platform workspace for infrastructure planning tools. The first tool tenant is the
[Site and Facility Editor](doc/tools/site-and-facility/Overview.md).

The build plan is [doc/implementation-plan.md](doc/implementation-plan.md). When it is time to
host it, [deployment patterns](doc/architecture/deployment-patterns.md) maps each unit onto AWS and
Alibaba Cloud services, and lists what must be closed first — starting with authentication.

## Getting started

From a clean clone to a running shell. Every command runs from the repository root.

### 1. Prerequisites

| Need | Why | Check |
| --- | --- | --- |
| Node 22.9 or later | every workspace declares it in `engines`. The dev scripts use `--env-file-if-exists`, which arrived in 22.9 | `node -v` |
| Docker with Compose v2 | runs both local services: PostgreSQL 16 **with PostGIS** — the schema stores `geometry`, so the plain `postgres` image will not do — and an S3-compatible object store | `docker compose version` |
| Google Chrome | only for `npm run ui:shot` (the screenshot harness) | — |

### 2. Install

```bash
npm ci
```

One install covers both layers: `packages/*` are libraries, `apps/*` are deployables, and
npm links them into a single workspace tree.

### 3. Start the local stack

```bash
npm run dev:up
```

That brings up the two **services the deployment replaces with managed offerings**, as
local containers: PostgreSQL 16 with PostGIS, and an S3-compatible object store. It waits
until both answer from the host — the path the application itself takes — and creates the
storage bucket through the same adapter the application uses, so a signing or addressing
problem surfaces here rather than on the first upload.

The application processes run on the host, not in containers: hot reload is worth more
locally, and how the API reaches these two services is configuration rather than code. See
[compose.yaml](compose.yaml), and
[deployment patterns](doc/architecture/deployment-patterns.md) for what each service becomes
in AWS or Alibaba Cloud.

```bash
npm run dev:status   # what is reachable, and on which port
npm run dev:down     # stop, keeping data
npm run dev:reset    # stop and delete the volumes (drops all local data)
```

Host ports are 55432 for the database and 59000/59001 for the object store (API and
console), chosen off the defaults so a machine that already runs PostgreSQL or another
S3-compatible store does not collide. `AI_INFRA_DB_PORT` and `AI_INFRA_OBJECT_STORE_PORT`
override them, and the values must match `DATABASE_URL` and `STORAGE_ENDPOINT` below.

### 4. Point the apps at it

The migration CLI, the API, the seed, the stack scripts, and the Vite dev server all read
these. The easy path is one file at the repository root:

```bash
cp .env.example .env
```

It is ignored by git, every dev script reads it, and the Vite dev server reads it for the
token bridge — restart that server after creating or changing it, because the bridge reads
the file once at startup. Anything already exported in your shell **takes precedence**, so a
one-off `DATABASE_URL=... npm run migrate` still does what it looks like it does.

Exporting by hand works too, and is the only option if you would rather not keep a file:

```bash
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/facility
export STORAGE_ENDPOINT=http://127.0.0.1:59000
export STORAGE_BUCKET=ai-infra-assets
export STORAGE_ACCESS_KEY_ID=ai-infra
export STORAGE_SECRET_ACCESS_KEY=ai-infra-secret
export AUTH_DEV_SECRET=dev-secret-for-local-only
export AUTH_ISSUER=https://identity.local
```

`.env.example` lists every variable with its default and why it exists, and `npm run dev:up`
prints the same block once the stack is ready.

`AUTH_DEV_SECRET` must be the **same value in both terminals**: the Vite dev server mints
a development token with it and the API verifies with it. If they disagree every request
is a 401 and nothing else looks wrong. Without the variable at all, the dev server mints
no token and the API falls back to a different well-known secret — so setting it
explicitly on both sides is the reliable path. `AUTH_ISSUER` defaults to
`https://identity.local` on both sides; the value above is simply explicit.

The shell has **no sign-in surface yet**, so the browser cannot obtain a token on its
own. In development the Vite dev server mints one and attaches it to proxied API
requests, which is also why `AUTH_DEV_SECRET` never enters the client bundle. The
bridge exists only inside `server.proxy`, which `vite build` and `vite preview` never
use — it is a development affordance, not a sign-in implementation.

### 5. Migrate and seed

```bash
npm run migrate      # applies data-scripts/*.sql in lexical order, once each
npm run dev:seed     # identities, two organisations, a project each, scenarios, and drafts
```

`migrate` is safe to re-run: it records a SHA-256 per file and reports drift instead of
applying anything twice. It exits with an error if `DATABASE_URL` is unset.

`dev:seed` is idempotent and also writes `apps/web/.env.development.local` with the
primary organisation id, which is how the shell knows which organisation to list. It
creates each project's first scenario and a `DRAFT` revision too, because opening a
project enters a workspace context, and a context is a project *and* a scenario *and* a
revision.

**Two organisations are seeded on purpose.** Tenancy is part of what there is to test — a
reference that crosses a tenant, or a permission resolved at the wrong one, is the class of
defect row-level security and the tenant-key discipline exist to catch — and one
organisation cannot show it:

| Organisation | Project | Identities |
| --- | --- | --- |
| Development organisation | Northern DC Campus | `dev-user`, `dev-editor`, `dev-viewer`, `dev-org-admin` |
| Cascade Cloud | Cascade Ridge Campus | `dev-second-admin`, `dev-second-editor`, `dev-second-viewer`, `dev-second-org-admin` |

**Each organisation holds one identity of every role**, four each, so the two tenants can be
compared entry by entry. A role present in one organisation and absent from the other is a
question the second tenant cannot be asked — whether an editor elsewhere may author, or
whether an organisation administrator elsewhere is refused the project keys. `system-admin` is
not among them: it is a system-scope role, held across organisations and owned by none, so an
organisation owning one of every role is four identities rather than five.

No identity belongs to both, so crossing the boundary is a `403` rather than a wider read.
`dev:seed:facility` fills **both** projects, and with two *different* campuses. The graphs
are data (`scripts/lib/dev-facility-layouts.mjs`), one layout per project:

| | Northern DC Campus | Cascade Ridge Campus |
| --- | --- | --- |
| Place | Ashburn, Virginia | Quincy, Washington |
| Projected CRS | EPSG:32618 (UTM 18N) | EPSG:32611 (UTM 11N) |
| Buildings | 2, two storeys | 3, single storey |
| Phases | 2 | 3, chained |
| Failure domains | 2, flat | 3, one nested |
| Utilities | 4 sources, 3 interfaces | 5 sources, 5 interfaces |
| Storage | fuel | fuel and water |

Two different campuses rather than one twice, because identical demo data makes a leak
across the tenant boundary look like a correct answer — and because the two are seeded to
fail *differently*, which is what gives the validator something to report. Northern DC is
missing connection points and commissions cooling after the phase that consumes it;
Cascade Ridge supplies every connection point but claims N+2 on two and one independent
paths.

The identities differ in **authority**, and the account control in the sidebar's bottom band
switches between them. The choice is a request header the dev server's proxy turns into a
bearer token for that subject, so switching changes what the server thinks the caller is —
not merely which controls the client draws. Anything less would test the CSS rather than the
permissions. The organisation follows the identity: an identity in the second organisation
lists the second organisation's projects, which is why the dev server declares the
organisation alongside each identity and only the primary falls back to the env var.

An identity is a **person**, the organisation they belong to, and the role they hold there,
and the menu shows exactly those three — grouped by organisation, because every role appears
once in each and the organisation repeated down every row would stop distinguishing anything:

```
DEVELOPMENT ORGANISATION
  ✓ Dana Whitfield        dev-user
    Project administrator
CASCADE CLOUD
  Priya Raman             dev-second-admin
  Project administrator
```

The `x-dev-subject` login sits beside each name, because that is what the proxy mints a token
for. Nothing in the menu describes a project, a scope, or the reason the identity exists —
those are facts about what the seed is *for*, and a menu of them cannot tell you who you are
acting as. The dev server serves a projection of the seed's list (`clientIdentity`) rather
than the record itself, so the fields the menu must not show are not in the browser to render.
Each option still carries its whole identity — organisation included — in its accessible name,
so an entry read on its own still says where the person works.

| Identity | Person | Organisation | Role |
| --- | --- | --- | --- |
| `dev-user` | Dana Whitfield | Development organisation | project administrator |
| `dev-editor` | Ravi Menon | Development organisation | project editor |
| `dev-viewer` | Mei Lin | Development organisation | project viewer |
| `dev-org-admin` | Alex Okafor | Development organisation | organisation administrator |
| `dev-second-admin` | Priya Raman | Cascade Cloud | project administrator |
| `dev-second-editor` | Ines Alvarado | Cascade Cloud | project editor |
| `dev-second-viewer` | Tom Beckwith | Cascade Cloud | project viewer |
| `dev-second-org-admin` | Noah Bergstrom | Cascade Cloud | organisation administrator |

What each role is *for* — which controls it should see, and which it should not. Both
organisations hold every one of them, so this is a table of roles rather than of people, and it
reads the same in either tenant:

| Role | What it is for |
| --- | --- |
| project administrator | Everything; the baseline where nothing is hidden |
| project editor | Authors and validates, and cannot publish, approve, or waive |
| project viewer | Read-only; every write control should be absent |
| organisation administrator | Administers the organisation and holds no project content keys |

Each identity's own access stops at its organisation, so the second tenant's editor is the
first tenant's editor in every respect except that neither can see the other's project.

Switching reloads the page, because everything a session resolved — permissions, the
project list, the open tabs — was resolved *as somebody*, and patching it in place would
show one identity's state under another's name. The switcher appears only when the dev
server answers with a list, which a build never does; in a deployment the account control
is a label and the header is never sent.

`dev:seed` deliberately leaves the projects empty. To give them something to show, seed the
demo facility artifacts on top of them:

```bash
npm run dev:seed:facility   # run after `npm run dev:seed`, and after `npm run migrate`
```

It writes two kinds of artifact into **each** seeded project's draft revision, from that
project's layout:

* A **facility graph** in the 001 schema — a `DRAFT` envelope, the `SITE` design scope, a
  parcel, two data-centre buildings with halls and support spaces, an equipment yard, two
  phases, failure domains, four utility sources with their interfaces, fuel storage, a
  resilience requirement, an environmental profile, spatial constraints, assumptions, and a
  document. The geometry is real (Ashburn, Virginia; WGS 84 and EPSG:32618), so the canvas
  can fit real bounds once the facility overlay lands in T7.
* Five **project assets** pushed through the W3/W4 pipeline exactly as an upload would be:
  a GeoJSON site plan, a KML boundary survey, a CSV utility point table, a DXF power riser,
  and a PDF feasibility study. Each carries a server-observed checksum, a malware-scan
  state, and its derived `FEATURES`/`GEOREFERENCE` representations, so the Assets surface
  has real content.

It is idempotent: facility rows use deterministic identifiers derived from a fixed seed
namespace, so a re-run replaces exactly what this script owns and leaves anything you
created in the revision alone; an unchanged asset is skipped, and changed sample bytes
become a new immutable version rather than an overwrite. The revision stays `DRAFT`,
because publishing is T5's job and the seeded campus deliberately does not validate
cleanly. The
run ends by self-checking the graph — every geometry record valid, projected, and present —
and fails loudly rather than seeding something that only looks complete. A re-run also
clears the validation and governance rows it produced, because diagnostics reference the
envelope and would otherwise block the graph's replacement.

#### Validating the seeded campus

Verification (T4) is implemented in `@ai-infra/facility`: the 74-entry constraint catalog,
the engine, the policy registry, the worker, and the reads. A `FULL` run is a job; a small
`AFFECTED_SUBGRAPH` run answers inline, because the editor needs it while editing.

```bash
# With `npm run dev` running, the Vite proxy mints the token. Both ids are printed
# by `npm run dev:seed` and `npm run dev:seed:facility`.
REV=f5089815-860a-4d3b-9c35-4c4331bbe81e
PROJECT_ID=cf33af59-b09c-4e4c-90ea-bc347e3f584b
curl -s -X POST "http://localhost:5173/api/v1/projects/$PROJECT_ID/facility/revisions/$REV/validate" \
  -H 'content-type: application/json' -d '{"scope":"FULL"}'
curl -s "http://localhost:5173/api/v1/projects/$PROJECT_ID/facility/revisions/$REV/coverage"
curl -s "http://localhost:5173/api/v1/projects/$PROJECT_ID/facility/revisions/$REV/diagnostics?status=OPEN"
```

The worker runs inside the API process by default, so development needs no third terminal.
`npm run dev:worker` runs the same loop on its own for a deployment that scales job
execution separately; the queue is the `jobs` table, claimed with `FOR UPDATE SKIP LOCKED`,
so both arrangements are the same code path.

Three rules are worth knowing before reading a result:

* **Policy is a pinned reference.** Derating, reserve, required path count, and
  approval-required come from a versioned built-in registry, and a reference is
  `policy_id@version`. A bare name is an unpinned reference and raises
  `facility.resilience.availability_policy.unresolved`; changing a number means adding a
  version, never editing one.
* **Applicability is strict.** A check runs only when the revision contains its evidence. A
  check that cannot run is recorded as **not checked** and its capability cannot reach
  `VALIDATED` — an empty result is never evidence that a check passed. That is why the
  seeded campus reports every capability as `PROVISIONAL` or `NOT_PROVIDED` rather than
  pretending a clean sheet.
* **Diagnostics are append-only.** A re-run supersedes the previous diagnostic for the same
  constraint and evidence; a waiver is inherited through that chain, so a waiver keeps
  meaning what it meant until it expires or is revoked.

A `FULL` run reports different findings per campus, because the two are seeded to fail
differently:

* **Northern DC Campus** — 9 errors and 12 warnings. Four utility sources have no
  connection point, COOLING has one independent path against an N+1 policy, two phase
  capability dates precede the phase that consumes them, and two sources claim availability
  after the phase that uses them. The warnings are unresolved assumptions, building-local
  geometry with no reviewed transform, no water envelope, phase dates without precision, and
  non-firm capacity states.
* **Cascade Ridge Campus** — 2 errors and 7 warnings. Every connection point exists and the
  phase dates are precise, so the only errors are the ones its policy claim produces: N+2
  against two independent power paths and one cooling path. The warnings are unreviewed
  transforms, one open assumption, and a contractual network-entry source.

Neither is a clean sheet, which is the point: a seed that always validated would exercise no
finding.

### 6. Run it

```bash
npm run dev          # both, in one console; Ctrl-C stops both
```

Each half is still available on its own — `npm run dev:api` and `npm run dev:web` — for when
you want a separate console or to restart one without the other. `npm run dev` prefixes every
line with `[api]` or `[web]` so interleaved output stays attributable, stops both when either
one exits, and warns up front if the database or object store is not reachable, because a
missing database shows up as 503s on protected routes rather than as an obvious failure.

Move them with `PORT` and `WEB_PORT` if the defaults are taken:

```bash
PORT=8792 WEB_PORT=5199 npm run dev
```

If a port is already taken, `npm run dev` names the process holding it and stops before
starting either half. The usual occupant is a stray copy of itself: the two halves are started
detached so one Ctrl-C can signal the whole tree, which also means an earlier run outlives its
terminal. The choice is then explicit rather than implicit.

```bash
npm run dev -- --kill    # reclaim ports this repository's own dev servers hold, then start
npm run dev -- --reuse   # leave what is already listening, and start only the missing half
```

`--kill` signals only the processes listening on those two ports, and only when they run from
this checkout's `apps/api` or `apps/web`; anything else is reported and left alone. `--reuse`
does not pretend to own the server it joins — the banner marks it as already running, and
Ctrl-C stops only what that console started. Neither is the default because a rejoined server
keeps the environment it read when it started, so a `.env` change since then stays invisible.

Open **<http://localhost:5173>**. Use `localhost` rather than `127.0.0.1`: the dev server
binds the IPv6 loopback, so the literal address can refuse the connection.

You should see the project list with **Northern DC Campus**. Click the row to enter the
workspace: project context bar, sidebar, open-view tabs, the Site & Facility canvas, and
the collapsed `Panels` drawer along the bottom.

The canvas opens the active revision and draws its facility graph over the basemap —
campus boundary, parcel, buildings, halls and support spaces, and utility connection
points, with a switch per layer. Selecting a shape names it and states its kind, level, or
capacity, and a distance scale in the corner states how much ground the view covers, in SI
units. A search control in the top-right corner finds a drawn feature by name, type, or
role: hovering or focusing a result highlights it on the map, and choosing one selects it,
so a name you know can take you to a place you have not found yet. If you have run `npm run dev:seed:facility` (step 5) there is a campus to see; if
you have not, the same surface renders the empty grid, which is a stated state rather than
a failure. With no basemap provider reachable the geometry still draws on the plan-only
grid. That fallback names the provider that failed and offers a retry, and it is never
permanent: a tile that arrives clears it, as does changing provider or moving the view.

The default providers are Google Maps, a commercial OSM provider, and the public OSM tile
server; the canvas picks one that answers. **Self-hosted tiles are not offered unless this
deployment has a tile server**, because an option that fails on every tile reads as a broken
canvas rather than an unconfigured one. To use them, run `npm run dev:tiles` in another
terminal and set the address it serves on:

```
MAP_SELF_HOSTED_TILE_URL=http://127.0.0.1:8080/tiles/{z}/{x}/{y}.png
```

Running that script twice is not an error — the second copy reports that one is already
listening on 8080 and exits.

The graph is read from
`GET /api/v1/projects/{projectId}/facility/revisions/{revisionId}`, which returns the
design-context slice of the normalized envelope under `facility.read`. `capabilityCoverage`
is empty because T4 derives it: an unvalidated draft has no coverage, and the surface says
"coverage not derived" rather than showing an empty map as a pass.

### 7. Verify without a browser

```bash
curl -s http://127.0.0.1:8787/healthz   # liveness
curl -s http://127.0.0.1:8787/readyz    # readiness, including the database

ORG=$(grep '^VITE_ORGANISATION_ID=' apps/web/.env.development.local | cut -d= -f2)
curl -s "http://localhost:5173/api/v1/projects?organisation_id=$ORG"
```

The last call goes through the Vite proxy, so it carries a minted token. Calling the API
port directly without one is a 401 by design — that is the authentication working, not a
misconfiguration.

The object store is checked the same way, through the adapter the application uses:

```bash
npm run dev:status     # database and object store, probed from the host

node --input-type=module -e "
  import { loadConfig } from '@ai-infra/core';
  import { createStorage } from '@ai-infra/storage';
  const storage = createStorage(loadConfig());
  await storage.putObject({ key: 'healthcheck.txt', body: 'ok', contentType: 'text/plain' });
  console.log(await storage.headObject({ key: 'healthcheck.txt' }));
  console.log(storage.signedDownloadUrl({ key: 'healthcheck.txt', expiresIn: 60 }));
"
```

That writes an object and reads its metadata back, then mints a download URL you can open in
a browser. If the URL resolves, the credentials and the signature are both correct.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 UNAUTHENTICATED` on every request | `AUTH_DEV_SECRET` unset or different in the two terminals | export the same value in both, restart both |
| `503 SERVICE_UNAVAILABLE`, "running without a database" | `dev:api` was started without `DATABASE_URL` | export it and restart `dev:api` |
| `npm run dev` reports "Port 5173 is held by this repository's own dev server" | an earlier `npm run dev` outlived its terminal | `npm run dev -- --kill` to reclaim it, or `npm run dev -- --reuse` to keep using it |
| `EADDRINUSE: address already in use :::8787` | an older `dev:api` is still running and was started directly, without the pre-flight check `npm run dev` does | `npm run dev -- --kill`, or `lsof -nP -iTCP:8787 -sTCP:LISTEN` and kill that pid, or run on another port with `PORT=…` |
| `Port 5173 is already in use` | an older `dev:web` is still running. Vite used to move to 5174 silently, which is how a stray server ends up somewhere your bookmark is not | `npm run dev -- --kill`, or `lsof -nP -iTCP:5173 -sTCP:LISTEN` and kill that pid, or use `WEB_PORT=…` |
| `Cannot find module '@ai-infra/...'` | workspaces not installed, or a package was moved | `npm ci` |
| The project list renders but clicking a project does nothing | `dev:seed` never ran, so the project has no scenario to open | `npm run dev:seed` |
| `STORAGE_NOT_CONFIGURED`, "No storage bucket is configured" | `STORAGE_BUCKET` is unset | export it, or set `STORAGE_DRIVER=filesystem` with `STORAGE_ROOT` for offline work |
| `503 SERVICE_UNAVAILABLE`, "No LLM provider is configured" | `LLM_ENDPOINT` and `LLM_MODEL` are unset, so the assistant host was never assembled. The rest of the API runs, by design | set them in `.env` — with `LLM_API_KEY_SECRET` naming the variable that holds the key, e.g. `LLM_API_KEY_SECRET=SJTU_LLMS_API_KEY` and `SJTU_LLMS_API_KEY=…` — and restart the API. `node --watch` watches sources, not `.env`, so an edit alone changes nothing |
| `STORAGE_REQUEST_FAILED` with `AccessDenied` | the store's credentials differ from the ones the application was given | `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` must match `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`; the defaults are `ai-infra` / `ai-infra-secret` |
| `npm run dev:up` cannot bind 55432 or 59000 | something already owns that port — commonly a locally installed PostgreSQL, or a container started earlier | `npm run dev:status` reports which are reachable; set `AI_INFRA_DB_PORT` or `AI_INFRA_OBJECT_STORE_PORT`, and match `DATABASE_URL` / `STORAGE_ENDPOINT` to them |
| `dev:up` stops with "pull access denied" | the registry is unreachable or wants a login | both images are public: check `docker login` and network access |
| `STORAGE_UNSUPPORTED` from `signedDownloadUrl` | the filesystem driver cannot mint URLs, by design | use the S3 driver (`npm run dev:up`) whenever a download URL is needed |
| `migration.drifted` when running `npm run migrate` | an already-applied migration file was edited | restore the file; applied migrations are immutable |
| The shell looks stale after editing CSS or JS | a long-lived hot-reload session | hard-refresh the tab |

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Cross-cutting primitives: configuration, correlation IDs, the standard response envelope, structured logging, and redaction |
| `packages/secrets` | Secret provider interface and implementations. Secrets are injected at runtime and never stored in the database, logs, or images |
| `packages/db` | PostgreSQL connection pool, tenant and organisation session scoping, and the migration runner |
| `packages/storage` | Object storage behind one interface: an S3-compatible driver for both local and cloud, and a filesystem driver for tests. The same code path serves a local container and a managed bucket |
| `packages/identity` | Token verification (OIDC JWKS and a development shared secret), the authenticator, and step-up guards |
| `packages/rbac` | The permission catalog and presets, the cached evaluator, the decision contract, the permission guard, and the SQL repository |
| `apps/api` | The deployable API gateway: routing, correlation propagation, the error contract, and readiness |
| `apps/*` | Additional deployables as they arrive (workers, tile proxy, assistant host) |
| `apps/web` | The workspace shell: project list, project workspace, tool slots, bottom drawer, Assets surface, assistant composer, and the permission predicate it evaluates against (`src/rbac/client.js`) |
| `data-scripts` | Ordered SQL migrations applied by `packages/db` |
| `doc` | The specification bundle. It is the source of truth; code is corrected to match it |
| `src` | The C++ simulation engine |

The arrow only points one way: an app may import a package, never the reverse, and
`apps/web` imports no `@ai-infra/*` package at all — the one thing it needed from the
backend, a dependency-free permission predicate, lives in its own tree. Both halves are
enforced by `apps/web/src/tests/import-boundaries.test.js` rather than by convention.

## Commands

```bash
npm ci                 # install workspaces
npm test               # run every workspace test suite
npm run build          # build every workspace that has a build step

npm run dev            # the API and the shell together, one console
npm run dev:up         # start the local database and object store, create the bucket
npm run dev:status     # report what the local stack is serving
npm run dev:down       # stop the stack, keeping data
npm run dev:reset      # stop the stack and delete its volumes

npm run migrate        # apply data-scripts/*.sql (needs DATABASE_URL)
npm run dev:seed       # seed development data (needs DATABASE_URL)
npm run dev:api        # API gateway, watch mode
npm run start:api      # API gateway, no watch
npm run dev:web        # workspace shell, Vite dev server
npm run ui:shot        # screenshot the running shell (see below)
```

`npm test` runs each workspace's own suite. Suites that need a database **skip** when
`DATABASE_URL` is unset, so export it to run them for real:

```bash
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/facility
export STORAGE_ENDPOINT=http://127.0.0.1:59000 STORAGE_BUCKET=ai-infra-assets
export STORAGE_ACCESS_KEY_ID=ai-infra STORAGE_SECRET_ACCESS_KEY=ai-infra-secret
npm test               # adds the DB-backed repository and route tests, and a real
                       # object-store round trip including a presigned download
```

CI provides both services as containers, so that round trip runs there even when it skips on
a machine with no local store.

### Object storage

`@ai-infra/storage` is the only way the platform touches an object store, and it is
deliberately the same code for a local container and a managed bucket:

```js
import { loadConfig } from '@ai-infra/core';
import { createStorage } from '@ai-infra/storage';

const storage = createStorage(loadConfig());
await storage.putObject({ key, body: readableStream, contentType, contentLength });
await storage.headObject({ key });       // metadata, or null when the object is absent
await storage.getObject({ key });        // { body: stream, size, ... }, or null
await storage.deleteObject({ key });
storage.signedDownloadUrl({ key, expiresIn: 900, filename }); // GET only, never list-capable
```

Two drivers: `s3` — MinIO locally, S3 or any compatible endpoint in deployment — and
`filesystem`, for tests and for working offline. The filesystem driver refuses to mint a
download URL rather than returning something that behaves differently in a browser.

Uploads stream **through the API** and only downloads use signed URLs
([D23](doc/tools/site-and-facility/decisions.md)). A streamed body has no hash before it is
read, so uploads sign `UNSIGNED-PAYLOAD` and rely on TLS; the checksum the platform records
is computed while the bytes flow past. Signature Version 4 is implemented on `node:crypto`
and checked against vectors from an independent implementation — see
`packages/storage/src/tests/sigv4.test.js` for the parameters that produced them.

### Looking at the shell

A visual change is verified by looking at it. With the dev server running, the
screenshot harness drives the real application in headless Chrome and writes a PNG,
including clicking into the state under review:

```bash
npm run ui:shot -- --out /tmp/list.png                      # the project list
npm run ui:shot -- --out /tmp/ws.png --click "text=Northern DC Campus"
npm run ui:shot -- --out /tmp/drawer.png \
  --click "text=Northern DC Campus" --click "text=Panels" --height 900
npm run ui:shot -- --out /tmp/dark.png --fresh \
  --eval "localStorage.setItem('ai-infra.ui.appearance.v1', JSON.stringify({colorScheme:'DARK'}))" \
  --reload --click "text=Northern DC Campus"
```

`--probe "<js>"` prints an evaluated value, so an observation can be checked rather
than asserted — for example `--probe "getComputedStyle(document.querySelector('.surface-empty__title')).color"`.
`--clip-selector ".drawer__bar" --scale 2` captures one element at zoom, which is how
a 1px border or an alignment is reviewed instead of guessed at from a shrunk preview.
It needs no dependencies: Node's built-in `WebSocket` speaks the DevTools Protocol.
It expects Google Chrome at the default macOS path; set `CHROME_BIN` to override.
Written screenshots land wherever `--out` points (`ui-shots/` is ignored by git).

## Conventions

* **Contract first.** Wire shapes come from the specification bundle, never from an implementation convenience.
* **Migrations are immutable once applied.** The runner records a checksum per file and fails on drift.
* **Tenant isolation is enforced twice.** Row-level security in the database, plus `project_id` in every key and reference ([D22](doc/tools/site-and-facility/decisions.md)).
* **Secrets never reach logs.** Log fields pass through a redactor that strips credential-shaped keys and signed-URL query parameters.
