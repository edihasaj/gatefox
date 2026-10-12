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
   For shared execution changes, run `scripts/e2e-shared-execution.mjs` with the
   installed command, isolated native home, and isolated client configuration.
   Start without `--inference`, then enable real provider turns and image history.
   The zero-inference run proves process ownership rather than durable chat resume.
   For speed controls, run `scripts/e2e-fast-mode.mjs --gateway INSTALLED_COMMAND
   --package INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY`. It uses the
   real signed SDK with a mock upstream through stdio and a private Unix socket.
   It proves requested and returned tiers, settings changes, saved-history resume,
   and native isolation; it sends no subscription inference and does not prove
   rendered desktop controls or the built-in cloud transport.
   For compaction changes, run `scripts/e2e-compaction-switch.mjs --gateway
   INSTALLED_COMMAND --package INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY
   --shared`. It reproduces the previous-model failure with `--expect baseline`
   and verifies selected-model recovery, Stop, failures, and reconnect through
   stdio and Unix with a mock upstream and the signed SDK. Shared ownership is
   checked for safe refusal of automatic compaction, not seamless recovery.
   For Responses continuation changes, run
   `scripts/e2e-responses-continuation.mjs --package INSTALLED_PACKAGE --codex
   SIGNED_CODEX_MACH_O --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It verifies actual
   continuation flags, message phases, nested text, and one dispatched tool with
   the pinned signed SDK and a mock upstream. Pass the signed Mach-O under
   `CodexCLI.app/Contents/MacOS/codex`, not its unsigned `bin/codex` shell launcher.
   The fixture requires fresh isolated state, rejects native homes, and uses no
   copied authentication or paid inference.
   A first real turn is required before the SDK can resume an empty chat.
   Run `scripts/e2e-execution-sandbox.mjs` to confirm the live control socket is
   unreachable inside the actual macOS sandbox, including through its alias.
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

Gateway executors can use a separately compiled SDK with selected-model compaction.
Build and test it from the checksum-pinned upstream archive:

```sh
node scripts/build-gateway-sdk.mjs --test
node scripts/build-gateway-sdk.mjs
node scripts/build-release.mjs --with-native --with-gateway-sdk
```

The gateway SDK has its own executable, licenses, dependency inventory, and build
receipt. The release builder verifies its version, SDK revision, archive and patch
digests, source digest, binary checksum, and capability. It refuses modified cached
SDK source or unexpected artifact files. The native signed Codex executable and
desktop bundle remain unchanged. Only a verified gateway executable can enable
the selected-model compaction capability; older installations retain their existing
fallback behavior. Run the real SDK mock cases and gateway continuation checks
before publishing a release with this capability.
The upstream release archive declares workspace version `0.162.0-alpha.17.2`
while its lockfile retains `0.0.0`. A guarded helper repairs exactly those 161
source-less workspace versions. All external package versions, sources, checksums,
and dependency blocks remain byte-identical. The repaired lockfile and helper are
hashed in the receipt; Cargo tests and builds still use `--locked`.
The four compaction cases use the upstream compact suite with its original test
aliases and constructor. The runner temporarily narrows the suite aggregator to
that module, avoiding unrelated upstream test compilation errors, then restores
the exact original bytes. Its digest joins the receipt; the verified SDK source
tree must match again before building the executable.

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
For next-login cleanup changes, run
`node scripts/e2e-login-consolidation.mjs /absolute/installed/bin/gateway`.
It uses uniquely named launchd fixtures to verify live-PID preservation, refused
manual promotion, and actual primary-job activation. It stops only those fixtures
and uses no provider inference or native authentication.

To remove the installation, run `gateway uninstall`. The installation and managed
LaunchAgents move to Trash. Credentials and native Codex configuration remain.
CLI registration cannot make an unconfigured SSH/cloud backend understand gateway
models; test each execution backend used by a shared chat.
