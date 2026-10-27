# Architectural Blueprint: AI Infrastructure Planner

## Status and Scope

This is the canonical architectural specification for the **AI Infrastructure Planner**, an industrial-grade platform for planning, designing, validating, simulating, and deploying AI computing facilities and their optical networks.

The platform translates human and LLM-assisted design intent into a validated physical design, then compiles that design into a high-performance runtime representation for simulation. It covers the lifecycle from site feasibility through construction and commissioning artifacts.

---

## 1. Architectural Principles

### 1.1 Authoring, Interchange, and Execution Are Separate Models

The system uses three representations, each optimized for a different job:

1. **Design-time model (authoring):** A rich, mutable object graph in the frontend and authoring services. It supports LLM-assisted edits, CAD interactions, catalog selection, and topological changes without requiring data-layout stability.
2. **Interchange model (verification contract):** A versioned Protocol Buffer (`DesignBlueprint`) exchanged between authoring and verification. JSON may be used inside the UI and LLM integration, but never crosses the authoring-to-verifier or verifier-to-simulator boundary.
3. **Runtime model (simulation):** An immutable, explicitly versioned Structure of Arrays (SoA) image compiled by the verifier after static validation. The C++ simulation engine reads integer offsets and contiguous arrays rather than object graphs or protobuf messages.

This distinction is deliberate: protobuf is a compact, typed interchange format, not a zero-copy SoA runtime image. A protobuf message is parsed once at the boundary, then compiled into the runtime arrays. A runtime image may be memory-mapped only when its binary layout, alignment, endianness, and schema version are explicitly defined.

### 1.2 Invariant Containers and Variant Technology

Physical infrastructure is modeled as recurring domain pairs from land through silicon packaging:

* **Invariant container (the box):** Physical space, standard dimensions, structural limits, capacity, coordinates, and topology. Examples include land parcels, halls, racks, chassis, and fixed routes.
* **Variant payload (the technology):** Pluggable implementation choices installed within or between containers. Examples include LPO versus coherent optics, EPS versus OCS switching, cooling systems, and facility power equipment.

Replacing a payload must not silently alter the container's structural identity. A replacement is valid only after dependent constraints are re-evaluated.

### 1.3 Domain Delegates Own Their Constraints

The verifier evaluates the design through independently testable domain delegates:

| Domain | Engineering ownership | Representative checks |
| --- | --- | --- |
| Land and facility | Civil, grid, and facility engineering | Utility capacity, site footprint, climate, facility power budget |
| Data hall and cooling | Thermal and HVAC engineering | Heat rejection, airflow containment, liquid-loop capacity; for example, `Qdot = mdot * Cp * deltaT` |
| Rack and power | Electrical and mechanical engineering | Rack density, PDU balance, breaker limits, weight, and floor loading |
| Interconnect and network | Optical and network engineering | Reach, attenuation, SNR margin, latency, port capacity, and routing |
| Workload and collective behavior | Performance engineering | All-Reduce completion time, congestion, utilization, and scheduling behavior |

Delegates return structured diagnostics with stable constraint identifiers, affected design node IDs, severity, evidence, and suggested remediation classes. They do not mutate the authoring model.

### 1.4 Bottom-Up Invalidation With Batched Diagnostics

Verification begins at the most specific affected constraint and propagates invalidity upward. A failed optical path can invalidate its interconnect, rack, hall, and facility aggregates; a parent marked `TAINTED` is excluded from downstream optimization and deployment.

The system reports all independently discoverable failures in a validation pass rather than presenting one failure at a time. Each diagnostic is mapped through the inverse index registry from runtime offsets to stable container IDs and authoring paths. This preserves the physical dependency rule without creating a serial "whack-a-mole" interaction loop.

---

## 2. Product Tool Suite

### 2.1 One Shared Design Model

The product is a workspace of specialized tools, not a collection of isolated files or editors. Each tool reads and writes a bounded part of the same versioned design-time graph, identified by stable entity IDs. An edit in one tool immediately invalidates dependent views and triggers affected-subgraph validation.

The Floorplan Editor owns physical placement and pathways; the Rack Editor owns equipment installation; the Network Topology Editor owns logical connectivity; and the Cabling Editor owns physical cable assignments. No tool may create a conflicting duplicate of an entity owned by another tool. Derived values, including cable length, rack heat load, power draw, and port utilization, are calculated from the shared model rather than copied into editor-local state.

