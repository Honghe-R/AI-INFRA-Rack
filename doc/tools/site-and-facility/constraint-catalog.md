# Site and Facility Editor Constraint Catalog

This document is the stable identifier registry for every check the Site and Facility Editor and the Verify workspace run against a facility revision. It refines [Verification Requirements](verification-requirements.md); that document defines check classes and gating intent, this catalog defines the exact identifiers, default severity, gating capability, and remediation category that diagnostics, API responses, waivers, and UI deep links must use.

## Identifier Convention

A `constraint_id` is a lowercase, dot-delimited, stable, never-reused identifier:

```text
facility.<domain>.<subject>.<condition>
```

* `domain` is one of `data`, `import`, `site`, `utility`, `capacity`, `resilience`, `environment`, `phase`, `interface`, `revision`, `governance`.
* `subject` names the entity or relationship under test.
* `condition` names the specific failure.
* Identifiers are permanent. A retired check keeps its identifier and is marked `Retired`; field numbers and identifiers are never reassigned.

Diagnostics must reference the catalog identifier, never a free-form message, so downstream tools, waivers, exports, and the assistant can filter and link deterministically.

## Severity, Status, and Remediation

| Enum | Values |
| --- | --- |
| `Severity` | `ERROR`, `WARNING`, `INFO` |
| `DiagnosticStatus` | `OPEN`, `ACKNOWLEDGED`, `WAIVED`, `RESOLVED`, `SUPERSEDED` |
| `RemediationCategory` | `ADD_DATA`, `CORRECT_GEOMETRY`, `RESOLVE_CONFLICT`, `UPDATE_CAPACITY`, `ADJUST_PHASE`, `OBTAIN_APPROVAL`, `REVIEW_IMPORT`, `RECONFIGURE_RESILIENCE`, `CONTACT_RESPONSIBLE_PARTY`, `REVIEW_POLICY` |

`ERROR` blocks `VALIDATED` capability coverage and publication. `WARNING` permits `PROVISIONAL` coverage and publication only with an explicit unresolved-capability notice. `INFO` is advisory and never gates.

A `WARNING` may be waived only when the catalog row names a waiverable rule reference; a waived diagnostic becomes `WAIVED` and stops gating that revision, but remains visible and is never deleted.

### Diagnostic Evidence

```text
FacilityDiagnostic
  id, revision_id, constraint_id, severity, status
  entity_refs[]: EntityRef
  geometry_refs[]: UUID
  source_values[]: { field, value, unit?, source_ref? }
  computed: { expression, expected, actual, unit?, tolerance? }
  remediation_category, remediation_hint, policy_ref?
  validation_run_id, created_at, supersedes_diagnostic_id?
```

## Coverage Derivation

`CapabilityCoverage` is derived, never typed (see [D11](decisions.md)):

| Capability | Checks that must be free of `ERROR` |
| --- | --- |
| `GEOMETRY` | `facility.data.*`, `facility.site.*`, `facility.import.*`, `import.*`, `asset.*` |
| `POWER`, `COOLING`, `WATER`, `FUEL`, `NETWORK_ENTRY` | The matching `facility.utility.*` rows plus `facility.capacity.*` rows scoped to that resource kind |
| `ENVIRONMENT` | `facility.environment.*` |
| `PHASING` | `facility.phase.*` |

`facility.resilience.*` rows gate the capability of every resource kind named by the availability policy. `facility.import.*`, the shared `import.*` processing rows, and the shared `asset.*` rows gate `GEOMETRY`. `facility.revision.*` and `facility.governance.*` gate publication, not coverage.

## Check Scope

Every row declares where it runs:

* **Local**: affected-subgraph checks the editor runs during editing; results are advisory and marked with the draft ETag they were computed against.
* **Full**: the complete batch Verify runs before a revision may be published as `VALIDATED`.
* **Both**: identical logic in both paths; the editor may run only the affected subgraph.

