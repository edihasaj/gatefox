---
summary: 'Live Copilot CLI sessions per Codex thread (the default): why they exist, how requests continue, reseed or fall back, and what stays on disk.'
read_when:
  - Changing the Copilot provider, its live sessions or its cleanup
  - Turning copilotSessions on or off, or investigating Copilot credit spend
---

# Live Copilot sessions

The gateway keeps one `copilot --headless` process and one session per Codex thread, the
way the Copilot CLI runs on its own. The session holds the native history, the caller's
tool calls wait inside it as pending external tool requests, and each gateway request
sends only what is new. This is the default (`copilotSessions.mode: "live"`).

Why: a new session on every request (`"oneshot"`) reads only the fixed system message and
tool list from Copilot's prompt cache and writes the rest of the history to the cache
again. In a three-round tool loop on `gpt-6-luna` with a 3.7k-token prompt, rounds 2 and 3
each read 1.6k tokens from the cache, wrote 2.2k to 2.3k and cost about 30 million
nano-AIU. In one session, every follow-up call reads the whole earlier prompt from the
cache and writes only the new tail. With a 12k-token prompt, the first call wrote 12k
tokens and cost 151 million nano-AIU, and each follow-up call cost about 13 million. In
the live check on CLI 1.0.97, gateway rounds 2 and 3 of the 3.7k-token loop read 98% of
their input from the cache, wrote under 60 tokens and cost 4.8 to 6.0 million nano-AIU.
Observed gateway traffic before live sessions cost about 9.5 times what the same work
costs natively.

```json
{ "id": "copilot", "type": "copilot-subscription", "copilotSessions": { "mode": "live", "max": 4, "parkMinutes": 30, "toolWaitMinutes": 25 } }
```

Every field is optional, and a provider with no `copilotSessions` at all runs live with
the defaults below. The daemon reads a change on its next request. `"oneshot"` (or
`"replay"`, accepted as another name) turns live sessions off: running turns finish, and
the provider's parked sessions close on its next request, or at once when the daemon
reloads the configuration (`mode_oneshot`). A reload also closes the sessions of a Copilot
provider that was removed or whose `id` or `authDirectory` changed (`provider_removed`):
no request would ever reach it again, and the session folders hold the conversation log.
A session whose turn is running closes when the turn ends. One-shot is also what a
request falls back to whenever a live session cannot serve it.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `live` | `live` keeps a session per thread; `oneshot` or `replay` starts a session per request |
| `max` | 4 | Live sessions in the whole process (1–16). A session being started counts toward it |
| `parkMinutes` | 30 | Idle time before a session closes (5–240). Copilot's prompt cache lasted 30 minutes for `gpt-6-luna` and 5 minutes for `claude-haiku-5.5` in the measurements; a session parked longer still continues, at about the price of a reseed, and keeps its native history |
| `toolWaitMinutes` | 25 | How long a session waits for Codex to run a tool before it closes (1–25) |

## What a session is made of

One-shot requests and live sessions are built the same way, so a fallback never changes
what the model sees.

- **System message:** the gateway's guidance, the tool-name mapping, and the caller's
  leading system and developer messages. It is fixed for the session's life.
- **History:** one user message per conversation item, oldest first, each between
  `<<item N role>>` and `<</item>>` lines. A seed sends all items with
  `session.sendMessages`; a continuation sends only the new ones.
- **Images:** a history item's images are written (mode 0600) to the `images` folder of
  the CLI's private folder and attached to the item's message as `file` attachments; the
  message text names each one. Their bytes never travel inside a message, because one
  RPC message to the CLI is limited to 16 MiB and a few screenshots pass that. The files
  go with the folder. A tool output's images can only travel inline, as binary results
  of the waiting call, so a tool result whose JSON exceeds 12 MiB is not handed over: the
  thread reseeds (`large_tool_result`), and the seed sends those images as files.
- **Tools:** the caller's whole catalog, always, whatever the tool choice. Each tool is an
  external tool the caller answers, named `tool_<name>_<hash>` after its identity, so
  reordering the catalog changes nothing. The list is sorted. `skipPermission` is on,
  every tool is `defer: "never"`, and `toolSearch` and `largeOutput` are off: the CLI
  never hides a caller tool behind its own tool search, never saves a large result to a
  file, and never runs a tool itself.
