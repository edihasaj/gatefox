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

Why: a new session on every request (`"oneshot"`) sends the whole history as new input,
so each model call is user-initiated and the history is written to the prompt cache
again every time. One tool loop of three rounds, measured on `gpt-6-luna` with a
3.7k-token prompt, wrote 2,217 to 2,307 tokens to the cache per round and cost about
30 million nano-AIU per round. The same loop in one native session reads the prefix from
the cache and costs about a tenth of that (13.5 million nano-AIU for a 12k-token prefix).
Observed gateway traffic cost about 9.5 times what the same work costs natively.

```json
{ "id": "copilot", "type": "copilot-subscription", "copilotSessions": { "mode": "live", "max": 4, "parkMinutes": 30, "toolWaitMinutes": 25 } }
```

Every field is optional, and a provider with no `copilotSessions` at all runs live with
the defaults below. The daemon reads a change on its next request. `"oneshot"` (or
`"replay"`, accepted as another name) turns live sessions off: running turns finish, and
the provider's parked sessions close on its next request. One-shot is also what a
request falls back to whenever a live session cannot serve it.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `live` | `live` keeps a session per thread; `oneshot` or `replay` starts a session per request |
| `max` | 4 | Live sessions in the whole process (1–16). A session being started counts toward it |
| `parkMinutes` | 30 | Idle time before a session closes (5–240). Copilot keeps its prompt cache 30 minutes |
| `toolWaitMinutes` | 25 | How long a session waits for Codex to run a tool before it closes (1–25) |

## What a session is made of

One-shot requests and live sessions are built the same way, so a fallback never changes
what the model sees.

- **System message:** the gateway's guidance, the tool-name mapping, and the caller's
  leading system and developer messages. It is fixed for the session's life.
- **History:** one user message per conversation item, oldest first, each between
  `<<item N role>>` and `<</item>>` lines. A seed sends all items with
  `session.sendMessages`; a continuation sends only the new ones.
- **Images:** a user item's images are inline blob attachments on its message. A tool
  output's images travel as binary results of the waiting call. The gateway writes no
  image file.
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
  request of the call it answers, whatever order the outputs arrive in. The prefix is read
  from the cache, the follow-up model calls are agent-initiated, and the request is billed
  for its own model calls only.
- **Reseed** (a new process, one cache write, which a one-shot request pays on every
  call). The old process and its folder are removed first, and a session that was waiting
  for tools is aborted. The telemetry `missReason` is one of:
  `fingerprint_changed` (model, summary mode, system message, tools, or whether a reasoning
  effort is set), `window_changed` (the context window changed), `prefix_diverged` (an
  earlier message was edited), `unexpected_tail` (for example a new message together with
  tool outputs, which is what Stop followed by a new message sends), `forced_choice`
  (tool outputs arrived with a forced, required or `none` choice, which a tool result
  cannot carry), `effort_midturn` (an effort change while tools were pending),
  `effort_rejected` (the CLI refused an in-place effort change),
  `tool_request_missing` (the session had no pending request for a call whose output
  arrived), and, when the thread's previous session had ended, `session_dead`, `evicted`,
  `reaped`, `interrupted`, `tool_wait_expired` or `idle_missing`. An effort change
  between turns keeps the session and uses `session.model.switchTo`.
- **One-shot fallback** (the request is answered with its own session and no live session
  starts or changes): `no_thread` (no thread id), `request_kind` (compaction, prewarm and
  memory requests), `concurrent` (a second request for a thread whose first still runs),
  `capacity` (every slot is running a turn), `spawn_failed` or `initialize_timeout` (the
  process or its handshake did not come up in time), `delivery_rejected` (the session
  refused a tool result), and `stream_failed` (the session died before its first event).
  Images and forced choices are served live.

## Admission

While every slot holds a session, a new thread takes the slot of the least recently used
session that finished its turn, then of the least recently used one that waits for tool
outputs. A running session is never evicted, and neither is one whose own request is being
placed. When every session is running, the newcomer is served one-shot (`capacity`). An
evicted thread reseeds on its next request (`evicted`). Sessions being started count
toward `max`, in arrival order, so concurrent starts can never run more processes than the
cap.

## Waiting for tools

Copilot fails a pending external tool request 1,800 seconds after it was issued, and the
runtime then makes a model call of its own, which is billed. The gateway closes a session
that is waiting for tool outputs after `toolWaitMinutes` (25 at most), before that
happens: `session.abort`, then SIGKILL. The next request reseeds (`tool_wait_expired`).