Local results are invalidated when any entity they reference changes or when the draft ETag advances.

## Capacity, Utility, and Interface

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.utility.source.capacity_missing` | ERROR | resource kind | Both | ADD_DATA | Utility source capacity is undeclared. |
| `facility.utility.source.negative_capacity` | ERROR | resource kind | Both | CORRECT_GEOMETRY | Capacity value is zero or negative where a positive value is required. |
| `facility.utility.source.state_not_firm` | WARNING | resource kind | Both | ADD_DATA | Availability relies on non-firm capacity state. |
| `facility.utility.source.availability_after_phase` | ERROR | PHASING | Full | ADJUST_PHASE | Source availability date is later than the phase that consumes it. |
| `facility.utility.interface.source_undefined` | ERROR | resource kind | Both | ADD_DATA | Interface references a missing or cross-project utility source. |
| `facility.utility.interface.connectivity_missing` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Interface has no `CONNECTION_POINT` geometry. |
| `facility.utility.interface.redefines_source` | ERROR | resource kind | Full | RESOLVE_CONFLICT | Interface attempts to redefine source kind, capacity state, or failure domain. |
| `facility.utility.route.disconnected` | WARNING | GEOMETRY | Full | CORRECT_GEOMETRY | Site utility corridor does not reach its declared connection points. |
| `facility.capacity.budget.overcommit` | ERROR | resource kind | Full | UPDATE_CAPACITY | Allocated demand exceeds firm capacity after derating and reserve. |
| `facility.capacity.budget.duplicate` | ERROR | resource kind | Full | RESOLVE_CONFLICT | More than one budget exists for the same owner, phase, resource, and basis. |
| `facility.capacity.allocation.basis_mismatch` | ERROR | resource kind | Both | UPDATE_CAPACITY | Allocation basis does not match its budget basis. |
| `facility.capacity.allocation.phase_mismatch` | ERROR | PHASING | Both | ADJUST_PHASE | Allocation phase does not match its budget phase. |
| `facility.capacity.allocation.provisional_gate` | ERROR | resource kind | Full | OBTAIN_APPROVAL | A `PROVISIONAL` allocation is used to satisfy a hard gate. |
| `facility.capacity.reserve.eroded` | ERROR | resource kind | Full | UPDATE_CAPACITY | Reserve policy quantity is not held. |
| `facility.capacity.derating.undefined` | WARNING | resource kind | Full | REVIEW_POLICY | Firm capacity relies on derating without a policy reference. |
| `facility.capacity.planned.firm_claim` | WARNING | resource kind | Full | ADD_DATA | A firm-capacity claim depends on planned capacity. |
| `facility.interface.allocation.exceeded` | ERROR | resource kind | Full | UPDATE_CAPACITY | Downstream request exceeds its allocated envelope. |
| `facility.interface.entity_invalid` | ERROR | GEOMETRY | Both | ADD_DATA | Downstream reference does not resolve to a facility entity in this revision. |
| `facility.interface.request.provisional` | WARNING | resource kind | Full | OBTAIN_APPROVAL | Downstream request is provisional. |

## Resilience

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.resilience.failure_domain.missing` | WARNING | resource kind | Full | RECONFIGURE_RESILIENCE | A required independent path has no declared failure domain. |
| `facility.resilience.failure_domain.shared` | ERROR | resource kind | Full | RECONFIGURE_RESILIENCE | Paths required to be independent share a prohibited failure-domain ancestor. |
| `facility.resilience.failure_domain.cycle` | ERROR | resource kind | Full | RESOLVE_CONFLICT | Failure-domain containment is cyclic. |
| `facility.resilience.availability_policy.violated` | ERROR | resource kind | Full | RECONFIGURE_RESILIENCE | Declared availability policy cannot be met. |
| `facility.resilience.availability_policy.unresolved` | WARNING | resource kind | Full | REVIEW_POLICY | Availability policy reference is missing or has no version. |
| `facility.resilience.fuel_duration.insufficient` | ERROR | FUEL | Full | RECONFIGURE_RESILIENCE | Fuel autonomy is shorter than the policy requires. |
| `facility.resilience.water_duration.insufficient` | ERROR | WATER | Full | RECONFIGURE_RESILIENCE | Water autonomy is shorter than the policy requires. |
| `facility.resilience.redundancy.path_count` | ERROR | resource kind | Full | RECONFIGURE_RESILIENCE | Independent path count is below the policy requirement. |

