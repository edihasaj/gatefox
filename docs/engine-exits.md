---
summary: 'Why desktop-adapter engine exits and dropped engine frames are recorded, and what each event means.'
read_when:
  - Investigating "The Codex engine stopped while this turn was running" or an unexplained engine restart
  - Investigating "Shared executor host connection was lost" or a chat that keeps failing until its computer connection reconnects
  - Changing how the adapter reads native or gateway engine streams or when it stops an engine
---

# Engine exits and stream recovery

The adapter launched the engine, so a recoverable stream problem must never
kill it. Three stream faults are recorded and skipped instead of fatal, native
turn tracking cannot grow into a self-inflicted stop, and every engine process
exit is recorded once with its cause.

## Stream faults that keep the engine running

Frame recovery is provided by `AppServerConnection` (the spawned native engine
and each spawned gateway generation). Handler recovery also applies to
`SocketAppServerConnection`, which attaches to shared engines. The adapter's
client-facing input stream keeps its 16 MiB hard limit.

| Event | Fields | Meaning |
| --- | --- | --- |
| `engine_frame_dropped` | `engine`, `sizeMiB` | One JSON line exceeded the 64 MiB engine frame limit. Its bytes were discarded up to the next newline and reading continued. `sizeMiB` is the frame's size band: `"64"` (up to 128 MiB), `"128"` (up to 256 MiB), `"256"` (up to 512 MiB), or `"more"`. When the dropped line was the answer to a request the adapter had sent, that request fails at once instead of waiting for its 120-second timeout. |
| `engine_frame_invalid` | `engine` | One line was not valid JSON. It was skipped; the engine's replies for it (if any) time out like any lost response. |
| `engine_message_failed` | `engine`, `method`? | The handler for one engine message threw. The message was dropped, the exception was reported to the scrubbed error reporter as `engine_message`, and reading continued. This handler runs for notifications and for the engine's own server requests (an approval, for example); a server request that could not be passed on is answered with a fixed `-32603` failure so the engine stops waiting for it. `method` appears only when it is a plain slash-separated name of at most 64 characters. |

For a shared socket, `engine_message_failed` carries `transport: "socket"`
instead of `engine`, because the transport does not identify the engine's kind.
A callback failure preserves pending RPC requests, subsequent messages, and
other clients. If sending the fixed error itself fails, normal transport failure
handling still closes that client connection. Invalid JSON, oversized frames,
binary frames, and queue floods retain their existing connection limits.

Stdin `error` (EPIPE) and real stream errors stop the engine only when the
process is still running: the adapter waits 500 ms for the engine to finish
exiting, and an exit inside that window stays recorded as engine-initiated and
its remaining output is allowed to drain, because the engine was already on its
way out. A missing executable is stopped at once.

## Server callback bookkeeping

Answered server callbacks do not count toward the 256 unanswered-request limit.
Ordinary native callbacks, including attestations, do not necessarily produce a
`serverRequest/resolved` notification. Counting their completed replies as
pending could eventually block later tool and approval requests.

Each engine connection keeps bounded recent fingerprints and exact completed-ID
membership. Numeric IDs are compressed into adjacent ranges of actually seen
IDs; an unseen lower ID is not treated as completed just because a higher one
arrived first. A completed ID whose fingerprint aged out is refused rather than
exposed as a new tool call. Completed-history capacity also fails closed.
The bounds are 256 unanswered requests, 256 recent fingerprints per connection,
4096 disjoint completed numeric-ID ranges, and 1024 completed string IDs. IDs
from different engine connections never share a history. Delivery order is not
assumed to match numeric allocation order.

Threaded callbacks on shared sockets, including dynamic tool calls, retain
protected uncertainty records when their replies might have been lost. Ordinary
attestation traffic cannot evict those records. A matching warm replay keeps its
original desktop request ID; the adapter never automatically approves a request
or replays a tool result. Genuine resolution or terminal-turn cleanup releases
protected records. A full protected set refuses a new callback before exposing
it to the client instead of discarding an older uncertain request.
That protected set has a separate 256-entry limit across pending and
answered-but-unconfirmed threaded callbacks. The limits remain deliberate
fail-closed safeguards, not a promise to accept unbounded unresolved work.

## Native turn tracking

