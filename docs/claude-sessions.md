---
summary: 'Live Claude CLI sessions per Codex thread: when they continue, reseed or fall back.'
read_when:
  - Changing the Claude provider, its live sessions, relay or ledger
  - Turning claudeSessions on or off, or investigating Claude cache spend
---

# Live Claude sessions

By default every Claude request starts a new `claude -p` process and replays the
whole history (`claudeSessions.mode: "replay"`). With `"live"`, the gateway keeps
one stream-json CLI process per Codex thread, the way Claude Code itself runs. The
CLI holds the native history: real tool_use and tool_result turns, signed thinking
that carries across tool steps, and a prompt cache that grows by appending.

```json
{ "id": "claude", "type": "claude-subscription", "claudeSessions": { "mode": "live" } }
```

The daemon reads the change on its next request. `"replay"` turns it off again;
running sessions finish their turn and close. A provider in replay mode retires its
own parked sessions on its next request, so they do not wait out the park timer.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `replay` | `live` keeps a session per thread |
| `max` | 10% of RAM | Live sessions in the whole process (1–32). The default is `clamp(floor(0.10 × totalmem / 300 MB), 6, 32)`: 6 up to 20 GiB, 21 on 64 GiB, 32 from about 94 GiB. A session being started counts toward it |
| `parkMinutes` | 60 | Idle time before a session closes (5–240), per session |
| `warmup` | 1 | Completed requests a thread needs before its first live session may start (0–5). `0` restores immediate spawning. |
| `replayFormat` | `text` | Item encoding for one-shot requests and session seeds; `json` restores the old one |

## How a request is served

- **Continue:** the request carries the history the session already has plus new
  items. Tool outputs go back to the CLI's waiting MCP calls through a private relay
  (a 0600 Unix socket with a per-session key). The relay carries only the RPC id, the
  tool name and the tool_use id, never arguments. A new user turn is sent as one
  message.
- **Reseed** (a new process, one cache write): the model, thinking, Fast, system
  prompt, tool catalog or window changed (`fingerprint_changed`, `window_changed`), or
  the session was idle 60 minutes or more (`idle_expired`; see Context management
  below). The cache of the old session is gone or unusable either way, so the new
  process costs no more than the next one-shot request would.
- **Forced downgrade** (no reseed): an earlier message was edited
  (`prefix_diverged`), the history had an unexpected tail (`unexpected_tail`), a forced
  tool choice arrived (`forced_choice`), an effort change arrived while tools were
  pending (`effort_midturn`), or the session died or crashed. A second process would
  pay the whole cache write again for one turn, so that request is served one-shot and
  the thread stays on replay (`replayUntil`) for 60 minutes, when a session of its own
  could keep a cache again. A held request inside that window is served the same way and
  starts the window over, so a thread that keeps talking is never seeded a process it
  would have to reseed on its next turn. The old session closes at once.
- **Capacity** (no eviction): see Admission below.
- **Warmup** (no session): a thread must complete `warmup` ordinary requests before
  its first live CLI starts. Until then, it runs one-shot with the `warmup` miss
  reason. This keeps composer prediction forks and one-request subagents from
  occupying a parked CLI for an hour. The default of one is cheap: the promoted
  session seed reads the cache the one-shot request wrote and writes only its new
  content.
- **One-shot fallback:** compaction, prewarm and memory requests; requests without a
  thread id; a second request for a thread that is still generating; and any failure
  before the first event, including a CLI that exits right after the seed.

## Reasoning-summary replay

The Claude route preserves readable reasoning summaries as typed metadata at the
Responses restoration boundary. Text replay gives them a `reasoning_summary`
item header; JSON replay retains `reasoningSummary: true`. Their text stays
unchanged. Ordinary assistant messages remain ordinary assistant messages,
including valid string-content messages. The session ledger skips typed
reasoning metadata while counting the messages the renderer emits, so a genuine
assistant answer cannot disappear from history matching because of its string
encoding. Other providers retain their previous restoration behavior, including
account-scoped Codex encrypted-state round trips.

A public summary has no native Claude thinking signature. The gateway never
fabricates one or reconstructs an unsigned thinking block from the summary.
The caller's instructions, saved chat ID, archive, answers, calls and tool
outputs remain intact. A replay-contract revision makes an adopted idle session
reseed once through the existing fingerprint-change path. Requests already in
flight finish on their original runtime.

