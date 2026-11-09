---
summary: "Install, activate and build the native connected-machine relay without replacing its registration."
read_when:
  - Installing or building the native relay
---

# Native relay setup and builds

Return to the [native connected-machine overview](native-remote.md).

## Activation

The old transport and the relay cannot own the same machine concurrently. Quit
ChatGPT normally on the test machine before activation. The installer never quits
the app. Install a release containing the relay, then run:

```sh
gateway native install
gateway desktop register
gateway desktop
gateway native status
```

The per-user LaunchAgent starts at login and restarts after a crash. SDK heartbeats,
acknowledgements, chunks, and reconnects carry the remote app-server messages.
The local adapter obtains real remote-control status and methods through an owned
private Unix socket. Its original executor's remote transport is disabled only
for that process. The primary configuration stays unchanged.

Existing registrations are bound to their native account. Signing out or changing
that account stops the relay's existing connection. It cannot silently adopt a
different account or create a new connected computer.

### Registering a relay under the unified service

A consolidated Mac whose relay slot waits as `not_registered` registers the relay the
service already runs, with ChatGPT quit normally:

```sh
gateway native install
```

Under a unified plan this installs no LaunchAgent. It takes the relay binary, relay
home, native home and app CLI from the plan's native component, refuses while ChatGPT
is open, and runs the relay's `--check` against this account's existing, enabled Codex
Desktop registration. A missing or disabled registration is refused, and the relay
never enrolls a new machine. Running it again with the same plan changes nothing.

**A registered relay owns remote control.** OpenAI allows one remote-control
connection per Mac, so an engine that connects first leaves the relay with
`HTTP error: 409 Conflict` on every retry until that engine exits. Once the relay is
registered, every adapter, SSH listener and shared host starts its stock engine with
remote control switched off, whether or not the relay is connected at that moment. The
environment switch applies only to engine startup; it does not make a later
`remoteControl/enable` safe. Therefore a registered relay owns every
`remoteControl/*` request, even when its cloud status is errored or its private socket
is temporarily absent. The adapter reconnects that socket automatically. While it is
unavailable, those control requests fail with the relay error; they never fall back to
the stock engine. A registered relay that is down for a while means the phone loses
this Mac until the relay is back; no other engine takes its place. A `409 Conflict` in
the relay log can indicate a competing engine, including an older adapter that allowed
an enable request while the relay was unavailable; it is not proof of the exact holder.

The install avoids that race in this order:

1. It writes `<state>/native-registration.pending`. Adapters and listeners that start
   from now on already count the relay as registered. The previous
   `native-registration.json` is not touched, so it is the rollback. A pending record
   older than ten minutes (a dead install) counts as none.
2. It looks for stock engines under this gateway's adapters, SSH listeners and shared
   host that started before the pending record (it reads the process list in the C
   locale and refuses if any line cannot be read). A first registration only; a Mac
   that already registered a relay has none to clear.
   - An SSH listener is never killed from outside. The install sends it SIGUSR2, a
     request to retire. The listener decides itself, in one step, whether it is
     truly idle: no request in flight, no turn running, no approval waiting, and 30
     seconds without traffic. If so it stops the way a TERM would and the remote app
     reconnects through a fresh listener, which stands down. Otherwise it ignores the
     request and says so in its record, and the install refuses with "an SSH session
     from another Mac is using this Mac; retry when it is idle".
   - The signal is sent only to a listener whose record
     (`listener-activity-<pid>.json` beside its socket) names the same start time as
     the process list. A listener from a release before 0.4.8 keeps no record and
     would die of that signal, so the install refuses with "a listener from an older
     release is running; quit ChatGPT on the other Mac, wait about 2 minutes, then
     retry".
   - Another Codex session on this Mac that runs its own engine also refuses the
     install. The shared host's engine is not signalled: the service restarts the
     host, once idle, because the pending record already counts as a registration; the
     install waits for it and refuses if the host stays busy.
   The steps run in this order so that a refusal changes as little as possible: the
   checks that need no action come first, then the shared host (waited for up to about
   30 seconds, while the service restarts it when idle), and only then are the
   listeners asked, one by one. Any refusal removes the pending record and registers
   nothing. If a listener declines after an earlier one already retired, the earlier
   one stays retired; that is harmless, because its remote app reconnects through a
   fresh listener that stands down.
3. It runs the relay's `--enable` and waits up to 45 seconds. On success it writes
   `<state>/native-registration.json` and removes the pending record. On a timeout or
   an early exit it keeps the previous registration exactly as it was, removes the
   pending record and reports the fixed reason.

The service notices the registration within about two seconds (not at the five-minute
check) and starts the relay while ChatGPT stays closed, so the slot is not left free.
Each SSH listener keeps `listener-activity-<pid>.json` beside its socket (pid, start
time, whether any turn or approval is in flight, when it last declined a retire
request); it is removed when the listener exits. A shared host that started before the
registration restarts when idle so its engine stands down too. Nothing hands remote
control back to an engine while the relay is registered, so a relay that stays broken
leaves the phone without this Mac.

