# Site and Facility Editor

The Site and Facility Editor establishes the physical and utility envelope used by downstream tools. It owns site and facility intent, not detailed branch-circuit design, CFD analysis, or rack placement; those remain the responsibility of the Power Supplier, Thermal/HVAC, and Floorplan Editors.

## Ownership Boundaries

The boundaries below are normative ([D7](decisions.md), [D8](decisions.md)). A tool that owns an entity type is the only writer of that type; other tools reference it by stable ID.

| Concern | Owned here | Owned elsewhere |
| --- | --- | --- |
| Land and envelope | Site and campus scope, parcels, buildings, floors, halls, support spaces, equipment yards, reserved areas | Room, zone, row, rack, containment, and in-building pathway geometry belong to the Floorplan and Route and Pathway Editors |
| Utility entry | Planning-level utility sources, interfaces, connection points, site access and utility corridors, fuel and water storage | Transformers, switchgear, UPS, generators, PDUs, and branch circuits belong to the Power Supplier Editor |
| Resilience | Availability policy requirement, failure-domain declarations, fuel and water autonomy duration | Redundancy equipment design and its internal topology belong to the Power Supplier and Thermal/HVAC Editors |
| Constraints | Site spatial constraints, regulatory overlays, environmental and permit constraints, design-weather envelope | Detailed code-compliance reports and construction documentation belong to Verify, Cost and Schedule, and Deployment |
| Capacity | Resource budgets, reserves, and allocation decisions against facility capacity | Workload intent belongs to Workload and Capacity; downstream consumption requests arrive as `CapacityDemandRequest` |
| Governance | Assumptions, waivers, and approval attestations for facility revisions | Cross-project change management remains in the Constraints and Changes workspace |
| Cost, schedule, and sustainability | Read-only references attached to a facility revision | The Cost, Schedule, and Sustainability workspace owns every cost, schedule, and sustainability value |

This tool does not create or edit `DesignBlueprint` network topology, and it does not compile a runtime image; it publishes a versioned Facility Envelope that the platform compiler references ([D3](decisions.md)).

## Core and Peripheral Design Targets

The editor has two classes of targets. **Core design targets** define the facility envelope and constrain downstream placement, power, cooling, routing, and verification. **Peripheral (logistical) targets** make the design importable, traceable, governable, and deliverable; they support the core design but do not establish physical feasibility by themselves.

### Core Design Targets

| Target | Minimum result | Downstream consequence |
| --- | --- | --- |
| Spatial facility context | A scoped, georeferenced (or explicitly local) set of parcels/buildings/floors/halls with valid parent relationships and geometry | Floorplan and Route and Pathway can place rooms, rows, racks, and pathways within a known envelope. |
| Spatial constraints | Setbacks, easements, access routes, hazard/exclusion zones, height limits, and other hard overlays, when applicable | Floorplan and facility verification can reject placements or routes that violate physical or regulatory limits. |
| Utility connection envelope | Planning-level connection points and capacity classes for declared power, cooling, water, fuel, and network-entry resources | Power Supplier and Thermal/HVAC can design downstream systems against explicit source limits rather than assumed unlimited supply. |
| Capacity allocation envelope | Per-phase IT/floor-area/power/cooling/water/network-entry budgets, including reserve and commissioned-versus-planned state, when those resources are claimed | Downstream tools can request and receive bounded allocations; Verify can detect overcommitment. |
| Resilience and failure domains | Declared failure-domain containment, an availability policy requirement, and fuel/water autonomy duration, when resilience is in scope | Power, cooling, and network designs can test common-cause failure and redundancy requirements. |
| Environmental and operating envelope | Applicable design-weather, ambient, water, hazard, emissions, and permit constraints, when those claims are made | Thermal/HVAC, Power Supplier, and Verify can apply derating and operating limits. |
| Facility phasing envelope | A phase sequence and capability-availability dates, when the design has multiple phases or future capacity | Downstream tools cannot consume capacity before the corresponding facility capability is available. |

The minimum safe handoff is the `FacilityDesignContext` plus explicit `CapabilityCoverage` and `ValidationSummary`. A context may be spatially complete while power, thermal, environmental, or phasing targets remain `NOT_PROVIDED` or `PROVISIONAL`; that is a valid partial design, not a feasible facility claim.

### Peripheral (Logistical) Targets

