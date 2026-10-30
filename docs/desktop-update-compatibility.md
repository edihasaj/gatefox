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
not with earlier admitted engines. The engine is admitted for the relay only; it
joins `hostVerifiedAppEngines` after the shared-native fixture passes against it.
