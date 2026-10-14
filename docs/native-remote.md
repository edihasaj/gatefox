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
build blocks creating replacement enrollments. It verifies the signed CLI matches
Codex 0.162.0-alpha.17.2 before using that version's transport. Another desktop
build requires an SDK update and verification.

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
drained first, and intentional shutdown does not manufacture a failure. A relay
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
client and stream ID is no longer closed when its predecessor's task finishes.

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