| Target | Purpose | Rule |
| --- | --- | --- |
| Document import and conversion | Bring existing CAD, KML/KMZ, BIM/IFC, and GIS plans into the workflow as shared project assets through an extensible adapter framework | Files are project assets ([D20](decisions.md)); this tool binds an exact asset version and never owns the file. Preserve originals, transforms, mappings, checksums, and conversion diagnostics; import metadata cannot substitute for normalized design entities. Adapters are independently versioned and registered ([D19](decisions.md)). |
| Provenance and source management | Identify who supplied a value, when it applied, and how confident it is | Required for traceability and review, but provenance alone does not make a value physically valid. |
| Revision, scenario, and collaboration state | Support drafts, comparisons, ownership, approvals, and change review | Must never alter the meaning of a published Facility Envelope or silently overwrite another revision. A draft is mutable in place under optimistic concurrency. |
| Assumptions, waivers, and approvals | Record unresolved inputs and authorized exceptions | A waiver or approval is a governance record; it does not remove the underlying diagnostic or turn missing design data into a constraint. An active assumption caps coverage at `PROVISIONAL`. |
| Documents and operational metadata | Track contacts, permits, documents, service dates, ownership, and commissioning coordination | Supports execution and accountability; detailed construction and commissioning design belongs to downstream workflows. |
| Cost, schedule, and sustainability metadata | Enable later estimates, lead-time planning, energy/carbon reporting, and procurement | Reference-only ([D18](decisions.md)): the Cost, Schedule, and Sustainability workspace owns the values, and this tool stores only `CostScheduleReference` links. A reference can never relax a hard geometry, capacity, resilience, or environmental check. |

Peripheral targets may be present in a draft or omitted from an early design context. Their coverage and review state must remain explicit so downstream tools can distinguish "not supplied" from "not applicable" and from "validated."

## Functions

1. Define sites, parcels, boundaries, coordinate reference systems, access points, setbacks, hazards, and regulatory constraints.
2. Bind CAD, KML/KMZ, and BIM/IFC files that exist as project assets to the facility design through registered adapters, map source layers, features, and spatial structures, and review spatial transformations.
3. Define buildings, floors, halls, support spaces, equipment yards, and expansion phases.
4. Record utility feeds, connection points, water and fuel storage, failure domains, and network demarcation points at the planning level.
5. Define environmental envelopes, capacity allocations, resilience requirements, and phased build-out scenarios.
6. Publish a versioned Facility Envelope for downstream authoring, verification, and deployment.

## Specification Bundle

* [UI Pattern](ui-pattern.md)
* [Interchange Contract](interchange-contract.md)
* [Entity Model](entity-model.md)
* [Storage Shape](storage-shape.md)
* [Backend API Contracts](backend-api-contracts.md)
* [Tool Surface](tool-surface.md)
* [Verification Requirements](verification-requirements.md)
* [Constraint Catalog](constraint-catalog.md)
* [Import Mapping](import-adapters.md) (facility specialization of the shared [workspace import and conversion framework](../../workspace/import-adapters.md))
* [Assistant Integration](assistant-integration.md)
* [Non-Functional Requirements](non-functional-requirements.md)
* [Decisions and Open Questions](decisions.md)

This tool implements the role defined in the [platform blueprint](../../architecture/ai_infrastructure_planner_blueprint.md). The shared workspace shell, assistant composer, and cross-tool navigation rules are defined in the [workspace UI pattern](../../workspace/ui-pattern.md).

## Acceptance Criteria

1. A user can go from project entry to a validated, published Facility Envelope without leaving the workspace shell.
2. The published envelope carries mandatory design context, derived capability coverage, a validation summary, and at least one pinned asset version.
3. Every declared capability is `NOT_PROVIDED`, `PROVISIONAL`, or `VALIDATED`, and no absent capability is presented as feasible.
4. Imported geometry retains its source document, transform, mapping, and provenance, and never becomes authoritative before review.
5. Downstream tools can request and receive bounded capacity allocations without writing facility entities directly.
6. A revision cannot be published with an open `ERROR` diagnostic, unpinned source, or out-of-scope waiver.
7. Ownership boundaries hold: this tool never writes Power Supplier, Floorplan, Route and Pathway, Cabling, or Network topology entities.
8. The tool declares an assistant surface, capabilities, UI actions, and attachment policy consistent with [Assistant Integration](assistant-integration.md).
9. BIM/IFC import maps spatial structure to facility containers and geometry records, and every unmapped model element is explicitly reference-only rather than silently dropped.
10. A new source format can be added by registering an adapter and its fixtures, without changing the core import pipeline, storage, API, or UI.
