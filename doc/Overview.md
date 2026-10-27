# Documentation Index

Documentation is organized by architectural scope and tool ownership.

| Location | Contents |
| --- | --- |
| [implementation-plan.md](implementation-plan.md) | Build plan for the first release: the workspace platform, then the Site and Facility Editor |
| [architecture/Overview.md](architecture/Overview.md) | Canonical platform architecture |
| [workspace/Overview.md](workspace/Overview.md) | Shared application-shell and platform-framework patterns that apply to every tool |
| [tools/Overview.md](tools/Overview.md) | Tool-specific specifications, grouped by tool |
| [sessions/](sessions/) | Dated work records: what landed on a day, the decisions taken, the defects found, and what is still open |

Every tool folder uses this document bundle:

* `Overview.md`: scope, ownership, functions, and links to the detailed documents.
* `ui-pattern.md`: work surface, navigation, interaction, and accessibility requirements.
* `interchange-contract.md`: normalized inputs, outputs, lifecycle, and handoff semantics.
* `entity-model.md`: canonical entity shapes, relationships, invariants, and persistence models used by the tool.
* `storage-shape.md`: persistence split between databases, object stores, indexes, and derived data.
* `backend-api-contracts.md`: browser-facing and service-to-service API operations.
* `verification-requirements.md`: local and cross-domain checks, diagnostics, and gating rules.

Additional files belong in the same tool folder only when they are specific to that tool, such as import-adapter, simulation, or deployment specifications.
