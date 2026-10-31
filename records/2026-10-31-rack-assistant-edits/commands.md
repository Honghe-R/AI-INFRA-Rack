# Round36 — Assistant Edits

Starting HEAD `4840c60`; only the Rack copy was changed. No commits/staging/push,
teacher platform access, real model calls or credential output.

## Implemented

Seven model capabilities: five original reads, write-authorized typed edit preview
and confirmed server-owned proposal application. Six edit operations cover cabinet
add/remove/move, existing-device assignment/unassignment, clearance and assumed
room budgets. Migration014 persists owner/plan/version/snapshot, exact normalized
save body, readable changes,30-minute expiry and retry/applied state with forced
project RLS. Save and proposal update share one transaction and plan lock.
Existing checked save remains authoritative. Successful chat writes invalidate
Rack reads; drafts are retained and keep ordinary version-conflict protection.

## Validation

```powershell
node --env-file-if-exists=.env --test apps/api/src/tests/rack-assistant.test.js apps/api/src/tests/rack-plans.test.js
npm --workspace @ai-infra/web test
npm --workspace @ai-infra/web run build
```

- [API/unit/DB log](api-tests.log):79/79 passed, zero skipped,104.6s. Includes
  scripted real orchestration preview→confirmation→save→readback; no write before
  confirmation; exact/concurrent replay; viewer/foreign-owner/foreign-plan denial;
  dirty/stale/version/source/expiry refusal; geometry overlap, U overflow and room
  budget conflicts. Existing save/lifecycle/lock/tenancy regressions also passed.
- [Web log](web-tests.log):65 files /694 tests passed. [Build](build.log):passed,
  with existing toolchain and bundle-size warnings. No full-repository pass claim.
- Applied only014 to the guarded localhost55532/rack_facility target;13 older
  migrations skipped. No reset, seed, volume removal or demonstration edits.
- Initial focused tests exposed a real DTO mismatch: domain placements include
  scope IDs while editable requests reject them; fixed the boundary before save.
  Subsequent fixture corrections used a real feasible concave-room coordinate and
  allowed the confirmation envelope's absent draftChanged instead of assuming a
  false field. Final full regression above passed; failures were not hidden.

## Boundaries

Actual model interpretation and browser click/refresh acceptance remain untested
with a real provider/native browser in this iteration. Production correctness is
not guaranteed by scripted-provider tests. No auto-unlock, new device-spec creation,
plan deletion, automatic quantity design/allocation or Facility mutation is exposed.
Proposal retention/quota cleanup and a complete per-change audit viewer remain
future work. Unknown/unchecked engineering scope remains explicit; validation NOT_RUN.
