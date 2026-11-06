---
summary: 'Native Anthropic Messages ingress and Claude Code client settings for the shared gateway model catalog.'
read_when:
  - Connecting Claude Code or an Anthropic-compatible client to the gateway
  - Changing Messages parsing, streaming, tool replay, or client configuration
---

# Messages clients

The gateway accepts each client's native protocol and routes the selected public
model alias through the existing provider adapters. Codex uses Responses;
Claude Code uses Anthropic Messages. A Messages client can select GPT, Claude,
or a local model from the same configured catalog.

```text
Codex / Responses client --------+
                                +-- gateway routing -- GPT / Claude / local API
Claude Code / Messages client --+
```

The gateway translates inference requests and replies. The calling harness still
owns its instructions, roles, model selection, permissions, and tool execution.
A provider returns a tool call; the client executes that tool and sends its
result on the next request. The same HTTP integration works across harnesses;
existing subscription adapters retain their native CLI or API transports.

## Endpoints and authentication

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/messages` | Accepts a native Messages request and returns JSON or Messages SSE. |
| `POST /v1/messages?beta=true` | Uses the same route; routing matches the pathname. |
| `POST /v1/messages/count_tokens` | Returns a 501 in the normal error envelope. Claude Code uses its own context estimate. The gateway records one `request_unsupported` telemetry event (`route`, `endpoint`), not `request_failed`, and prints no diagnostic. |
| `POST /v1/responses` | Retains the existing Responses client behavior. |

Messages requests use the existing gateway client credential in either
`Authorization: Bearer ...` or `x-api-key`. Conflicting credentials fail closed.
They are client credentials for this gateway, not upstream provider credentials.
Provider authentication remains on the inference host.

Claude Code's structured JSON `metadata.user_id` carries a conversation UUID
alongside device and account fields. Gateway extracts only that bounded UUID into
internal session routing. Explicit valid session/thread headers take precedence;
arbitrary user IDs, malformed JSON and invalid UUIDs never group conversations.
Device and account identity fields are not forwarded. Live Claude and Copilot
adapters can use this session identity without a Codex thread header. Each client
still owns its saved chat, archive, permissions, instructions and tool execution.

A subagent reuses its parent's UUID with a different history. Gateway combines it
with a hash of `x-claude-code-agent-id` so each subagent has its own conversation
and cannot disturb its parent's live session. Each one can therefore hold its own
live session, which counts toward `claudeSessions.max`.

Token counting is optional in the Claude Code gateway contract. The gateway does
not return fabricated exact token counts. Endpoint absence or the unsupported
response lets Claude Code use its own character-based estimate.

## Claude Code setup

Use one Harness Gateway client directory, with each client's native configuration
kept separately. These are opt-in paths; the generators write to stdout and do
not move an existing client home or migrate its settings.

```text
~/.config/harness-gateway/clients/
├── codex/config.toml
└── claude/settings.json
```

Both clients connect to the same gateway listener and provider catalog. For an
isolated Codex CLI home:

```sh
gateway_client_root="$HOME/.config/harness-gateway/clients"
gateway_codex_home="$gateway_client_root/codex"
mkdir -p "$gateway_codex_home"
gateway codex-config --model claude/claude-sonnet-5-5 \
  > "$gateway_codex_home/config.toml"
CODEX_HOME="$gateway_codex_home" codex
```

This separate home has its own Codex state. Existing custom roles, profiles, and
skills are not copied automatically. Preserve them when integrating gateway
provider settings into a normal client setup.

Generate Claude Code's settings from the same gateway configuration:

```sh
gateway_client_root="$HOME/.config/harness-gateway/clients"
mkdir -p "$gateway_client_root/claude"
gateway claude-config --model codex/gpt-6.1-sol \
  > "$gateway_client_root/claude/settings.json"
claude --settings "$gateway_client_root/claude/settings.json" --model codex/gpt-6.1-sol
```

Choose a public gateway alias, such as `codex/gpt-6.1-sol`,
`claude/claude-opus-5-5`, or `qwen/qwen3.8-flash-next`, that is present in the
configured catalog. The generator validates the choice. It does not register a
provider, log in to an account, rewrite the user's main Claude settings, or
generate agent roles.

The file contains `model`, `env`, `modelPicker`, and an `apiKeyHelper` command.
The helper reads the existing scoped client credential when Claude needs it;
the settings contain no token value. The SDK base URL omits a trailing `/v1`
because Claude Code appends `/v1/messages` itself. An endpoint ending in `/v1`
is accepted by the generator and normalized for this purpose.

| Setting | Why it is there |
| --- | --- |
| `env.ANTHROPIC_BASE_URL` | Points Claude Code at this gateway. |
| `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` | Asks Claude Code to label compaction and side requests; see [hint headers](#hint-headers). |
| `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Declares the launch model's catalog window so compaction runs at the right point. It is left out when the model's window is unknown, because the catalog's 32,768 placeholder does not describe the model. A remote client sees only the public catalog, so a model there whose real window is exactly 32,768 is also left out. |
| `effortLevel` | Starts on the launch model's default effort when the model offers one and it is a level Claude Code keeps from settings (`low`, `medium`, `high`, `xhigh`), because Claude Code's own default can be a level the route refuses. |
| `modelPicker` | Lists the catalog's visible aliases in `/model`, plus the launch model. Claude Code's own discovery keeps only IDs containing `claude` or `anthropic`, so it would hide GPT and Qwen. |