- **Tool choice:** a forced or required choice, or `none`, is a line on the last message
  (`Use the required caller tool …`, `Use one of the caller tools.`, `Do not call any
  caller tool; answer directly.`). A model that ignores it fails the request.

## How a request is served

- **Spawn:** the thread has no session. A new process starts and the history is sent once.
  Telemetry reports `spawned`.
- **Continue:** the request carries the history the session already has plus new items.
  New user items are sent as user messages. Tool outputs are handed to the session's
  pending external tool requests with `session.tools.handlePendingToolCall`, each to the
  request of the call it answers, whatever order the outputs arrive in, at most 16 at a
  time (the CLI connection takes 32 requests in flight). An empty output is handed over
  as `(no output)`, so the waiting call is still answered. The prefix is read
  from the cache, the follow-up model calls are agent-initiated, and the request is billed
  for its own model calls only. An effort change between turns keeps the session: the
  gateway calls `session.model.switchTo`, which keeps the cache.
- **Reseed** (a new process, one cache write, which a one-shot request pays on every
  call). A session that was waiting for tools is aborted first, and the old process and
  its folder are gone before the new process starts: the request waits for that, at most
  2 seconds for the abort and then the SIGKILL. The telemetry `missReason` is one of:
  `fingerprint_changed` (model, summary mode, system message, tools, or whether a reasoning
  effort is set), `window_changed` (the context window changed), `prefix_diverged` (an
  earlier message was edited), `unexpected_tail` (for example a new message together with
  tool outputs, which is what Stop followed by a new message sends), `forced_choice`
  (tool outputs arrived with a forced, required or `none` choice, which a tool result
  cannot carry), `large_tool_result` (a tool result with images is too large to hand over
  inline), `effort_midturn` (an effort change while tools were pending),
  `effort_rejected` (the CLI refused an in-place effort change),
  `tool_request_missing` (the session had no pending request for a call whose output
  arrived), and, when the thread's previous session had ended or ended while the request
  was being placed, `session_dead` (it crashed or was killed for a violation), `evicted`,
  `reaped`, `interrupted`, `tool_wait_expired` or `idle_missing`.
- **One-shot fallback** (the request is answered with its own session and no live session
  starts or changes): `no_thread` (no thread id), `request_kind` (compaction, prewarm and
  memory requests), `concurrent` (a second request for a thread whose first still runs or
  is still being placed), `capacity` (every slot is held by a running session, a session
  whose own request is being placed, or a session still starting), `spawn_failed` or
  `initialize_timeout` (the process or its handshake did not come up in time, or the
  session misbehaved while starting), `delivery_rejected` (the session did not confirm a
  tool result: it refused it, answered with an error, did not answer within 15 seconds,
  or had no pending request for the call; the session is then closed), `stream_failed`
  (the session died before its first event), and `attach_failed`
  (an unexpected error while placing the request; one that is not a provider error is
  also reported as an exception).
  Images and forced choices are served live.

## Admission

While every slot holds a session, a new thread first waits for a session that is already
closing, then takes the slot of the least recently used session that finished its turn,
then of the least recently used one that waits for tool outputs. A running session is
never evicted, and neither is one whose own request is being placed. When no slot can be
freed, because every slot is held by a running session, a session whose own request is
being placed, or a session still starting (another thread's attach that has no session
yet), the newcomer is served one-shot (`capacity`). An evicted session's process and
folder are gone before its replacement starts, and the evicted thread reseeds on its next
request (`evicted`), even one that arrives while the old session is still ending: the
evicted session keeps its slot until it is gone, and that request waits for it. Sessions being started count toward `max`, in arrival order, so
concurrent starts never hold more sessions than the cap. A session that is still closing
when its thread's next request comes no longer holds the thread or a slot; the request
waits until it is gone and starts a new session, reporting how the old one ended (for
example `tool_wait_expired`).

## Waiting for tools

Copilot fails a pending external tool request 1,800 seconds after it was issued, and the
runtime then makes a model call of its own, which is billed. The gateway closes a session
that is waiting for tool outputs after `toolWaitMinutes` (25 at most), before that
happens: `session.abort`, then SIGKILL. The next request reseeds (`tool_wait_expired`).

