# Round33 — Scale Equipment with Cabinet Count

Started2026-10-30, completed2026-10-31 (Asia/Shanghai). Workdir: `C:\Users\RHH\Desktop\AI-INFRA-Rack`. HEAD `61ebb26`; round32 local modifications were preserved. No teacher directory/platform access or Git staging/commit/push.

## Implementation and data

- Saved equipment bound expanded512→2,048;256 rack-limit records unchanged. Domain owns constants in `packages/rack/src/limits.js`; browser uses a generated dependency-free mirror. `node scripts/rack-sync-limits.mjs --check` and parity tests protect alignment. All browser validation/add buttons/counters/batch additions use the mirror.
-128-rack dense fixture reuses the original32-rack equipment profiles four times with unique plan-local identities.944 installed devices:144 GPU servers,576 compute servers,224 ToR switches. Eight pending devices retained. Total952. Power/cooling960kW baseline,966kW assumed budget. Actual80%-threshold colors:80 high-load,48 normal, no overcapacity. Utilization range54%–98.75%. Geometry,96 locked/32 movable racks and exclusions unchanged.
- Ordinary `--large` creates the new density for new demos and retains existing matching plans. Explicit `--upgrade-large-equipment` checks the old fixture exactly, tolerates JSON/placement array ordering, refuses user equipment edits or changed rack identities/models, preserves positions/constraints, writes a non-overwriting backup and uses ordinary check/versioned-save APIs. Repeating a completed upgrade is a no-op.
- Saved inventory capacity is independent of search effort: relocation64 movable racks, allocation64 unlocked targets/128 pending devices, demand design32 generated racks remain unchanged. This example operates within those budgets. HTTP body limit remains1MiB; it accepts this fixture and the2,048-device integration body, but large field values can still reach the byte limit first.

## Validation commands

```powershell
node scripts/rack-sync-limits.mjs --check
node --test scripts/tests/rack-hall-demo.test.mjs scripts/tests/rack-large-hall-demo.test.mjs scripts/tests/rack-limits.test.mjs
npm run test --workspace @ai-infra/rack
node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js apps/api/src/tests/gateway.test.js
npm run test --workspace @ai-infra/web
npm run build --workspace @ai-infra/web
npm run rack:demo:hall -- 4c11ab8d-5d57-4ad8-ad55-ac08574fba46 4b8f7bf3-9015-455f-8bc8-ef3520f0d748 --upgrade-large-equipment
```

- [Fixture/parity10/10](fixture-tests.txt), zero skipped: original fixture retained,952 identities, exact model counts,944 valid assignments, resource/U checks, color counts via real display helper, ordinary allocator, upgrade guards/preservation/no-op, generated limit parity.
- [Rack domain141/141](domain-tests.txt), zero skipped, including2,048 pending records without mutation and2,048 installed devices across128 cabinets with exact slot/capacity totals; bound+1 rejection.
- [DB/HTTP/gateway74/74](api-tests.txt), zero skipped. New integration test checks2,048 records, saves/reads them exactly, rejects2,049 and confirms saved state unchanged. Existing authorization/concurrency/atomicity/Assistant tests retained. Fixtures create and clean their own test data in the isolated Rack database.
- [Full Web final run](web-tests-final.txt):63 files passed, one failed;689 tests passed, one failed of690. Sole remaining failure: unchanged `src/tests/rack-room-budget.test.jsx` imports `@ai-infra/rack`, violating `import-boundaries.test.js`. Confirmed that import exists in HEAD via `git show HEAD:apps/web/src/tests/rack-room-budget.test.jsx`. No complete Web/repository pass claimed.
- [Initial Web run](web-tests.txt) also caught five new direct domain-limit imports. Corrected the new violations by removing the new Web package dependency and using generated browser constants/parity. Did not relax the architecture guard. Original package manifests/lock dependency state restored.
- [Web build](web-build.txt) passed, with inherited toolchain and970kB bundle-size warnings. No package installation or lockfile dependency changes required.

## Actual saved-plan upgrade

[Upgrade output](upgrade.txt): plan `879a2cbc-87d4-4c7a-93c3-ca435e3f34f3`, v2→v3,392→952 inventory records,384→944 installed. Pre-upgrade document: [before-v2](before-879a2cbc-87d4-4c7a-93c3-ca435e3f34f3-v2.json). Geometry/constraints deep-equal before/after. Two other active scoped plans and original32-rack source deep-equal before/after. No direct SQL rewrite/migration/reset/seed or volume operations.

Normal API check produced zero spatial/equipment diagnostics. Scoped statuses remain INCOMPLETE due to unknown obstacles/eight pending devices; whole-plan NOT_RUN. Allocation preview adds two GPUs and retains six pending with expected unknown, oversized and room-budget reasons. Both relocation previews stageable, zero unplaced,32 moved, all96 locked placements and equipment retained. Saved plan deep-equal after previews; none applied. [Repeat](repeat.txt) retained v3 exactly without another save.

Single local observations: check567ms, save697ms, allocation525ms, relocation comparison14,599ms. These are smoke timings under local conditions, not repeated performance/load experiments or an SLA.

## Browser checks

Only `http://localhost:5193/`, Dana/admin, Northern DC Campus → Rack. Module hot updates briefly left the old tab blank; ordinary reload recovered the project list. Selected the same upgraded128-rack plan. Observed952 total inventory,944 installed, eight pending, saved v3. Power coloring visibly contains both normal and high-load cabinets. Selected B01:11 devices,21/42U occupied,8.3/10kW. Capacity table and Rack elevations both loaded the expanded inventory. Returned to expanded floor view with B01 selected; [screenshot](dense-hall.png). No browser draft edits/saves.

Current docs and PROGRESS distinguish the superseded sparse round32 example from this dense upgrade. All specifications and budgets are synthetic assumptions; connected egress, electrical/airflow/cabling engineering acceptance, shared authoritative budgets and repeated scaling measurements remain future work.
