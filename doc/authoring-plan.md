# Site and Facility Editor Authoring Plan

This plan adds design editing to the Site and Facility Editor. It is the delivery counterpart to two existing documents: the change-set contract in [Backend API Contracts](tools/site-and-facility/backend-api-contracts.md) ("Draft and Change Sets") and the write capabilities recorded as pending in [Tool Surface](tools/site-and-facility/tool-surface.md).

It exists because the facility graph is currently **read-only in production code**. A user can open a campus, inspect it, run validation, grant waivers, and publish — but no code path in `apps/` or `packages/` writes a design-graph table. The only writers are `scripts/dev-seed-facility.mjs` and the test fixtures. Every facility in the system was inserted by the seed.

## Decisions This Plan Takes

### D-A. Edits are in-place on the draft; there is no per-entity version history

The schema has no `entity_versions` or geometry-history table. `revision_etags` and `revision_lineage` are the only versioning structures that exist. [D1](tools/site-and-facility/decisions.md) already states that a `DRAFT` revision is **mutable in place** under optimistic concurrency and rejects per-edit child revisions. So `update_entity`'s "creates a new entity version in the draft" is read as *the draft's current version of that entity changes*, and `set_geometry`'s "preserves the prior version" is satisfied by revision-level immutability plus the outbox record.

This is the low-regret choice: if audit-grade per-entity history is required later, it can be added as an append-only table fed by the same commit path, **without changing the command surface**.

Consequence to keep in view: the outbox is therefore the only change history. That raises the stakes on D-B.

### D-B. The outbox has one reader; delivery is still deferred

`outbox_events` has three writers (the validation engine, `waivers.js`, the asset repository). There is no dispatcher, and the validation worker polls `jobs`, not the outbox. Building one is platform work affecting every event type, not facility work.

One **read** was added rather than a dispatcher. `get_revision_activity` pages the events recorded against a revision, which is what makes "what changed recently" answerable at all: a draft is edited in place (D-A), so there are no per-edit revisions to diff and `compare_revisions` can only compare two revisions that exist — comparing a draft with itself is the one honest zero, and a missing revision is now refused rather than read as "no changes". The read returns the rows; it does not consume, publish, or dispatch them, so the deferral of *delivery* is intact.

Deferring delivery does not block this plan, and that is the deciding argument: once the draft ETag advances on commit, the browser detects staleness client-side through the freshness logic already in the Verify surface, so the edit → re-validate loop works without event delivery. We emit `facility.revision.changed.v1` because it is the durable record and is nearly free, and we state plainly that it is not delivered yet.

## Phase 0 — The Draft ETag Path

**Prerequisite for everything else, and it fixes a live defect.** `get_revision_context.draftEtag` is always `null` today, so the Verify surface's staleness indicator can never fire: a local validation result can never be shown as stale, because there is nothing to compare against.

`revision_etags` already exists with the right shape — `etag uuid DEFAULT gen_random_uuid()`, `etag_version bigint`, `updated_at` — and is used by no code. No migration is required; this is plumbing.

| Piece | Detail |
| --- | --- |
| Populate | Upsert a token row on revision creation, and backfill existing revisions from the seeds |
| Expose | `get_revision_context.draftEtag` and the envelope read return `etag` and `etagVersion` |
| Advance | Conditional update in the commit transaction: `SET etag = gen_random_uuid(), etag_version = etag_version + 1 WHERE etag = $expected` |
| Refuse | Zero rows affected is `409` with `constraint_id: facility.revision.current` |
| Guard | A `DRAFT`-only check on every write; today only the validation service enforces immutability |
| Branch ancestry | Validate `base_revision_id` against `revisions.base_revision_id` (the column exists) in the same transaction |

A draft token and a frozen content checksum are different things and must not be conflated: the token changes on every commit, the checksum exists only once a revision is `VALIDATED`.

**Exit.** Concurrent commits presenting the same etag — exactly one succeeds. A stale etag returns `409`. The Verify surface reports `CURRENT` or `STALE` against a real draft token.

## Phase 1 — The Change-Set Commit

A new `packages/facility/src/changes.js`, one tool (`apply_change_set`), and one route.

