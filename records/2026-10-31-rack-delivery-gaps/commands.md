# Round35 Evidence

Working directory: `C:\Users\RHH\Desktop\AI-INFRA-Rack`; starting HEAD
`3b21e53`, with the previous round's PROGRESS update already modified.
No teacher directory/platform, commits, staging, pushes or remotes were touched.

## Migration

Checked the configured target programmatically for localhost/127.0.0.1,
port55532 and database `rack_facility` without printing its URL/credentials.
Migration dry-run reported only `013_rack_check_runs.sql` pending. Applied it with
the normal checksummed migration runner:1 applied,12 skipped. Compared all12
existing plan IDs/versions/deletion timestamps before/after: identical. No reset,
seed or volume removal. Restricted-role RLS acceptance is in the API tests.

## Tests

```powershell
node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js apps/api/src/tests/project-access.test.js apps/api/src/tests/gateway.test.js
npm --workspace @ai-infra/web test
npm --workspace @ai-infra/web run build
```

- [API/DB log](api-tests.log):89/89 passed, zero skipped,97.3s.
- [Web log](web-tests.log):65 files /694 tests passed, zero skipped.
- [Build log](web-build.log):passed. Existing esbuild/oxc and >500kB bundle warnings.
- Earlier focused front-end run:11/11; first two new API tests:2/2, all passed.
  Counts overlap and must not be summed. No full-repository pass is claimed.
- Corrected the inherited Web test's backend import by supplying representative
  HTTP response fixtures. An old assertion also expected wording absent from the
  current component; it now checks its actual explicit per-rack limitation.
  The import-boundary guard remains enabled and passed.

## Runtime and performance

```powershell
node records/2026-10-31-rack-delivery-gaps/runtime-check.mjs
node --env-file-if-exists=.env scripts/rack-performance.mjs 4c11ab8d-5d57-4ad8-ad55-ac08574fba46 4b8f7bf3-9015-455f-8bc8-ef3520f0d748 879a2cbc-87d4-4c7a-93c3-ca435e3f34f3
```

- [Runtime result](runtime-result.json):created one idempotent saved check for the
  synthetic128-rack v3 plan, replay returned the same run; both scoped statuses
  INCOMPLETE with zero blocking diagnostics. Matched current JSON report and
  serialized952 equipment rows with CSV checksum. Three active layouts deep-equal
  before/after. Direct API8797 `/healthz` and `/readyz`200; Web5193 HTML200.
- One exploratory `/api/v1/healthz` returned404 because health is registered at
  API root `/healthz`, not that prefixed path; corrected direct probes passed.
- [Performance report](performance.md) / [samples](performance.json):one warmup
  plus five sequential read/check/report samples for32- and128-rack plans. No
  layout changes, no concurrency/optimizer/SLA claim. Performance was sampled
  before the saved check was created, so report payload then lacked that record.
- Native Computer Use helper unavailable in this session; no actual browser
  visual/click/download acceptance is claimed. Static-render tests, build and
  real HTTP/database paths passed. Browser download UX still needs a manual look.

## Remaining scope

See [current delivery review](../../RACK_DELIVERY_STATUS.md). Whole-plan validation
remains NOT_RUN. Real-model acceptance, continuous egress, authoritative shared
reservations, production login/operations, durable candidates and the human
course report/presentation are outstanding; local JSON/CSV are not accepted
cross-tool handoffs. No real keys, provider calls or credential output.
