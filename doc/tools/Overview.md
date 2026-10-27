# Tool Specifications

Each tool has its own folder and follows the standard specification bundle:

* `Overview.md`: scope, ownership, and bundle index.
* `ui-pattern.md`: UI surface and interaction behavior.
* `interchange-contract.md`: boundary-level inputs, outputs, and handoff semantics.
* `entity-model.md`: canonical entity shapes, relationships, invariants, and persistence models.
* `storage-shape.md`: database, object-store, index, and cache persistence.
* `backend-api-contracts.md`: browser-facing and service-to-service APIs.
* `tool-surface.md`: the named, permission-scoped, bounded operations shared by every consumer of the tool.
* `verification-requirements.md`: checks, diagnostics, and validation gates.

## Available Tools

* [Site and Facility Editor](site-and-facility/Overview.md)

Additional tool folders should use the same names and document set wherever the concern applies.

Cross-tool platform frameworks that every tool consumes, such as the [import and conversion framework](../workspace/import-adapters.md), are documented in [workspace/Overview.md](../workspace/Overview.md) and referenced by the tool documents they affect.
