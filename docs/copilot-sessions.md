---
summary: 'Live Copilot CLI sessions per Codex thread: why they exist, how requests continue, reseed or fall back, and what stays on disk.'
read_when:
  - Changing the Copilot provider, its live sessions or its cleanup
  - Turning copilotSessions on or off, or investigating Copilot credit spend
---

# Live Copilot sessions

By default every Copilot request starts a new `copilot --headless` process and session
and sends the whole history as one user message (`copilotSessions.mode: "oneshot"`).
That is the expensive way to use Copilot. Each model call is user-initiated, and the
history is written to the prompt cache again on every call, because it is a new
conversation each time. One tool loop of three rounds, measured on `gpt-6-luna` with a
3.7k-token prompt, wrote 2,217 to 2,307 tokens to the cache per round and cost about
30 million nano-AIU per round. The same loop in one native session reads the prefix from
the cache and costs about a tenth of that (13.5 million nano-AIU for a 12k-token prefix).

With `"live"`, the gateway keeps one CLI process and one session per Codex thread, the way
the Copilot CLI runs on its own. The session holds the native history, the caller's tool
calls wait inside it as pending external tool requests, and each gateway request sends
only what is new.

```json
{ "id": "copilot", "type": "copilot-subscription", "copilotSessions": { "mode": "live", "max": 4, "parkMinutes": 30, "toolWaitMinutes": 25 } }
```

The daemon reads the change on its next request. `"oneshot"` (or `"replay"`, accepted as
another name) turns it off again: running turns finish, and the provider's parked
sessions close on its next request.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `oneshot` | `live` keeps a session per thread |
| `max` | 4 | Live sessions in the whole process (1–16). A session being started counts toward it |
| `parkMinutes` | 30 | Idle time before a session closes (5–240). Copilot keeps its prompt cache 30 minutes |
| `toolWaitMinutes` | 25 | How long a session waits for Codex to run a tool before it closes (1–25) |

## How a request is served

- **Spawn:** the thread has no session. A new process starts, the history is sent once as
  one user message per item, and the system message carries the caller's instructions and
  the tool names. Telemetry reports `spawned`.
- **Continue:** the request carries the history the session already has plus new items.
  New user items are sent as user messages. Tool outputs are handed to the session's
  pending external tool requests with `session.tools.handlePendingToolCall`, each to the
  request of the call it answers, whatever order the outputs arrive in. The prefix is read
  from the cache and the request is billed for its own model calls only.
- **Reseed** (a new process, one cache write, which a one-shot request pays on every
  call): the model, summary mode, system message or tool catalog changed
  (`fingerprint_changed`), the context window changed (`window_changed`), an earlier
  message was edited (`prefix_diverged`), the history had an unexpected tail
  (`unexpected_tail`: for example a new message while tool outputs were pending), an
  effort change arrived while tools were pending (`effort_midturn`), the CLI refused an
  effort change, or the session had ended (`reaped`, `evicted`, `interrupted`,
  `session_dead`). The old process and its folder are removed first. An effort change
  between turns keeps the session and uses `session.model.switchTo`.
- **One-shot fallback** (the request is answered the old way and no session starts or
  changes, except as noted): no thread id; compaction, prewarm and memory requests;
  conversation images (the live path sends text only); a forced or `none` tool choice (the
  thread's session also closes, because the one-shot answer is not part of it); a second
  request for a thread whose first still runs (`concurrent`); every slot holding a warm
  session (`capacity`); a process that cannot start (`spawn_failed`); and a session that
  dies before its first event (`stream_failed`).

## Admission

While every slot holds a session, a new thread runs one-shot and nothing is evicted. A
session is evicted only after it has been idle 30 minutes, the length of Copilot's cache,
so its cache has gone anyway. With the default `parkMinutes` that never happens, because
the park timer closes the session first; it matters when `parkMinutes` is longer.
Sessions being started count toward `max`, in arrival order, so concurrent starts can
never run more processes than the cap.

## Waiting for tools

Copilot fails a pending external tool request 30 minutes after it was issued, and the
model then calls itself without the caller. The gateway closes a session that is waiting
for tool outputs after `toolWaitMinutes` (25 at most), before that happens. The next
request reseeds. Cancelling a request kills its process and removes its folder, because
the half-written answer and its pending tool requests are not worth keeping; the next
request reseeds. A request that has already finished is not affected when the client
closes the connection afterwards.

## Safety

- The CLI sees only the gateway's tools (`gateway_tool_N`). A permission request, a tool
  start or external request for any other name, a sub-agent event, BYOK usage, another
  model or output with no request attached kills the session and fails the request. The
  gateway still answers no host request.
- A large tool result is never saved to a file: `largeOutput` is off, because the CLI
  would otherwise write results past about 50 KB to the OS temp folder and give the model
  a path it cannot read.
- The session store stays off, so no session rows or session folders are added to
  `~/.copilot`, and the CLI's configuration folder is private. The CLI does write a log of the conversation, including prompts and
  tool results, to `session-state/<id>/events.jsonl` in that folder. In one-shot mode it
  lives for seconds; in live mode it lives as long as the session. The folder is
  `$TMPDIR/gateway-copilot-live-<owner pid>-<random>`, mode 0700, and also holds the CLI's
  own `TMPDIR`. It is removed when the session closes, parks out, is evicted, crashes, is
  cancelled or is retired, and by every gateway shutdown hook. If the gateway exits some
  other way, its exit handler kills the CLIs and removes the folders synchronously; if the
  gateway is killed outright, the next gateway sweeps folders whose owner pid is dead on
  its first live request.
- No caller prompt, tool argument or output goes to gateway logs or the usage ledger.

## Billing and diagnostics

The usage ledger records one row per gateway request with that request's own cache read,
cache write, reasoning and nano-AIU totals, so the saving shows directly in the cache-read
share of `inputTokens` and in `nanoAiu` per request; see [diagnostics](diagnostics.md).
`copilot_session` telemetry records each outcome (`spawned`, `continued`, `reseeded`,
`reaped`, `evicted`, `crashed`, `interrupted`, `fallback`), the miss reason, the thread's
`threadKey` (the first 8 hex of its session key), live session count, and the request's
tokens and `nanoAiu`.

## Limits

Images in a conversation keep that thread on one-shot requests, because the live path
sends text. A request that arrives with a tool output the session cannot match reseeds
instead of guessing. The protocol details come from measurements on Copilot CLI 1.0.97;
run a short live check against the installed CLI after upgrading it.
