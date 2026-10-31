# Saved Checks and Reports

## Purpose and ownership

Record repeatable evidence for a saved Rack plan and download a portable planning
snapshot. Live draft checks remain available without writes. A saved check is a
scoped planning check, not engineering certification, approval or publication.
Whole-plan `validationState` remains `NOT_RUN`.

## Contract

All paths are relative to `/api/v1/projects/:projectId/rack/plans/:planId`.
Every operation also requires `facility.read`.

| Method and path | Permission | Behavior |
| --- | --- | --- |
| POST `/check-runs` | `rack.write` | Check the saved aggregate and append one immutable result |
| GET `/check-runs` | `rack.read` | Latest 20 summaries, newest first; no request query parameters |
| GET `/check-runs/:runId` | `rack.read` | Historical reports and current freshness metadata |
| GET `/report` | `rack.read` | Current saved layout and its latest matching recorded check, if any |

POST requires a UUID `Idempotency-Key` and
`{ "contract_version": 1, "base_version": 3, "snapshot_id": "<uuid>" }`.
It accepts no placements or draft inputs. A plan lock serializes check recording
with layout/lifecycle writes. Facility token/lifecycle share locks prevent source
changes during the operation. Version, snapshot and unchanged source are checked
before computation. A replay returns the same run; a key used for different input
or actor is rejected. Recording never increments the layout version or changes
equipment, positions or constraints.

The database record contains run ID, project/plan IDs, saved version, snapshot ID,
SHA-256 of canonical inputs (including models and Facility binding), ruleset ID,
creator/time, spatial report and equipment/capacity report. The ruleset is
`rack-scoped-checks/v1`; changes in checking semantics MUST change this ID.
Forced project RLS and a composite plan foreign key protect scoped storage.
Records survive soft deletion/restoration, but deleted-plan endpoints return410.
There is no user-facing record update/delete operation or retention policy yet.

Freshness is computed, not persisted: changed version, snapshot, input fingerprint,
ruleset or source makes a run historical. A historical clear result never clears
the current plan. Statuses are reported separately for spatial and equipment
scope; unknown values and unchecked rules are retained verbatim.

## User journey and downloads

Open **Checks**. Save/discard a draft before recording evidence. Editors/admins
can record; viewers can inspect/download. An uncertain retry reuses its original
key and body. History and downloads reload when the plan/version changes.

**Download plan JSON** fetches a fresh server report: pinned geometry, models,
positions, constraints, inventory, provenance, saved version, explicit scope and
only a matching recorded check. It is a planning artifact, not a round-trip import
format or an accepted cross-tool handoff. **Download equipment CSV** uses that
same saved response and includes assigned/unassigned devices, cabinet identity,
U intervals, resource assumptions and pinned model references. Unknown values
are empty cells; CSV quotes delimiters/newlines and prefixes formula-like text
with an apostrophe. Download names use UUID/version rather than untrusted names.
Historical check JSON contains reports and metadata, not a historical layout.

## Acceptance and limitations

Verify exact replay, no layout mutation, stale-version/snapshot/source refusal,
tenant/role isolation, historical invalidation after save/rename, scoped exports,
CSV escaping, and preserved unknown/unchecked values. Performance evidence must
state fixture size, repetitions and environment; local samples are not an SLA.
Continuous egress, electrical redundancy, shared Facility reservations and actual
provider acceptance remain outside this feature.
