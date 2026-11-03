---
summary: 'Grok subscription inference through the official Grok Build CLI: live ACP sessions per conversation, private Grok home, tool handoff, fail-closed checks and limits.'
read_when:
  - Changing the grok-subscription provider, its live sessions or its Grok home
  - Turning grokSessions on or off, or investigating a refused Grok conversation
  - Signing the gateway in to Grok, or investigating a failed Grok request
---

# Grok subscription

A `grok-subscription` provider spends a Grok subscription allowance through the
official Grok Build CLI (`grok`). API keys are never used: `XAI_*` and `GROK_*`
variables are removed from the CLI's environment. Model choices are never changed
automatically.

Two transports share one Grok home:

| Transport | When | History |
|---|---|---|
| Live session (default) | A request carries a conversation id (`threadId` or session id) and is an ordinary turn | One long-lived `grok agent stdio` process per conversation; history stays in the process, so a tool loop costs one seed |
| One shot | No conversation id, a compaction/prewarm/memory request, or `grokSessions.mode: "oneshot"` | One `grok -p` process per request; standalone only |

The one-shot path admits only standalone requests. Historical assistant/tool turns
and another request for a previously admitted conversation are refused before a CLI
starts, rather than automatically seeding full history again. The bounded admission
record survives handler upgrades in the process; a full restart resets it, while
historical input is still refused independently. An attempt that produced no content
and spent no allowance releases its admission, so signing in and retrying the same
turn works instead of failing as a replay. A turn that streamed content or was
charged keeps its admission; repeating that conversation is refused.

```
Codex ──request──▶ gateway ──ACP (stdio JSON-RPC)──▶ grok agent --agent-profile P stdio
                      │  ▲                                   │ MCP over loopback HTTP
                      │  └── tools/call held open ◀──────────┘ http://127.0.0.1:<port>/mcp/<token>
                      └─ yields {tool call, done}; next request answers the held call
```

## Live sessions

`grokSessions` is optional and validated like `copilotSessions`:

```json
{ "id": "grok", "type": "grok-subscription", "grokSessions": { "mode": "live", "max": 4, "parkMinutes": 30, "toolWaitMinutes": 25 } }
```

| Field | Range | Default | Meaning |
|---|---|---|---|
| `mode` | `live`, `oneshot` | `live` | `oneshot` restores the standalone-only transport |
| `max` | 1–16 | 4 | Live conversations at once. A newcomer past the cap is refused (`capacity`); no session is evicted |
| `parkMinutes` | 5–240 | 30 | A session idle after a finished turn is closed |
| `toolWaitMinutes` | 1–25 | 25 | A session waiting for tool outputs is closed (never longer than `parkMinutes`) |

**Process.** `grok agent --no-leader --agent-profile <profile> -m <model> [--reasoning-effort <e>] stdio`
with the private Grok home, `GROK_TURN_SUMMARY=false` and `GROK_TITLE_REFRESH=false`
(the CLI must not start inference of its own). `--always-approve` is never passed.
The gateway speaks ACP: `initialize`, `session/new` (one HTTP MCP server named
`gateway`), `session/prompt`, and answers every agent request itself; anything but a
permission request gets JSON-RPC error -32601. `_x.ai/*` notifications are ignored.

**Profile (mandatory).** The gateway writes a 0600 profile in a private 0700 folder
before the CLI starts: `tools: [search_tool, use_tool]`, every built-in tool under
`disallowedTools`, and the gateway system prompt plus the caller's leading
instructions as its body. Without a profile the 1.0.52 CLI ran native tools with no
permission request, so a session never starts without one.

**Tools.** The session hosts a loopback MCP endpoint on a random port behind a random
path token (and an exact `Host` check). It lists the caller's tools (the same names as
the one-shot catalog; Grok calls them `gateway__<name>`) and holds each `tools/call`
open. That call is the caller's tool call: the request ends with the call(s) and
`done` while the ACP prompt stays pending, and the next request answers the held call
with the caller's output. Parallel calls are collected until Grok is quiet for a
moment. `server/discover` and other unknown methods get "method not found".

**Permissions.** Every `session/request_permission` is answered by the gateway:

| Request | Answer |
|---|---|
| `use_tool` naming `gateway__<tool>` that is in the session's catalog | `allow_once` |
| `search_tool` | `allow_once` |
| Anything else (native tool, unknown gateway tool, other server) | `reject_once`, else cancelled |

