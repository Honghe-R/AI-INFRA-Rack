# Local Rack Read/Check Samples

Run on2026-10-31 with Node22.22.1, Windows11 build22631, i7-14650HX,
24 logical CPUs and15.71GiB RAM; isolated local PostgreSQL/PostGIS stack.
See [raw samples](performance.json) for exact IDs, geometry counts and times.

```powershell
node --env-file-if-exists=.env scripts/rack-performance.mjs 4c11ab8d-5d57-4ad8-ad55-ac08574fba46 4b8f7bf3-9015-455f-8bc8-ef3520f0d748 879a2cbc-87d4-4c7a-93c3-ca435e3f34f3
```

The script accepts one project and one to three saved plan IDs. It uses only local
HTTP reads and computation POSTs; no layout writes, seeds, resets, record writes
or external model calls. One warmup is discarded per operation, followed by five
sequential samples. Before/after deep equality checks detect layout changes.

| Fixture | Read median / sample p95 | Spatial + equipment check median / sample p95 | Planning report median / sample p95 |
| --- | --- | --- | --- |
| 32 racks /236 installed +8 pending |40.9 /51.3ms |511.8 /594.2ms |42.1 /51.5ms |
| 128 racks /944 installed +8 pending |55.8 /66.8ms |555.9 /670.3ms |71.6 /114.0ms |

Times include development proxy authentication, HTTP, DB/domain checking,
serialization and JSON parsing. Both fixtures have four obstacles and a five-point
Polygon. Both stayed at v3 and produced no blocking diagnostics in repeated checks.
Reports were sampled **before** the first saved check was recorded, so report
timings do not measure the later additional recorded-capacity payload.

With five samples, nearest-rank p95 is simply the maximum. This is preliminary
course-scale evidence, not a reliable tail-latency estimate, concurrency/load test,
optimizer benchmark, production throughput claim or SLA. Warm caches, local
process overhead and sample variation explain why ratios need not follow worst-case
complexity; these numbers do not establish constant-time checking.

## Complexity and extension

Let R be cabinets, O declared obstacles, V room vertices, D devices, D_i devices
in cabinet i, U_i enumerated occupied U positions, and B bounded candidate poses.

- Spatial SQL constructs footprints/bands then checks cabinet pairs and
  cabinet/obstacle and band interactions. Pair enumeration grows O(R² + R·O),
  with geometry-predicate cost depending on V and topology.32→128 increases
  possible cabinet pairs496→8,128. Query plans/bounding-box optimizations affect
  actual execution; this estimate is not a PostGIS timing guarantee.
- Equipment checks group devices by cabinet, compare U intervals pairwise per
  cabinet, enumerate occupied slots and total resources. Approximate work is
  O(R + D + ΣD_i² + ΣU_i), plus output diagnostics. A pathological concentration
  in one cabinet differs from distributing the same D over many cabinets.
- Input fingerprinting canonically sorts object keys and hashes serialized input;
  export payload size grows with geometry, cabinets, devices and included reports.
  History lists return at most20 summaries; full reports are fetched individually.
- Packing and placement use deterministic heuristics with explicit device/rack,
  arrangement, pose, query and elapsed-time budgets. They do not prove global
  optimality. This experiment did not time planning, save, rendering or Assistant.

Before increasing bounds, profile larger/concave inputs and dense diagnostics,
measure concurrent users, and examine spatial indexing/batching, interval sweeps,
planning workers/cancellation and response sizes. Preserve feasibility, explicit
unknowns and source/version checks when optimizing.