`modelPicker` replaces the built-in rows because they name models this gateway may
not serve. Claude Code keeps its own **Default** row, which still names a Claude
model. The context window is a per-process value, so it stays at the launch model's
size after a `/model` switch: generate settings for the model you start on, and
rely on the `prompt is too long` recovery below if you switch to a smaller one.
The effort also carries across a switch. A route that does not offer it refuses the
request with `does not support this reasoning effort`; choose another with `/effort`.
A Chat Completions route with no reasoning levels refuses every effort, so Claude
Code needs a route whose levels are known.

The helper command uses POSIX shell quoting. Settings generation on Windows is
explicitly unsupported rather than emitting an unsafe command string. The HTTP
protocol itself does not depend on that shell convention.

For an authenticated remote gateway reached through HTTPS or a local SSH tunnel:

```sh
gateway_client_root="$HOME/.config/harness-gateway/clients"
mkdir -p "$gateway_client_root/claude"
gateway claude-config --model codex/gpt-6.1-sol \
  --endpoint http://127.0.0.1:3459/v1 \
  --token-file /absolute/path/to/gateway-client.token \
  > "$gateway_client_root/claude/settings-remote.json"
claude --settings "$gateway_client_root/claude/settings-remote.json" --model codex/gpt-6.1-sol
```

Remote generation validates the public model catalog. It never downloads
upstream account credentials. Keep any existing task policy and agent definitions
in the client. A role that selects a model must use an alias the gateway knows;
the gateway does not silently choose another provider or account.

## Messages compatibility

The adapter translates the core text/image and caller-tool conversation into the
gateway's established internal request representation. Outbound adapters remain
specific to their provider; an Anthropic client is not forced to send Responses,
and an Anthropic upstream is not forced to accept that wire format.

Streamed replies use the native Messages event sequence, including content-block
boundaries, `message_delta`, and `message_stop`. Quiet requests receive SSE pings.
An upstream failure or disconnect is not represented as a successful completion.
Tool IDs, names, arguments, and client results remain associated across turns.

System instruction text and priority are retained through provider-specific
normalization. Native control fields must be translated or explicitly rejected;
unsupported instructions, hosted tools, and destructive context edits must not
disappear silently.

The Anthropic API adapter keeps initial system text blocks separate so an
attribution block cannot swallow later instructions. It rejects mid-conversation
system messages rather than changing their position.

Chat Completions uses its established leading-system representation for both
client protocols: all system/developer instruction text is combined, in its
original instruction order, into one leading system message. This normalizes
system-message positions for templates such as Qwen that reject a later system
role. User, assistant, and tool replay retain their conversation order; system
instructions are never downgraded to user text.

The installed Claude Code request shapes used during development include
adaptive thinking with `omitted` or `updates` display, an effort in top-level or
system-message `output_config`, cache markers, and a preserve-all thinking context
edit. Those control fields are separate from the user's instructions and tool
arguments.

Per-message effort follows the new-user-input boundary: an override after new
user input affects its reply; otherwise it waits for the next new user input.
Tool-result-only messages do not activate a pending change. The current effective
effort becomes the upstream request setting; historical native effort boundaries
are not preserved. Unsupported output controls and native `safeguards` return
an explicit request error. The settings generator does not change permission
mode or allow rules.

The optional `service_tier` field forwards the caller's speed selection to the
provider independently of reasoning effort on Claude and Codex subscriptions
and Responses API routes. Tier IDs must be lowercase and at most 128 characters;
provider capability checks still apply. Transports without speed support reject
nonstandard tiers instead of silently discarding the selection.

Adaptive thinking and its display preference are accepted. Explicitly disabling
thinking and fixed thinking-token budgets return an unsupported request error
because the current bridge cannot enforce those controls across providers.
Output reasoning summaries are omitted rather than wrapped in unsigned or
synthetic thinking blocks. Readable prior thinking remains semantic history;
foreign opaque signatures and redactions are not replayed as valid provider state.