The contract is as specified: `{ base_revision_id, etag, idempotency_key?, changes[] }`, committed atomically, applied in dependency order — entities → geometry → constraints → phases → utilities → resilience → capacity → environment — returning each change's resolved `entity_ref` and stable id. A single invalid change rejects the set with `422` and per-change diagnostics. A set referencing a missing entity returns `409` unless `cascade: CHILDREN` is explicit.

Three design points that must be right:

1. **Permissions are dynamic.** The tool layer declares `requiredFunctions` statically, but a change set's requirement is the union of its change kinds' keys. Requiring all of them statically is unusable; requiring none is a hole. So `requiredFunctions` becomes optionally a function of `args`: selection offers the tool on the entry keys, and the executor refuses a set whose kinds the caller is not authorized for. The single choke point is preserved.
2. **Invalid geometry is accepted; only unstoreable geometry is rejected.** The contract is explicit that diagnostics can never be suppressed by a change set, so a footprint violating a setback must land in the draft *and* come back with its `ERROR`. Reject with `422` only what the database cannot hold — unparseable GeoJSON, a wrong SRID — and let `facility.data.geometry.invalid` report a self-intersection.
3. **Commit-time diagnostics cost more than the specification implies.** The engine's `AFFECTED_SUBGRAPH` scope is currently the `BOTH`-scope subset of the whole catalog, not a walk of the entities reachable from the change (`constraintsForScope`). True subgraph scoping is a separate refinement. The plan is therefore to run the existing `BOTH` sweep inside the commit transaction, measure it, and offer `preview_diagnostics: false` as an escape hatch for bulk paths.

Also: `Idempotency-Key` through the existing `idempotency_records` table; one `facility.revision.changed.v1` event carrying the previous and new etag and the changed entity refs; and an audit record per change kind.

**Exit.** A set with one bad change rolls back entirely. A set that violates a constraint commits and returns the diagnostic. A repeated idempotency key returns the first result. Editing a `VALIDATED` revision is refused.

## Phase 2 — The Four Core Change Kinds

`create_container`, `set_geometry`, `update_entity`, `remove_entity`.

`update_entity` is thinner than it sounds and needs a per-type dispatch: `entity_registry` carries only `status` and `display_name`, so any real attribute edit — name, level, elevation, phase, parent — lands on the subtype table, which for containers is `facility_containers`. That dispatch is the substance of the change kind, not the SQL.

`remove_entity` performs the reference check first and returns the referencing entities in the `409`.

**Exit — the acceptance test for the whole increment.** From the seeded campus: move a footprint into the 15 m setback, commit, and receive `facility.site.setback.violated` in the response. GEOMETRY stays `PROVISIONAL` and the new finding appears in Verify. An edit that leads to a finding, and a finding that leads back to the edit, is what makes Verify a workflow rather than a report.

## Phase 3 — The Kinds That Clear the Common Findings

`set_utility_source`, `set_utility_interface`, `assign_phase`, `set_phase_dependency`.

Chosen from evidence rather than symmetry. The seeded campus's dominant gating finding is `facility.utility.source.state_not_firm`, which holds back POWER, COOLING and NETWORK_ENTRY at once, and `facility.phase.*` accounts for six constraints that currently cannot be cleared by any means. Phase dependencies reject cycles at write time.

## Phase 4 — The Remaining Change Kinds

`set_failure_domain`, `set_resilience_requirement`, `set_storage_reserve`, `set_capacity_budget`, `set_environmental_constraint`, `assign_constraint`, `transform_geometry`, `record_assumption`, `resolve_assumption`, `attach_document`, `detach_document`.

This completes the eighteen-kind contract and is what makes ENVIRONMENT, RESILIENCE and CAPACITY findings actionable. It is the largest phase by count and the least urgent by value.

## Phase 5 — The Authoring UI

* An **inspector** that reads through `get_entity` and writes a change set. It is a client of the command API, not new domain logic.
* **Canvas editing**: draw a polygon for `create_container`, move vertices for `set_geometry`.
* **Dirty state**: the shell already has the machinery — `setDirty`, the "Discard unsaved changes?" dialog — with no callers. The change set is held client-side and committed explicitly, which is what [D1](tools/site-and-facility/decisions.md)'s single-draft, dirty-state work surface describes.
* **Conflict handling**: on `409`, surface the staleness banner the Verify surface already models, and offer reload or discard.
* **Preview**: highlight newly produced findings on the canvas after a commit.

