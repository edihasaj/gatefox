---
summary: 'Keep desktop startup and pinned gateway execution independent of ChatGPT app-engine updates.'
read_when:
  - Investigating desktop startup failures after ChatGPT updates itself
  - Changing app-server invocation classification or native sharing admission
  - Verifying a new signed ChatGPT engine against the connector
---

# ChatGPT update compatibility

The desktop's CLI hook is a command interface, not exclusively a persistent RPC
server. Startup diagnostics must reach the app's own CLI unchanged before the
gateway reads its configuration, credentials, model catalog, relay registration
or execution-host state. Normal stdio and private Unix sessions still use the
gateway adapter. A diagnostic must not be replayed during catalog preflight.

ChatGPT 26.1021.31345 introduced `app-server --print-startup-config` with engine
0.164.0-alpha.11.1. Treating that command as a persistent session caused the
catalog preflight to consume its one JSON line and exit, leaving the desktop with
no startup response. The generated wrapper and direct shim must agree about the
invocation; executable fixture tests cover both boundaries and exact arguments.

| Boundary | Update behavior |
| --- | --- |
| CLI startup and diagnostic commands | The original CLI owns their output, errors, environment and exit status. |
| Gateway inference and saved gateway chats | The verified packaged gateway SDK remains independent of the app engine. |
| A missing app executable during bundle replacement | A combined host retains gateway execution; native-only execution still refuses an unavailable SDK. |
| Native sharing and native chat ownership | Only an explicitly verified signed app engine is shared. Private native fallback retains the original native provider and writer lease. |
| Remote relay | Compatibility admission is separate from host sharing. Unknown remote transport remains unavailable, with its existing registration claim preserved. |

The service probe compares app executable identity only when its current host
actually shares native execution. A combined plan that degraded to gateway-only
must not repeatedly restart a healthy pinned gateway because the planned native
executable is absent or different. Gateway discovery similarly does not apply
native executable-path equality to a gateway request; the host's configuration,
home, process and socket ownership checks still apply.

This does not grant future app engines blanket sharing or relay permission.
Unknown native capabilities remain degraded, and requested sharing keeps strict
rollout readiness pending. A future incompatible RPC change may require an
adapter update; diagnostics and pinned gateway execution should remain isolated.
After gateway-only degradation, restoring native sharing requires a verified
engine and an idle host/service restart. The gateway does not automatically
admit a new engine merely because its file has returned.

Stopping the app-owned metadata timer settles its pending policy-read attempt
immediately, even when that reader ignores cancellation. The underlying reader retains
its busy slot until it actually settles, so shutdown neither waits for its
deadline nor starts overlapping work. A reconciliation pass retains its bounded
cleanup wait.

Engine 0.167.0-alpha.3.2 corresponds to OpenAI commit
`b4b58be951a4fcbbda5cf50d48dcd7d4d8a41533` (tag `rust-v0.167.0-alpha.3.2`). ChatGPT
26.1103.41825 shipped it on 8 Nov 2026. The 1.5.9 relay kept running beside it until
the 1.7.6 rollout restarted macbook-server's service; the restarted relay refused the
engine ("requires the matching Codex CLI build") and paused as `failing`, so the phone
lost that Mac. Relative to the admitted 0.166.0-alpha.6, `app-server-transport`
(including `remote_control`), the app-server remote-control processor and
`state/migrations` are byte-identical, the `AuthDotJson` structure is unchanged, and
`CHATGPT_ACCOUNT_ID_HEADER` is still `chatgpt-account-id`. `login` now writes
`auth.json` atomically and reports parse errors more clearly; the format is unchanged.
The rebuilt relay passed its 47 tests and the upstream `remote_control` suite
(165 passed). 1.7.7 admitted it for the relay only. On macbook-server, whose
plan shares native execution, rollout then stayed `native_owner_pending`. The engine
joined `hostVerifiedAppEngines` in 1.7.8 after `scripts/e2e-shared-native.mjs` passed
all 24 phases over stdio and Unix, with and without `--host-codex`, with the native
configuration unchanged and no owned process left behind.

Engine 0.167.0-alpha.4.1 corresponds to OpenAI commit
`d2c035639366e0bf2c316aa2065c24aabc12bcdc` (tag `rust-v0.167.0-alpha.4.1`). ChatGPT
26.1106.51428 shipped it; on 11 Nov 2026 the M5 MacBook took that update, and at its next
service start the 1.9.3 relay refused the engine ("requires the matching Codex CLI build")
and paused as `failing`, while the shared host reported `native_sharing_unavailable`
(`sdk_version`). Relative to the admitted 0.167.0-alpha.3.2, `app-server-transport`
(including `remote_control`), the app-server remote-control processor and its tests,
`state/migrations` and `login/src/auth/storage.rs` (`AuthDotJson`) are byte-identical, and
`CHATGPT_ACCOUNT_ID_HEADER` is still `chatgpt-account-id`. The engine was taken from the
official update ZIP (`ChatGPT-darwin-arm64-26.1106.51428.zip`, OpenAI TeamIdentifier
`2DC432GLL2`, notarized). 1.9.4 admits it for both the relay and the shared host: the
rebuilt relay passed its 47 tests and the upstream `remote_control` suite, and
`scripts/e2e-shared-native.mjs` passed every stdio and Unix phase against it, with and
without `--host-codex`, with the native configuration unchanged, no paid inference and no
owned process left behind.

