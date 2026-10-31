---
summary: 'Native connected-machine adapter using the existing Codex Desktop registration.'
read_when:
  - Changing Control other devices transport or native relay installation
  - Testing models through existing connected machines
  - Investigating remote stalls, sequence gaps, or native relay logs
---

# Native connected machines

The native relay sits in front of the gateway's app-server router. It uses the
same environment ID, installation ID, server name, account, and client-name scope
as the machine's existing Codex Desktop registration. It does not create another
machine or require an SSH entry in the desktop UI.

This adapter is in preflight testing. MacBook Pro 2's original registration is
online through the installed relay, and real desktop requests reach its router.
Registration checks also passed on Studio and the primary Mac. The separate
transport prototype was stopped and its temporary environment deleted.
The original connection still needs its rendered model and chat checks. Do not
remove a working connection until those checks pass.

The SDK reads host authentication from the native account through its normal auth
manager. Authentication is never copied into the relay home. Inference still uses
the gateway's separately registered providers. Only the original registration's
metadata is read from the primary SQLite database, through a read-only connection.
The relay keeps its own database and preferences in a private home. Native config,
transcripts, and SQLite files are not migrated or rewritten by registration.

The relay refuses a missing, disabled, or differently owned registration. Its SDK
build blocks creating replacement enrollments.

## Verified app engines

The relay remains linked to the Codex SDK released as rust-v0.163.0-alpha.10.2.
The accepted engines retain the remote-control wire contract, so the relay can
keep that linked SDK. Earlier accepted 0.162/0.163 engines have byte-identical
`app-server-transport` source. The relay and the shared native host keep
separate lists in `src/native-engine-versions.ts`:

| App engine | Relay (`relayAcceptedAppEngines`) | Shared native host (`hostVerifiedAppEngines`) |
| --- | --- | --- |
| `codex-cli 0.166.0-alpha.5.1` | Requires the rebuilt relay; remote-control wire contract unchanged from 0.165 | Verified with the signed engine through the stdio and Unix shared-native fixtures (31 Oct 2026) |
| `codex-cli 0.165.0-alpha.1.2` | Requires the rebuilt relay and the unchanged remote-control wire contract | Verified with the signed engine through the stdio and Unix shared-native fixtures |
| `codex-cli 0.164.0-alpha.11.1` | Runs with the linked transport after separate wire-contract review and relay tests | Shared after the signed SDK passed stdio and Unix reconnect, steering, Stop, once-only command and pending-approval checks |
| `codex-cli 0.163.0-alpha.11.2` | Runs with the linked 0.163.0-alpha.10.2 transport | Shared after the signed M5 SDK passed both stdio and Unix native/gateway disconnect, reconnect, steering, Stop, once-only command, and pending-approval checks |
| `codex-cli 0.163.0-alpha.11.1` | Runs with the linked 0.163.0-alpha.10.2 transport | Shared after the signed SDK passed the native disconnect, reconnect, steering, Stop, command, and approval checks |
| `codex-cli 0.163.0-alpha.11` | Runs with the linked 0.163.0-alpha.10.2 transport | Shared after the signed SDK passed the same checks |
| `codex-cli 0.163.0-alpha.10.2` | Runs; this is the SDK it links | Shared after the signed SDK passed the native disconnect, reconnect, steering, Stop, and approval checks |
| `codex-cli 0.162.0-alpha.17.2` | Runs, so a Mac whose app has not updated keeps its relay | Shares the engine |
| Anything else | Exits with status 1 before it connects | Not shared; a combined host serves gateway chats only and logs `native_sharing_unavailable` with `reason: sdk_version` |

See [desktop update compatibility](desktop-update-compatibility.md) for startup
diagnostic passthrough, app-bundle replacement isolation and the 0.164 review.

