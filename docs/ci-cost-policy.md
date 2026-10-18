---
summary: "Manual-only production opt-in CI for every hosted job to bound Actions spend."
read_when:
  - Changing GitHub Actions runners or release triggers.
  - Requesting a production build or investigating Actions charges.
---

# CI cost policy

Hosted GitHub Actions minutes for this repository are paused. The
Mac-capable workflows were manually disabled on October 14, 2026, and the CI
workflow now has no automatic triggers at all: keep everything paused until Edi
explicitly requests a production build. This includes mixed workflows
containing a Mac job: their Linux lanes are also paused while the workflow is
disabled. Unaffected portable workflows remain unchanged.

The policy for `.github/workflows/ci.yml`:

- Triggers: `workflow_dispatch` only. No push, pull_request, schedule,
  workflow_run, merge_group, or repository_dispatch entry may return.
- Every hosted job — the Ubuntu `verify` job and the macOS `macos-native`
  job alike — carries a job-level guard requiring an explicit dispatch on
  `refs/heads/production` with the typed boolean `run_build` input set to
  `true`. `run_build` defaults to `false`, so a default dispatch allocates
  nothing.
- `macos-native` additionally requires the typed boolean `run_native` opt-in,
  also defaulting to `false`. A branch push, tag push, production PR,
  schedule, or ordinary dispatch must not allocate a paid Mac or any other
  hosted runner.
- Publication, where present, still needs its own affirmative publish input;
  a diagnostic is never a substitute for release verification.

Because all hosted builds are paused, local gates carry the day-to-day load:
`npm run build`, `npm run check`, and `npm test` (plus the policy guards below)
must pass before a change is considered validated.

Promote the reviewed workflow changes to `production` before requesting a
build. Do not dispatch historical tags that contain old workflow definitions,
rerun old paid jobs, or enable a workflow merely to check its configuration.
The `production` workflow remains `disabled_manually` externally; the guards
here must never be used to enable or dispatch it. Release/package workflows
remain disabled after this change. Explicit production builds still incur
normal GitHub charges; this is not a zero-dollar account cap.

## Local verification

Run `node --test scripts/tests/ci-native-policy.test.mjs` and
`ruby scripts/test-ci-cost-policy.rb`. Both parse the actual workflow YAML —
the Node guard with its own parser and expression evaluator, the Ruby guard
with the standard-library YAML parser — and check every hosted job against
inline scenarios: automatic events with every opt-in, dispatches on wrong
refs, missing or default opt-ins, and the positive production opt-in path.
Each guard also mutates the parsed workflow (ungated Linux or new jobs,
relaxed gates, added push/schedule triggers, `run_build` defaulting to true)
and requires rejection. Where a production-release validator exists, the Ruby
guard additionally exercises its tag identity checks. Configuration
verification must not dispatch paid hosted jobs.