Between requests the gateway accepts only housekeeping: the pending calls' own
`tool.execution_start` and `external_tool.requested` events, `session.info`,
`session.usage_info`, `session.usage_checkpoint`, `session.idle` (CLI 1.0.97 sends it
right after `assistant.idle`), and `model.*` events other than `model.call_start`. It also
accepts the CLI's start-up announcements `session.start` and
`session.managed_settings_resolved` until the session's first request, and a
`session.model_change` that confirms the effort change the gateway asked for (the CLI
sends it before it answers `session.model.switchTo`). Anything else kills the session at
once, before it can spend: a `tool.execution_complete` or `external_tool.completed` for a
call nobody answered (the timeout, or a failed call), a model call, any assistant output
or usage, compaction, truncation or an error, a model change nobody asked for, a
permission request, a sub-agent event, or a tool request for a call that is not pending.
A session that misbehaves while it is starting is never handed to a request; the request
is served one-shot (`spawn_failed`). A timer cannot be trusted alone, because a sleeping
Mac stops it while the CLI's clock goes on.

## Stopping a session

Cancelling a request, a reseed, an eviction, a tool-wait expiry and any violation end the
session the same way: `session.abort` (bounded to 2 seconds, errors ignored), then SIGKILL
of the CLI's whole process group, which is its own group, and the removal of its folder.
A parked session that is not running anything needs no abort and is killed the same way.
A one-shot request is closed the same way when its CLI holds an unanswered tool request,
that is, when the turn ended in tool calls or was cancelled after the CLI announced one;
only a one-shot turn that ended in text is deleted (`session.delete`) and stopped with SIGTERM.
A cancelled request ends at once and its session is killed in the background; a reseed or
an eviction waits for the old session to be gone. Closing a session under a running
request fails that request at once, or, before its first event, hands it to the one-shot
path (`stream_failed`). The next request after a cancellation reseeds,
because the half-written answer cannot be matched against what Codex replays. A request
that has already finished is not affected when the client closes the connection
afterwards.

A complete answer whose `assistant.idle` event does not follow within 5 seconds still
ends the request normally; the session then closes (`idle_missing`).

## Safety

- The CLI sees only the gateway's tools. A permission request, a tool start or request for
  any other name, a sub-agent event, BYOK usage, another model or output with no request
  attached kills the session and fails the request. The gateway still answers no host
  request, and the CLI is spawned with `--disable-builtin-mcps`, `--no-custom-instructions`,
  `--no-remote` and the session store off.
- The session store stays off, so no session rows or session folders are added to
  `~/.copilot`, and the CLI's configuration folder is private. The CLI does write a log of
  the conversation, including prompts and tool results, to `session-state/<id>/events.jsonl`
  in that folder. In one-shot mode it lives for seconds; in live mode it lives as long as
  the session. The folder is
  `$TMPDIR/harness-gateway-copilot-<uid>/gateway-copilot-live-<owner pid>-<owner start>-<random>`
  (one-shot: `gateway-copilot-run-…`), with the gateway's pid and start time in base 36
  (the start time is left out when `ps` cannot read it), mode 0700. The parent
  `harness-gateway-copilot-<uid>` is the gateway's own folder in the OS temp folder, mode
  0700 and owned by you; a symlink or another user's folder in its place is refused.
  The folder holds the CLI's own `TMPDIR` and the history's images, for every CLI the gateway
  starts. It is removed when the session closes, parks out, is evicted, crashes, is
  cancelled or is retired, and by every gateway shutdown hook. If the gateway exits through
  `process.exit` or the end of its event loop without closing them, an exit handler kills
  every Copilot CLI it started (live, one-shot, starting or closing) and removes their
  folders synchronously. If the gateway is killed outright, its CLIs exit when their input
  closes (measured on CLI 1.0.97), and the next gateway removes every folder whose owner no
  longer runs when it starts, before its first request and whatever any provider's mode is.
  It reads only the parent folder, never the whole OS temp folder, which can hold hundreds
  of thousands of entries. An owner no longer runs when its pid is dead or now belongs to a
  process with another start time (`ps -o lstart`), so a reused pid keeps nothing; folders
  that another user owns are never removed. Folders that older releases left straight in the
  OS temp folder without an owner (`gateway-copilot-<random>`) are removed once they are
  more than two hours old, longer than any request runs; the OS temp folder is read for
  them once and again after a week (the `.legacy-scan` file in the parent records when).