## Environment

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.environment.design_weather.missing` | WARNING | ENVIRONMENT | Full | ADD_DATA | No design-weather reference is declared. |
| `facility.environment.permit.exceeded` | ERROR | ENVIRONMENT | Full | OBTAIN_APPROVAL | A declared permit constraint is exceeded. |
| `facility.environment.water.envelope_missing` | WARNING | WATER | Full | ADD_DATA | Water availability or permit envelope is undeclared. |
| `facility.environment.hazard.mitigation_missing` | ERROR | ENVIRONMENT | Full | ADD_DATA | A policy-required hazard mitigation is absent. |
| `facility.environment.emissions.exceeded` | ERROR | ENVIRONMENT | Full | OBTAIN_APPROVAL | Declared emissions limit is exceeded. |
| `facility.environment.profile.out_of_scope` | ERROR | ENVIRONMENT | Full | RESOLVE_CONFLICT | Environmental profile is applied outside its site or effective period. |
| `facility.environment.constraint.basis_missing` | ERROR | ENVIRONMENT | Both | ADD_DATA | Constraint has no declared unit or basis. |

## Phasing

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.phase.dependency.cycle` | ERROR | PHASING | Full | ADJUST_PHASE | Phase dependency graph contains a cycle. |
| `facility.phase.dependency.duplicate` | ERROR | PHASING | Full | RESOLVE_CONFLICT | Duplicate phase dependency edge. |
| `facility.phase.dependency.self` | ERROR | PHASING | Full | ADJUST_PHASE | Phase depends on itself. |
| `facility.phase.capability.before_commissioned` | ERROR | PHASING | Full | ADJUST_PHASE | A phase consumes capability before it is commissioned. |
| `facility.phase.capacity.future_reserved_consumed` | ERROR | PHASING | Full | ADJUST_PHASE | A phase consumes capacity reserved for a later phase. |
| `facility.phase.date.unconfirmed` | WARNING | PHASING | Full | ADD_DATA | Phase date or precision is not confirmed. |

