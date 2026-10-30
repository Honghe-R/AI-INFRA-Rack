# Rack Planner Import Mapping

## Purpose and Ownership

This is Rack's specialization boundary for the shared [workspace import framework](../../workspace/import-adapters.md) and [Project Assets](../../workspace/project-assets.md). Today Rack consumes normalized Facility geometry and a local versioned synthetic catalog. It does not implement direct CAD/BIM/PDF/CSV-to-Rack import or a vendor ingestion job.

An inherited generic upload control does not establish a Rack importer. Files remain project assets; Rack must not copy/re-upload authoritative originals or treat an attachment as a design command.

## Authority Model

| Stage | Current status | Authority |
| --- | --- | --- |
| Original file/version | Shared asset subsystem | Immutable source evidence, not automatic design truth |
| Extraction/conversion | Shared framework; no Rack-specific mapper yet | Derived/reference data |
| Facility normalization | Owned upstream | Rack references exact revision/HALL/geometry |
| Room localization | Implemented supported Polygon adapter | Fixed translated input retaining provenance; no survey certification |
| Equipment specification | Implemented read-only synthetic catalog versions | Teaching assumptions, not accepted vendor data |
| Rack/device instances | Implemented UI/service commands | Plan-owned saved design under normal guards |

A converter must never directly write rack_plans, placement coordinates, budgets or assignments. Only reviewed normalized input passed through the ordinary authenticated aggregate save may change a plan.

## Inputs Enabled Today

### Facility Polygon

Read the exact HALL boundary from the selected Facility revision, require supported valid 2D WGS84 UTM Polygon and preserve all holes. Translate projected coordinates by an explicit origin; retain CRS, identity, source reference and transform/review metadata. Reject unsupported type/dimension/complexity/extent rather than guessing from labels or area.

### Local Catalog

Resolve exact equipment model/version server-side. Carry model source and unknown specifications into instances. Bound catalog references cannot be used with altered resource values. Rack models have separate server UUID identities. A catalog version update must not reinterpret already bound devices in place.

### Manual Assumptions

Custom device specs, exclusions, clearance and budgets are explicit ASSUMED inputs with source references. They are not converted from arbitrary document prose by the Assistant. Unknown data remains null and incomplete coverage remains visible.

## Planned File and Vendor Adapters

| Candidate adapter | Needed normalized target | Required safeguards before enablement |
| --- | --- | --- |
| Vendor equipment sheet | Model/version/specification | Units, provenance, immutable version, range/unknown handling and review |
| Inventory CSV | Device instances and optional assignments | Dry-run mapping, duplicate/foreign IDs, quantity/U validation, atomic apply |
| CAD/BIM rack layout | Referenced geometry and tentative placements | Shared asset/transform review, Floorplan ownership agreement, supported object mapping |
| PDF/screenshot | Reference evidence only initially | No dimensions/resources inferred as authoritative without review |

These adapters are planned, not available endpoints or supported upload promises. Their job states, diagnostics, confirmation, resource limits and compatibility version must be specified before implementation.

## Diagnostics and Remediation

Use existing source/geometry/domain errors for current inputs. Unsupported CRS/type/complexity must remain visible. Unknown catalog version/spec mismatch is rejected. Future import diagnostics must identify asset version, adapter version, source selector, units/transform, intended target and remediation, without inventing currently registered Rack constraint IDs.

## Acceptance Criteria

Current input adapters preserve source identity, holes, units and unknowns and refuse unsupported inputs without writes. Future adapters require fixture-based extraction/mapping tests, dry-run review, exact version pinning and standard save rollback/authorization tests. A text attachment or model reply cannot bypass those gates.