## Verify an app update

1. Verify the installed app engine's exact version, OpenAI signature and binary
   checksum. Keep a full signed bundle when moving it for isolated testing;
   extracting only its Mach-O can invalidate its Info.plist-bound signature.
2. Run `scripts/probe-desktop-wrapper.mjs` through the normally registered
   wrapper. Add `--startup-config` for engines that support the one-shot startup
   command. The receipt stores success booleans and counts, never resolved
   startup configuration or chat contents.
3. Run the isolated stdio and Unix checks in
   [native launcher verification](native-launcher-verification.md), including
   the launcher path and generated wrapper. Those checks cover reconnect,
   steering, Stop, approvals, original model/provider identity and commands
   executing once, without copying authentication or using paid inference.
4. Review relay transport and registration compatibility separately before
   changing the relay's accepted list. Rebuild and test the relay when its
   admission list changes; a TypeScript-only change cannot update that binary.
5. Check startup through the normal wrapper before and after an authorized
   service restart, then require `gateway rollout --verify --json` to report
   `ready`. Temporary launchd overrides do not prove the installed connector.

For 0.164.0-alpha.11.1, the remote-control protocol, enrollment/registration,
client tracker and stream handling remain identical to the linked 0.163
transport. The newer transport adds fallible auth-header construction, local
daemon socket helpers and optional local WebSocket compression. These changes
are separate from the relay's unchanged wire protocol. The signed engine must
also pass the shared-native fixture before entering the host's verified list.

Engine 0.165.0-alpha.1.2 corresponds to OpenAI commit
`720fec862a608ae1e5878d1eecb04fb93192e93c`. Its remote-control wire types,
registration, enrollment, persistence and client tracker match the linked
0.163 transport. Relative to the admitted 0.164 engine, token storage and remote
auth headers are unchanged; the auth manager extracts the existing owner-checked
grant reader while retaining the refresh lock for leasing. Migration 62 adds a
thread-parent column and index without changing registration SQL. The signed
0.165 engine passed isolated stdio and Unix shared-native checks for reconnect,
steering, Stop, command execution exactly once and pending approval recovery.
Relay admission also requires its separately rebuilt relay fixture to pass.

Engine 0.166.0-alpha.5.1 corresponds to OpenAI commit
`f79b26ccbb3116b052544666a181012fb45dc49b`. ChatGPT 26.1027.30824 shipped it on
30 Oct 2026; the installed relay refused it at the next service restart, paused as
`failing`, and the phone lost every Mac. Relative to the admitted 0.165 engine, the
only `remote_control` change reads the account header from the shared
`codex_http_client::CHATGPT_ACCOUNT_ID_HEADER` constant, whose value is still
`chatgpt-account-id`. The other transport changes concern the local WebSocket
listener's zstd compression. `state/migrations` is identical. The new SQLite
journal-mode policy and NFS migration apply only under managed policy on NFS, not
to a local `~/.codex`. `auth.json` keeps its format; 0.166 adds an advisory
`auth.lock` around writes, which the linked 0.163 relay SDK does not take, as it did
not with earlier admitted engines. On 31 Oct 2026 the signed engine
(TeamIdentifier `2DC432GLL2`) passed every stdio and Unix shared-native phase:
reconnect, steering, Stop, command execution exactly once, pending approval
recovery and native/gateway capability separation, with no owned process left
behind. It joined `hostVerifiedAppEngines` in 1.3.0; until then rollout reported
`native_owner_pending` on Macs that share native work.

Engine 0.166.0-alpha.6 corresponds to OpenAI commit
`4f093f2748667f3b0e6a07e3d4055121cbd3ce64`. ChatGPT 26.1029.61003 shipped it on
4 Nov 2026 to the MacBook Pro, where the installed relay refused it, paused as
`failing`, and the post-update smoke test failed at `stdio-catalog`. Relative to the
admitted 0.166.0-alpha.5.1, `app-server-transport` (including `remote_control`),
`state/migrations`, `login` and the app-server remote-control processor are
byte-identical, and `CHATGPT_ACCOUNT_ID_HEADER` is still `chatgpt-account-id`. The
other changes concern OTel requirements, review delivery, a ChatGPT routing-affinity
header for model requests, thread-listener registration and a read-only attached-thread
query over an existing column. The rebuilt relay passed its tests, the upstream
`remote_control` suite (165 passed) and `scripts/e2e-native-relay.mjs` against the
signed engine. The engine passed every stdio and Unix shared-native phase, with and
without `--host-codex`, including the changed thread-listener lifecycle (reconnect,
disconnect of every frontend, steering, Stop, commands exactly once, pending approval
recovery, native/gateway capability separation), with no owned process left behind.