`src/native-turns.ts` tracks which native threads have a turn in progress.
Entries are released by `turn/completed`, by the engine's own `thread/closed`
notification, and by a `thread/status/changed` whose new tagged `status.type` is
`"idle"` or `"notLoaded"`. `systemError` is deliberately not a release: the SDK
reports it while the turn is still running, so releasing there would drop a live
turn on the floor. A status in no such shape changes nothing. Every release also
bumps the notification revision, so a `thread/read` or `thread/resume` that was
already in flight cannot re-add a thread the engine has closed. The 256-thread
cap now evicts the oldest entry instead of throwing, which used to kill a healthy
engine after leaked sub-agent threads filled the table:

| Event | Fields | Meaning |
| --- | --- | --- |
| `native_turns_evicted` | `count` | Entries the tracker dropped to stay under the cap. Emitted at most once per minute; `count` is how many were evicted since that report. Evictions counted inside that minute are reported when the minute closes, or when the engine exits, whichever comes first. |

## Engine exits

| Event | Fields | Meaning |
| --- | --- | --- |
| `engine_exit` | `engine`, `code`?, `signal`?, `uptimeMs`, `activeTurns`, `initiatedBy`, `reason` | One owned engine process ended, exactly once per process. `engine` is `"native"` or `"gateway"`. `activeTurns` counts the native threads or the gateway generation's loaded turns; for a native engine it is counted after that engine's last frames have drained, so a completion the engine wrote just before exiting is not mistaken for a live turn. |

- `initiatedBy: "engine"` — the process exited by itself (crash, clean
  shutdown, or death the app triggered). `reason` is `"none"`, and active
  native turns get the existing "The Codex engine stopped while this turn was
  running…" failure, as before.
- `initiatedBy: "adapter"` — we stopped it, and `reason` is one of
  `"session_end"` (adapter shutdown), `"idle"` (an adapter that stopped its
  engines because it was idle after an app install), `"replaced"` (an old
  gateway generation with no loaded chats making room for a new one),
  `"spawn_error"` (the process could not be started, or it never finished
  `initialize`), `"stdin_error"`, or `"stream_error"` (a broken pipe or stream
  on a process that stayed alive).

The event carries no stderr text, paths, thread ids or arguments — only the
fields above. Only a process the adapter spawned can say why it stopped: the
engines reached over a shared socket (shared native executor or shared gateway
executor) have no process the adapter watches, so they emit no `engine_exit` at
all and the reason they are given is ignored. Their loss is reported through the
socket paths documented in `docs/diagnostics.md`.

When an exit is unexpected (`initiatedBy: "engine"`), correlate `uptimeMs`
with the app's adapter restarts: the app restarts the adapter within about
half a second, which starts a new native process and a fresh `engine_exit`
series. `adapter_session_end` records whether the native engine was already
closed when the session ended.

## The shared host's control connection

A desktop adapter that shares native chats keeps one extra connection to the
executor host (`host.sock`) next to the engine socket. That connection is what the
host keys this adapter's native ownership and generation leases to, and the host
drops them when it closes it, so the session cannot go on even though the host
process and its engine are still running. The adapter records
`execution_host_control_lost` (only `sharedGateway`; no paths or chat ids) and ends
the session the way a native engine exit does, so the app reconnects within about
half a second and the new session discovers the host and acquires a fresh
connection. Turns already running in the host-owned engine are not reported failed
by this, for the same reason a lost engine socket does not prove SDK death; they are
failed only when the host confirms that exact launch died. A connection the adapter
closed itself, because it was stopping, records nothing.

That exit path waits twice on the desktop app, and a lost host connection bounds both
waits to 250 ms. It first lets the frames the engine already sent reach the app; if
the app has stopped reading, a forwarded notification parks there and the session
never ends. Then, when the host confirms that this exact launch died, the exit reports
each live turn with an `error` and a failed `turn/completed` — either frame can park
the same way, so each is raced against the bound, and once the bound has fired the
loop stops rather than blocking on the next turn's pair. Every frame is still handed
to the writer before it is awaited, so a bound that had already fired cannot swallow
the report of a confirmed death: the notice goes out whenever the app reads again, and
the reconnecting app finds those chats through their saved history either way.

The bound is a promise of its own rather than the one a deliberate stop resolves,
because that one also ends the `native/death` check: cutting the confirmation short
would lose a genuine death on an exit that has nothing to do with this connection. It
arms whether or not this adapter had to close the engine socket itself, so it also
bounds an exit whose socket died first.
