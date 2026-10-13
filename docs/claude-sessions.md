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
running sessions finish their turn and close.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `replay` | `live` keeps a session per thread |
| `max` | 6 | Live sessions in the whole process (1–16); the least recently used finished one is evicted |
| `parkMinutes` | 60 | Idle time before a session closes (5–240), per session |
| `replayFormat` | `text` | Item encoding for one-shot requests and session seeds; `json` restores the old one |

## How a request is served

- **Continue:** the request carries the history the session already has plus new
  items. Tool outputs go back to the CLI's waiting MCP calls through a private relay
  (a 0600 Unix socket with a per-session key). The relay carries only the RPC id, the
  tool name and the tool_use id, never arguments. A new user turn is sent as one
  message.
- **Reseed** (a new process, one cache write): an earlier message was edited; the
  model, thinking, Fast, system prompt, tool catalog or window changed; an effort
  change arrived while tools were pending; the history had an unexpected tail; or the
  session was idle 60 minutes or more (see Context management below).
- **One-shot fallback:** compaction, prewarm and memory requests; requests without a
  thread id; a second request for a thread that is still generating; and any failure
  before the first event, including a CLI that exits right after the seed.

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

## Context management

The CLI sends only `clear_thinking` with `keep: all`, which removes nothing. Version
2.1.293 also contains `clear_tool_uses`, behind a server flag that is off by default.
It applies only to a conversation that returns after at least 65 minutes idle with at
least 20 tool uses. A session idle 60 minutes or more is therefore reseeded rather
than continued, so Claude's history always matches what Codex sent.

## Measured

Haiku 5.5 and Sonnet 5.5, CLI 2.1.293:
- A continued request reads the whole cached prefix and writes only its new content
  (74–108 tokens on a tool loop), with 2 uncached input tokens. The one-shot path
  rewrites at least 350 tokens per request.
- A session's second user turn misses 350–430 tokens once, whatever the seed size.
  The seed itself is not rewritten. A turn that ends in tool use has no such miss.
- Each session uses about 240 MB for the CLI and 44 MB for its MCP child.
- A text turn's result arrives 3–7 ms after its final `message_delta`, so a live
  request still ends at the result. One-shot requests end at that delta instead.

## Restarts and upgrades

An in-place upgrade keeps the sessions: the registry lives on a versioned global
symbol, so the new runtime adopts it. An inference restart reseeds each active
thread once. The release that moved caller instructions into the system prompt
changes every session's fingerprint, so each thread reseeds once after it even when
an in-place upgrade adopted its session; that reseed is the chat's one cache write.
On shutdown, idle sessions close at once and a running turn closes when it ends; the
relay's dead-man check and stdin EOF stop any CLI whose gateway died.
`claude_session` telemetry records each outcome; see [diagnostics](diagnostics.md).
