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
A session whose turn is running closes when the turn ends, and so does one that was still
starting when its provider was removed (it closes when the request that started it ends).
A gateway generation that an in-place upgrade starts does the same for the sessions it
adopts from the release before it: those whose provider its configuration no longer serves
close at once. An ordinary live request that cannot continue receives a final
refusal instead of silently switching to one-shot. See [provider reuse](provider-reuse.md).

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `live` | `live` keeps a session per thread; `oneshot` or `replay` starts a session per request |
| `max` | 4 | Live sessions in the whole process (1–16). A session being started counts toward it |
| `parkMinutes` | 30 | Idle time before a session closes (5–240). Copilot's prompt cache lasted 30 minutes for `gpt-6-luna` and 5 minutes for `claude-haiku-5.5` in the measurements; a session parked longer still continues, at about the price of a reseed, and keeps its native history |
| `toolWaitMinutes` | 25 | How long a session waits for Codex to run a tool before it closes (1–25). The wait is the smaller of this and `parkMinutes`: with `parkMinutes: 10` a session waiting for tools closes after 10 minutes |

## What a session is made of

One-shot requests and live sessions are built the same way, so a fallback never changes
what the model sees.

- **System message:** the gateway's guidance, the tool-name mapping, and the caller's
  leading system and developer messages. It is fixed for the session's life.
- **History:** one user message per conversation item, oldest first, each between
  `<<item N role>>` and `<</item>>` lines. A seed sends all items with
  `session.sendMessages`; a continuation sends only the new ones. Replayed calls
  to a currently declared tool use its same native name as the tool declaration.
  Arguments, custom input, call IDs and results stay unchanged, and the live
  ledger keeps the caller's original identities. Ambiguous or unavailable old
  tool names remain historical names; replay never makes them available.
- **Images:** a history item's images are written (mode 0600) to the `images` folder of
  the CLI's private folder and attached to the item's message as `file` attachments; the
  message text names each one. Their bytes never travel inside a message, because one
  RPC message to the CLI is limited to 16 MiB and a few screenshots pass that. The files
  go with the folder. A request that is cancelled (or whose session ends) while its images
  are being written writes no further image: the check comes before each one, the write in
  flight ends before the folder is removed, and an `images` folder is never created in a
  CLI folder that is already gone. A tool output's images can only travel inline, as binary results
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