## Data Integrity and Geometry

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.data.entity.required` | ERROR | GEOMETRY | Both | ADD_DATA | A required entity for the declared design scope is absent. |
| `facility.data.id.duplicate` | ERROR | GEOMETRY | Full | RESOLVE_CONFLICT | Duplicate stable ID within a revision. |
| `facility.data.crs.missing` | ERROR | GEOMETRY | Both | ADD_DATA | Geometry has no declared coordinate reference system. |
| `facility.data.units.missing` | ERROR | GEOMETRY | Both | ADD_DATA | Quantity has no unit or basis. |
| `facility.data.geometry.invalid` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Geometry is topologically invalid. |
| `facility.data.geometry.self_intersection` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Polygon ring self-intersects. |
| `facility.data.geometry.type_mismatch` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Geometry type does not match the declared role. |
| `facility.data.geometry.role_missing` | ERROR | GEOMETRY | Both | ADD_DATA | Required geometry role is absent for the entity kind. |
| `facility.data.transform.unreviewed` | WARNING | GEOMETRY | Both | REVIEW_IMPORT | Local geometry transform is unreviewed. |
| `facility.data.provenance.missing` | ERROR | GEOMETRY | Both | ADD_DATA | Authoritative value has no provenance. |
| `facility.data.provenance.stale` | WARNING | GEOMETRY | Full | ADD_DATA | Value is older than the project staleness threshold. |
| `facility.data.assumption.unresolved` | WARNING | GEOMETRY | Full | ADD_DATA | An active assumption remains unresolved. |
| `facility.data.entity.parent_cycle` | ERROR | GEOMETRY | Full | RESOLVE_CONFLICT | Container hierarchy contains a cycle. |
| `facility.data.entity.parent_cross_scope` | ERROR | GEOMETRY | Full | RESOLVE_CONFLICT | Parent/child link crosses scope or revision. |

## Site and Code

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.site.container.outside_parent` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Building or equipment lies outside its parcel. |
| `facility.site.container.overlap` | WARNING | GEOMETRY | Both | CORRECT_GEOMETRY | Containers overlap where overlap is prohibited. |
| `facility.site.setback.violated` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Footprint violates a setback constraint. |
| `facility.site.easement.violated` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Footprint or equipment falls within an easement. |
| `facility.site.access_route.blocked` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Access route is blocked by a container or exclusion zone. |
| `facility.site.height.exceeded` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Height limit exceeded. |
| `facility.site.hazard.excluded` | ERROR | GEOMETRY | Both | CORRECT_GEOMETRY | Placement falls inside a hazard or exclusion zone. |
| `facility.site.constraint.rule_missing` | ERROR | GEOMETRY | Full | REVIEW_POLICY | Regulatory or hazard constraint has no rule/provenance reference. |
| `facility.site.constraint.geometry_missing` | ERROR | GEOMETRY | Both | ADD_DATA | Constraint has no linked geometry where geometry is required. |

## Document Import

Asset integrity and lifecycle failures are shared, tool-independent diagnostics defined once in the [Project Assets](../../workspace/project-assets.md) model under the `asset.*` namespace. Processing failures are likewise shared under `import.*` in the [Workspace Import and Conversion Framework](../../workspace/import-adapters.md). This tool MUST surface them unchanged and MUST NOT redefine them. Together they cover asset checksum, malware, and supersession state, adapter resolution and registration, units, transform review and residual, conversion fidelity, reference-only features, and IFC extraction.

This tool owns only the mapping and scope diagnostics that depend on the facility model:

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.import.mapping.unresolved` | ERROR | GEOMETRY | Full | REVIEW_IMPORT | A required mapping matches no source feature. |
| `facility.import.mapping.ambiguous` | WARNING | GEOMETRY | Both | REVIEW_IMPORT | A selector matches more than one normalized target where cardinality is one-to-one. |
| `facility.import.geometry.out_of_bounds` | ERROR | GEOMETRY | Both | REVIEW_IMPORT | Imported geometry falls outside the design scope. |

## Revision and Governance

| `constraint_id` | Default severity | Gating capability | Scope | Remediation | Rule reference |
| --- | --- | --- | --- | --- | --- |
| `facility.revision.current` | ERROR | none | Both | ADD_DATA | Request targets a revision that is not the current draft. |
| `facility.revision.publish.requires_validation` | ERROR | none | Full | OBTAIN_APPROVAL | Publication attempted for a revision without a clean validation run. |
| `facility.revision.publish.source_unpinned` | ERROR | none | Full | ADD_DATA | A source document or policy is not pinned. |
| `facility.revision.writes_immutable` | ERROR | none | Full | RESOLVE_CONFLICT | A write targeted a `VALIDATED` or `PUBLISHED` revision. |
| `facility.governance.approval.required` | ERROR | none | Full | OBTAIN_APPROVAL | Deployment policy requires an approval attestation that does not exist. |
| `facility.governance.waiver.expired` | WARNING | none | Full | OBTAIN_APPROVAL | A waiver that gated this revision has expired. |
| `facility.governance.waiver.scope_mismatch` | ERROR | none | Full | OBTAIN_APPROVAL | Waiver does not cover the referenced diagnostic or revision. |
| `facility.governance.attestation.revoked` | ERROR | none | Full | OBTAIN_APPROVAL | The governing approval attestation was revoked. |
