# Workspace Retention and Deletion

## Purpose and Authority

Retention classes are owned at two levels, and this document exists because the split was previously implicit:

* **Workspace classes** — project assets and their representations and previews, the proxied basemap tile cache, assistant sessions, turn objects, and attachments, and workspace audit — are defined **here**. No tool may redefine them or carry its own value for them.
* **Tool classes** — revisions, envelopes, diagnostics, validation runs, job records, idempotency records, exports, and tool audit — are defined in the owning tool's Non-Functional Requirements retention table. The first tool is the [Site and Facility Editor](../tools/site-and-facility/non-functional-requirements.md).

A project asset and an assistant attachment are project-wide and consumed by several tools, so their retention cannot live inside one tool's document. Previously [Project Assets](project-assets.md) deferred these values to the Site and Facility Non-Functional Requirements, which made one tool authoritative for platform data.

## Workspace Retention Classes

| Artifact class | Store | Retention | Deletion rule | Governing item |
| --- | --- | --- | --- | --- |
| Project assets and versions | Object store plus transactional metadata | Project lifetime plus 24 months after project archive | Deleted only under an authorized retention action after a reference check | D20 |
| Asset representations | Object store or cache | Life of the referencing revision plus 12 months | Regenerable; never replaces the original bytes | D20 |
| Previews and tiles | Object store and cache | 30 days rolling | Regenerable from the asset version and transform | D20 |
| Basemap tiles (proxied) | Cache only | Provider-permitted lifetime, maximum 30 days (proposed) | Never written to the object store; evicted on expiry or provider policy change | D16 |
| Assistant attachment, never sent in a turn | Object store, under the owner prefix | 1 hour after upload | Expired by a prefix-and-age sweep; the grace window protects an in-flight pick | W0 porting decisions |
| Assistant attachment, sent in a turn | Object store | Retained while its session is retained | Removed with the session; never swept while referenced | W0 porting decisions |
| Assistant sessions and turn objects | Object store plus the relational session index | 90 days of inactivity | Index row, manifest, and turn objects are deleted together | W0 porting decisions |
| Assistant usage and audit records | Append-only audit store | 7 years | Retained for the full period; no in-place edit | W0 porting decisions |

## Rules

1. A legal or regulatory hold overrides every value in this document.
2. Deletion is logical first, authorized, and audited. Physical removal happens only after a reference check.
3. An object MUST NOT be deleted while a retained revision, asset version, binding, or session references it.
4. A value changes only by a versioned configuration change with an audit record.
5. Expiry is evaluated per class on a schedule, and the resulting deletion plan MUST be reviewable before execution.
6. A tool MUST NOT redefine a workspace class. A tool that needs a different period for a workspace artifact changes this document instead.
7. Derived search, tile, and cache projections are rebuildable and MUST NOT be the sole copy of any retained artifact.

## Promotion

An assistant attachment promoted into the project asset model **copies** its bytes into the asset key layout. From that point asset retention governs, and the asset's own reference-guarded deletion rule applies. The source attachment object is still named by the turn's immutable message block, so it is retained until its session expires rather than swept as an orphan. The cost is duplication across the two storage planes on promotion: quota accounting counts both copies, and no cross-plane deduplication is attempted.

## Known Gap

Recovery targets for workspace-owned stores — object-store RPO, RTO, and durability — are still recorded in the [Site and Facility Non-Functional Requirements](../tools/site-and-facility/non-functional-requirements.md) because no workspace-level non-functional document exists yet. Retention is the subject of this document; recovery is not. Consolidating the recovery targets is a follow-up.