## Testing Strategy

Per change kind: valid and invalid payloads, and permission denial. Cross-cutting: a concurrent-commit race in which exactly one wins, immutability refusal, whole-set rollback on one bad change, idempotent replay, dependency ordering, and cycle rejection. Round-trip: edit → diagnostics → coverage. Web: inspector render, dirty-state blocking, conflict banner.

## Out of Scope

Event delivery (D-B), per-entity version history (D-A), true affected-subgraph scoping, and the import-driven on-ramp (T3 asset bindings). The last is a cheaper path to *real* site data — users have KML, CAD, and IFC, not a desire to hand-draw parcels — and the pipeline, bindings and mapping tables already exist. It should be sequenced deliberately rather than by accident.

## Sequencing

The order matters more than the schedule. Phase 0 is small and fixes a live defect. Phase 1 is the structural work and is the prerequisite for every authoring path, including import. Phase 2 is where the product changes from a report into a workflow, and its exit criterion is the loop that already exists.

The phases are built. What comes next is a measurement rather than a plan step: whether
breadth or the import on-ramp matters more is now answerable by using the editor on real
work.

**Adding an entity kind to the canvas** is the next natural increment rather than a phase:
`assign_phase` and the utility kinds are reachable, but a failure domain, a reserve or a
budget still has no surface. They share one shape — a list of the revision's objects with
an inspector — so the second one is much cheaper than the first.

## Status

| Phase | State |
| --- | --- |
| P0 — Draft ETag path | **Built.** `packages/facility/src/etags.js`; `get_revision_context` and the envelope read return the token; the seeds backfill it. |
| P1 — Change-set commit | **Built** (`packages/facility/src/changes.js`), together with the change kinds below. |
| P2 — Four core change kinds | **Built** (`packages/facility/src/change-kinds.js`): `create_container`, `update_entity`, `set_geometry`, `remove_entity`. |
| P3 — Utility and phase kinds | **Built**: `set_utility_source`, `set_utility_interface`, `assign_phase`, `set_phase_dependency`, plus `set_phase` and `set_phase_capability`. |
| P4 — Remaining kinds | **Built**: failure domains, reserves, resilience, capacity, environmental and spatial constraints, assumptions, documents. |
| P5 — Authoring UI | **Built**: the inspector, the pending change set, drawing a footprint, and the conflict decision. |
| Post-P5 fixes | **Built**: chat envelope recovery, the render loop on commit, and the canvas that moved when the draw controls appeared. |
| Adding an interface | **Built**: a placement mode for a utility interface, with its domain and phase inherited from the source. |
| Edit history read | **Built**: `get_revision_activity` pages the revision's `outbox_events`, so "what changed recently" is answerable from the one change history a draft has ([D-A](#d-a-edits-are-in-place-on-the-draft-there-is-no-per-entity-version-history), [D-B](#d-b-the-outbox-has-one-reader-delivery-is-still-deferred)), and the assistant surface declares it. |

P1 and P2 were built as one increment, because the writer is untestable without a kind
to write and P1's own exit criteria need `set_geometry` to violate a constraint. The
seam between them still holds: `changes.js` orders, applies, collects and commits
without knowing what a container is, and `change-kinds.js` holds every kind.

### P1 and P2 as built

`applyChangeSet` does one thing per concern: preconditions, a dependency-ordered apply
sweep with a savepoint per change (so every change is checked rather than only up to the
first failure), a whole-set refusal with per-change diagnostics, the token advance, the
`facility.revision.changed.v1` event, and an optional diagnostics preview.

Four decisions came out of building it, each because the obvious version was wrong:

* **The command owns its own rollback.** Applying each change in a savepoint and
  relying on the caller to roll back on the throw is enough for the HTTP route and
  wrong for any other caller — one that caught the error and continued would commit a
  partially applied set. The set is wrapped in its own savepoint, so the guarantee is
  local to the command instead of a property of its callers.