Between requests the gateway accepts only housekeeping: the pending calls' own
`tool.execution_start` and `external_tool.requested` events, `session.info`,
`session.usage_info`, `session.usage_checkpoint`, and `model.*` events other than
`model.call_start`. Anything else kills the session at once, before it can spend: a
`tool.execution_complete` or `external_tool.completed` for a call nobody answered (the
timeout, or a failed call), a model call, any assistant output or usage, compaction,
truncation or an error, a permission request, a sub-agent event, or a tool request for
a call that is not pending. A timer cannot be trusted alone, because a sleeping Mac
stops it while the CLI's clock goes on.

## Stopping a session

Cancelling a request, a reseed, a tool-wait expiry and any violation end the session the
same way: `session.abort` (bounded to 2 seconds, errors ignored), then SIGKILL of the CLI's
whole process group, which is its own group, and the removal of its folder. A parked
session that is not running anything needs no abort and is killed the same way. The
next request after a cancellation reseeds, because the half-written answer cannot be
matched against what Codex replays. A request that has already finished is not affected
when the client closes the connection afterwards.

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
  the session. The folder is `$TMPDIR/gateway-copilot-live-<owner pid>-<random>` (one-shot:
  `gateway-copilot-run-<owner pid>-<random>`), mode 0700, and also holds the CLI's own
  `TMPDIR`. It is removed when the session closes, parks out, is evicted, crashes, is
  cancelled or is retired, and by every gateway shutdown hook. If the gateway exits some
  other way, its exit handler kills the CLIs and removes the folders synchronously. If the
  gateway is killed outright, the next gateway removes every folder whose owner pid is dead
  when it starts, before its first request and whatever any provider's mode is. Folders
  that older releases left without an owner pid (`gateway-copilot-<random>`) are removed
  once they are more than two hours old, longer than any request runs.
- No caller prompt, tool argument or output goes to gateway logs, telemetry or the usage
  ledger.

## Billing and diagnostics

The usage ledger records one row per gateway request with that request's own cache read,
cache write, reasoning and nano-AIU totals, so the saving shows directly in the cache-read
share of `inputTokens` and in `nanoAiu` per request; see [diagnostics](diagnostics.md).
Usage that the CLI reported before a request failed or was cancelled is still counted.

`copilot_session` telemetry has one event per decision or end:

| Field | Values |
| --- | --- |
| `outcome` | `spawned`, `continued`, `reseeded`, `fallback`, `interrupted` (the request was cancelled), `reaped` (parked or tool-wait timer), `evicted`, `crashed`, `closed` (ended on purpose) |
| `missReason` | on `reseeded` and `fallback`: the reasons above. On an end (`closed`, `reaped`, `evicted`, `crashed`): why it ended — a reseed reason, `interrupted`, `idle_missing`, `tool_wait_expired`, `mode_oneshot` (the provider switched to one-shot), `shutdown`, `stopped`, or for `crashed`: `foreign_tool`, `permission`, `sub_agent`, `unannounced_tool`, `unattended_output`, `unattended_completion`, `backlog`, `exited`, or the code of the error that failed the request |
| `threadKey` | the first 8 hex of the thread's session key |
| `liveSessions` | live sessions after the event |
| `divergedAt` | on `prefix_diverged` and `unexpected_tail`: the index of the first item that did not match |
| `parkedMs` | how long the session had been idle when the request or end came |
| `failed` | on a request that failed after reaching a session |
| `initiator`, `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `nanoAiu`, `toolCalls` | the request's own totals; `initiator` is `user` (a new message started the first call), `agent` (the session's own follow-up) or `mixed` |

`request_completed` and `request_failed` carry the same `initiator`, `cacheWriteTokens`,
`reasoningTokens` and `nanoAiu` for every Copilot request.

## Limits

A request that arrives with a tool output the session cannot match reseeds instead of
guessing. The protocol details come from measurements on Copilot CLI 1.0.97, and
`session.sendMessages`, `session.tools.handlePendingToolCall`, `session.abort` and
`session.model.switchTo` are experimental there; run a short live check against the
installed CLI after upgrading it. Blob attachments, tool-output images and tool
deferral above 30 tools are specified by the CLI's schema but were not measured against a
vision model. A live session costs about 257 MB of memory, so `max: 4` is about 1 GB.