This corrects a representation error; it does not establish which passage a
provider classifier rejected or override a provider refusal.

## Admission

A session is evicted only after it has been idle for 60 minutes, the length of the 1 h
cache. While every slot holds a warm session, a new thread runs one-shot (`capacity`)
and stays on replay until a slot frees; nothing is evicted and no warm cache is spent
on a newcomer. Sessions being started count toward `max`, in arrival order, so
concurrent attaches can never run more processes than the cap. Telemetry records the
`warmup` and `capacity` fallbacks and each replay-hold reason as `claude_session`
events with the `fallback` outcome and the thread's `threadKey`. A promoted spawn has
`afterWarmup: true`, so diagnostics records its cache cost; see
[diagnostics](diagnostics.md).

The system prompt is the gateway's fixed text plus the caller's instructions and
the system and developer messages before the first other message, as on the
one-shot path (see [Responses support](responses.md)). It lives in a private file in
the session directory. Those messages are not part of the session's history ledger;
the session fingerprint covers them, so a change to them reseeds. A later developer
message is history and continues the session like any other new item.

An effort change between turns uses the CLI's `apply_flag_settings` and keeps the
cache. Cancelling interrupts the turn and keeps the session; the next history may
keep or drop the partial text. The session closes instead if a tool call was being
written.

## Prompt cache across threads

Each Claude request's system array has a billing header with no cache marker, then the
CLI identity block with a breakpoint, then one block with a breakpoint that joins the
gateway's fixed text to the caller's leading system and developer content.
`--append-system-prompt-file` joins that same block and creates no separate breakpoint.
`--exclude-dynamic-system-prompt-sections` is ignored with a custom system prompt. The
CLI sorts tools alphabetically and marks no tool.

A new thread therefore reuses the tools, billing header and identity block from
another thread's cache. It reuses caller instructions only when they are byte-identical,
such as two root chats within the cache lifetime. On 2026-10-19, a new thread's first
request read 33,331 cached tokens 66 seconds after another thread on the same model.
A subagent, or any thread whose leading instructions differ, rewrites that block. The
gateway does not move caller developer text into user history to improve this cache
reuse because that would change its role.

The block layout was captured with CLI 2.1.299 in API-key mode against a local mock.
The subscription cache TTL is one hour: a direct CLI run reported
`ephemeral_1h_input_tokens` of 9,604 and `ephemeral_5m_input_tokens` of 0.

## Safety

