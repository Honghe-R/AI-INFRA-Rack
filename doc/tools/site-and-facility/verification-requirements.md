# Site and Facility Editor Verification Requirements

This document defines verification performed by the Site and Facility Editor and the complete cross-domain validation batch run by Verify. Exact diagnostic identifiers, default severities, gating capabilities, and remediation categories are cataloged in [Constraint Catalog](constraint-catalog.md); this document defines when checks run, what they gate, and how results are published.

## Validation Scope

Verification has two execution paths:

| Path | Trigger | Coverage | Effect |
| --- | --- | --- | --- |
| Affected-subgraph (`AFFECTED_SUBGRAPH`) | Any committed change set or explicit user request | Only entities, geometry, budgets, and interfaces reachable from the changed entities | Advisory; tagged with the `base_etag` it was computed against; never sets lifecycle state |
| Full (`FULL`) | Explicit request, or mandatory before publication | Every applicable check in the catalog for the revision | Produces the `ValidationSummary` that publication consumes |

Verify runs the complete batch before a Facility Envelope may be published as `VALIDATED`. The editor must never claim full facility feasibility merely because its own fields are complete.

Local results are invalidated when any referenced entity changes or the draft ETag advances (`facility.revision.changed.v1`). A stale local result must be displayed as stale, never merged into a later summary. Local spatial checks execute synchronously against the transactional store's native spatial index, which PostGIS provides ([D15](decisions.md)); they never depend on a derived or eventually-consistent projection.

## Target Gating

Core design targets gate downstream engineering; peripheral targets gate trust, traceability, or workflow readiness. They are evaluated separately so a document-import or approval status cannot mask an unresolved physical constraint.

| Target class | Gate |
| --- | --- |
| Core | A `FacilityDesignContext` with valid geometry and spatial constraints is required for any Floorplan or Route and Pathway handoff. |
| Core | A utility interface, capacity allocation, resilience claim, environmental constraint, or phase commitment is publishable only when its required fields and applicable checks are complete. |
| Core | `VALIDATED` capability coverage means every applicable engineering check passed with no `ERROR`; `NOT_PROVIDED` and `PROVISIONAL` capabilities remain unresolved. |
| Peripheral | Import provenance, source checksums, mapping review, approvals, waivers, and collaboration state must be internally consistent and traceable, but do not replace core engineering checks. |

| Check class | Constraint prefix | Gating capability | Requirement | Severity when violated |
| --- | --- | --- | --- | --- |
| Data integrity | `facility.data.*` | `GEOMETRY` | Required entities are present; IDs are unique; units and coordinate reference systems are declared; geometry is valid; source data has provenance and an effective date | Error for missing or invalid authoritative data; warning for stale or assumed data |
| Document import | Shared asset: `asset.*`. Framework: `import.*`. Tool mapping: `facility.import.*` | `GEOMETRY` | Asset version checksum, scan state, adapter and converter version, declared units and spatial transform, and mapping review state are recorded; geometry is valid in the target CRS; required source features are mapped or explicitly marked reference-only | Error for invalid transforms, unresolved required mappings, or malformed geometry; warning for unsupported reference-only features or residual error above project tolerance |
| Site and code | `facility.site.*` | `GEOMETRY` | Buildings and utility equipment are within parcels; footprints respect setbacks, easements, access routes, height limits, and hazard exclusions | Error for a hard regulatory or geometry conflict; warning where policy permits a waiver |
| Utility | `facility.utility.*` | matching resource kind | Sources declare capacity and state; interfaces resolve to exactly one source and phase; connection points exist; service order respects availability | Error for missing or redefined sources; warning for non-firm capacity |
| Capacity | `facility.capacity.*` | matching resource kind | Per-phase allocated demand does not exceed commissioned firm capacity after documented derating, reserve, and redundancy policy | Error for an exceeded hard limit; warning when it relies on planned capacity or an unapproved assumption |
| Resilience | `facility.resilience.*` | every resource kind named by the policy | Required independent utility paths do not share a declared common failure domain; backup fuel and water duration meet the selected availability policy | Error for a violated availability requirement; warning when failure-domain evidence is incomplete |
| Environmental | `facility.environment.*` | `ENVIRONMENT` | Cooling and water assumptions remain within site permits and design-weather limits; hazard mitigation is present where policy requires it | Error for permit or operating-envelope breach; warning for incomplete study data |
| Phasing | `facility.phase.*` | `PHASING` | Every dependent facility capability is commissioned in the same or an earlier phase; no phase consumes capacity reserved for a later phase | Error for an impossible sequence; warning for dates or dependencies not yet confirmed |
| Downstream interface | `facility.interface.*` | matching resource kind | Floorplan, power, thermal, and network requests reference valid facility entities and remain within allocated envelopes | Error for invalid connection points or exceeded allocations; warning for provisional requests |
| Revision and governance | `facility.revision.*`, `facility.governance.*` | none (publication gate) | The target is the current draft; sources and policies are pinned; required attestations exist and are not revoked; waivers are in scope and unexpired | Error for a blocking publication condition; warning for an expired waiver or unconfirmed date |

## Tolerances and Thresholds

| Threshold | Default | Override |
| --- | --- | --- |
| Linear tolerance | 0.01 m | Project policy reference |
| Areal tolerance | 0.01 m² | Project policy reference |
| Fitted-transform residual | 0.05 m | Project policy reference |
| Source-value staleness | 365 days from `effective_at` | Project policy reference |
| Height-limit tolerance | 0.0 m (hard limit) | None; a limit is never rounded in the permissive direction |
| Capacity overcommit tolerance | 0.0 (hard limit) | Redundancy and reserve policy reference |
| Assumption expiry | None unless declared | Assumption `expires_at` |