Cache markers are validated and then dropped as advisory hints. This translation
does not promise native Anthropic cache-boundary fidelity. A tool result marked
`is_error` becomes a client tool result with a fixed `[Tool error] ` text prefix;
empty tool results and empty stop-sequence lists remain valid no-ops.

## Hint headers

Generated settings turn on Claude Code's hint headers. A client that does not send
them keeps the behavior it had before.

| Header | Gateway behavior |
| --- | --- |
| `x-claude-code-compaction`, or request class `compaction` | Runs as a `compaction` request: one-shot, with the separate compaction cache budget, and a success permits one replacement history. |
| Request class `auxiliary` | Runs as an `auxiliary` request: one-shot and outside the conversation's replay and cache budgets, so a title or classifier cannot replace a live session's history. |
| Any other class, or an unknown value | Treated as an ordinary turn. |

Gateway reads these headers on Messages requests only, and does not forward them.

## Context overflow

When the upstream rejects a request for exceeding the model's context window, the
Messages reply is a 400 `invalid_request_error` whose message starts with
`prompt is too long`, on the JSON path and as the SSE `error` event. Claude Code
recognizes that text (and `input is too long for requested model`) as a
prompt-too-long error, so this is what lets its reactive auto-compact run. When
the provider reported the counts in `prompt is too long: <n> tokens > <max>
maximum`, as the Anthropic API does, the message repeats them and Claude Code
reads the token gap from it. Current Claude CLIs report an overflow without counts
(`Prompt is too long`, or a longer `Prompt is too long · …` form, or
`terminal_reason: "prompt_too_long"`), so on Claude subscription routes the reply
carries no counts and Claude Code compacts with its own fallback.
Otherwise the message reads `prompt is too long: the request exceeds the model's
context window`. Only the two numbers are kept; no other upstream text is
repeated. Responses errors are unchanged.

## Provider limits

`max_tokens` is required by Messages. API adapters enforce an output limit when
their provider supports it. A genuine provider output-limit terminal maps to the
Messages `max_tokens` stop reason; truncated tool arguments are never dispatched
as a complete tool call. Existing Responses truncation behavior is unchanged.

Some subscription transports do not expose an enforceable per-request output
limit. For those Messages routes the gateway reports
`X-Gateway-Output-Limit: provider-managed`; it does not claim that the requested
limit was enforced. This compatibility behavior is specific to Messages ingress
and does not weaken the existing Responses option validation.

Usage comes from provider events when available. Claude Code may estimate a price
or context window for an unfamiliar model alias; those client estimates do not
establish the upstream model's actual price or maximum context. The gateway
neither invents reasoning signatures nor promises that every provider supports
every native Claude feature.