The 0.163.0-alpha.11.2, 0.163.0-alpha.11.1, 0.163.0-alpha.11, 0.163.0-alpha.10.2, and 0.162.0-alpha.17.2
releases ship a byte-identical `app-server-transport` crate, so the
remote-control protocol, the patched stream-end hooks, the existing-registration
guard and the `remoteControl/*` methods are the same for these app engines. The 0.163 state
database adds two migrations, and the SDK opens a database that a newer release
migrated, so a rollback to a 0.162 relay still opens the relay home.

The 11.2 comparison covered all 36 `app-server-transport` files, which matched
11.1 and the linked 10.2 source byte for byte. Its signature and reported version
were checked on the M5 before the isolated shared-native fixture ran. The fixture
used no copied authentication or paid inference and left no owned SDK process
behind. This compatibility admission requires a newly built relay; changing the
TypeScript list alone cannot update an older installed relay binary.

Shared-engine verification covers more than the protocol. In 0.163,
pending unloads became a map with a wake-up
signal, listener removal now checks the thread's generation, finished v2 sub-agent
threads unload automatically, and startup configuration resolves against the
working directory. The 0.163 fixture also verifies every frontend disappearing
during inference or a pending approval, followed by recovery of the same SDK
process, turn, history, and original approval request. An engine joins
`hostVerifiedAppEngines` only after
`scripts/e2e-shared-native.mjs` passes against it. The relay needs none of that,
because it never uses the host's engine (see the next section).

The relay's own list is `native-relay/src/cli_version.rs`; a gateway test fails when
it differs from `relayAcceptedAppEngines`. The relay compares the text that the app
CLI prints for `--version`; it does not check the code signature itself. Its `--codex`
path is the app's own launcher, taken from the service plan or the registration, and a
host that shares an engine verifies OpenAI's signature (TeamIdentifier `2DC432GLL2`)
before it runs it. Gateway chats are a separate pin: they run the release's own
gateway SDK (0.162.0-alpha.17.2), whatever engine the app ships. A relay that refuses
the app's engine exits at once, and after three such exits the service sets it aside
with `component_paused` and reason `failing` instead of restarting it in a loop. A new
app engine needs a new relay build and this verification again.

## Relay sessions and native chats

Each phone stream starts its own `gateway codex-shim` session, so the model list, the
chat list and the routing the phone sees are the gateway router's. The relay answers
only `remoteControl/*` itself; `thread/list`, `model/list` and turns go to the router.

Native chats run where any adapter runs them. When the host shares the native engine,
the session attaches to it. Otherwise the session's adapter runs a private native engine
on the native home: always on a plan with `sharedNativeExecutor: false`, and as a
fallback when the host cannot share the app's engine. From 0.4.7, private engines share
the native home with each other, so the app's adapter and the relay's sessions each run
one. The ChatGPT app opened after the relay connected leaves remote control to the relay.

