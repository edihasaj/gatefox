---
summary: 'Why desktop-adapter engine exits and dropped engine frames are recorded, and what each event means.'
read_when:
  - Investigating "The Codex engine stopped while this turn was running" or an unexplained engine restart
  - Changing how the adapter reads native or gateway engine streams or when it stops an engine
---

# Engine exits and stream recovery

The adapter launched the engine, so a recoverable stream problem must never
kill it. Three stream faults are recorded and skipped instead of fatal, native
turn tracking cannot grow into a self-inflicted stop, and every engine process
exit is recorded once with its cause.

## Stream faults that keep the engine running

Raised by `AppServerConnection` (the spawned native engine and each spawned
gateway generation). They never apply to the adapter's client-facing input
stream, which keeps its 16 MiB hard limit.

| Event | Fields | Meaning |
| --- | --- | --- |
| `engine_frame_dropped` | `engine`, `sizeMiB` | One JSON line exceeded the 64 MiB engine frame limit. Its bytes were discarded up to the next newline and reading continued. `sizeMiB` is the frame's size band: `"64"` (up to 128 MiB), `"128"` (up to 256 MiB), `"256"` (up to 512 MiB), or `"more"`. |
| `engine_frame_invalid` | `engine` | One line was not valid JSON. It was skipped; the engine's replies for it (if any) time out like any lost response. |
| `engine_message_failed` | `engine`, `method`? | A notification handler threw (for example a forwarding deadlock). The message was dropped, the exception was reported to the scrubbed error reporter as `engine_message`, and reading continued. `method` appears only when it is a plain slash-separated name of at most 64 characters. |

Stdin `error` (EPIPE), real stream errors, and a missing executable still stop
the engine: the process or pipe is genuinely gone.

## Native turn tracking

`src/native-turns.ts` tracks which native threads have a turn in progress.
Entries are released by `turn/completed`, by the engine's own `thread/closed`
notification, and by a `thread/status/changed` whose new tagged `status.type` is anything
other than `"active"` (`idle`, `notLoaded`, `systemError`, …); payloads in no
such shape change nothing. The 256-thread cap now evicts the oldest entry
instead of throwing, which used to kill a healthy engine after leaked
sub-agent threads filled the table:

| Event | Fields | Meaning |
| --- | --- | --- |
| `native_turns_evicted` | `count` | Entries the tracker dropped to stay under the cap. Emitted at most once per minute; `count` is how many were evicted since that report. |

## Engine exits

| Event | Fields | Meaning |
| --- | --- | --- |
| `engine_exit` | `engine`, `code`?, `signal`?, `uptimeMs`, `activeTurns`, `initiatedBy`, `reason` | One owned engine process ended, exactly once per process. `engine` is `"native"` or `"gateway"`. `activeTurns` counts turns tracked at exit (native threads, or the gateway generation's loaded turns). |

- `initiatedBy: "engine"` — the process exited by itself (crash, clean
  shutdown, or death the app triggered). `reason` is `"none"`, and active
  native turns get the existing "The Codex engine stopped while this turn was
  running…" failure, as before.
- `initiatedBy: "adapter"` — we stopped it, and `reason` is one of
  `"session_end"` (adapter shutdown), `"idle"` (retiring a shared executor
  with no loaded chats), `"replaced"` (an old generation or a failed
  initialize making room for a new one), `"stdin_error"`, `"stream_error"`, or
  `"spawn_error"`.

The event carries no stderr text, paths, thread ids or arguments — only the
fields above. Host-owned engines reached over a shared socket (shared native
executor or shared gateway executor) have no process the adapter watches, so
they emit no `engine_exit`; their loss is reported through the socket paths
documented in `docs/diagnostics.md`.

When an exit is unexpected (`initiatedBy: "engine"`), correlate `uptimeMs`
with the app's adapter restarts: the app restarts the adapter within about
half a second, which starts a new native process and a fresh `engine_exit`
series. `adapter_session_end` records whether the native engine was already
closed when the session ended.
