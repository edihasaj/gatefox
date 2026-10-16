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
| `POST /v1/messages/count_tokens` | Returns an explicit unsupported response. Claude Code uses its own context estimate. |
| `POST /v1/responses` | Retains the existing Responses client behavior. |

Messages requests use the existing gateway client credential in either
`Authorization: Bearer ...` or `x-api-key`. Conflicting credentials fail closed.
They are client credentials for this gateway, not upstream provider credentials.
Provider authentication remains on the inference host.

Token counting is optional in the Claude Code gateway contract. The gateway does
not return fabricated exact token counts. Endpoint absence or the unsupported
response lets Claude Code use its own character-based estimate.

## Claude Code setup

Generate an opt-in settings file from the existing gateway configuration:

```sh
mkdir -p work
gateway claude-config --model codex/gpt-6.1-sol > work/claude-gateway.settings.json
claude --settings work/claude-gateway.settings.json --model codex/gpt-6.1-sol
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
gateway claude-config --model codex/gpt-6.1-sol \
  --endpoint http://127.0.0.1:3459/v1 \
  --token-file /absolute/path/to/gateway-client.token \
  > work/claude-remote.settings.json
claude --settings work/claude-remote.settings.json --model codex/gpt-6.1-sol
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