One chat still has one writer. The SDK keeps a per-chat writer lock in
`<native home>/thread-writer-locks`: while the app's engine holds a native chat, the
phone's `thread/resume` is refused with `already has an active writer`, and once the
app lets the chat go (it closes the chat's engine, for example by quitting), the phone
continues it. Gateway chats use the host when the plan shares gateway executors, and
otherwise private gateway engines under the same lock.

## Project trust on mobile

A project appearing in the picker does not prove that its original folder has a
saved trust decision. This affects both new chats and existing chats. A trusted
child repository does not trust its parent folder, and a `projects."/"` entry is
not a wildcard. Mobile can refuse the turn before `turn/start`, with
"Can't verify project trust". Check the native engine's `config/read` response
with the selected `cwd` and `includeLayers: true`; use the native user layer,
not a gateway executor's private configuration snapshot.

An operator who wants all selected folders trusted can explicitly set
`"trustAllProjects": true` in that machine's gateway configuration. This is off
by default and applies when an adapter process loads that configuration. Existing
listeners keep their loaded choice until they retire normally. The
adapter saves real, version-guarded native trust entries for registered project
roots and requested working directories. New project creation and chat
start/resume/fork also establish trust before the result reaches the client or
the chat loads. Gateway executors receive the same policy in their own private
configuration, so an older snapshot does not lose the choice.
Existing aliases are resolved and both spellings are trusted, so a canonical
untrusted entry cannot defeat the selected folder's trust. Starts without a
working directory use the engine's reported default before loading settings.
A shared host from an older release that cannot report its default requires an
explicit folder for such a start until that host upgrades normally.

This policy accepts every selected folder, including a folder previously marked
untrusted. Repository instructions, project configuration and enabled hooks may
therefore load automatically. Command approval and sandbox settings remain the
caller's choices. The adapter returns the engine's actual configuration and layer
provenance; a managed override or failed write remains a failure. It does not
manufacture a trusted response or start a separate maintenance job.

Clearing the flag stops automatic trust after the adapter processes reload. Trust decisions
already saved remain in Codex's user configuration until the operator changes
them. A gateway release that predates this option must first adopt a release
that implements it; editing configuration alone cannot add the behavior.

Run `node scripts/e2e-project-trust.mjs --root /tmp/TASK/project-trust` to verify
the policy through the signed native engine and both adapter execution paths.
The fixture uses private homes, a local model catalog and one localhost mock
turn, with no external provider inference.

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
service](#registering-a-relay-under-the-unified-service)). So the order is: the relay
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

## Session diagnostics

The relay records timestamped, fixed lifecycle causes in its existing private
managed stderr log. Records cover session start/end, queue saturation, auth scope
changes, frame failures, child exit, and task panic. Real queued SDK lifecycle
events may include canonical thread and turn IDs. Queue acceptance does not prove
that the frontend received or rendered an event.

Child stderr is drained with bounded buffers. Only aggregate byte/chunk counts
and whether draining finished are recorded; raw errors, prompt text, tool
arguments, credentials, environment values, paths, and labels are excluded.
Thirty-second activity records distinguish quiet active work from an ended
session. Reconnect cleanup checks task identity before cancelling a connection;
an older task cannot cancel its replacement. Separate limits bound active and
retiring sessions. Fair event selection keeps Stop and steering requests from
being starved by continuous child output.

The adapter reports a genuine unfinished native executor exit as an error and
failed turn before shutting its client down. Buffered SDK completion events are
drained first, and intentional shutdown does not manufacture a failure. The error
says the Codex engine stopped (the app may have restarted it), that the chat's history
is saved, and that sending a message continues it; a chat on a connected machine
reconnects that computer if it stays unavailable. The same text serves local chats,
whose engine the app restarts by itself, for example on "Authenticated workspace
changed". A relay
disconnect alone does not establish whether shared work stopped, so the relay
does not manufacture a completed or failed task from that observation.

## Stream ends

Each remote client stream maps to one relay session. When the relay side ends a
stream, the patched SDK tells the client right away: it forwards the replies
already queued for that stream, then sends `Pong { status: unknown }` for it. The
client closes the stream with "became unknown", fails its own pending requests,
and reconnects after about one second. Before this change the SDK forgot the
stream silently, and the client lost every request it sent until its next
30-second ping.

| Stream ended by | Unknown pong |
| --- | --- |
| Shim child exit, session rejection, queue failure, relay shutdown, inbound-gap reset | Yes, after the queued replies |
| Client close, idle sweep (10 minutes), re-initialize of the same stream, SDK shutdown | No |

The tracker marks a stream before it ends it itself, so only relay-side ends send
the pong. Every step is bounded by one 750 ms budget: forwarding the queued
replies, queueing the pong, and waiting for the websocket writer to confirm it.
Replies or a pong that miss the budget are dropped and counted, so a full queue or
a stalled writer cannot keep a stream open. A re-initialized stream with the same
client and stream ID is no longer closed when its predecessor's task finishes, and
the old stream's chunk state is cleared when the new `initialize` arrives, so a
restarted sequence cannot be mistaken for duplicates.

On shutdown the relay first ends every session, which sends the unknown pongs,
then reads transport events for up to one second until each stream reports
`ConnectionClosed`. The SDK emits that event only after the pong was written or
its budget ran out. Streams that open during that second are refused the same
way, and their requests are counted. Only then does the relay stop the SDK.

The pong only shortens detection. A relay restart still ends every stream, and an
`initialize` sent while no relay is running waits for the next relay. Children
that keep failing at startup now cause client reconnects paced by the client's
backoff (one to twenty seconds) instead of its 30-second ping; compare
`streamEndNotified` with `session_rejected` records when that happens.

## Transport counters

`session_activity` (every 30 seconds per session) and `session_ended` records
carry a `transport` object. A `transport_activity` record with the same object is
written every 30 seconds whenever it changed, including when no session is open.
Values are totals since the relay started.

| Key | Counts |
| --- | --- |
| `inboundSeqDedupeDrops` | Client messages the SDK dropped because their sequence number was at or below the last delivered one |
| `inboundLateFillDeduped` | Of those, messages that filled a known hole: they arrived late and out of order |
| `inboundChunkDedupeDrops` | Chunks of an already completed chunked message |
| `unknownStreamDrops` | Client messages for a stream the SDK did not know (only `initialize` opens one) |
| `unknownStreamPings` | Pings for an unknown stream, answered with an unknown pong |
| `streamEndNotified` | Relay-side stream ends that ran the unknown-pong path |
| `streamEndPongQueued`, `streamEndPongWritten`, `streamEndPongUnconfirmed`, `streamEndPongDropped` | What happened to those pongs within the budget |
| `streamEndDrained`, `streamEndDrainDropped` | Queued replies forwarded or dropped before the pong |
| `pingsWithSeq`, `pingsWithoutSeq`, `messagesWithoutSeq` | Client envelopes on tracked streams with or without a sequence number |
| `holesOpened`, `missingSeqs`, `holesFilled` | Sequence gaps seen, the sequence numbers they span, and gaps filled later |
| `holesStale`, `holesFilledAfterStale`, `holesUnresolvedAtClose`, `holeOverflows` | Gaps older than 15 seconds, gaps filled after that, gaps still open when the stream closed, and gaps not tracked past 64 per stream |
| `inboundGapResets`, `inboundGapResetsSuppressed` | Streams ended by reset mode, and resets skipped by the ten-minute limit |
| `outboundUnacked`, `outboundUnackedMax` | Envelopes waiting for a backend acknowledgement now and at most; the SDK writer stops at 128 |
| `noSessionDrops` | Client messages for a connection with no relay session |
| `shutdownRefusedStreams` | Streams refused while the relay was shutting down |
| `inboundGapResetMode` | Whether the reset switch file exists |

## Lost-request detection

Some client requests never reach the host. The detector shows where they go
missing without changing what the SDK delivers. For each stream with an explicit
stream ID, it records every client sequence number the host sees: messages,
completed chunked messages, pings, and client closes. Acknowledgements carry
server sequence numbers and are ignored. A gap below the highest number seen is a
hole; it exists only because a later envelope arrived.

A hole is stale when it stays unfilled for 15 seconds and no chunk of that stream
arrived in the last 15 seconds. The check runs on every envelope and on the SDK's
30-second sweep. Each stale hole is logged once. A loss is detected only after a
later envelope arrives, so the worst case is about 15 seconds plus a 30-second
ping plus the 30-second sweep. A message the client never numbered, or that never
reached the host, cannot be seen.

The detector rests on one unverified assumption: that the backend forwards ping
sequence numbers. The first ping on each stream logs `ping_seq_presence`. If
`pingsWithoutSeq` grows, or pings with sequence numbers leave holes on healthy
streams, the detector would misreport, and reset mode must stay off.

## Reset switch

Reset mode is off by default. While the file `inbound-gap-reset` exists in the
relay home, a stale hole ends its stream through the unknown-pong path, so the
client fails the stuck requests and reconnects. The file is checked when a hole
turns stale, so no restart is needed:

```sh
touch RELAY_HOME/inbound-gap-reset   # enable
trash RELAY_HOME/inbound-gap-reset   # disable
```

The relay home is the `relayHome` that `gateway native install` reports; it also
holds `status.json`. Only a regular file enables the switch. Each stream is reset
at most once in ten minutes. A reset fails every pending request on that stream,
including a `turn/start` whose turn may already be running in the shared
executor, so a user retry can duplicate that turn. No JSON-RPC result or turn
event is ever invented.

Enable it only after log-only data shows `pingsWithoutSeq` at 0 and almost no
stale holes on healthy streams, including across host reconnects.

## Reading the logs

The relay writes one JSON record per line, prefixed with `gateway: `, to its
managed log. Each record is written with a single write, so records no longer
splice, and a daemon no longer prints `remote-client-connected` to the same file.

Records with `"scope":"native_relay"` are the relay's own: session lifecycle,
`session_activity`, `session_ended`, and `transport_activity`. Records with
`"scope":"native_relay_sdk"` and `"event":"sdk_log"` come from the SDK transport.
They carry a fixed `label`, the `level`, and only allowlisted fields. SDK message
text is never printed; a warning without a known label appears as `unlisted` with
its source file and line. Each label prints at most 20 lines a minute, and the
next line reports the rest as `suppressed`.

| Label | Meaning |
| --- | --- |
| `rc_connecting`, `rc_connected`, `rc_cycle_ended`, `rc_status_changed` | Host websocket lifecycle; `connectionEndReason` and `reconnectAttempt` explain reconnects |
| `rc_connect_failed` | A connect attempt failed. The SDK's error text is never printed: `errorClass` names its kind (`ws_auth`, `ws_http`, `ws_tls`, `ws_io`, `ws_dns`, `ws_protocol`, `refresh_http`, `refresh_transport`, `refresh_parse`, `refresh_mismatch`, `auth_recovery` or `unclassified`) and `httpStatus` the 3-digit status for `ws_auth`, `ws_http` and `refresh_http`. `ws_http` with `httpStatus` 409 means another engine holds this Mac's remote-control connection |
| `rc_writer_disconnected`, `rc_reader_disconnected` | The host websocket dropped; `errorKind` is `TimedOut` (no websocket pong for 60 seconds), `UnexpectedEof` (stream ended), `ConnectionAborted` (close frame), or `InvalidData` (read error) |
| `stream_end_notified` | A relay-side stream end: `reason`, replies `drained` and `drainDropped`, and the `pong` outcome |
| `inbound_hole_stale` | A stale hole: first missing number, size, age, highest number seen, ping counts, reset mode, and the action taken |
| `inbound_hole_filled_late` | A stale hole was filled later, after `waitedMs` |
| `inbound_late_fill_deduped`, `inbound_seq_dedupe_drop` | The SDK dropped a message at or below its delivered mark; the first means it filled a hole |
| `unknown_stream_drop`, `inbound_gap_reset`, `ping_seq_presence` | Unknown-stream drops, resets (or suppressed resets), and whether a stream's pings carry numbers |

Late fills and deduped late fills mean the backend reordered envelopes; stale
holes that are never filled mean the envelopes were lost before the host. An
`outboundUnacked` near 128 means the backend stopped acknowledging and the SDK
writer is gated for every stream. The backend may never acknowledge a pong sent
to a stream the client already closed; if `outboundUnackedMax` keeps rising after
unknown pongs, that is the cause.

Client and stream IDs appear only as 12-character hashes with a per-process salt.
The same ID has the same hash in every record of one relay process (`client` and
`stream` in gateway labels, `clientId` and `streamId` in SDK labels), and a new
hash after a restart. Counters, labels, numbers, durations, and fixed reasons are
the only other content: no tokens, bodies, arguments, URLs, paths, or account,
server, or environment identifiers.

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