Copilot's SDK protocol defines an omitted `assistant.message.toolRequests[].type`
as `function`. The gateway accepts that documented default while retaining exact
catalog-name matching, distinct call IDs, object argument checks and client-owned
execution. Explicit non-function types remain rejected because the gateway declares
only external functions. Treating a missing type as malformed previously failed
valid tool calls and made Codex retry their response streams. This matches the
[official SDK event contract for CLI 1.0.97](https://github.com/github/copilot-sdk/blob/9782624309a2366f6cbe2141ee7b2289b5d94136/nodejs/src/generated/session-events.ts).
`arguments` is likewise optional there: a call that omits it is forwarded with no
arguments, while an explicit non-object payload (including custom tools missing
their string input) remains rejected.

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
- **Queued caller updates:** complete pending results followed by user/developer
  messages continue the same session. Each new item is acknowledged through
  immediate `session.send` before any result is delivered. Old adopted instances
  without that capability preserve and refuse rather than dropping messages.
- **Controlled reseed:** genuine model/system/tool or window changes, oversized
  inline results, an idle/dead/expired session found before placement, or a completed
  native Messages caller-owned history replacement can require a new process.
  A failed session during the current placement cannot seed again in that request.
- **Preserve and refuse:** unexplained `prefix_diverged`, `unexpected_tail`,
  `forced_choice`, `effort_midturn`, an explicit `effort_rejected`, or
  `tool_request_missing` leaves a usable session and its pending tools intact.
  Matching corrected input can continue it. An uncertain effort change closes the
  unsafe session and returns a final continuity refusal.
- **Standalone:** explicit compaction/prewarm/memory requests and anonymous first
  questions can use one-shot. Historical anonymous conversations require an ID.
- **Final continuity refusal:** concurrency, capacity, startup, tool-delivery,
  stream and attachment failures cannot silently replay history. This also applies
  after partial output/usage. Images and forced choices remain supported on
  compatible live paths.

## Admission

While every slot holds a session, a new thread first waits for a session that is already
closing, then can take a session idle at least 30 minutes. Warm and running sessions,
and sessions whose own request is being placed, are never evicted. Without a cold
slot, the newcomer receives a final `capacity` refusal. An evicted session's process and
folder are gone before its replacement starts. The evicted thread reseeds on its next
request (`evicted`). If that request arrives while the old session is still ending, it
takes over the slot: the old session stops counting toward `max` and the request waits
until its process and folder are gone before it starts its new session. Sessions being
started count toward `max`, in arrival order, so concurrent starts never hold more sessions
than the cap. Any session that is still closing when its thread's next request comes
no longer holds the thread or a slot in the same way; the request waits until it is gone
and starts a new session, reporting how the old one ended (for example
`tool_wait_expired`).

## Waiting for tools

Copilot fails a pending external tool request 1,800 seconds after it was issued, and the
runtime then makes a model call of its own, which is billed. The gateway closes a session
that is waiting for tool outputs after `toolWaitMinutes` (25 at most) or `parkMinutes`,
whichever is smaller, before that happens: `session.abort`, then SIGKILL. The next request reseeds (`tool_wait_expired`).

Between requests the gateway accepts only housekeeping: the pending calls' own
`tool.execution_start` and `external_tool.requested` events, `session.info`,
`session.usage_info`, `session.usage_checkpoint`, `session.idle` (CLI 1.0.97 sends it
right after `assistant.idle`), and `model.*` events other than `model.call_start`. It also
accepts the CLI's start-up announcements `session.start` and
`session.managed_settings_resolved` until the session's first request, and a
`session.model_change` that confirms the effort change the gateway asked for (the CLI
sends it before it answers `session.model.switchTo`; the gateway recognizes it even when
it is read after the next request attached). A confirmation for another effort than the one
asked for ends the session (`effort_mismatch`), and the request is refused. Anything
else kills the session at
once, before it can spend: a `tool.execution_complete` or `external_tool.completed` for a
call nobody answered (the timeout, or a failed call), a model call, any assistant output
or usage, compaction, truncation or an error, a model change nobody asked for, a
permission request, a sub-agent event, or a tool request for a call that is not pending.
A session that misbehaves while it is starting is never handed to a request; the request
receives a final refusal (`spawn_failed`). A timer cannot be trusted alone, because a sleeping
Mac stops it while the CLI's clock goes on.

## Stopping a session

Cancelling a request, a reseed, an eviction, a tool-wait expiry and any violation end the
session the same way: `session.abort` (bounded to 2 seconds, errors ignored), then SIGKILL
of the CLI's whole process group, which is its own group, and the removal of its folder.
A parked session that is not running anything needs no abort and is killed the same way.
A one-shot request is closed the same way whenever its CLI may hold an unanswered tool
request: a turn that ended in tool calls, a tool request the gateway rejected (a disabled
or other tool than the required one, a native tool), any failure, a cancellation once its
session exists, and a client that stops reading. Only a one-shot turn that ended idle with a
complete text answer, and so nothing pending, is deleted (`session.delete`) and stopped
with SIGTERM; once a session exists no other end ever sends either, because a runtime that
is told to exit can fail a pending call and make a model call of its own. A connection that
fails (an event backlog, an invalid frame) ends its CLI with SIGKILL. Only a CLI whose request
is cancelled or fails while the connection is still being opened (before the handshake ends)
has no session and nothing pending, and is stopped with SIGTERM. A request cancelled while its
CLI is still ending sends nothing more: the prompt of a one-shot request, and the messages or
tool results of a live one, are not sent after the cancellation, because each would start a
model call nobody waits for.
A cancelled request stops reading the model at once but ends only when its session is gone
(about 2 seconds: the abort is bounded to 2 seconds, then the CLI is killed and its folder
removed), handing over the usage the CLI reports meanwhile. A process outside the CLI's group
that keeps the CLI's output open (a helper the CLI detached) does not hold the request: once the
CLI has exited and its output has been silent for half a second, or at most about 5 seconds (100
ticks) after the exit when output keeps arriving, the gateway closes its pipes and the request
ends. A reseed or
an eviction waits for the old session to be gone. Closing a session under a running
request fails that request at once with a final continuity refusal (`stream_failed`).
The next independent request after a cancellation reseeds,
because the half-written answer cannot be matched against what Codex replays. A request
that has already finished is not affected when the client closes the connection
afterwards.

A complete answer whose `assistant.idle` event does not follow within 5 seconds still
ends the request normally; the session then closes (`idle_missing`).

## Safety

- The CLI sees only the gateway's tools. A permission request, a tool start or request for
  any other name, a sub-agent event, BYOK usage, another model or output with no request
  attached kills the session and fails the request. The gateway still answers no host
  request, and the CLI is spawned with `--no-auto-update`, `--disable-builtin-mcps`,
  `--no-custom-instructions`, `--no-remote` and `--no-remote-export`, and the session
  store off.
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
  folders synchronously; a folder that could not be removed when its CLI closed (the
  removal is retried five times) stays on that list for the handler, and closing never
  fails the request or the gateway because of it. If the gateway is killed outright, its CLIs exit when their input
  closes (measured on CLI 1.0.97), and the next gateway removes every folder whose owner no
  longer runs when it starts, before its first request and whatever any provider's mode is.
  Each sweep reads the parent folder; it does not read the whole OS temp folder, which can
  hold hundreds of thousands of entries, except once and then again after a week, for the
  folders of older releases (below). An owner no longer runs when its pid is dead or now
  belongs to a process with another start time (`ps -o lstart`), so a reused pid keeps
  nothing; folders that another user owns are never removed, and a parent that is not a
  real folder you own is neither read nor trusted. Folders that older releases left straight
  in the OS temp folder without an owner (`gateway-copilot-<random>`) are removed once they
  are more than two hours old, longer than any request runs; that weekly read of the OS temp
  folder is recorded by the `.legacy-scan` file in the parent.
- No caller prompt, tool argument or output goes to gateway logs, telemetry or the usage
  ledger.

## Billing and diagnostics

The app's Diagnostics screen and `gateway diagnostics` now summarize Copilot
session outcomes, rebuild reasons and cache coverage. New session events include
provider and model identity. Tool-call failures carry fixed structural reasons,
so an unknown tool, duplicate call ID, malformed call and invalid argument shape
are distinguishable without storing tool arguments. Historical generic failures
retain their original level of detail. See [diagnostics](diagnostics.md).

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
process leaves 1.5 seconds after the drain deadline at the latest. Before it leaves, it
writes a `failed` ledger row and a `request_failed` record for every request still
running, with the usage its provider had reported so far, and then flushes telemetry and
the ledger, so a request stopped at shutdown never loses what it had already cost. Usage
that arrives after the process has left is not recorded. A cancelled request hands
its total over as the CLI reports it, live or one-shot: each usage the CLI reports while it
is being aborted (`session.abort` is bounded to 2 seconds before SIGKILL) is added to the
request's totals and handed over at once as the running total, without waiting for the CLI
to be killed, so a process that leaves in between has the usage already. A live request
ends once its session is gone; the `interrupted` event is written then, so it counts that
usage too.

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

Upgrading from a release that replayed caller tool names rebuilds each live
session once because the system message's tool-name guidance changed.

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
