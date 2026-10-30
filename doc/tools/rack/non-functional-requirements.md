# Rack Planner Non-Functional Requirements

## Purpose and Relationship to Functional Documents

This document distinguishes enforced implementation limits from proposed operational targets. [Entity Model](entity-model.md) defines valid objects; [API Contracts](backend-api-contracts.md) defines operations; [Verification](verification-requirements.md) defines evidence. Numeric ceilings below are inspected guards, not measured sustainable throughput. Proposed targets require experiments before being promised.

## Scale Limits

| Concern | Current bound | Source |
| --- | --- | --- |
| Saved layout | 256 racks, 2,048 devices, 256 rack-limit records; independent1MiB default HTTP body cap | Domain normalization; generated browser mirror |
| Declared exclusions | 64 rectangles | Spatial normalization |
| Room geometry | 64 rings, 4,096 points, 10,000m extent per axis | Room localization |
| Plan list | 20 default, 50 max/page | Plan service |
| Relocation | 64 movable racks; 2,048 poses/rack; 16,384/option; batch128 | PLANNER_LIMITS |
| Auto allocation | 128 pending devices, 64 target racks, 100U height | ALLOCATION_LIMITS |
| Demand design | 16 groups, 128 devices, 32 racks; 256 arrangements/strategy; batch16 | DEMAND_LIMITS |
| Rack Assistant | 20-item pages, 10 calls/turn, one relocation generation | Rack projection |
| Personal connections | One default per authenticated user; single API instance adapter | Connection service |

These limits serve different paths. A saved 256-rack plan is not automatically accepted by a 64-movable-rack planner. Locking existing racks changes planner eligibility but does not increase every algorithm's bound.

## Performance and Latency Budgets

Planning services set 5-second SQL statement timeouts and 15-second cooperative deadlines for relocation/demand design. They return explicit timeout errors and do not save partial results. Provider calls use shared configured timeouts, with a 60-second default in the current connection adapter; turn/output budgets are host configuration. None of these is a verified end-user SLA.

Proposed course-scale experiments:

1. Use fixed, labelled synthetic inputs at 8/32/64 racks and varied obstacle/vertex counts, staying within each path's guards.
2. Measure check/read/save and planning separately; report wall-clock plus server timings where available.
3. Repeat identical scenarios after warm-up, record count/median/p95 and failures/timeouts; retain raw samples and machine/database versions.
4. Compare baseline/heuristic under identical inputs using feasibility, placed-device count, rack count, envelope area and search work.
5. Report no-result cases, unknown inputs and pathological geometry; do not present one happy-path timing as a benchmark.

Initial target (proposed): keep ordinary plan inspection/check feedback comfortably interactive, while bounded planning may take seconds. Round33 exercised a128-rack/944-installed-device example through check/save/readback/allocation/relocation and browser views, plus a2,048-device HTTP persistence boundary and128-rack/2,048-installed-device domain check. One local comparison took14.6s. This is smoke evidence, not repeated scaling/load measurement, an SLA or a complete experiment. A numeric responsiveness commitment should be selected only after the above measurements.

## Concurrency, Availability and Durability

Project access has a separate [authorization contract](access-control.md): granular Rack deletion/recovery, organisation-scoped existing accounts, versioned membership changes, project-row serialization, fresh actor checks, last-administrator protection and transactional access events. Effective authority remains additive across scopes. Permission-decision invalidation is process-local; multi-instance deployments need coordinated revocation before being accepted.

Optimistic versions and a shared plan-row lock prevent lost updates across save/lifecycle paths. Source token/lifecycle locks prevent a Facility writer advancing those values during a Rack save. This does not provide collaborative draft merge, offline synchronization or live presence.

Saved design durability depends on PostgreSQL volumes and backups. Browser drafts and candidates are ephemeral. Model failure must not disable ordinary Rack editing/checking. Local API/Web/Docker need running processes after reboot; a browser bookmark alone does not start the platform.

Connection metadata/key storage is single-process: horizontal scaling requires centralized metadata, concurrency control, revocation and a managed secret-store design. Durable mounts must preserve both data and master key. RPO/RTO, disaster recovery and backup restore drills remain unaccepted operational items.

## Security and Privacy

| Risk | Current control | Remaining boundary |
| --- | --- | --- |
| Foreign plan access | Authenticated scope, route/tool checks, tenant transactions/RLS | Production role/RLS audit still required |
| Lost edits | Version/token/snapshot guards and idempotency | No automatic merge |
| Prompt injection | Strict model tools, untrusted returned names/references, no Rack writes | Model prose can still be misleading |
| Credential exposure | External encrypted storage, public metadata only, request-local redaction | Runtime-account/API compromise can expose secrets |
| SSRF | Public HTTPS, all DNS answers checked, pinned socket, redirects blocked | Admin allowlist is privileged configuration |
| External disclosure | First-use notice; only relevant tool data should be sent | Provider retention/usage policy is external |
| Resource exhaustion | Input/search/tool bounds and timeouts | Multi-user fairness/load testing still needed |
| Development auth | Server-side dev token bridge | Not a production login/MFA solution |

Do not commit .env, secrets, master keys or local backups. Do not print provider bodies to diagnose credential failures. No real API key is needed for documentation/unit fixtures. Browser labels or private code provenance do not authorize changes to the teacher platform.

## Observability and Audit

Retain correlation IDs, operation/outcome/duration and credential-free scope/version metadata. Planning exposes elapsedMs/limits/fingerprints; command records retain request hashes/applied versions. Unknown/unchecked/timeout counts are useful operational signals.

Current logs are not a complete immutable user-visible audit trail or metrics service. Do not log full credential forms, prompt attachments or large geometry payloads by default. A fingerprint identifies input equality; it is not an authentication mechanism.

## Retention and Deletion

Soft delete retains content and allows restore. There is no Rack hard-delete policy, candidate archive or log retention service. Future policies must address snapshots, commands, sessions, secrets, backups and dependent references separately. Deleting a personal model connection leaves Rack plans intact. Deleting a plan must not delete another user's model connection.

## Accessibility, Localization and Units

English is the current built-in UI/specification language. SI metres/kg/kW and integer U remain explicit; locale formatting must not alter JSON numeric semantics. Unknown, zero and not checked stay distinct. Keyboard/focus/screen-reader and narrow-screen acceptance require actual manual checks; static tests alone do not prove compliance.

## Capacity Growth and Open Items

Current checks include pairwise rack/device comparisons and repeated Polygon tests. Before scaling limits upward, profile queries, allocation, serialization, React canvas and large diagnostic payloads. Potential work includes spatial indexes/batching, worker-based planning, cancellation/fair scheduling and response digests. These are proposals, not implemented performance claims.

Acceptance requires a reproducible benchmark report, recovery drill, restricted-role security review and manual accessibility evidence before making production-scale promises. The course report should explain these limitations alongside the implemented architecture.