The separate Claude Desktop inference service can explicitly enable
[empty completion recovery](claude-desktop.md#empty-completion-recovery) for
selected Chat Completions providers. Its ledger includes both attempts, while
the successful Messages reply reports the final attempt's context usage.
The ordinary shared gateway and Responses requests do not enable this policy.

## Usage accounting

A Messages request runs through the same request handler as a Responses request,
so telemetry and the [usage ledger](diagnostics.md#usage-ledger) record it the same
way: one row per finished request with the same token counts, Copilot credits and
status, including the usage of a request that fails or whose client leaves after
the provider reported it. On `copilot-subscription` and `claude-subscription` routes,
while the ledger is on, the message id is `msg_gl_<request id without dashes>` and
the ledger row records that id, just as Responses requests carry `resp_gl_`. The two
prefixes are the `gatewayMarkerPrefixes` list in `src/usage-ledger.ts`; the
[diagnostics](diagnostics.md#usage-ledger) page says how a consumer reads them.

The reply's `usage` reports `cache_read_input_tokens` and, where the provider reports
cache writes in its usage (Claude subscription and the Anthropic API),
`cache_creation_input_tokens`; `input_tokens` excludes the cache reads and, on those
routes, the cache writes. Copilot reports no separate cache-write field to the
reply, so its cache writes stay inside `input_tokens`. Copilot credits, reasoning
token counts and the Copilot cache-write figure stay in the local ledger and never
appear in the reply. A Responses reply never carries cache writes.

## Known request rejections

Claude Code sends some fields Gateway cannot honor. Each one fails clearly, and the
[update check](provider-updates.md#claude-code-request-shapes) fails on any field
that is not listed here.

| Field | Result |
| --- | --- |
| `safeguards` | Claude Code retries without it and uses its built-in auto-mode classifier; see [auto mode](#auto-mode). |
| Tool `defer_loading` | Tool search is unsupported. From Claude Code 2.1.305 the client retries with every MCP tool loaded upfront. On 2.1.299, setting `ENABLE_TOOL_SEARCH=true` ends in `API Error: 400`. |
| Mid-conversation `system` messages on `anthropic-api` routes | The route refuses them, and Claude Code 2.1.299 sends them on every request without recovering. **`anthropic-api` routes do not currently work with Claude Code.** The update check records this and continues. |

## Auto mode

Auto mode asks a classifier to review actions before Claude Code runs them. That
request names `claude-sonnet-5`, disables thinking, and has no tools. Gateway sends
exactly that shape to a real Claude model, through the same restricted one-turn,
tool-free CLI run that Claude Desktop uses:

```text
classifier request
  ├─ exact shape + one Claude subscription route → one-turn Claude review
  └─ anything else → refused → Claude Code tries its fallback, then denies the action
```

The route must be unambiguous. With two Claude accounts, set `defaultForBareModels`
on one, or the request is refused. Gateway invents no verdict: a refusal, a
truncated reply or an unavailable CLI stays a failure. Requests are limited to
256 KiB and two at a time, and each review spends the Claude subscription.

| What to expect | Why |
| --- | --- |
| An action you asked for by name can run, even a risky one | Auto mode weighs user intent. It is not a sandbox. |
| With no Claude route, a Chat Completions main model reviews its own actions | When the first review fails, Claude Code retries on the main model with `stop_sequences`. Chat routes accept that, so Qwen would act as the reviewer. Subscription and Responses routes refuse it, and the action is denied. |

On November 6, 2026, real Claude Code 2.1.299 ran in auto mode with a scripted main
model and real Claude review. It denied a piped remote script, a credential upload
and `rm -rf ~/Documents`, none of which the user had asked for, and allowed `git
status`. When the user asked by name for a piped script, it allowed the command.

## Verification

For session continuity with real client processes and synthetic backend inference:

```sh
node scripts/e2e-client-sessions.mjs \
  --package /absolute/path/to/verified/installed/package \
  --claude /absolute/path/to/claude \
  --code /absolute/path/to/harness-gateway \
  --root /tmp/fresh-client-session-proof
```

It checks Claude Code Write/Read and Codex app-server command execution, saved-chat
resume and follow-up, requiring one backend process per client conversation.
Private homes isolate the clients, and native configuration hashes must remain
unchanged. This fixture sends no paid inference and does not establish provider
cache-hit rates or billing parity. Real provider verification remains separate.

Run the repository gates first:

```sh
npm run build
npm test
```

The native client smoke uses an explicit provider configuration and model alias:

```sh
GATEWAY_E2E_CONFIG=/absolute/path/to/gateway.json \
GATEWAY_E2E_MODEL=codex/gpt-6.1-sol \
node scripts/e2e-claude.mjs
```

It creates a separate candidate configuration, listener, state directory, and
Claude settings home. A native Claude Code session must call tools to write and
read an exact random proof. The session uses `dontAsk` with an allowlist restricted
to the proof file. The script checks the actual file and the client result
rather than treating an HTTP success as proof. The installed gateway
service and the user's default Claude/Codex configuration stay in place.

Use the existing Codex client checks to verify the reverse direction. Fixture
tests cover parsing and transport behavior; a real provider run establishes the
additional account, model, and tool-loop path. Record the selected models and
remaining untested features when reporting a run.

On 15 October 2026, native Claude Code 2.1.299 passed the Write/Read proof through
`codex/gpt-6.1-sol`, `qwen/qwen3.8-flash-next`, and `claude/claude-sonnet-5-5`,
using `dontAsk` and exact proof-file permission rules. Native Codex 0.162.1 also
passed the reverse route through `claude/claude-sonnet-5-5`: streaming, file read,
patch, follow-up, reasoning, switching to GPT and back, cancellation, and recovery.
These runs used isolated candidate listeners and state directories with existing
provider registrations. They did not restart the installed gateway service or
change the user's default client configuration.

## Protocol references

- [Claude Code gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol)
  describes native endpoints, control fields, streaming, and optional token counting.
- [Claude Code gateway connection](https://code.claude.com/docs/en/llm-gateway)
  describes the gateway integration and Anthropic's support boundary for non-Claude models.
- [Claude per-message effort](https://platform.claude.com/docs/en/build-with-claude/effort#per-message-effort-beta)
  describes effort changes and the new-user-input boundary.
- [Claude file permissions](https://code.claude.com/docs/en/permissions#read-and-edit)
  describes the Read/Edit rules used by the isolated smoke test.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
  describes the Responses tool-call and client-result loop used by GPT upstreams.
