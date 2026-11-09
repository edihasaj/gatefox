---
summary: 'Manual-only hosted CI behind production opt-ins; local gates run every change.'
read_when:
  - Changing CI runners or platform-specific tests
  - Checking the source validation gate
---

# CI

Hosted CI is manual-only. The workflow has no push, pull-request, or schedule
triggers: a branch push, a PR (including into `production`), a tag, or a
schedule never starts a hosted runner. The `production` workflow is also
disabled at the repository level (paused manually on October 14, 2026 per the
[CI cost policy](ci-cost-policy.md)), so **all hosted builds are paused** until
Edi re-enables it and dispatches it himself. See [releasing](RELEASING.md) for
the release side of the same pause.

## Home CI

`.github/workflows/home-ci.yml` runs the full gate (`npm ci`, build, check, test) on an
isolated self-hosted runner for each push to `main` or `production` and for manual runs.
It uses no hosted minutes. Because this repository is public, the runner is guarded in
three places:

| Guard | Where | What it stops |
| --- | --- | --- |
| Trust check before a runner exists | `edihasaj/home-runners` control Worker (`control/src/trust.ts`) | It registers a one-job runner only for a queued job in a `home-ci.yml` run that `edihasaj` started from `main` or `production` by push or manual run. A fork pull request can edit `runs-on` but never gets a runner; its job just waits. |
| Same check inside the VM | `job-started` hook (`broker/hooks/trust_check.py`) | Repeats the check from the job's own GitHub context and fails the job before any step runs. |
| Isolation | Separate `public-ci` VM and host key | Never shared with private repositories; egress firewall blocks the Mac host, home LAN and Tailscale. Broker and hooks are root-owned. |

The workflow has a read-only token, uses no secrets, does not keep checkout credentials,
and never prints the environment or host details, because its logs are public.
`scripts/tests/home-ci-policy.test.mjs` enforces that and runs as the job's first step.
Pull requests from forks get no home CI.

Validation therefore happens locally on every change:

```
npm run build
npm run check
npm test
```

`npm test` runs the suite under a private temporary folder and a private home
folder (`HOME` is `<folder>/home` and `CODEX_HOME` is `<folder>/home/.codex`,
overriding an inherited Codex home, so execution hosts keep nothing in
`~/.local/state/gw-exec`), so the real ones are left as they were. At most eight
test files run concurrently because each can start several CLI processes.
It also
fails a test that hangs (120 s by default for a test with no timeout of its
own), lets a test file exit once its tests have ended, and stops every test
process when the run is signalled: the test processes exit on the signal, which
stops the Copilot CLIs they started (those run in process groups of their own),
and the runner removes the stale sockets its run linked to in
`/tmp/codex-daemon-<uid>`, the one place the pinned SDK fixes outside both
folders. Every test process, and every process a test starts with its
environment, refuses the real per-user roots (`gw-exec`, `gw-native`, `gw-ssh`,
the SDK rendezvous and a linked native Codex home) unless they lie in a
temporary folder (`src/test-root-guard.ts`), so a test file run on its own with
`node --test` fails instead of writing there; run single files through
`node scripts/run-tests.mjs <file>`. As a backstop the runner notes the entries
of the real `~/.local/state/gw-native` and `gw-exec` before the run and fails
it, naming the files, when a new entry's `owner.json` points its configuration
or native home into a temporary folder; it never removes anything there. The
tests that need macOS retain their explicit platform guards.

## Hosted jobs (opt-in only)

Every job in `.github/workflows/ci.yml` carries a job-level guard requiring
`workflow_dispatch` **on `refs/heads/production`** with the typed boolean
`run_build` input set to `true`. The input defaults to `false`, so a plain
dispatch runs nothing. Promotion to production happens before a build is
requested; historical tags and old workflow definitions must never be
dispatched.

```
workflow_dispatch on refs/heads/production
├── run_build: true                      → verify (Ubuntu 24.04 ARM)
└── run_build: true + run_native: true   → macos-native (macOS 15 ARM)
```

- `verify` runs the unchanged source gate on a fresh hosted machine:
  `npm ci`, `npm run build`, `npm run check`, the executable CI-policy guard,
  and `npm test`. Each job has a ten-minute limit, read-only repository
  permissions, pinned official actions, and an npm download cache.
- `macos-native` spends paid Apple-silicon minutes only for an intentional
  native validation: a dispatch from `production` with **both** hosted-build and
  native opt-ins enabled. A skipped job is not native proof. When selected, it
  runs the complete native files and ownership regressions:

  - `mac-service.test.ts`: native plist parsing.
  - `service-plan.test.ts`: managed service inventory.
  - `service-tunnel.test.ts`: native SSH parsing and supervisor arguments.
  - `service-shared-executors.test.ts`: shared service migration and lifecycle.
  - `service-shared-native.test.ts`: native migration and verified artifact guards.
  - `native-execution-host.test.ts`: shared native ownership and recovery.

  Keep any additional macOS-only test files in that job. When native validation
  is selected, both jobs must pass; the Linux suite alone does not establish
  macOS coverage. Fixtures use temporary configuration, mock providers, and
  owned child processes. CI does not install or activate the gateway, register
  desktop services, authenticate providers, publish a release, or send paid
  inference. Signed SDK, installed-service, and rendered desktop checks remain
  separate release verification described in [verification](verification.md)
  and [releasing](RELEASING.md).

## Policy guards

Two executable guards read the actual workflow and fail if anyone widens it:

- `node --test scripts/tests/ci-native-policy.test.mjs` parses the YAML,
  evaluates every job's real gate expression against inline event scenarios
  (automatic events with every opt-in, wrong refs, missing/default opt-ins,
  the positive production opt-in) and rejects mutations such as an ungated
  Linux job, a new job, an extra automatic trigger, or a weakened input
  default. It no longer depends on an external event fixture, so the guard
  cannot drift from the workflow.
- `ruby scripts/test-ci-cost-policy.rb` parses the same YAML with the standard
  library and applies the same manual-only policy to every hosted job, native
  or not, including mutation coverage for ungated or under-gated jobs and
  added automatic triggers. See [ci-cost-policy](ci-cost-policy.md).

Run both locally before touching CI; neither requires a hosted run.