Import and conversion is shared platform infrastructure, specified in [workspace/import-adapters.md](../workspace/import-adapters.md). Imported files are first-class project assets ([workspace/project-assets.md](../workspace/project-assets.md)): every entry point creates a project-scoped asset with immutable versions, and tools consume an exact asset version through a binding. Format adapters, extraction, unit and coordinate resolution, representation handling, and processing diagnostics are owned once at the workspace level, and each tool owns only the mapping of extracted content to its own entity types.

### 2.2 Design and Engineering Tools

| Tool | Primary responsibility | Authoritative entities and outputs | Key dependencies |
| --- | --- | --- | --- |
| Site and Facility Editor | Define the site, building envelope, utility feeds, resilience requirements, and expansion phases | Land, building, hall, utility connection, failure-domain, resilience-requirement, and facility-envelope constraints | Supplies capacity and geometry to Floorplan, Power, and Thermal/HVAC |
| Floorplan Editor | Plan data-hall geometry and physical placement | Rooms, zones, rows, rack coordinates, containment, trays, conduits, and clearances | Drives route distance, floor loading, airflow zones, and rack placement |
| Rack Editor | Arrange installations within each rack | Rack units, devices, PDUs, busbars, blanking panels, weight, and port locations | Consumes rack coordinates and catalog data; supplies heat, power, port, and endpoint data |
| Network Topology Editor | Design the logical and physical compute fabric | GPU nodes, NICs, switches, ports, links, topology tiers, oversubscription, and optical technology choices | Consumes rack endpoints and catalog ports; supplies link intent to Cabling and Simulator |
| Route and Pathway Editor | Define permitted physical paths | Tray, conduit, overhead/underfloor routes, bend constraints, separation rules, and length calculations | Consumes Floorplan geometry; supplies permissible paths to Cabling |
| Cabling Editor | Assign and document physical interconnects | Cable assemblies, patch panels, connector ends, labels, routes, slack, and patch schedules | Requires Network link intent, port endpoints, and permitted pathways |
| Thermal and HVAC Editor | Model heat removal and cooling distribution | Cooling topology, CRAC/CDU equipment, airflow zones, liquid loops, setpoints, and thermal limits | Consumes facility capacity, floorplan zones, and rack heat loads |
| Power Supplier Editor | Model utility supply and electrical distribution | Utility feeds, transformers, switchgear, UPS, generators, PDUs, branch circuits, redundancy, and power budgets | Consumes facility limits and rack/device draw; supplies available power to Verify |
| Equipment Catalog Editor | Maintain approved hardware and engineering properties | SKUs, dimensions, ports, optical characteristics, power, thermal, weight, cost, availability, and supported configurations | Is referenced by every editor; no unapproved free-form hardware enters a design |
| Workload and Capacity Planner | Express capacity and performance intent | Target GPU count, pod shape, workload mix, collective patterns, utilization targets, and growth forecasts | Supplies scenario inputs to Network Topology, Verify, and Simulator |

### 2.3 Cross-Cutting Workspaces

| Workspace | Role |
| --- | --- |
| Verify | A cross-domain validation workspace, not an isolated editor. It runs local affected-subgraph checks during editing and full validation on demand, groups diagnostics by root cause, shows dependency propagation, and links every finding back to its owning tool and entity. |
| Simulation | Configures scenarios and presents discrete-event results: collective completion time, congestion, latency, utilization, and failure behavior. It consumes only validated blueprint revisions. |
| Cost, Schedule, and Sustainability | Calculates CapEx, OpEx, lead times, energy use, PUE/WUE, and carbon assumptions from the approved catalog and design. |
| Deployment and Commissioning | Produces BOMs, rack elevations, cable labels, PDU balancing, switch configuration, test plans, and acceptance checklists from an approved revision. |
| Constraints and Change Management | Records assumptions, waivers, validation findings, approvals, revision diffs, and traceability across all tools. |

### 2.4 Initial Release Sequence

The first usable release prioritizes the closed path from physical layout to verified network design:

1. Equipment Catalog Editor and shared design identity.
2. Floorplan Editor and Rack Editor.
3. Network Topology Editor plus Route and Pathway Editor.
4. Cabling Editor and the Verify workspace.
5. Thermal/HVAC and Power Supplier validation views, followed by simulation and deployment exports.

### 2.5 Site and Facility Editor

The tool overview and its UI, interchange-contract, and verification documents are maintained in [tools/site-and-facility/Overview.md](../tools/site-and-facility/Overview.md).

### 2.6 Project Workspace UI

The shared project-first application shell, tool navigation, tab behavior, sidebar states, and project-list entry flow are specified in [workspace/ui-pattern.md](../workspace/ui-pattern.md).

---

## 3. Lifecycle and Compilation Pipeline

