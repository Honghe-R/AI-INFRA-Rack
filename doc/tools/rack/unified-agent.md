# Unified Rack Assistant

## Goal

One Ask about Rack entry understands the project, inspects current saved design
state, chooses authorized tools, previews mutations, executes confirmed changes
and verifies results. Users do not choose Planning versus Development. The model
connection remains personal. Tool availability and server checks determine access;
natural-language instructions and Full authorization never grant account rights.

## Knowledge and context

Search/read tools expose an explicit allowlist of Rack specifications and core
implementation files, with paths, line numbers and content hashes. Runtime data,
environment files, credentials and teacher files are excluded. Retrieved material
is evidence, not executable instructions. A bounded turn-start digest names the
active project, selected saved Plan/version, draft presence and effective function
permissions. Fresh tool reads remain authoritative. Unknown constraints and
engineering assumptions must be disclosed.

## Execution

Existing proposal preview/apply remains the only aggregate layout-save path. Add
device catalog/custom creation, quantity additions, explicit batch removals, rack
limits/locks and exclusion zones. Algorithm previews may produce a server-owned
proposal using existing design/relocation/allocation services. Saves retain normal
version, source, snapshot, geometry, equipment and lock checks. Unlocking and
moving/deleting a previously locked rack require separate saved changes.

Plan creation/rename/delete/restore use existing lifecycle services, independent
permission keys, version checks and deterministic user-scoped retry keys. A room
read provides current Facility source tokens. Explicit target Plan IDs are scoped
and reread in the same project/scenario/revision; they never select a foreign scope.
After a save, reread/check the result; stale concurrent edits fail without overwrite.

Authorized administrators also receive private source edit/terminal/test tools in
the same conversation. These still operate only in filtered private snapshots and
offline containers; patch export/application remains separate from live Plan saves.
No automatic source promotion, commits, credential access or live database shell.

## Consent, limits and acceptance

Read only excludes mutation previews, writes and commands. Ask requires the normal
confirmation card; Full skips cards only for the explicit Rack/source tool
allowlist. Every handler checks current identity/scope/permissions, including
revocation between preview and apply. Dirty local drafts block design mutations.
Bound model rounds, tool outputs, operation quantities and algorithm invocations;
record completed/failed tool rounds in existing session history. Failure is never
reported as success. Default tests use scripted local providers, with no paid API.

Unified limits are 8 model rounds, 16 total calls and 900 output tokens per
completion; existing aggregate tools also retain their 10-call/one-generation cap.
Private source tools retain 12 calls/2 commands/60 seconds per command. These do
not impose a total input-token or monetary cap. Account permissions remain separate
from user consent. Missing room geometry or dirty drafts stop design changes.

## Current capability map

| Concern | Tools | Authority |
| --- | --- | --- |
| Project explanations | rack_search_knowledge, rack_read_knowledge | rack.read and facility.read; allowlisted current docs/core code |
| Saved design | rack_list_plans, rack_read_plan, rack_query_capacity, rack_check_saved_layout, rack_generate_layout_options | Scoped read services; bounded results |
| Inputs | rack_get_catalog, rack_list_rooms | Pinned synthetic models and current Facility HALL source tokens |
| Layout/inventory/constraints | rack_preview_changes, rack_preview_automatic_design, rack_apply_changes | rack.write, checked owner/version-bound proposal, atomic save and read-back |
| Plan lifecycle | rack_create_plan, rack_rename_plan, rack_delete_plan, rack_restore_plan | write / write / delete / restore keys, normal versioned services |
| Private development | dev_workspace, dev_list_files, dev_read_file, dev_search_code, dev_edit_file, dev_delete_file, dev_run_command, dev_changes | Administration plus Rack read/write, filtered snapshot, offline container |

An explicit Plan target never expands the active project/scenario/revision. A
deleted selected Plan remains a valid conversation scope for restoration, while
layout services still refuse deleted contents. Lifecycle creates use canonical
user-scoped retry keys; identical arguments reuse the creation identity. Browser
Plan selection remains user-controlled: a newly created Plan appears in the list,
and the agent can operate on its returned ID without forcing a canvas switch.

## Verification evidence

Round55 local acceptance used a scripted provider with real isolated PostgreSQL/
PostGIS services: room read → Plan create → scoped read → demand design preview →
confirmed/full apply → independent read-back. It also added pending inventory,
saved explicit unlocks, previewed/applied automatic allocation, deleted/restored
the Plan and verified viewer/editor refusals. Fixtures were cleaned. Knowledge,
file/path/lock/batch and forged-confirmation cases use local tests. No real model
API or interactive browser acceptance was performed; configured-model quality
remains a separate user-run check. Formal engineering validation remains NOT_RUN.

Round56 (2026-11-01) added small real-provider acceptance: the configured model
successfully called rack_read_knowledge and answered in Chinese with document-line
citations, through the actual guide/scope/tool/orchestrator path. Only one read
tool was offered for cost control: two provider requests,3,704 reported total
tokens (3,549 input/155 output). Actual database permission checks refused viewer
creation/editor deletion without further model calls. No business data was changed.
This confirms the targeted real knowledge/tool round trip, not real mutation,
browser sign-in, full-tool routing or unrestricted model quality. Reproduce only
with explicit `node --env-file-if-exists=.env scripts/rack-assistant-live-smoke.mjs --live`;
the flag authorizes paid use and is never run as part of default unit tests.
