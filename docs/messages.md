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

The file contains `model`, `env.ANTHROPIC_BASE_URL`, and an `apiKeyHelper` command.
The helper reads the existing scoped client credential when Claude needs it;
the settings contain no token value. The SDK base URL omits a trailing `/v1`
because Claude Code appends `/v1/messages` itself. An endpoint ending in `/v1`
is accepted by the generator and normalized for this purpose.

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

## Context overflow

When the upstream rejects a request for exceeding the model's context window, the
Messages reply is a 400 `invalid_request_error` whose message starts with
`prompt is too long`, on the JSON path and as the SSE `error` event. Claude Code
recognizes only that text as a prompt-too-long error, so this is what lets its
reactive auto-compact run. When the provider reported the counts, as the
Anthropic API and the Claude CLI do in `prompt is too long: <n> tokens > <max>
maximum`, the message repeats them and Claude Code reads the token gap from it.
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

## Verification

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
