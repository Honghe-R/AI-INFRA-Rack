# Rack specification bundle review — 2026-10-30

Starting HEAD: `3afb153`. Working tree was clean. All work was confined to the Rack copy.

## Scope

- Rewrote ten existing documents under `doc/tools/rack` in English with implementation-specific detail.
- Added assistant-integration, constraint-catalog, import-adapters, non-functional-requirements and decisions, matching the relevant Site and Facility bundle concerns.
- The folder now has 15 indexed documents. Historical progress/research evidence outside that folder was not translated or rewritten.
- Added source ownership links, three Mermaid diagrams, actual API examples, algorithms/limits, permission/storage/connection contracts, acceptance matrices and explicitly planned features.

## Source review

Compared the copied Site and Facility bundle's index/headings and detailed overview, tool surface, Assistant integration, import and quality requirements. No teacher directory or hosted platform was accessed.

Checked Rack routes, plan/layout/Assistant services, connection/endpoint services, migrations007–011, domain model/room/equipment/budget/constraints/allocator/planner/demand modules and existing UI/save contracts. Documented actual caveats rather than changing code: general versus demand-specific rack limit policy, local versus formal validation, partial allocation stageability, absent room-budget coverage and the single-instance secret-store boundary.

## Documentation validation

Inline Node filesystem checks verified:

- 15 English documents with no Han text, titles and complete Overview index;
- 49 relative file/directory links resolve;
- all three JSON examples parse;
- Markdown fences are balanced and no trailing whitespace exists;
- three Mermaid blocks are present (structure inspected; not visually rendered by this check);
- five model-facing capability names match the actual `add(...)` registrations in rack-assistant.js and appear in both relevant documents.

The final check after small wording corrections repeats these validations. Tracked document changes pass `git diff --check`; new documents were checked separately using `git diff --no-index --check -- NUL <path>`. An initial wrapper treated exit1 from a no-index difference as a whitespace failure despite no diagnostics; corrected the wrapper to inspect diagnostics and error exit codes. The documents themselves had no whitespace findings.

No business source, database, environment, credentials, ports or running service was changed. No model requests, migrations, seeds, reset, commits, pushes or remote changes. Tests/build were not rerun because this increment changes Markdown only. Dated test counts in the specification are clearly historical evidence, not new results. Markdown checks do not establish runtime behavior, real-provider compatibility, engineering accuracy or accessibility compliance.