* **Idempotency is answered before the ETag.** A replay of a commit that already
  succeeded necessarily presents a stale token, so checking concurrency first refuses
  the replay of a successful write — the exact case the key exists for.
* **GeoJSON names types in title case and the store's enum is upper case.** Comparing
  them directly refused every geometry change, which reads like a validation rule until
  you look at both sides.
* **A domain invariant belongs in the kind, not in a constraint name.** The store
  requires a level number on a `FLOOR` or `HALL` and forbids it elsewhere; surfacing that
  as `facility_containers_level_number_check` tells a caller nothing. `create_container`
  asserted it from the start and `update_entity` did not, so a parcel edit that set a
  level reached the database and came back as a named constraint. Both paths now assert
  it, and both assert the inverted-elevation rule against the row the write produces
  rather than against the fields the patch happens to state.

Two trade-offs are recorded rather than solved. The diagnostics preview runs inside the
commit transaction, so a preview failure rolls the edit back — deliberate, because the
preview writes a validation run and a run describing a rolled-back graph would be a lie,
but it does mean a defect in one check can block an edit. And `remove_entity`'s
referential check covers the five tables that can reference an entity from outside it;
the list grows as the remaining kinds start writing the others. A geometry row is
deliberately not one of them: it belongs to the entity the removal deletes, so treating
it as a referrer refused every deletion of a drawn object.

Verified live on the seeded campus, not only in fixtures: a set with an unknown kind is
refused `422` naming the registered kinds; a footprint placed 5 m from the boundary
commits and returns `facility.site.setback.violated`; restoring the original footprint
clears it; and a second editor holding the old token is refused `409`
`REVISION_ETAG_STALE` carrying `facility.revision.current`.

### P3 and P4 as built

Eighteen of the specification's nineteen kinds are registered, plus two the contract
omits but the loop needs: `set_phase` and `set_phase_capability`, without which a phase
could be assigned to but never created, and
`facility.phase.capability.before_commissioned` could never be cleared. The
specification's change-kind table has no phase-creation kind, which is a gap rather than a
decision. `transform_geometry` remains unbuilt and is recorded in `PENDING_CHANGE_KINDS`
with its blocker: `spatial_transforms` requires an `asset_version_id` and a `binding_id`,
so a transform cannot exist without an asset binding, and bindings have no command until
T3.

Building them turned up a **verification bug that defeated the whole point of the
phase**. A finding whose condition no longer held was never closed: supersession fires
only when a later run re-issues the same finding, so an edit that fixed a problem left
the old diagnostic `OPEN`, the capability capped, and the revision unable to reach
`VALIDATED`. A run now marks a live diagnostic `RESOLVED` when a constraint that **ran**
did not re-emit it. Only a constraint that ran may do this — a check that could not run
has proved nothing — and `RESOLVED` is terminal for that record, so a recurrence emits a
new finding. The change-set response reports both halves of the answer now: what the edit
broke, and what it cleared.

A second class of defect came from the store's own invariants, each of which was
answering a caller with a constraint name. They are now rules in the kinds: a spatial
constraint is anchored to exactly one of a scope or a container; a numeric rule declares
its kind and unit; a reserve's basis is paired with its kind; an interface declares all
of its capacity or none of it; a capability that is available says from when; a phase
order is unique; one document per content checksum; a derating factor is a fraction; and
an inverted window or elevation is refused.

Verified live, with the finding that gates three capabilities: setting the seeded
campus's contractual source to `FIRM` resolved its diagnostic — it stopped gating, and
the resolved record stayed visible — and restoring it to `CONTRACTUAL` emitted a new
`OPEN` finding while the resolved row remained as history. That round trip is the
append-only ledger behaving correctly, and it is the acceptance test for P3.

### P5 as built

`apps/web/src/facility/authoring-state.js` holds the staging rules, and they are rules
rather than an append. A change that supersedes an earlier pending one **replaces** it —
re-drawing a footprint twice must commit one geometry record, not two fighting over the
same role — and staging a removal **cancels** that entity's pending edits, because asking
the server to update and delete one entity in the same set is a conflict the user did not
create.

