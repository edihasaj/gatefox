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
