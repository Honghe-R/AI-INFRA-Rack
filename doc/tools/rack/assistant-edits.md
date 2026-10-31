# Assistant Edits

## Workflow

The Rack Assistant supports natural-language edit requests through two tools:
`rack_preview_changes` builds a validated server-owned proposal;
`rack_apply_changes` applies that exact proposal after the existing chat
confirmation card is accepted. Both require `rack.read`, `facility.read` and
`rack.write`. Preview changes no layout; viewers keep the five read tools.

Supported operations: add/remove/move a cabinet, assign/move/unassign an existing
device, set front/rear clearance, and set an assumed room power/cooling budget.
Names resolve exactly inside the selected plan; duplicate names are refused.
Coordinates are absolute local metres, U slots start at1. No unlock, arbitrary
patch, SQL, project/plan deletion, Facility mutation or invented device specification
is exposed. Unknown/zero and source assumptions retain their ordinary meaning.

## Proposal contract

Preview takes a positive `base_version` and1–20 typed operations. It rejects an
unsaved draft hint or stale client version. It normalizes the full resulting
aggregate, enforces saved cabinet locks and runs the existing Polygon/equipment
checks. Known conflicts return structured findings without creating an executable
proposal. Incomplete scopes remain explicit and may be saved just like UI edits.

Migration014 stores an opaque proposal UUID, owner, project/plan, saved version,
fixed snapshot, exact normalized save body, server-generated change summary,
30-minute expiry, idempotency key and applied version/time. Forced project RLS and
a composite plan FK apply. There are no provider-generated full-layout save bodies.

Apply accepts only the proposal UUID, and rechecks owner, selected plan, scope,
write permission, source, snapshot, expiry and saved version. The plan lock and
ordinary save run in the same transaction as marking the proposal applied.
Geometry, U/resource, lock and source checks run again before commit. Failure
rolls back both save and proposal state. Exact retries return the original applied
version without another save, including after later edits; current version is
reported separately. Proposals survive an API restart, but expired unapplied
proposals cannot be confirmed. Retention cleanup remains future work.

## User experience and limits

The model reads first, previews the requested change, explains before/after values
and reported incomplete scope, then asks the existing confirmation card to apply.
The card uses the stored server summary. A denial does not save. One confirmed
application per turn is allowed. Successful writes invalidate the Rack views;
local browser drafts are retained and ordinary version conflict handling applies.
The model must stop further mutations and report the returned applied version.

Examples: “Move rack A01 to X10/Y12 metres”, “Move Server1 to B02 starting at U5”,
“Unassign Server1”, “Set front clearance to1.2m and rear to0.8m”. Ambiguous intent
must be clarified rather than inventing coordinates, limits or target equipment.

## Acceptance

Test real preview→confirmation→atomic save→readback; denial/no writes; viewer and
foreign-owner refusal; wrong plan/source/snapshot/version; dirty drafts; overlap,
U/capacity/locked conflicts; exact retry; expiry; concurrent confirmation; rollback;
and refreshing the saved views without overwriting drafts. Scripted-provider tests
validate orchestration; real-provider language understanding remains separate
acceptance, and no model can guarantee every interpretation is correct.