The live CLI sees only the gateway's MCP tools: it runs with `--tools ""`,
`--allowedTools` limited to the gateway, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` and
`ENABLE_TOOL_SEARCH=false`, as one-shot CLIs now do too. A tool_use for anything else
kills the session as soon as the gateway reads that line, and the request fails with
`invalid_tool_call`. No gateway CLI inherits the host's `CLAUDECODE`,
`CLAUDE_CODE_*` or `CLAUDE_AGENT_SDK_*` variables; the gateway sets its own, including
`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`, so caller tool descriptions are not cut.
Nothing is written to `~/.claude`: sessions use `--no-session-persistence` and a
private working directory under `$TMPDIR/gateway-claude`, which the next start sweeps
after a crash. Live sessions set `DISABLE_AUTO_COMPACT=1`; Codex owns compaction.

## Request rejections

Claude `invalid_request` failures are final HTTP 400 errors. Responses streams
use `invalid_prompt`, so the desktop stops retrying an unchanged rejected request.
A recognized credit refusal still takes billing precedence, and context overflow
still permits the caller's normal compaction recovery. The native
`reasoning_extraction` refusal gets a fixed explanation of Claude's protection
policy; the gateway preserves caller history, instructions and model choice.
See [request rejection diagnostics](diagnostics.md#claude-request-rejections).

## Authentication failures

The CLI's `authentication_failed` code does not by itself prove that the user must
sign in again. The gateway classifies bounded diagnostics from native failure
envelopes into fixed reasons: `login_unavailable`, `session_expired`,
`credential_revoked`, `upstream_rejected`, or `unknown`. It never saves the
diagnostic text. Local `claude auth status` reports credential presence; it does
not prove that an inference request will authenticate.
An unclassified failure therefore suggests retrying and signing in if it
persists, rather than asserting that the saved login has expired.

An explicit generic upstream HTTP 401, identified by the CLI's native error
prefix, gets one fresh one-shot attempt after a cancellable two-second wait.
This recovery is allowed only before any inference event has reached the caller.
The same model, instructions, history and tools are used, and a failed live
session closes before the replacement starts. Text, reasoning or a dispatched
tool makes the failure final for this request. Missing, expired, revoked and
unclassified logins also remain final, as do billing and subscription limits.
A second failure preserves its original error. Recovery never resumes a stopped
goal, answers an approval, or replays an executed command.

On October 21, 2026, five fresh one-shot requests failed with
`authentication_failed` between 10:33 and 10:36 Europe/Belgrade, each before any
inference event. Two original chats later continued without a recorded login
change. Earlier telemetry did not retain a failure reason, so it cannot prove
whether those failures involved credential access, expiry or upstream rejection.
The guarded recovery addresses the explicit upstream-401 shape; it is not a
demonstrated reproduction of that incident.

## Context management

The CLI sends only `clear_thinking` with `keep: all`, which removes nothing. Version
2.1.293 also contains `clear_tool_uses`, behind a server flag that is off by default.
It applies only to a conversation that returns after at least 65 minutes idle with at
least 20 tool uses. A session idle 60 minutes or more is therefore reseeded rather
than continued, so Claude's history always matches what Codex sent.

## Measured

Haiku 5.5 and Sonnet 5.5, CLI 2.1.293:
- A continued request reads the whole cached prefix and writes only its new content
  (74–108 tokens on a tool loop), with 2 uncached input tokens. A one-shot request
  reads the previous request's prefix and writes its new items plus about 350 tokens
  of the CLI's trailing reminder, as long as every block ends in a non-space
  character (see the closing line in [responses](responses.md)).
- A session's second user turn misses 350–430 tokens once, whatever the seed size.
  The seed itself is not rewritten. A turn that ends in tool use has no such miss.
- Each session uses about 240 MB for the CLI and 44 MB for its MCP child, which is
  why the default pool is sized at 300 MB a slot.
- On 2026-10-19, CLI 2.1.299 with Haiku 5.5, a subscription login, an approximately
  8k-token fixed instruction prefix and synthetic history served a first one-shot
  request with 0 cache-read tokens and 21,319 cache-write tokens. Its second request,
  which spawned after warmup, read 20,960 and wrote 423, so the session seed read the
  one-shot cache instead of rewriting it. The next continued turn read 21,016 and
  wrote 435. Changing effort from low to medium continued through
  `apply_flag_settings` and read 21,426 while writing 95. A control new thread with
  different history read only the shared system prefix (12,159) and wrote 9,167.
- Before the admission policy, least-recently-used eviction on a working set larger
  than the pool evicted the thread needed next. One window with 7 threads against
  `max` 6 saw 14 evictions after a median 49 s idle (20–160 s, against a 1 h cache), and
  every evicted thread came back. Its 22 reseeds read 0.686M tokens (only the shared
  system prefix) and wrote 1.496M, against 0.804M for spawns and 0.241M for continues:
  reseeds were 59% of all cache writes. Concurrent starts bypassed the cap, so 7
  sessions ran at `max` 6.
- A text turn's result arrives 3–7 ms after its final `message_delta`, so a live
  request still ends at the result. One-shot requests end at that delta instead,
  except Fast ones, which need the result's fast mode state.

## Restarts and upgrades

An in-place upgrade keeps the sessions: the registry lives on a versioned global
symbol, so the new runtime adopts the one it finds and adds the collections a later
release introduced (`replayUntil`, `scopes`) to it in place. An adopted session is
still its thread's session: the next request continues the running process and
records its provider scope as it goes. A registry reporting another interface
version is not adopted but replaced, and its sessions are left to their own park
timers. An inference restart reseeds each active thread once. The release that moved
caller instructions into the system prompt changes every session's fingerprint, so
each thread reseeds once after it even when an in-place upgrade adopted its session;
that reseed is the chat's one cache write.
On shutdown, idle sessions close at once and a running turn closes when it ends; the
relay's dead-man check and stdin EOF stop any CLI whose gateway died.
`claude_session` telemetry records each outcome; see [diagnostics](diagnostics.md).
