# Saved Rack data in English — 2026-10-30

The user explicitly requested translation of existing visible content regardless of its author, including saved plan names. This supersedes the previous round's decision to retain user-entered Chinese labels.

## Local maintenance

Run only from `C:\Users\RHH\Desktop\AI-INFRA-Rack` with its existing isolated local database:

```powershell
# Preview; fails on Chinese text without a reviewed translation.
node --env-file=.env records/2026-10-30-rack-data-english/translate-rack-data.mjs
# Apply reviewed changes, backing up original rows outside Git first.
node --env-file=.env records/2026-10-30-rack-data-english/translate-rack-data.mjs --apply
```

Applied once to three plans, translating 253 string values:

| Plan | Result | Version |
| --- | --- | --- |
| Full Hall Demo · 32 Racks / Mixed Equipment Rows | Active; 32 racks, 244 devices | 2 → 3 |
| Auto Design Demo · 22 Devices | Active; 3 racks, 22 devices | 2 → 3 |
| User Journey Demo · Two Racks with Servers and Switches | Remains deleted | 8 → 9 |

Includes 244 device names, four exclusion-zone names and two assumption references as well as the three plan names. IDs, model bindings, assignments, rack positions, constraint values, resource limits, deletion states and lifecycle state were retained. Updates run in one transaction with original version/content predicates; each affected plan version increments to reject stale drafts. This is explicitly authorized local data maintenance, not a new UI editing API or schema migration. `updated_at` changes; the script does not invent a user attribution or modify old command hashes.

Original rows are backed up to the Git-ignored `.local-runtime/backups/rack-english-1793334561389.json`. Keep this local backup for recovery. Repeat preview reports zero changes. The script rejects a non-Rack Compose project, unexpected database host/port/name and unmapped Chinese text rather than guessing translations.

## Source changes and verification

- `scripts/lib/rack-hall-demo.mjs` now creates English plan, equipment and exclusion-zone names. The demo runner still recognizes the old Chinese name to avoid duplicate demos on other existing databases.
- The earlier offline Rack preview's HTML, labels and six scenario descriptions are now English too; HTML declares `lang="en"`.
- `node --test scripts/tests/rack-hall-demo.test.mjs`: 4/4 passed, no skips.
- `node --check` passed for the maintenance script, hall fixture/runner and both preview scripts.
- Real Web-proxied GET for both active plan details/layouts returned HTTP200, with no Chinese strings in the complete layout responses. Deleted plan detail returned HTTP200 and stayed deleted.
- Compared backed-up/current equipment and constraints after removing display-text properties: all non-text content matched; versions increased exactly once. Initial verification compared a PostgreSQL Date object directly with its serialized backup string; corrected to ISO comparison, then the entire read-only check passed.
- Reran the hall demo runner using the existing local hall plan: `retainedExisting:true`, version3, other active plan/source unchanged; no new plan or candidate saved.
- Temporary offline preview on port5184: HTML/JavaScript/data HTTP200, six scenarios, no Chinese strings. Temporary server stopped afterward; existing platform services kept running.

No reset, reseed, geometry replacement, model call, credentials output, teacher-directory/platform operation, commit, push or remote changes. Historical development documentation and evidence remain in their original language. No full repository test run or live browser visual verification was performed for this text-only increment.