**Giving remote control back.** `gateway native uninstall` under the unified service
now writes `{"registered":false}` to `<state>/native-registration.json`, keeps the
previous record as `native-registration.json.pre-relay-off-<time>` and removes a pending
record. Only engines that start afterwards keep their own remote control; running ones
keep standing down until they restart, and a service restart does not make the desktop
app or SSH listeners release it:

- the desktop app: quit ChatGPT, and open it again once the rest has let go;
- SSH listeners: they let go the next time they start, that is when the remote app next
  connects after its listener exits;
- the relay and the shared host: restart the service while idle
  (`gateway service restart`).

`gateway health` warns when a registered relay has been paused for more than five
minutes, or runs but has not been connected for that long. The "not connected" time is
measured from the last moment the service saw the relay connected (`lastConnectedAt` in
its status file), or from the relay's start if it never was, because the relay rewrites
its own status file on every change and a refused connection (HTTP 409) changes it
constantly. The warning names the cause class (the relay keeps failing, or the service
has not started it since the registration) and this command.

### Moving a Mac to the 0.163 relay

Before this release the relay refused the 0.163 engine, so the phone used ChatGPT's own
remote control, which lists only `openai` chats and would send gateway model aliases to
OpenAI. What to expect depends on the Mac:

| Mac | Plan | Relay slot before | After this release |
| --- | --- | --- | --- |
| Studio, macbook-server | `sharedNativeExecutor: false` (set on 17 October) | `paused`: `failing` where a relay is registered, `not_registered` on macbook-server | Relay sessions retain private native engines until native sharing is explicitly adopted |
| A Mac with `sharedNativeExecutor: true` | Host shares native chats | `paused`, `failing` | The verified 0.163 host shares native work; clients detach without stopping its SDK |

