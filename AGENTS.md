# Local development rules

- Work in `C:\Users\RHH\Desktop\AI-INFRA-Rack` only. The original
  `C:\Users\RHH\Desktop\AI-INFRA` directory must not be modified.
- Keep work local. Do not create commits, push, or change remotes. The user
  handles all Git commits and publication.
- Proceed in small, reviewable steps. Current scope is the foundation; do not
  implement the full checklist without a new user request.
- The user has deferred Docker/environment setup. Continue with offline domain
  work; do not resume Docker downloads, service startup, migrations or seeding
  unless the user revisits that scope.
- Read `PROGRESS.md` and `RACK_FOUNDATION.md` before continuing Rack work.
- Append concrete changes, decisions, validation results and outstanding work
  to `PROGRESS.md`. Update checklist items only when supported by evidence.
- Separate inherited baseline failures, skipped checks and new regressions.
  Do not report the whole project as passing when only Rack tests pass.
- Do not claim the synthetic example is a vendor specification or engineering
  validation. Do not publish credentials, `.env` contents or private course data.
