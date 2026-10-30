# Round32 — Larger Synthetic Hall

Date: 2026-10-30. Starting HEAD: `61ebb26`; working tree was clean. Workdir: `C:\Users\RHH\Desktop\AI-INFRA-Rack` throughout.

## Changes and boundaries

- Added deterministic128-rack/eight-row fixture,384 installed devices and eight pending devices. Mixed GPU/compute/network profiles, individual limits, four exclusions, alternating faces and assumed provenance.
- Added `--large` to the demo runner with a separate name/idempotency namespace. Original32-rack fixture/tests and existing plans remain intact. Repeated execution retains the existing demo rather than overwriting it.
- Dense floor views suppress labels too wide for a cabinet; selection always reveals the selected label. Tooltip titles, inventory search and Inspector preserve every identity.
- No limit increases, migration, reset/seed, volume deletion, teacher access, real model calls, key output, staging, commits, push or remote changes.

## Commands and results

```powershell
node --test scripts/tests/rack-hall-demo.test.mjs scripts/tests/rack-large-hall-demo.test.mjs
npm run test --workspace @ai-infra/web -- src/tests/rack-workbench.test.jsx
npm run rack:demo:hall -- 4c11ab8d-5d57-4ad8-ad55-ac08574fba46 4b8f7bf3-9015-455f-8bc8-ef3520f0d748 --large
```

- Fixture/domain tests8/8, zero skipped. Covers deterministic identities, unchanged inputs, row counts,96 locked/32 movable racks,392 devices, valid U/resources,336kW baseline/6kW margin, real allocation and unsupported-input rejection. [Output](tests.txt).
- Existing Workbench tests7/7, zero skipped. [Output](web-tests.txt). No full Web/repository suite or production build repeated for this localized fixture/label change.
- Normal authorized HTTP creation/check/save succeeded. Plan `879a2cbc-87d4-4c7a-93c3-ca435e3f34f3`, v2. Actual extent106.300×91.641m, Polygon area9,229.789m². Spatial/equipment diagnostic arrays empty; scoped statuses INCOMPLETE and whole-plan NOT_RUN remain accurate. [Creation output](create.txt).
- Allocation assigns two GPUs, leaves six pending with expected budget/unknown/oversized reasons; preview installed total342kW. Two relocation candidates stageable,32 moved, zero unplaced;96 locked positions/all equipment retained. No candidate persisted. Saved plan deep-equal after previews; two other active scoped plans/source deep-equal before/after.
- Repeated command retained the exact new saved v2 and rechecked old plans/source. [Retention](retain.txt).
- Single local observations: check713ms, save714ms, allocation490ms, comparison14,139ms. Not repeated scaling benchmarks, browser frame-rate measurements or capacity claims.
- Initial project-list discovery lacked organisation scope and returned403; scoped source GET succeeded. One UI search used a nonexistent directory before correction. Neither changed data. One documentation patch was rejected atomically for duplicate file operations and then rewritten; no partial edits.

## Browser acceptance

Only the existing `http://localhost:5193/` tab, as Dana/admin. Refreshed plans and selected the new English entry. Observed128 racks,392 inventory,384 installed and eight pending. Expanded floor shows eight rows, central/outer reservations and room minimap.

Initial screenshot exposed overlapping labels. After the label adjustment, inspected G01: GPU U1–4, compute U5–6, switch U7,7/42U and4.1/10kW. Capacity table loaded and retained G01 selection. Returned to floor, left expanded and selected, saved [large-hall.png](large-hall.png). No browser layout edits or saves.

## Remaining boundaries

Larger saved synthetic fixture, not full-load production capacity or a larger demand generator. Limits remain256 saved racks/512 devices,64 movable relocation racks,64 unlocked allocation targets and32 demand-generated racks. Partially populated cabinets stay within inventory bounds. Unknown obstacles, connected access/egress, shared authoritative capacity and engineering/network validation remain unresolved. Teammates reproduce data in their own isolated databases.