The product lifecycle and the software compilation pipeline are related but not identical:

```
Planning -> Design -> Static validation -> Runtime compilation -> Dynamic simulation -> Deployment
```

| Stage | Primary component | Inputs | Outputs |
| --- | --- | --- | --- |
| Planning | Feasibility services | Site, utility, climate, capacity intent | Macro constraints and facility envelope |
| Design | Authoring UI and LLM adapter | Constraints, catalog, user edits | Mutable object graph and `DesignBlueprint` |
| Static validation | Verifier and domain delegates | `DesignBlueprint` | Batched diagnostics or validated blueprint |
| Runtime compilation | Verifier compiler | Validated blueprint | Versioned SoA runtime image and inverse index registry |
| Dynamic simulation | C++ DES engine | Runtime image and workload scenario | Performance, utilization, and failure results |
| Deployment | Artifact generators | Validated blueprint and approved results | BOM, cabling, PDU, configuration, and digital-twin artifacts |

### 3.1 Planning

Planning establishes the facility envelope: land, grid capacity, HVAC and water assumptions, target GPU count, density targets, and high-level network intent. It produces constraints for design; it does not bypass design-time verification.

### 3.2 Design and Intent Parsing

The LLM is a conversational authoring interface, not a source of trusted infrastructure state. It converts requests such as "deploy a 64-pod fat-tree using LPO for short reach and coherent optics for long reach" into proposed structured mutations. Every mutation is schema-validated, catalog-resolved, permission-checked where applicable, and accepted only by the authoring model.

The authoring component may consume or emit JSON for UI and LLM tooling. Before it invokes verification, it serializes the normalized object graph as `DesignBlueprint` protobuf bytes.

### 3.3 Static Validation

The verifier parses the protobuf contract and executes deterministic, mostly linear-time checks across the topology. It can evaluate affected subgraphs incrementally during editing, but approval always records the complete validated blueprint revision.

Static validation is a gate. No dynamic simulation, deployment export, or construction artifact may consume a blueprint with `CRITICAL_FAILURE` diagnostics.

### 3.4 Runtime Compilation and Dynamic Simulation

For a validated design, the compiler creates flat arrays for nodes, links, ports, routes, capacities, timing parameters, and workload metadata. It also emits the inverse index registry necessary to translate runtime failures back to design entities.

The discrete-event simulator consumes this image with preallocated data structures. Its reaction processors use offsets and integer IDs, avoiding object allocation and pointer-heavy topology traversal in the event loop. It models workloads such as AI collective communication, including All-Reduce, and returns results associated with the validated blueprint revision and runtime-image version.

### 3.5 Deployment

Approved validated designs produce deployment artifacts: bill of materials, precision cabling and patch schedules, PDU balancing tables, switch initialization/configuration, commissioning checklists, and a digital-twin export. Every artifact records the originating blueprint revision and catalog version.

---

## 4. Contract Boundaries

### 4.1 Boundary Rules

1. Authoring to verification uses versioned protobuf bytes; it does not use JSON across the process or network boundary.
2. Verification to simulation uses a separately compiled runtime image, not a raw protobuf byte stream.
3. Runtime-image mmap is optional and permitted only for a documented portable binary layout. The loader validates magic bytes, format version, schema compatibility, endianness, alignment, bounds, and checksums before use.
4. Diagnostics and simulation results contain stable design IDs and blueprint/runtime versions, allowing round-trip display in the UI.
5. Schema evolution follows protobuf compatibility rules: never reuse field numbers, reserve removed field numbers and names, and treat enum additions as unknown-safe in every consumer.
6. Domain sub-contracts are referenced, not inlined: `DesignBlueprint.facility_envelope_ref` points at a versioned Facility Envelope in `infrastructure.planner.facility.v1`, and the envelope is parsed by its own generated bindings. Authoring keeps stable UUIDs; runtime compilation assigns `uint32` design IDs and publishes the inverse index registry, so runtime failures map back to domain UUIDs.

### 4.2 Protocol Buffer Schema Blueprint

