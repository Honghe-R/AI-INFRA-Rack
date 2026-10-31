# Rack Development Agent

## Purpose and execution model

The unified Rack Assistant chooses business, knowledge or source tools from the
request; there is no Planning/Development selector. Source tools require project
administration on the isolated local Rack installation. The earlier rack_developer
surface is retained for compatibility. This workflow uses the
existing per-user model connection, confirmation cards, bounded tool loop and chat
history. It reads source, searches literal text, edits files, runs commands/tests,
inspects changes and exports a patch. It never stages, commits, pushes, deploys,
edits the teacher installation or changes live database records.

## Workspaces and source access

One private workspace per authenticated user/project is stored under the ignored
`.local-runtime/developer/` directory. The first use takes a filtered snapshot of
apps, packages, scripts, doc, data-scripts and selected root documentation/manifests.
Only regular source/text files are copied. Dotfiles, credentials, env files, Git,
dependencies, build output and local runtime data are excluded. Links/junctions,
absolute paths, traversal and Windows special paths are rejected. The immutable
baseline and editable tree are separate. Workspaces survive new chats/restarts;
they are snapshots, not automatic mirrors of later checkout changes.

File edits require the SHA-256 hash returned by a read. Replacements must match
exactly once. New files require an explicit null hash. Deletion also requires the
current hash. Concurrent operations on a workspace are serialized. Export produces
a unified patch for manual review/application to the real checkout; it is never
automatically applied. Source changes do not update live Plan data or the UI.

## Container execution

Commands run through a fixed Docker image in a disposable Linux container, never
through a host shell. The container has no network, credentials, Docker socket or
live repository mount. Its only bind is a read-only filtered workspace snapshot.
Each run copies that snapshot and preinstalled dependencies to a temporary filesystem.
Shell commands may edit this disposable copy but those edits are not retained;
durable source edits use the file tools. Tests have no live database/API access.

The root filesystem is read-only, capabilities are dropped, no-new-privileges is
enabled, UID is non-root, and CPU/memory/PID/time/output limits are fixed by the
server. Cancellation removes the named container. No host-command fallback is
allowed when Docker or the prepared image is unavailable. Image preparation uses
network to install locked dependencies with lifecycle scripts disabled, outside
model turns. Docker isolation is not a hardened hostile multi-tenant service.

## Tools and policy

Development exposes workspace status, paginated file list, bounded read/search,
hash-checked edit/delete, container terminal, and changed-file/diff inspection.
Source tools require project.member.manage plus rack.read and rack.write. The same
conversation offers independently authorized business tools. All calls recheck access.
Read only excludes edits and execution. Ask requires confirmation for file writes,
deletes and commands; Full authorizes those operations only inside this workspace.
No model-supplied path, scope or prompt can expand the roots or container privileges.

Source limits per turn: at most 12 source tool calls, 2 commands and 900 output
tokens per completion, with bounded file/search/terminal context. Stop after a
small verified change; explain failed/skipped tests honestly. Unified Rack allows
8 model rounds and 16 total calls; legacy standalone Development retains 6 rounds.
Real use consumes provider tokens; local scripted tests do not call the provider.
No scheduled/background continuation is added.

HTTP endpoints are authenticated `GET /api/v1/assistant/developer/status` and
`GET /api/v1/assistant/developer/patch`, both with `project_id`. Status returns
`enabled`, `runtimeReady` and `limits` in the ordinary data envelope; patch returns
a `text/plain` attachment with `Cache-Control: no-store`. Both recheck project
administration and Rack read/write access; actor identity comes from authentication.
The model has no endpoint to apply a patch to the live checkout.

## Setup and acceptance

Run `npm run rack:developer:setup` once to build the local sandbox image. Refresh
the Assistant and request a code task directly. Existing credentials are reused. A patch
download is available without a model call. Initial acceptance uses a scripted
provider for read → edit → test → diff, plus path/hash/isolation/permission tests
and one short real Docker smoke test. Real-provider natural-language quality is
separate user acceptance; no paid calls are made automatically.

Reproduce the short real-container acceptance with
`node scripts/developer/smoke.mjs`. It creates/cleans a temporary private workspace,
runs 17 existing Rack model tests and one isolation test, verifies ephemeral
terminal writes and patch export, and never opens the configured model connection.
The pinned Node image is obtained through the official public ECR mirror during
setup. Docker Desktop must be running; dependencies are rebuilt explicitly after
lockfile changes. Set `RACK_DEVELOPER_ENABLED=false` on the API to disable this mode.
