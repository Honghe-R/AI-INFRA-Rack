# Rack Planner Reference Observations

## Source and Evidence Boundary

These are historical read-only observations from 2026-10-29 of the teacher demonstration platform, recorded before the user instructed us to work only on our platform. No teacher page was revisited for this documentation update. No teacher objects were created, moved, validated, published or deleted, and no teacher sample was exported as local seed data.

The observations concern particular displayed pages/revisions, not a code/algorithm audit or proof of hidden deployment configuration. The local repository's copied Site and Facility specification is the document-structure reference; the following UI observations serve interaction design only.

## Observed Pages and Rack Implications

| Reference | Observed behavior | Suitable Rack interpretation |
| --- | --- | --- |
| Power revision 18ff33d2 | 107 devices, 130 connections, 24 circuits; dot grid, Wiring/By level, orientation/snap, selectable inspector | Consistent grid/selection/details. Electrical hierarchy layout is not metre-based floor placement |
| Power ats-a inspector | Identity, declaration, supply path, protection, load/headroom, redundancy and provenance; derived values and missing basis | Present totals/headroom/utilization with provenance. kVA/MVA is not directly Rack kW |
| Network revision a2074084 | 40 devices, 3 tiers, 144 links; By plane/By rack/Blast radius and tier bands | Reuse grouping/filter/selection patterns while preserving Rack physical semantics |
| Network inspector | Ports/connectivity/capacity/resilience/provenance, open findings, provisional/not-provided inputs | Show missing/pinned input evidence and partial coverage instead of implying completeness |
| Network revision 8a2d4bdd | Empty scope with explicit no-result behavior | Distinguish empty/unavailable from a checked design with no defects |
| Rack/Floorplan at that time | Context/lifecycle placeholder rather than complete editor | Local Rack must implement its own core workflow |

Tool data shown in these references belonged to different revisions. Switching tools could expose missing-tool-data guidance rather than creating a new revision. Input pinning/source freshness matters beyond drawing a large graph.

## Applied Design Choices

Keep Plans creation/deletion/restoration, then add Rack-appropriate commands inside each selected plan. Use floor layout, elevations and capacity table with one shared inspector and object identity. Keep metric/unknown/provenance labels and source/version guards. Use a physical room Polygon and metre coordinates; do not turn Network/Power graph spacing into physical feasibility.

The local hall samples are explicitly synthetic: the original32-rack plan is preserved, and a separate128-rack, eight-row plan contains944 installed devices plus eight unassigned devices, exclusions and resource assumptions. Cabinets and installed devices both scale by four; actual checked utilization produces80 high-load and48 normal cabinet colors. See [demonstration setup](../../../RACK_HALL_DEMO.md). Their size/appearance is not evidence that teacher topology or engineering data was reused.

## Non-Transferable Conclusions

No visual reference proves an optimization method, durable candidate history, verified wiring/airflow or credential storage. The previously observed Assistant service/model labels cannot establish key ownership, billing, exact endpoint or retention. Our own [Assistant Integration](assistant-integration.md) documents our actual architecture and limits instead.