`FacilityInspector.jsx` is a client of the command API and writes nothing. What is
editable follows the change kinds that exist: a container carries a name, a level and
elevations; a utility source carries a capacity state. `FacilityAuthoringPanel.jsx` is the
one place a commit happens, and it is also where the conflict decision lives: on a `409`
the server's current token arrives with the refusal, so the user can re-base and keep their
work or discard it. Re-basing silently would commit an edit against a revision they never
saw.

Drawing is a mode rather than a gesture: while it is on, a pointer press places a vertex
instead of panning, so the map cannot move under a polygon being drawn. The draft is
projected with the same maths as the committed geometry — `unprojectScreen` sits beside
`screenGeometry` in `facility-overlay.js` precisely so a click and a read cannot disagree
about where the map is — and it is drawn dashed and unselectable, because unfinished work
is not a facility feature.

The shell's dirty-state machinery finally has a caller. `onDirtyChange` reports whether
there is uncommitted work, which is what makes closing the tab or switching context ask
before discarding a change set. Until this phase, `setDirty` had no callers at all.

**Two defects came out of looking at it rather than testing it.** A source has no
geometry, so it cannot be picked on the canvas and the source branch of the inspector was
unreachable; editing a source through the interface that resolves to it is how supply
actually becomes firm, so the inspector routes through the interface and names the source
in the hint. And that path sent the *interface's* id as `utility_source_id`, which named a
source that did not exist: the whole set was refused with `422`, and only a rendered
screenshot showed it. Both are now covered by tests.

Verified in the browser end to end on the live dev stack: select a utility interface,
stage a capacity-state change, and commit. The header's "Unsaved" badge appears while
staged and clears on commit; the panel reports "Applied 1 change(s) · draft now at v9 · 4
new ERROR · 8 new WARNING" and lists each finding with its catalog id and remediation
hint. The demo campus was restored to its seeded state afterwards.

### Three defects found by using the built UI

All three came from a user reading the screen, not from a failing test, and none of them
would have been caught by the suites as they stood.

**The chat printed its own envelope.** The prompted reply shape is
`{ "type": "message", "payload": "<markdown>" }`, and the provider routinely writes literal
newlines inside that payload — which makes the object invalid JSON. `visibleAssistantText`
did parse best-effort and then *fell back to the raw text*, so the degradation was the bug:
the user read `{"type":"message","payload":"…"}` instead of the answer. Recovery is now
deterministic rather than a guess. `escapeControlCharsInStrings` walks the text and escapes
raw newlines and tabs **inside string literals only** — a newline between fields is legal
whitespace and must survive — tracking backslash escapes so an escaped quote does not end
the string early; the parser then unescapes the payload itself. Two further candidates
cover the other shapes actually observed: an envelope wrapped in a sentence or a code fence
is recovered from its outermost braces, and prose JSON cannot hold at all (an unescaped `"`
the model wrote inside its own answer) is salvaged by taking the `payload` member from the
first `"payload"` key to the closing quote, unescaped in a **single** pass — a chain of
`.replace()` calls would turn an escaped backslash before an `n` into a newline. The old
test asserted the leak as correct behaviour; it now asserts recovery.

The prompt gained one line for a second, quieter defect visible in the same screenshot: the
provider answered in its own default language. It now writes in the language of the user's
most recent message. Verified both ways — in a fresh chat an English question is answered
in English, while in a transcript that is already Chinese-dominant the model still follows
the transcript, which is reasonable and is not overridden.

**A render loop on commit.** After draw-and-apply the console filled with "Maximum update
depth exceeded". Three separate sources of new state on every render, each harmless alone:
`setDirty` in the shell's reducer built a fresh workspace object even when the value had not
changed, `bind()` did the same for its handler, and `onDirtyChange` was an inline arrow, so
each parent render handed the child a new prop and the child reported dirtiness back up.
The reducer now returns the *identical* state when nothing changed, `bind()` no-ops when it
would write the same value, and the callback is held in a ref. The fix is at the source of
each new identity rather than in a `useEffect` guard, because a guard would have hidden the
loop rather than removed the churn.