`allow_always` is never chosen. A session that is denied 25 times is closed.

**Continuation.** A request continues a session only when its history is the previous
history plus the new items: the outputs for exactly the pending calls (no more, no
fewer, no unknown ids), or new user messages after a finished turn. Tool outputs
followed by a new user message in the same request cannot continue a held prompt and
are refused. Any mismatch (edited history, missing or duplicate results, unknown call
ids, changed instructions or tool catalog, a forced tool choice on a tool result, a
second request while one is running, or history with no session) is refused with HTTP 400
`session_continuity_unavailable` and a fixed reason (`prefix_diverged`,
`unexpected_tail`, `fingerprint_changed`, `forced_choice`, `concurrent`,
`session_missing`, `parked`, `tool_wait_expired`, `session_dead`, `session_lost`,
`interrupted`, `shutdown`, `capacity`, `ended_store_unavailable`, `ended_store_full`). A refused request never touches the session and the gateway never replays
a conversation into a new process. The history may carry a turn's reasoning summary as
typed reasoning or as assistant text; both continue the session.

**Ended conversations are final.** Once a conversation's session has ended (parked or
tool-wait expiry, a crash, a cancelled request, gateway shutdown), every later request for
it is refused with the same 400, including the original user-only request: it would pay for
the whole conversation again in a second process. A failure after the prompt was sent
(crash, invalid or malformed ACP frame, protocol violation, closed session) is reported as
that final 400 `session_continuity_unavailable` (`session_dead`), not as a retryable 502.
A sign-in failure (HTTP 401, still returned to the client) releases the conversation only
when it hits a session's very first prompt and nothing showed that inference may have
happened. The session counts as having observed inference on a finished turn, on any
`session/update` that is not a pure setup notification (`available_commands_update`,
`current_mode_update` and `config_option_update` are the setup ones: message and thought
chunks, `tool_call`, `tool_call_update`, usage, `session_info_update` and any unknown
kind all count), on any MCP `tools/call` (valid or not) and on any permission request.
Signing in and repeating a request that observed nothing works. Anything observed keeps
the record, so retrying the original request is refused (`session_dead`) and starts no
CLI: the charged work lives in the dead process. A failure before the prompt (the CLI
dies or fails to open a session) spent nothing and stays a retryable `cli_failed`.

**Ended-record store.** The record is persisted, so a gateway restart or crash does not
reopen a conversation. It is `gateway-ended-sessions.json` in the provider's Grok home
(0700 folder, file mode 0600, written atomically through a temporary file and rename),
shared by every process that uses that home:

```json
{ "version": 1, "seq": 12, "entries": { "<sha256 of provider, home, model, effort, conversation id>": { "at": 1793700000000, "reason": "parked", "seq": 12 } } }
```

Only hashes, a time, a write sequence and a fixed reason code are stored, never content.

*Cross-process safety.* Every lookup, reservation, closing and release takes the repo's
cross-process lock (`withPrivateFileLock`, the `<file>.lock` next to the store), reads the
file again from disk, and writes the whole file back before it lets go. A process never
works from a copy it read earlier, so two gateway processes sharing a Grok home cannot
overwrite each other's records. A reservation is an atomic conditional insert: it records
the conversation as `live` only when the key is absent, and otherwise returns the existing
record, which refuses the request. Of two processes admitting the same conversation, exactly one starts a CLI.
`seq` is a write counter that increases with every change, across processes. A closing
or release whose write fails is kept in memory and applied under the lock before the next
operation; lookups fail closed meanwhile.

*Live entries.* A `live` entry (recorded before the CLI starts, replaced by the end reason
when the session closes) carries its owner, `<pid>:<process start time>`. A store instance
that finds a `live` entry whose owner is not this process and is no longer running (the pid
is gone, or reused by another process) converts it to `session_lost` with a fresh
timestamp before retention is applied, so an orphan is retained for a full period from
when it is found, not from when its gateway started it. A `live` entry of another running
gateway process is left alone. A `live` entry never expires by age.

*Retention.* Entries leave only when older than 7 days, never by count. Clock guards: a
timestamp in the future counts as now (and is rewritten to now); a record 10 times older than
the retention (a clock that jumped far forward, or a gateway idle for months) is suspect and
kept, and its age starts again, so one large jump cannot drop records written recently. A
smaller forward jump (between 7 and 70 days) can still expire records early. The store holds
at most 20,000 entries; past that, a new conversation is refused (`ended_store_full`)
rather than an old record forgotten.