- No caller prompt, tool argument or output goes to gateway logs, telemetry or the usage
  ledger.

## Billing and diagnostics

The usage ledger records one row per gateway request with that request's own cache read,
cache write, reasoning and nano-AIU totals, so the saving shows directly in the cache-read
share of `inputTokens` and in `nanoAiu` per request; see [diagnostics](diagnostics.md).
Usage that the CLI reported before a request failed or was cancelled is still counted,
live or one-shot: the request reports it as one running total of every model call it
made, and the `interrupted` or failed `copilot_session` event already includes it. When a
request stops early (the caller left, it was cancelled or timed out, or the gateway is
shutting down), the server keeps reading the provider for up to 3 seconds, for usage
only, even if it was waiting for a slow client to take earlier output. At shutdown it
waits for those requests to write their ledger rows before its final flush, but the
process leaves 1.5 seconds after the drain deadline at the latest, flushing telemetry
and the ledger first. A cancelled live request hands its total over at once; a cancelled
one-shot request hands it over once its stopped CLI has exited, which SIGKILL bounds to
about 1.5 seconds after SIGTERM.

`copilot_session` telemetry has one event per decision or end:

| Field | Values |
| --- | --- |
| `outcome` | `spawned`, `continued`, `reseeded`, `fallback`, `interrupted` (the request was cancelled), `reaped` (parked or tool-wait timer), `evicted`, `crashed`, `closed` (ended on purpose) |
| `missReason` | on `reseeded` and `fallback`: the reasons above. On an end (`closed`, `reaped`, `evicted`, `crashed`): why it ended — a reseed reason, `interrupted`, `idle_missing`, `tool_wait_expired`, `mode_oneshot` (the provider switched to one-shot), `provider_removed` (a reload removed the provider or changed its id or auth directory), `shutdown`, `stopped`, or for `crashed`: `foreign_tool`, `permission`, `sub_agent`, `unannounced_tool`, `unattended_output`, `unattended_completion`, `backlog`, `exited`, `delivery_rejected` (a tool result was not confirmed), or the code of the error that failed the request |
| `threadKey` | the first 8 hex of the thread's session key |
| `liveSessions` | live sessions after the event |
| `divergedAt` | on `prefix_diverged` and `unexpected_tail`: the index of the first item that did not match |
| `parkedMs` | how long the session had been idle when the request or end came |
| `failed` | on a request that failed after reaching a session |
| `initiator`, `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `nanoAiu`, `toolCalls` | the request's own totals; `initiator` is `user` (a new message started the first call), `agent` (the session's own follow-up) or `mixed` |

A session that never served a request (it failed while starting) has no end event; its
request's `fallback` event says why. `request_completed` and `request_failed` carry the
same `initiator`, `cacheWriteTokens`, `reasoningTokens` and `nanoAiu` for every Copilot
request.

## Restarts and upgrades

An in-place upgrade keeps the sessions: the registry lives on the versioned global
symbol `harness-gateway/copilot-sessions/v1`, so the new runtime adopts the one it finds,
with its sessions, and the next request of a thread continues the running process unless
something the session was created with changed. A registry with another interface version
is replaced, not adopted; its sessions still close on their own timers or at shutdown.
The gateway counts as busy, so an idle restart or a self-update waits, while a session is
starting or generating, or has waited for tool outputs for less than 10 minutes; a longer
wait gains nothing from its cache. On shutdown, after the request drain, every session is
closed: a turn that runs or waits for tools is aborted, then the process group is killed
and the folder removed.

## Limits

A request that arrives with a tool output the session cannot match reseeds instead of
guessing. The protocol details come from measurements on Copilot CLI 1.0.97, and
`session.sendMessages`, `session.tools.handlePendingToolCall`, `session.abort` and
`session.model.switchTo` are experimental there; run a short live check against the
installed CLI after upgrading it. The last check (October 2026) covered a three-round tool
loop, an effort change between turns, Stop while a tool waited, a request without a
thread id, shutdown with a parked session, and a gateway killed outright (see
[verification](verification.md)). History images use the file attachments with which
earlier releases passed real PNG checks. Tool-output images as binary results, and tool
deferral above 30 tools, are specified by the CLI's schema but were not measured against
a vision model. A
live session costs about 257 MB of memory, so `max: 4` is about 1 GB.
