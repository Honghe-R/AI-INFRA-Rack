# Rack Project Access — 2026-10-30

## Scope

Implement the approved Viewer/Editor/Project administrator matrix in the Rack copy. Starting HEAD: `0fc4bfa`; the previous read-only review entry in `PROGRESS.md` was already uncommitted and was preserved. No commit, push, remote changes or teacher directory/platform operations.

The English contract was written first in [access-control.md](../../doc/tools/rack/access-control.md). The change reuses inherited authentication and RBAC and adds Rack lifecycle authority, scoped member management and tests. It does not implement production browser sign-in or an external identity provider.

## Environment and migration

The initial migration attempt received `ECONNREFUSED` on Rack DB port 55532. Docker Desktop's Linux engine and the local application ports were not running. Started the installed Docker Desktop hidden, then ran `npm run dev:up` using the already configured Rack environment. Only `ai-infra-rack-dev` services were started. The startup script reported its Rack asset bucket created; no reset, seed or volume removal occurred.

Ran:

```powershell
node --env-file-if-exists=.env records/2026-10-30-rack-project-access/check-migration.mjs
npm run generate:keys --workspace @ai-infra/rbac
npm run dev
```

The migration check asserts loopback/55532/rack_facility, Rack Compose file/project names, creates a uniquely named empty probe DB, applies all 12 migrations, verifies repeat migration is unchanged, then applies only pending migration 012 to the local Rack DB. The probe DB was dropped. Existing plan contents/versions are unchanged. `project_access_events` has enabled/forced project RLS; a later restricted-role integration test proves visible rows are zero without scope or under the foreign project and one under the fixture project. Its temporary role/grants are rolled back, not retained.

`npm run dev` is running in execution session 2922. Last observed Web5193/API8797/DB55532 listeners were present. This is an observation, not a guarantee after closing the processes/computer. No environment or real credential contents were printed or edited; no real model requests were made.

## Verification

| Scope | Evidence | Result |
| --- | --- | --- |
| RBAC catalog/evaluator/guard/repository | [rbac-tests-final.txt](rbac-tests-final.txt) | 74/74, zero skipped |
| Project access + Rack DB/HTTP + gateway | [api-tests-accepted.txt](api-tests-accepted.txt) | 82/82, zero skipped |
| Final UUID-case/self-change/cache hardening | [access-tests-final.txt](access-tests-final.txt) | Project access 12/12 repeated after the full run, zero skipped |
| Access/Assistant/connection projection | [access-assistant-tests.txt](access-assistant-tests.txt) | 53/53, zero skipped, synthetic providers only |
| Web Rack, project access, permission, identity, Assistant and shell | [web-tests-final.txt](web-tests-final.txt) | 25 files, 269/269 |
| Production Web build | [build-final.txt](build-final.txt) | Success; inherited esbuild/oxc and bundle-size warnings remain |
| Browser | [browser-checks.md](browser-checks.md), [preview](admin-access.png) | Administrator panel, unchanged-save round trip, scoped account search, editor/viewer affordances |

Principal commands, from this repository root:

```powershell
npm test --workspace @ai-infra/rbac
node --env-file-if-exists=.env --test apps/api/src/tests/project-access.test.js apps/api/src/tests/rack-plans.test.js apps/api/src/tests/rbac-gateway.test.js
node --env-file-if-exists=.env --test apps/api/src/tests/project-access.test.js
node --env-file-if-exists=.env --test apps/api/src/tests/project-access.test.js apps/api/src/tests/rbac-gateway.test.js apps/api/src/tests/rack-assistant.test.js apps/api/src/tests/assistant-projection.test.js apps/api/src/tests/assistant-connections.test.js
npm exec --workspace @ai-infra/web -- vitest run src/tests/rack src/tests/project-access src/tests/permission-client src/tests/dev-identity src/tests/assistant src/tests/shell-render src/tests/api-client
npm run build --workspace @ai-infra/web
git -c core.safecrlf=false diff --check
```

The extra final access run follows a review finding that uppercase UUID spelling must neither bypass self-change protection nor invalidate only a noncanonical permission-cache tag. The service normalizes the target UUID and invalidation uses the response's database UUID. These cases are explicitly asserted. The 82-test run preceded that localized hardening; its affected 12-test file was then repeated in full. Do not add these overlapping counts together as unique tests.

Final static checks passed: all 16 Rack specifications are English and indexed, 55 local links resolve, four JSON examples parse, and 37 changed/new source/document files have no trailing whitespace; changed JavaScript module syntax checks and tracked Git diff checks passed. Raw `.txt` evidence is retained as produced and excluded from source whitespace scanning.

## Initial failures and corrections

- [api-tests.txt](api-tests.txt): 78/80. Adding a successful editor rename meant the old zero-command assertion needed to expect that one successful command, while still proving rejected requests add nothing. One existing gateway test also returned a transient `fetch failed`; the same range subsequently passed without changing that test.
- [api-tests-final.txt](api-tests-final.txt): 80/80 after the correction.
- [api-tests-final2.txt](api-tests-final2.txt): 80/81. Strengthening the revoked-manager test added a successful demotion and therefore an audit event before the rejected service call. Changed its assertion to preserve the event count captured immediately before rejection. No authorization assertion was relaxed.
- [api-tests-accepted.txt](api-tests-accepted.txt): 82/82 after that fixture correction and adding the restricted-role RLS test.
- One multi-file patch was rejected because a document heading did not match. Verified it had not partially applied, then applied the corrected patch. No runtime behavior was affected by the rejected patch.

## Limits

No full-repository test pass is claimed. Browser role changes were not used to alter seeded accounts: only an unchanged Viewer save was submitted and returned `changed:false`; actual add/promote/demote/suspend/reactivate/rollback/concurrency/revocation cases use isolated disposable HTTP/DB fixtures. Existing demo plans remain v3 and seeded memberships remain at migration-initialized version 1 in the browser.

The development switcher is not a production login. Organisation/global grants are additive; direct project suspension is not a deny. Members are existing active organisation accounts, without email invitation or registration. Custom role mappings require system review. System-level administration is an explicit privileged recovery route outside the new UI's last-admin policy and audit coverage. Revocation caches are process-local; other browser controls refresh on reopening/reloading, and already executing operations are not retroactively cancelled. Real model acceptance and production identity/RLS/retention/recovery architecture remain separate work.
