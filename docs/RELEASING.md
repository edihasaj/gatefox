---
summary: 'Build, verify, publish, install, and recover the Apple Silicon CLI release.'
read_when:
  - Cutting a gateway release
  - Changing installation, desktop registration, or managed services
---

# Release

The installer contains the compiled package and official Node 24.21.0 runtime.
The runtime archive is pinned to its published SHA-256 digest. Node's license
travels with it. No provider credentials, test output, or local configuration
belongs in the release archive.

1. Update the package version and lockfile. Run the development gate.
2. Download the official macOS ARM64 runtime into `.state/release-runtime` and
   verify it against Node's published checksums. Extract it in that directory.
3. Run `node scripts/build-release.mjs --allow-dirty` only for preflight testing.
   Test the extracted installer on an isolated prefix, including a repeated
   install, paths containing spaces/quotes, and a conflicting command.
4. Run real model tool loops and `scripts/e2e-chat-titles.mjs` against the installed
   command on the test Mac. Use isolated native and gateway state directories.
   The title check refuses shared state or a copied native auth file. Record configuration
   digests, provider registration, saved titles, and resume results.
5. Commit and push the final source. Wait for green CI.
6. Run `node scripts/build-release.mjs` from the clean release commit. Inspect
   the archive's file list and verify `SHA256SUMS`.
7. Publish the versioned archive and checksums to the private GitHub release.
   Install exactly that asset on each device.

The build refuses dirty source unless the preflight flag is explicit. It does not
download credentials or publish automatically.

For a release containing the native connected-machine adapter, build and test
the matching relay first, then use `node scripts/build-release.mjs --with-native`.
The relay's source digest, package version, pinned SDK revision, and release
profile must match the archive. Verify the original machine registration and
model picker before publishing. See [native transport checks](native-remote.md).

# Upgrade and recovery

The installer verifies file checksums before changing the current release link.
It saves the previous release target. Reinstalling identical content is safe;
different content under the same version is rejected. Preserve the existing data
directory. Service migration requests a safe idle stop before replacing a managed
LaunchAgent. Busy inference or request uploads refuse the upgrade.
The managed job is temporarily disabled during migration. The owning daemon
unloads its job only after its idle guard accepts the stop, so KeepAlive cannot
restart the old command. Older daemons need one safe restart to load the installed
idle-upgrade protocol. Failure reenables the job and restores its earlier plist.

Use `gateway service status`, `gateway doctor`, and `gateway desktop status` after
installation. Registration prepares future app launches and does not interrupt an
open app. One fresh launch is needed after first registration. The private desktop
launch hook is specific to the tested Codex build, so verify it after app upgrades.

Preview job consolidation with `gateway service consolidate`. Apply it only after
local and remote chats finish. See [the service migration checks](services.md).
An updated installer does not consolidate running jobs automatically.
Test an isolated supervisor under real launchd with
`node scripts/e2e-service-supervisor.mjs /absolute/installed/bin/gateway`.
The fixture exercises HTTP streaming, child and supervisor crashes, login setup,
and shutdown. Its relay child is a mock; it preserves the working native relay.

To remove the installation, run `gateway uninstall`. The installation and managed
LaunchAgents move to Trash. Credentials and native Codex configuration remain.
CLI registration cannot make an unconfigured SSH/cloud backend understand gateway
models; test each execution backend used by a shared chat.
