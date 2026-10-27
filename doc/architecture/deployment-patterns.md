# Deployment Patterns

## Status and Scope

This is **guidance, not a contract**. The specification bundle remains authoritative for
behaviour; this document only describes how the existing code maps onto managed cloud
services, and where that mapping currently has holes.

Two worked patterns are given, AWS and Alibaba Cloud (Aliyun). They are deliberately the
same shape — a static frontend, stateless backend instances, a managed PostgreSQL with
PostGIS, and an S3-compatible object store — because the repository already separates
those units: `apps/*` are deployables, `packages/*` are libraries, and the one-way import
rule is enforced by `apps/web/src/tests/import-boundaries.test.js`. Nothing here requires
reorganising the code.

## 1. What the code already gives you

Every deployment-relevant seam exists today and is configuration rather than code.

| Concern | Seam | Note |
| --- | --- | --- |
| Process configuration | Environment only (`packages/core/src/config.js`): `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `CORS_ORIGIN`, `AUTH_*`, `SECRET_SOURCE`, `AUTO_PROVISION`, `BODY_LIMIT_BYTES` | No config file, no per-environment build of the API |
| Liveness | `GET /healthz` | Public, and **never touches a dependency** — so a database blip does not restart every instance |
| Readiness | `GET /readyz` | Public; runs `SELECT 1` and returns 503 when the database is missing or unreachable, so a load balancer can drain an instance that cannot serve |
| Graceful shutdown | `SIGTERM` / `SIGINT` → `server.close()` then pool end | Matches load-balancer deregistration rather than dropping in-flight requests |
| Migrations | `npm run migrate`, a **separate CLI** (`packages/db/bin/migrate.js`) | Advisory-locked, SHA-256 drift-detecting, resolves `data-scripts` from the repository root, and is *not* part of API boot |
| TLS to the database | `?sslmode=require` in `DATABASE_URL` | Verified: `pg` sets `ssl = {}` with the parameter and `ssl = false` without it. Omitting it opens an unencrypted connection |
| Production authentication | `AUTH_JWKS_URI`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | The shared-secret verifier **throws** when `NODE_ENV=production`; an OIDC issuer is required |
| Object storage | `@ai-infra/storage`: one interface over an S3-compatible driver, configured by `STORAGE_*` | The same driver addresses a local container and a cloud bucket, so only the endpoint and credentials differ between development and deployment |
| Secrets | `SECRET_SOURCE=env` or `file` | Two providers; a managed-store provider is a small addition |
| Observability | Single-line JSON to stdout, `x-correlation-id` echoed on every response | Straight into CloudWatch Logs or SLS without a shipper |
| Frontend artifact | `npm run build` → static `dist/` | No SSR. The browser calls relative `/api/...` paths, and `API_URL` affects only the dev proxy |
| Deployable separation | `apps/web` imports no `@ai-infra/*` package at all | The frontend artifact contains no backend code, so the two deploy independently |

## 2. Gaps to close before either pattern is production-ready

Ordered by whether the platform can run at all.

1. **Authentication — blocker.** `createHmacVerifier` refuses to construct under
   `NODE_ENV=production` (`packages/identity/src/verifier.js`). An OIDC issuer with a JWKS
   endpoint is required, **and** the shell needs a sign-in surface: today its only token
   source is the Vite dev proxy, which `vite build` never uses.
2. **The active organisation is build-time.** `VITE_ORGANISATION_ID` is baked into the
   bundle (`apps/web/src/main.jsx`). Correct for a single-tenant deployment, wrong for
   many; the value belongs to the session, as that file's comment already says.
3. **Object storage is unbuilt** (W3). Nothing imports an S3 client yet. CI already runs a
   `quay.io/minio/minio` service container, so S3 semantics are the intended target.
4. **Database privileges on a managed service.** Migration 001 runs
   `CREATE EXTENSION postgis` / `pgcrypto`, which needs the master or a granted role; and
   row-level security is enabled but **not FORCEd**, so an application connecting as the
   table owner bypasses the policies. See §6.
5. **Secrets from a managed store.** `SECRET_SOURCE` supports `env` and `file`; on EC2/ECS
   inject from the cloud secret store at boot, or add a provider.
6. **No continuous deployment.** CI tests, migrates, and builds, but deploys nothing.

Two smaller ones: `CORS_ORIGIN` accepts a **single** origin and defaults to `null`, i.e.
no CORS headers are emitted; and permission decisions are cached in-process (30s for
decisions, 300s for key sets), so with N instances a revocation can lag per instance.

## 3. Shared topology

```
                    ┌──────────────────────────────┐
   browser ────────▶│ CDN  ──  static bundle        │  (frontend)
        │           │      └── /api/* ──┐           │
        │           └───────────────────┼───────────┘
        │                               ▼
        │                    ┌──────────────────────┐
        │                    │ load balancer        │
        │                    │  health: /readyz     │
        │                    └──────────┬───────────┘
        │                               ▼
        │                    ┌──────────────────────┐        ┌──────────────────┐
        │                    │ backend instances    │───────▶│ managed Postgres │
        │                    │  (N, stateless)      │  TLS   │  + PostGIS       │
        │                    └──────────┬───────────┘        └──────────────────┘
        │                          ▲    │ streams bytes, signs download URLs
        │      uploads (streamed)  │    ▼
        └──────────────────────▶ object store (S3-compatible) ◀── downloads (signed)
```

The frontend reaches the API through the **same origin** as the static bundle. That is a
deliberate choice, not a detail: it removes CORS from the picture entirely, including the
preflight that `authorization` and `content-type` would otherwise trigger.

Locally, the same two services run as containers: `npm run dev:up` starts PostgreSQL with
PostGIS and an S3-compatible object store, and `packages/storage` addresses both through the
same driver, the same interface, and the same environment variables as their managed
counterparts. Nothing about the database or storage code path differs between the two.

Uploads and downloads take different paths ([D23](../tools/site-and-facility/decisions.md)).
**Uploads are streamed through the API**, which writes them to the object store, computes
the checksum itself, and enforces declared size and media type while the bytes arrive.
**Downloads use signed URLs** and go straight to the store. Neither path gives the browser
a storage credential, and the bucket needs no write endpoint reachable from the internet.

That asymmetry is deliberate: a write capability is worth more to an attacker than a
time-limited read of immutable content, and a read is cacheable at the CDN.

Two deployment consequences follow, and both are the API's to carry:

* **The API is now a data path.** Size its request body limit, request timeout, and
  concurrency for the largest accepted asset, and remember egress is paid twice
  (browser → API → store). An upload holds a connection to the object store for its
  duration, so a handful of large transfers is a capacity consideration, not a rounding
  error.
* **Bucket CORS is still required, but only for reads.** The signed download is a
  cross-origin `GET` from the SPA origin; uploads never touch the bucket endpoint from the
  browser. Configure `GET` (and `HEAD`) for the app origin, and no write methods at all.
* **Resumability is not yet specified** — D23 records that the previous design got
  multipart resumability for free, so large-file intake needs a session resource and a
  completion call designed before rollout. Until then, treat the per-upload duration and
  size limits as hard operational bounds.

## 4. Pattern A — AWS

| Unit | Service | Notes |
| --- | --- | --- |
| Frontend | **S3** (private) + **CloudFront** with Origin Access Control | Serve `/` from the S3 origin and `/api/*` from the ALB origin |
| Backend | **EC2** in an Auto Scaling group behind an **ALB** | AMI or launch template with the app image; instances are replaceable |
| Database | **RDS for PostgreSQL** with the PostGIS extension | Multi-AZ for production; verify the extension is available for the chosen engine version |
| Object store | **S3** bucket for assets | Access via IAM instance profile. Uploads stream through the API; the API signs download URLs |
| Identity | **Cognito** user pool (or Auth0 / Keycloak) | Must publish a JWKS endpoint for `AUTH_JWKS_URI` |
| Secrets | **Secrets Manager** or **SSM Parameter Store** | Injected into the instance environment at boot |
| Logs and metrics | **CloudWatch Logs** from stdout | Correlation IDs already travel on every request and response |
| Images | **ECR** | If deploying containers rather than AMIs |
| Queue (W4 workers) | **SQS** | Import and validation jobs run outside the request path |

Production-shaped configuration:

```bash
NODE_ENV=production
PORT=8787
DATABASE_URL=postgres://app_user:…@<rds-endpoint>:5432/facility?sslmode=require
DATABASE_POOL_MAX=10
AUTH_ISSUER=https://<user-pool-domain>/
AUTH_AUDIENCE=<api-identifier>
AUTH_JWKS_URI=https://<user-pool-domain>/.well-known/jwks.json
SECRET_SOURCE=env
LOG_LEVEL=info
# CORS_ORIGIN deliberately unset: CloudFront makes the API same-origin
```

Operational notes:

* **Health checks.** Point the ALB target group at `/readyz`, so an instance that has lost
  the database is drained instead of serving errors. Use `/healthz` for liveness where the
  platform distinguishes the two — it stays healthy during a database blip by design.
* **Deregistration delay** must exceed the shutdown time, or the load balancer will cut
  requests the process was still finishing.
* **Migrations run as a one-off task** (ECS task, or SSM Run Command from the pipeline),
  never in instance user-data. The runner is advisory-locked, so a racing deploy cannot
  corrupt state, but a single job is still the clearer operation.
* **Invalidate CloudFront** after each frontend deploy; asset filenames are hashed but
  `index.html` is not.
* **Deep links are not implemented yet**, so no SPA rewrite rule is needed today. When
  client-side routing arrives, add an error-document mapping to `index.html`.
* **Pool sizing.** `DATABASE_POOL_MAX` (default 10) is per instance: 5 instances is 50
  connections before headroom. Either budget against `max_connections` or introduce RDS
  Proxy.

## 5. Pattern B — Alibaba Cloud (Aliyun)

| Unit | Service | Notes |
| --- | --- | --- |
| Frontend | **OSS** static website hosting + **Alibaba Cloud CDN** | Serve `/` from OSS and `/api/*` from the load balancer, so the API stays same-origin |
| Backend | **ECS** in an Auto Scaling group behind **SLB** (ALB or CLB) | Same stateless process; instance RAM role for object-store access |
| Database | **ApsaraDB RDS for PostgreSQL** with PostGIS, or **PolarDB for PostgreSQL** | Confirm PostGIS availability for the engine version at provisioning time |
| Object store | **OSS** bucket for assets | Uploads stream through the API; the API signs download URLs, and STS is available if a broader scoped grant is ever needed |
| Identity | **IDaaS (EIAM)** where it can act as an OIDC issuer; otherwise self-host Keycloak on ECS/ACK | The requirement is only "OIDC issuer publishing JWKS" — any compliant provider satisfies `AUTH_JWKS_URI` |
| Secrets | **Secrets Manager** with **KMS** | Injected at boot, as with Secrets Manager on AWS |
| Logs and metrics | **SLS** (Simple Log Service) + CloudMonitor | Collect the JSON stdout directly |
| Images | **ACR** + **ACK** or plain ECS | Containers optional; the app is a single Node process |
| Queue (W4 workers) | **MNS** or **RocketMQ** | Same role as SQS |

Configuration is identical to Pattern A apart from endpoints; nothing in the application
is cloud-specific.

Differences worth planning for rather than discovering:

* **OSS + CDN integration** is tighter than S3 + CloudFront, but CDN cache refresh is a
  distinct step on deploy, exactly as invalidation is on AWS.
* **Presigned URLs vs STS.** Both sign reads; STS temporary credentials are the
  Aliyun-native route if a broader scoped grant is ever needed. Uploads are unaffected,
  because they stream through the API on both clouds.
* **IdP support must be verified.** OIDC/JWKS is the only hard requirement the code has;
  if the managed offering cannot publish a suitable issuer, a small Keycloak deployment is
  a supported answer, not a workaround.
* **Connection pooling.** ApsaraDB offers a proxy; the sizing arithmetic from Pattern A
  applies unchanged.

## 6. The one database decision to make explicitly

Migration 001 enables row-level security on every table carrying `project_id` and installs
a project-isolation policy, but it deliberately does **not** run `FORCE ROW LEVEL
SECURITY` — the migration says so, and why: the owning role is left able to run
maintenance. The consequence on a managed database is concrete. The usual single-role
setup connects as the owner, and **an owner is not subject to its own policies**, so
tenant isolation then rests on the application's `project_id` predicates alone.

Two honest options, and one should be chosen before production data exists:

1. **Keep migrations on the owner, run the application as a separate non-owner role** with
   explicit grants. Preserves the migration's intent and makes RLS real for the app.
2. **Run `ALTER TABLE … FORCE ROW LEVEL SECURITY`** after migrating, so the owner is
   subject to the policy too. Simpler, but maintenance statements against those tables now
   need to set `app.project_id`.

PostGIS is the other privilege point: `CREATE EXTENSION` requires the RDS master user or a
role granted `rds_superuser`, so the migration job runs with more privilege than the
application does.

## 7. Go-live checklist

* [ ] OIDC issuer configured; `AUTH_JWKS_URI`, `AUTH_ISSUER`, and `AUTH_AUDIENCE` set; the
      shell has a sign-in surface (currently the blocker)
* [ ] `NODE_ENV=production`, so a dev secret cannot silently be accepted
* [ ] `DATABASE_URL` carries `?sslmode=require`
* [ ] Migrations executed as a one-off job; the runner reports no drift
* [ ] RLS decision from §6 applied, and verified by connecting as the application role and
      reading another tenant's row — expecting zero rows
* [ ] Target group health check on `/readyz`; deregistration delay ≥ shutdown time
* [ ] `DATABASE_POOL_MAX` × instance count budgeted against the managed connection limit
* [ ] Secrets come from the cloud secret store, not a plaintext environment
* [ ] CloudWatch/SLS receiving stdout; a correlation ID from a browser request can be found
      in the logs end to end
* [ ] Frontend deployed with cache invalidation, and the organisation resolved from the
      session rather than the bundle

## 8. Not covered here

Cost modelling, multi-region and disaster recovery, network topology (subnets, NAT, private
endpoints), Kubernetes-specific manifests, the C++ simulation engine's deployment, and
worker sandboxing for the licensed import adapters (W4). Each deserves its own document
when its milestone arrives.
