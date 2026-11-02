---
summary: 'Grok subscription inference through the official Grok Build CLI: private Grok home, tool handoff, fail-closed checks and limits.'
read_when:
  - Changing the grok-subscription provider or its Grok home
  - Signing the gateway in to Grok, or investigating a failed Grok request
---

# Grok subscription

A `grok-subscription` provider spends a Grok subscription allowance by running
the official Grok Build CLI (`grok`) once per request, the way the one-shot
Claude path runs `claude -p`. API keys are never used: `XAI_*` and `GROK_*`
variables are removed from the CLI's environment. This transport now admits only
standalone requests. Historical assistant/tool turns and another request for a
previously admitted conversation are refused before a CLI starts, rather than
automatically seeding full history again. The bounded admission record survives
handler upgrades in the process; a full restart resets it, while historical input
is still refused independently. Model choices are never changed automatically.

An attempt that produced no content and spent no allowance releases its
admission, so signing in and retrying the same turn works instead of failing as a
replay. A turn that streamed content or was charged keeps its admission; repeating
that conversation is refused.

Persistent Grok ACP sessions remain unqualified. Isolated native 1.0.52 tests
found that empty/invalid tool allowlists can restore native tools, resumed sessions
can lose confinement, and the CLI initiates title/summary inference. Those must be
resolved and independently qualified before enabling continued subscription chats.
See [provider reuse](provider-reuse.md).

```json
{ "id": "grok", "type": "grok-subscription", "label": "Grok",
  "models": { "grok/grok-4.7": "grok-4.7" },
  "modelMetadata": { "grok/grok-4.7": { "displayName": "Grok 4.7", "contextWindow": 256000, "inputModalities": ["text"] } } }
```

## Private Grok home

The gateway uses its own Grok home, `<stateDirectory>/grok-home` unless
`grokHome` names another directory. Sign it in once per Mac:

```sh
GROK_HOME="$HOME/Library/Application Support/Subscription Gateway/state/grok-home" grok login --device-auth
```

`--device-code` is the CLI's alias for the same flow. A missing `auth.json`
fails the request before the CLI starts, and a login the CLI rejects mid-run is
reported the same way: HTTP 401 `authentication`, with a fixed message that
names the gateway's Grok home. Neither case is reported as a temporary upstream
failure, so a retry does not hide a sign-in problem.

The gateway keeps the home private (0700) and rewrites only its managed sections
of `config.toml`: no auto-update, telemetry, memory, xAI-side tools (X search,
code interpreter) or session search, Claude and Cursor compatibility (skills,
rules, agents, MCP servers, hooks) off, and exactly one MCP server, `gateway`.
Sections the CLI writes itself are kept. A personal `~/.grok` login and its MCP
servers and skills are never used.

## Tool handoff

Every built-in tool is named in `--disallowed-tools`. Grok reaches MCP tools only
through its `search_tool` and `use_tool` helpers, so those stay allowed. The
`gateway` MCP server lists the caller's tools for this request and never answers
`tools/call`. `search_tool` is answered inside the CLI from that catalog. A
`use_tool` block naming `gateway__<tool>` becomes the caller's tool call, with
its `tool_input` as arguments; the request ends and the CLI is stopped. The
client executes every tool.

The request fails with `invalid_tool_call` and the CLI is killed when the init
frame advertises any other tool or MCP server, or the stream contains any other
tool, a server-side tool block, or a `use_tool` for a non-gateway tool.

## Limits

- Text only: image input is refused before the CLI starts.
- Each admitted standalone request seeds its input. The CLI adds about 13,000 tokens of its
  own setup, so a tiny reply costs about 2 cents of allowance and long tool loops
  cost much more. `grok_cli` telemetry records `costUsd` from the CLI's result.
- Every tool step adds a `search_tool` round trip before the `use_tool` call.
- Instructions travel as `--system-prompt-override` and are capped at 256 KiB.
- Errors map to fixed classes (authentication, rate limit, allowance or billing,
  temporary failure); provider text is never forwarded.

Verified on 21 October 2026 with Grok Build 1.0.52 against `grok-4.7-build-fast`:
a text reply, and a tool turn that returned one caller call with exact arguments
and left no CLI process running. Fixture tests cover the stream and safety rules
without paid inference.
