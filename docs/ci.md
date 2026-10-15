---
summary: 'GitHub-hosted source validation and isolated macOS coverage.'
read_when:
  - Changing CI runners or platform-specific tests
  - Checking the source validation gate
---

# CI

Main and production pushes, all pull requests, and manual dispatches run the
Ubuntu source-validation job on fresh GitHub-hosted machines. New commits cancel
an older CI run for the same branch or pull request. Each job has a ten-minute
limit, read-only repository permissions, pinned official actions, and an npm
download cache.

The `verify` job uses Ubuntu 24.04 ARM and runs the unchanged source gate:
`npm ci`, `npm run build`, `npm run check`, the executable CI-policy guard, and
`npm test`, which runs the suite under a private temporary folder, so the
runner's real one is left as it was. It also fails a test that hangs (120 s by default for a test with no timeout of
its own), lets a test file exit once its tests have ended, and stops every test process
when the run is signalled: the test processes exit on the signal, which stops the Copilot CLIs
they started (those run in process groups of their own), and the runner removes the stale
sockets its run linked to in `/tmp/codex-daemon-<uid>`. Six tests require macOS and retain
their explicit platform guards.

`macos-native` uses GitHub's macOS 15 Apple Silicon runner only for an intentional
native validation: an explicit dispatch from `production` with
**Run paid macOS native checks** enabled. Pushes and PRs never allocate a Mac. The manual input defaults to `false`. Main, master, and feature pushes,
ordinary pull requests, tags, schedules, and merge queues do not spend hosted
macOS time. A skipped job is not native proof. When selected, it runs the complete
native files and ownership regressions:

- `mac-service.test.ts`: native plist parsing.
- `service-plan.test.ts`: managed service inventory.
- `service-tunnel.test.ts`: native SSH parsing and supervisor arguments.
- `service-shared-executors.test.ts`: shared service migration and lifecycle.
- `service-shared-native.test.ts`: native migration and verified artifact guards.
- `native-execution-host.test.ts`: shared native ownership and recovery.

Keep any additional macOS-only test files in that job. When native validation is
selected, both jobs must pass; the Linux suite alone does not establish macOS
coverage. Fixtures use temporary
configuration, mock providers, and owned child processes. CI does not install or
activate the gateway, register desktop services, authenticate providers, publish
a release, or send paid inference. Signed SDK, installed-service, and rendered
desktop checks remain separate release verification described in
[verification](verification.md) and [releasing](RELEASING.md).

`scripts/tests/ci-native-policy.test.mjs` reads the actual workflow condition and
event fixtures, checking production/manual opt-in and automatic-event opt-out.
Run it locally with `node --test scripts/tests/ci-native-policy.test.mjs`.