A relay that the service starts again does not restart the host
(`resumePaused` in `src/service-supervisor.ts`), and the host and each adapter decide
once, at start, whether the registered relay owns remote control (the registration, not
the relay's live status, decides; see [Registering a relay under the unified
service](native-remote-setup.md#registering-a-relay-under-the-unified-service)). So the order is: the relay
connects first, then the service restarts while idle, then ChatGPT opens. An engine
that started before the relay was registered keeps its remote control until it exits; a
`409 Conflict` in the relay log means exactly that, and `gateway native install`
retires idle SSH listeners for that reason. Except for
quitting and reopening ChatGPT, which the user does normally, the steps below only read
state or use the gateway's own commands.

1. Before the install, check the app engine and the current state:

   ```sh
   /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
   codesign -dv --verbose=2 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex 2>&1 | grep TeamIdentifier
   gateway service status
   gateway native status
   ```

   Expect `codex-cli 0.163.0-alpha.10.2`, `TeamIdentifier=2DC432GLL2`, the native
   component `paused` with its reason, and `executionHost.sharedNativeExecutor`
   (`false` on Studio and macbook-server).
2. Install the release as usual. The installer never quits the app.
3. When no chat is running, quit ChatGPT normally with Command-Q.
4. Only where the slot was `not_registered` (macbook-server): run
   `gateway native install`. It retires idle SSH listeners and refuses while one is busy. A slot paused as `failing` needs nothing; the new relay
   binary is the change the five-minute check waits for.
5. Wait a few seconds (up to five minutes if the install was not the trigger) with ChatGPT still closed, then check
   `gateway native status`: `relay.status` `connected` with the original
   `environmentId`, and `gateway service status`: the native component `running` with
   no `pausedReason`.
6. Still with ChatGPT closed and no chat running, restart the service so the host and
   the adapters start beside the live relay:

   ```sh
   gateway service restart
   gateway versions --check
   gateway service status
   gateway health --json
   grep -h -E '"event":"(component_resumed|component_paused|native_sharing_unavailable|native_sharing_fallback)"' STATE/telemetry/events-$(date +%F).jsonl
   ```

   Expect every process on the new release, `executionHost.state` `running`, the
   relay still connected, and one `component_resumed`. On a Mac whose plan shares
   native chats, `native_sharing_unavailable` with `reason: sdk_version` is expected.
   `STATE` is the gateway state directory.
7. Open ChatGPT normally. Its adapter finds the live relay, so the app's engine runs
   with its own remote control turned off and `remoteControl/*` reaches the relay.
8. On the phone, open this Mac's Codex chats. The list comes from the gateway router;
   gateway chats saved under the legacy provider appear when the router adds that
   provider to an unfiltered list. Continue one gateway chat and one native chat. A
   native chat that is open in the Mac's app is refused with `already has an active
   writer` until the app lets it go.
9. In the relay log, expect `session_started` and `session_ended` records, an
   `rc_connected` SDK label, and no `session_rejected`.

Native sharing can be staged on the verified release with
`gateway service shared-native --on-restart`, preserving the active service
plan until a safe primary daemon start. Include `--with-gateway` explicitly on
an installation that also needs gateway sharing. See
[travel recovery](travel-recovery.md). Old adapters and uncertain writers defer
adoption instead of being stopped.

If the relay stays paused, `gateway service status` names the reason. `failing` after
the install means the relay still refuses the engine or cannot start; the relay log
names the cause, and ChatGPT keeps its own remote control meanwhile. To go back,
install the previous release: its relay refuses 0.163 and is set aside again, and the
registration written by `gateway native install` stays, so the newer release picks the
relay up again.

`gateway native uninstall` stops this managed transport and keeps its private
state. A fresh normal app launch restores the original remote transport. Explicit
uninstall cancels remote work. A changed running registration is refused until
the old service is stopped after active chats finish.

## Build and checks

The relay links the Apache-2.0 Codex SDK from the exact upstream commit documented
in `native-relay/NOTICE`. The build downloads a checksum-pinned archive into
gateway-owned build storage. On every build it rewrites the patched files from
pristine archive bytes: the outgoing-envelope, server-name and existing-enrollment
guards, and the small hooks for the behaviour above. Each patch anchor must occur
an exact number of times. The hook logic lives in `native-relay/sdk-overlay`,
which may only add files. The signed desktop bundle is unchanged. The installer
carries the SDK license, notice, and dependency inventory.

```sh
node scripts/build-native-relay.mjs --test --dev
node scripts/build-native-relay.mjs
node scripts/build-release.mjs --with-native
```

The sources, pristine copies and crate manifest are kept per pinned revision
(`sdk-<revision>`, `build-<revision>` and `sdk-<revision>.tar.gz` in
`.state/native-relay-build`). The gateway SDK build reads its own pinned archive
from `sdk.tar.gz` in the same folder, so building the relay never replaces it. The
relay repairs its own lockfile with `scripts/native-relay-sdk-lock.mjs`: the 0.163
archive keeps `0.0.0` for 160 source-less workspace packages, and only those are
set to `0.163.0-alpha.10.2`.

The end-to-end check runs the built relay against the real signed app engine and
mock upstreams only:

```sh
node scripts/e2e-native-relay.mjs --root /tmp/gwrl-$(date +%s)
```

A localhost mock plays the ChatGPT backend and the phone. It hands out the server
token, accepts the relay's websocket and sends remote-control envelopes. The state is a
Mac like Studio or macbook-server: a unified plan with `sharedNativeExecutor: false`
and a registered relay. The relay starts each stream's `gateway codex-shim` session,
and the router runs the real engine privately for a native chat and a gateway executor
for a gateway chat, both answering from the mock. The run checks that the relay:

- accepts the 0.163 and 0.162 CLIs and refuses others;
- refreshes the server token for the original registration and never enrolls;
- connects with the original server ID, name and installation ID;
- answers `remoteControl/status/read` itself and passes `model/list` and
  `thread/list` to the router;
- runs both chats, and continues the gateway chat with its history on a second stream;
- lets the Mac's own app adapter, opened after the relay connected, read remote control
  from the relay and run its own private engine on the same home, where the SDK refuses
  the phone a chat the app holds (`already has an active writer`) until the app lets it
  go;
- stops cleanly without writing a token or the installation ID to its log.

Every home is a fresh folder with fake ChatGPT tokens, and on macOS the run re-executes
itself in a sandbox that refuses connections off this machine. The real engines put
their sockets in the SDK's fixed folder `/tmp/codex-daemon-<uid>` and remove them when
they exit; at the end the run removes any of its own that outlived their engine (new
since it started, this user's, named like an SDK socket and not listening) and reports
the counts as `daemonSockets`. It records whether an unfiltered `thread/list` shows the
gateway chat; `--expect-unfiltered-gateway-listing` makes that a requirement once the
router adds the legacy provider.

`--shared-native-plan` writes a plan that shares native chats but runs no host, so
every adapter (the relay's sessions and the app's) falls back to a private engine
under the native-home lease, as on a Mac whose host cannot share the app's engine. That
mode passes only where private engines share the home (0.4.7 and later); on an
exclusive lease the app's adapter fails to start beside the relay's session.

`--test` runs the relay tests and then the patched SDK's `remote_control` suite
with its locked dependencies, in `.state/native-relay-build/sdk-target`. It
requires 0 failures and a named list of gateway and upstream tests. The upstream
tests enroll new mock machines, so only the SDK's own test build skips the
existing-enrollment guard; the relay binary keeps it.

Current checks cover partial-frame cancellation, truncation, size limits, remote
biometric restrictions, preservation of future response fields, single-write
records, the unknown pong after queued replies, its absence on tracker-side ends,
bounded stream ends under a full queue, shutdown ordering, sequence holes, and the
reset switch. The shared router's live model changes, steering, permissions, and
goal operations passed Claude and Codex 2 tests. Native rendered checks and daemon
restart during saved chat recovery must pass before declaring this transport ready.