*Failures.* If the file cannot be read (missing is fine; unreadable, corrupt or not a
regular file is not), the lock cannot be taken within five seconds, or it cannot be written,
a new conversation is refused with `ended_store_unavailable` and no CLI starts; a request that
carries history gets its usual `session_missing`. To recover from a corrupt file, move it
aside: every conversation recorded in it can then start over, so only do that when none of
them matters.

*Temporary files.* The store writes `<file>.<writer pid>.<12 hex>.tmp` and renames it. A
write that was interrupted leaves its temporary file; under the lock, the next write removes
this store's own temporary files that are older than a minute and whose writer pid is not
running. A fresh one, or one whose writer is running, is kept; other files are never touched.

**Lifecycle.** A cancelled request, a crash, an unexpected tool call or output outside
a prompt, a timer, or shutdown closes the session: the process group gets SIGKILL, the
endpoint stops, held calls fail and the folder is removed. Sign-in failures map to HTTP
401 `authentication`; other failures use the fixed classes below. The group is always
signalled, also after the leader exited, so descendants do not outlive a session. A frame
that is not a JSON object (`null`, an array, a number) ends the connection with
`invalid_stream` and kills the process. A cancellation during startup waits for startup to
give up, then releases the folder, the endpoint and the process.

**Frames and stop reasons.** Every field read from an ACP frame is type-checked (`error.code`
a number, `error.message` a string, `result` an object, `method` a string, `id` a number or
string, `params` an object); a frame of the wrong shape ends the connection with
`invalid_stream` and kills the process. Nothing from a frame is coerced with `String()`.
The prompt's `stopReason` is mapped through an allowlist (`end_turn`, `max_tokens`,
`max_turn_requests`, `refusal`, `cancelled`); anything else is `unknown`.

**Telemetry.** `grok_session` events carry `outcome` (`spawned`, `continued`, `refused`,
`reaped`, `crashed`, `closed`, `interrupted`), `missReason` and counts (live sessions,
tool calls, permissions allowed and denied, tokens). `missReason` is always one of a fixed
list (`src/providers/grok-reasons.ts`; anything else is logged as `other`), so provider
text such as a stop reason never reaches telemetry. No tokens, request bodies, tool
arguments or environment values are logged.

```json
{ "id": "grok", "type": "grok-subscription", "label": "Grok",
  "models": { "grok/grok-4.7": "grok-4.7" },
  "modelMetadata": { "grok/grok-4.7": { "displayName": "Grok 4.7", "contextWindow": 256000, "inputModalities": ["text"] } } }
```

## Private Grok home

The gateway uses its own Grok home, `<stateDirectory>/grok-home` unless
`grokHome` names another directory. Sign it in once per Mac:

```sh
gateway login grok
```

The gateway runs the Grok CLI's device-code login against its own private home,
so the credential never lands in a personal `~/.grok`. The same flow is the
connection's Reconnect action in the desktop app. To run it by hand, set
`GROK_HOME` to that home and run `grok login --device-auth` (`--device-code` is
the CLI's alias). A clean CLI exit is not treated as success; the credential file
must exist afterwards.

A missing `auth.json` fails the request before the CLI starts, and a login the
CLI rejects mid-run is reported the same way: HTTP 401 `authentication`, with a
fixed message that names the gateway's Grok home. Neither case is reported as a
temporary upstream failure, so a retry does not hide a sign-in problem.

The gateway keeps the home private (0700) and rewrites only its managed sections
of `config.toml`: no auto-update, telemetry, memory, xAI-side tools (X search,
code interpreter) or session search, Claude and Cursor compatibility (skills,
rules, agents, MCP servers, hooks) off, and exactly one MCP server, `gateway`.
Sections the CLI writes itself are kept. A personal `~/.grok` login and its MCP
servers and skills are never used.

## Tool handoff (one shot)

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

Live sessions were qualified against Grok Build 1.0.52 with probes (an ACP session
with a loopback HTTP MCP tool, a held `tools/call` answered seconds later, and
permission allow/reject; the same CLI without the profile ran `touch` natively
without asking). The test suite uses a fake `grok` executable that speaks ACP and
never runs inference: `src/tests/grok-acp-fixture.ts`.