**The info bar moved the map.** The draw controls lived in a `banner` above the canvas, so
entering draw mode inserted a row, shrank the map, and re-projected every feature the user
was about to click on — an unprojection taken against the old height would land somewhere
else. The controls now live in the aside beside the map, which is where drawing already
belonged, and `SelectionBanner` is deleted rather than relocated: selecting a feature is
what the inspector is for.

Verified in the browser on the live dev stack: draw a footprint, "Add to pending changes",
commit — the panel reports `Applied 2 change(s) · draft now at v12 · 6 new ERROR · 7 new
WARNING`, the pending count clears, no error overlay appears, and the chat answers a
question about the current revision in rendered Markdown.

The first two now have regression tests that fail on the old code rather than merely
describing the new code. `site-facility-canvas-render.test.jsx` asserts that the draw
controls appear **after** the map surface and inside the aside — a `banner` slot renders
above the map, so the old layout fails both assertions. It reaches the write-gated markup
by granting the permission in the test, because `usePermission` never defaults a
project-scoped grant to true and a grant is not the thing under test. The loop is pinned at
its source: `open-views.test.js` asserts that reporting the same dirtiness returns the
*identical* state object, and `bindChangeSet` was lifted out of its `setState` callback into
`authoring-state.js` so `authoring-state.test.js` can assert the same for the revision
binding. A test that only checked "no warning was logged" would have passed on the buggy
code.

### Adding an interface, and putting the tools where the tool is

The authoring UI could edit what existed and draw a container, but it could not add a
utility interface — the one entity whose absence the catalog reports as
`facility.utility.interface.connectivity_missing`, and the one that makes a supply firm.
"Add interface" on the toolbar is that tool.

It is a mode, like drawing: the toolbar asks the canvas for it, the canvas takes one click
as the connection point, and the aside becomes the form. The shell asks rather than owns
the mode, because the mode needs the projection, the viewport, and the pending change set,
all of which live in the surface; the request carries a nonce so pressing the tool twice is
a new request rather than an object React would ignore.

Two of the three fields an interface needs are not the user's to choose. `set_utility_interface`
requires a failure domain and a phase, and an interface that declared its own would be
`facility.utility.interface.redefines_source` — an ERROR, because an interface is a
connection point *on a supply*, and the supply's domain is what it is connected to. Both are
therefore inherited from the source, and the form says so rather than offering a choice the
store would refuse. Capacity is omitted for the same reason: a capacity state that disagreed
with the source trips the same check, and a deliberate override belongs in the inspector.

That the source carries its own domain and phase is what made this buildable at all: there is
still no failure-domain route, so an interface tool that needed the user to pick one would
have needed a read that does not exist. The rule and the missing read happened to agree.

The geometry is staged as a second change addressing the identity minted for the first, which
is the only way a pair can be applied in one transaction where no id exists to read back in
between — the same shape the drawn footprint already used. `newContainerId` became
`newEntityId` for the same reason: the minter was never container-specific, and a name that
says otherwise is a small lie that costs a reader time.

`ENTITY_GEOMETRY` now declares, per entity kind, the role and GeoJSON type the store accepts.
The server refuses a mismatched pair with "the geometry type does not match the declared
role", so the client must not be able to offer one — and a table is a better place for that
than a comment.

### P0 as built

`etags.js` holds the token's whole lifecycle: `readEtag` (returns absent rather than inventing a row, because reads run in read-only transactions), `ensureEtag` (idempotent, so a backfill and a first commit can both call it), `advanceEtag` (a conditional update that *is* the concurrency control), `requireDraft`, and `requireBaseRevision`.

Three refusals, each carrying `facility.revision.current` so a client branches on a machine code rather than a sentence: `428` for a write that omits the token, `409` for a stale one — with the current value in the details, because a client forced to re-read to retry has been told half of what it needs — and `409` for a base revision that does not match. A draft token and a content checksum are kept apart in both the tool result and the envelope read: a draft has no checksum, which is exactly why using it as the token made staleness undetectable.

Verified against the dev project rather than only in fixtures: the token advanced from `v0` to `v1`, a second writer holding the old token was refused with `REVISION_ETAG_STALE`, and a local validation run pinned itself to the current token (`run.baseEtag` matching the envelope's `etag`). The 8 new tests cover the lifecycle, the stale race, both refusals, and the base-revision check.