A tolerance never converts an `ERROR` into a pass. It only bounds floating-point and measurement comparison.

## Coverage Derivation

`CapabilityCoverage` is derived from the completed validation run, not asserted by a user or a client ([D11](decisions.md)):

| Derived status | Condition |
| --- | --- |
| `NOT_PROVIDED` | No evidence exists for the capability; the corresponding entities or fields are absent. |
| `PROVISIONAL` | Evidence exists but is unreviewed, assumed, warning-gated, stale, or depends on non-firm capacity. |
| `VALIDATED` | Every applicable catalog check for that capability completed with no `ERROR` and no active blocking assumption. |

A capability never becomes `VALIDATED` because an unrelated capability passed. A waiver can remove the gating effect of a specific diagnostic but cannot by itself promote a capability to `VALIDATED` unless the waiver is explicitly designated `coverage_promoting` in its policy.

A read that reports itself incomplete — a truncated or degraded adapter result, a missing snapshot, or a read that fell back to an earlier version — MUST make the dependent checks **unrun rather than passed**. The affected capability stays `NOT_PROVIDED` or `PROVISIONAL`, the run is recorded as incomplete, and the revision MUST NOT become `VALIDATED` from that run. An empty or partial result is never evidence that a check passed. Degrading a read is a transport decision; it never relaxes a gate.

## Diagnostics and Gating

Every diagnostic returns a catalog `constraint_id`, affected entity IDs, source values, computed evidence, severity, status, remediation category, and the validation run that produced it. Capacity, resilience, environmental, import, and downstream-interface checks are re-run whenever relevant upstream site inputs or downstream demand changes.

Diagnostics are append-only. A later run supersedes an earlier diagnostic by referencing it; it never edits the earlier record. Waivers reference diagnostics and set their status to `WAIVED` without altering evidence. Waiver scope, expiry, and revocation are recorded as separate append-only records.

A run also **closes what it has cleared**. Supersession only fires when a later run re-issues the *same* finding, so a condition that stopped holding produced no finding at all — and nothing superseded the old row. An edit that fixed a problem therefore could not clear it: the diagnostic stayed `OPEN`, its capability stayed capped, and the revision could never become `VALIDATED`. A constraint that **ran** and did not re-emit a live diagnostic for a given evidence key marks that diagnostic `RESOLVED`. Only a constraint that ran may do this: a check that could not run because its evidence is absent has proved nothing, which is the same rule that keeps an unrun check from counting as a pass. `RESOLVED` is terminal for that record — a recurrence emits a new finding rather than reopening the old one, because the ledger is append-only.

`DRAFT` revisions may be shared for downstream authoring only with explicit capability coverage. A revision becomes `VALIDATED` only when a `FULL` validation run has completed and no applicable `ERROR` diagnostic remains. Consumers must inspect the validation summary and coverage state before relying on a power, thermal, environmental, or phasing conclusion.

## Publication Gate

Publication requires all of the following in one completed `FULL` run:

1. Lifecycle is `VALIDATED`, and the named validation run is the current clean `FULL` run for that revision (`facility.revision.current`, `facility.revision.publish.requires_validation`).
2. No applicable `ERROR` diagnostic is open (`facility.revision.publish.requires_validation`).
3. Every source document and policy reference used by the revision is pinned to an immutable version (`facility.revision.publish.source_unpinned`).
4. Every waiver that gates this revision is in scope and unexpired (`facility.governance.waiver.scope_mismatch`, `facility.governance.waiver.expired`).
5. Where deployment policy requires an attestation, an `APPROVED` attestation exists and has not been revoked (`facility.governance.approval.required`, `facility.governance.attestation.revoked`).
6. The `VALIDATED` to `PUBLISHED` transition commits atomically with writing the immutable envelope, its content checksum, and the `facility.envelope.published.v1` event.

`WARNING` diagnostics may remain; publication then records them in the `ValidationSummary` and the resulting `ImpactNotice`, the affected capabilities stay `PROVISIONAL`, and the revision becomes `PUBLISHED`. Publishing never changes coverage, and a `PUBLISHED` revision is never reopened.

## Acceptance Criteria

1. A local `AFFECTED_SUBGRAPH` run and a `FULL` run reach identical conclusions for the same catalog check on the same revision.
2. Every diagnostic carries a catalog `constraint_id`, and no diagnostic uses a free-form identifier.
3. Coverage is derived from the run summary and cannot be set by a client request.
4. An `ERROR` diagnostic in any catalog check blocks `VALIDATED` coverage and publication.
5. A `WARNING` diagnostic caps its capability at `PROVISIONAL` unless waived.
6. A waiver changes diagnostic status and gating only; evidence and the envelope remain unchanged.
7. Local results are visibly stale after the draft ETag advances.
8. `impact_notice` lists every consumer type invalidated by the change that produced the run.
9. Lifecycle transitions are one-way: `DRAFT` to `VALIDATED` on a clean full run, `VALIDATED` to `PUBLISHED` on publish, and neither a `VALIDATED` nor a `PUBLISHED` revision is ever reopened.
10. A write to a `VALIDATED` or `PUBLISHED` revision is rejected with `facility.revision.writes_immutable`, and a correction starts a new draft branched from the published revision.
11. A run over an input that reports itself incomplete cannot produce `VALIDATED` coverage or satisfy the publication gate.