```protobuf
syntax = "proto3";
package infrastructure.planner.v1;

message DesignBlueprint {
  ProjectMetadata metadata = 1;
  repeated ContainerNode nodes = 2;            // Invariant structure
  repeated TechnologyVariant variants = 3;    // Technology payloads
  uint32 schema_version = 4;
  FacilityEnvelopeRef facility_envelope_ref = 5;  // Facility sub-contract
}

message FacilityEnvelopeRef {
  string envelope_id = 1;
  string revision_id = 2;
  string content_checksum = 3;
  string proto_package = 4;                    // infrastructure.planner.facility.v1
}

message ProjectMetadata {
  string uuid = 1;
  string name = 2;
  uint32 target_gpus = 3;
  string revision_id = 4;
  string catalog_version = 5;
}

enum ContainerScale {
  CONTAINER_SCALE_UNSPECIFIED = 0;
  LAND = 1;
  BUILDING = 2;
  ROOM = 3;
  RACK = 4;
  CHASSIS = 5;
}

message ContainerNode {
  uint32 id = 1;                 // Stable design ID, not a runtime offset
  optional uint32 parent_id = 2;
  ContainerScale scale = 3;
  float x = 4;
  float y = 5;
  float z = 6;
  repeated uint32 adjacency_list = 7;
}

message TechnologyVariant {
  uint32 target_node_id = 1;
  oneof payload_type {
    OpticsPayload optics = 2;
    SwitchPayload switching = 3;
    ThermalPayload cooling = 4;
    FacilityPayload facilities = 5;
  }
}

message OpticsPayload {
  enum TechClass {
    TECH_CLASS_UNSPECIFIED = 0;
    LPO = 1;
    CPO = 2;
    NPO = 3;
    COHERENT = 4;
  }
  TechClass tech_class = 1;
  float line_rate_gbps = 2;
  float max_reach_meters = 3;
  float attenuation_db_km = 4;
}

message SwitchPayload {
  enum SwitchClass {
    SWITCH_CLASS_UNSPECIFIED = 0;
    EPS_VOQ = 1;
    OCS_MEMS = 2;
    OPS_BURST = 3;
  }
  SwitchClass switch_class = 1;
  uint32 total_ports = 2;
  float reconfig_delay_ns = 3;
}

message ThermalPayload {
  string cooling_type = 1;
  float power_draw_kw = 2;
}

message FacilityPayload {
  float max_grid_power_mw = 1;
}
```

The concrete `.proto` file must add new fields for links, routes, ports, catalog references, units, and diagnostics as implementation requires. It must not overload the existing `adjacency_list` as a substitute for physical link records.

---

## 5. Risks and Required Mitigations

| Decision | Benefit | Risk | Required mitigation |
| --- | --- | --- | --- |
| OOP authoring and SoA simulation | Flexible editing and efficient event processing | A bake is required after meaningful structural changes | Incremental preview validation, explicit revisioning, and inverse index registry |
| Independent domain delegates | Clear ownership and testability | Cross-domain constraints can form feedback loops | Fixed evaluation order, bottom-up taint propagation, batched diagnostics, and an explicit orchestration policy |
| Protobuf interchange | Typed, compact cross-language contract | Cross-language schema drift | Generated bindings in CI, compatibility tests, and versioned fixtures |
| Memory-mapped runtime image | Fast startup and predictable layout | ABI/layout corruption and platform differences | Defined binary format, loader validation, compatibility matrix, and fallback loader |
| LLM-assisted authoring | Faster exploration of complex designs | Hallucinated or unsafe structural changes | Strict schema and catalog validation, deterministic mutation review, and no direct runtime access |

---

## 6. Delivery Roadmap

1. **Sprint 1: Shared model, identity, and catalog.** Finalize the protobuf contract, stable design IDs, revision model, catalog references, and diagnostic schema. Generate Python, TypeScript, and C++ bindings with compatibility fixtures.
2. **Sprint 2: Core physical design tools.** Build the Floorplan and Rack Editors over the shared model, including geometry, installation, equipment selection, and affected-subgraph validation.
3. **Sprint 3: Network, pathways, cabling, and verification.** Build Network Topology, Route and Pathway, and Cabling Editors; implement domain delegates, taint propagation, batched diagnostics, and UI finding mapping.
4. **Sprint 4: Power, thermal, simulation, and deployment.** Add the Power Supplier and Thermal/HVAC validation views, define the SoA runtime-image compiler and C++ DES core, then export deployment and traceability artifacts.

## 7. Decisions Recorded

* The product scope includes facility planning, optical network CAD, simulation, and deployment artifacts.
* JSON is permitted only within authoring and LLM-facing workflows; protobuf is the authoring-to-verification interchange format.
* Protobuf is not the DOD runtime format; a validated blueprint is compiled into a separate SoA runtime image.
* Static validation is mandatory before simulation and deployment.
* Domain coupling is resolved through deterministic bottom-up invalidation and batched diagnostics, not unbounded optimizer feedback loops.
* The application is a suite of specialized tools over one authoritative, revisioned design model; Verify is the cross-domain validation workspace.
