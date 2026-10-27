# Workspace Documents

* [UI Pattern](ui-pattern.md): project-first application shell, sidebar navigation, tabs, revision context, the context-aware assistant composer, project-list entry flow, and the Assets surface and import entry points.
* [Project Assets](project-assets.md): first-class project-scoped files with immutable versions, representations, tool bindings, access control, and lifecycle.
* [Import and Conversion Framework](import-adapters.md): shared adapter registry, extensibility model, extraction rules, units and CRS resolution, representations, limits, and processing diagnostics used by every geometry-bearing tool.
* [Workspace Retention](retention.md): retention and deletion classes for workspace-owned artifacts — project assets, the basemap tile cache, and assistant sessions, turns, and attachments.
* [RBAC Blueprint](rbac-architecture-blueprint.md): role-based access control model, permission catalog, evaluation, enforcement, and client rendering.
* [Map Adapters Blueprint](map-adapter-architecture-blueprint.md): the map adapter layering, output contracts, normalization, and error contract behind the basemap and topology read surfaces.
* [Chatbox and LLM Blueprint](chatbox-llm-architecture-blueprint.md): chat surface, LLM backend, wire contracts, tool and UI-action registries, and redaction.
* [Porting Decisions](porting-decisions.md): the imported blueprints' open questions, answered and marked as decided or awaiting sign-off.

The workspace is shared infrastructure rather than an engineering tool. Its data and verification behavior is defined by the tool contracts it hosts, except for platform frameworks such as import and conversion, which the tool contracts consume.
