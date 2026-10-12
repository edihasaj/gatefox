---
summary: 'GitHub-hosted source validation and isolated macOS coverage.'
read_when:
  - Changing CI runners or platform-specific tests
  - Checking the source validation gate
---

# CI

Main pushes, pull requests, and manual dispatches run CI on fresh GitHub-hosted
machines. New commits cancel an older CI run for the same branch or pull request.
Each job has a ten-minute limit, read-only repository permissions, pinned official
actions, and an npm download cache.

The `verify` job uses Ubuntu 24.04 ARM and runs the unchanged source gate:
`npm ci`, `npm run build`, `npm run check`, and `npm test`. Six tests require macOS
and retain their explicit platform guards. The `macos-native` job runs their
complete test files and native ownership regressions on GitHub's macOS 15
Apple Silicon runner:

- `mac-service.test.ts`: native plist parsing.
- `service-plan.test.ts`: managed service inventory.
- `service-tunnel.test.ts`: native SSH parsing and supervisor arguments.
- `service-shared-executors.test.ts`: shared service migration and lifecycle.
- `service-shared-native.test.ts`: native migration and verified artifact guards.
- `native-execution-host.test.ts`: shared native ownership and recovery.

Keep any additional macOS-only test files in that job. Both jobs must pass; the
Linux suite alone does not establish macOS coverage. Fixtures use temporary
configuration, mock providers, and owned child processes. CI does not install or
activate the gateway, register desktop services, authenticate providers, publish
a release, or send paid inference. Signed SDK, installed-service, and rendered
desktop checks remain separate release verification described in
[verification](verification.md) and [releasing](RELEASING.md).
