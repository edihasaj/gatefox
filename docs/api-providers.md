---
summary: 'Grok/xAI, OpenCode Console and Go, OpenRouter, and custom API connections behind GateFox.'
read_when:
  - Connecting Grok, OpenCode or another API model service
  - Changing named API presets, upstream protocols or conversation headers
---

# API providers

API model services are upstream gateway providers. Existing clients keep their
normal tool execution, permissions and instructions:

```text
Codex / Claude / other client → GateFox → API model service
```

Add connection offers named presets for Grok API, OpenCode Console, OpenCode Go
and OpenRouter. Each connection has its own credential and model aliases. The
existing Responses, Anthropic and OpenAI-compatible choices accept other
compatible services through a custom URL.

| Service | Gateway transport | Base URL |
| --- | --- | --- |
| Grok/xAI API | `responses-api` | `https://api.x.ai/v1` |
| Anthropic API | `anthropic-api` | `https://api.anthropic.com/v1` |
| OpenRouter | `chat-completions-api` | `https://openrouter.ai/api/v1` |
| OpenCode Console Responses | `responses-api` | `https://opencode.ai/inference/openai/v1` |
| OpenCode Console Chat Completions | `chat-completions-api` | `https://opencode.ai/inference/openai/v1` |
| OpenCode Console Anthropic | `anthropic-api` | `https://opencode.ai/inference/anthropic/v1` |
| OpenCode Go Responses | `responses-api` | `https://opencode.ai/inference/go/openai/v1` |
| OpenCode Go Chat Completions | `chat-completions-api` | `https://opencode.ai/inference/go/openai/v1` |
| OpenCode Go Anthropic | `anthropic-api` | `https://opencode.ai/inference/go/anthropic/v1` |

OpenCode publishes models with different native APIs. Choose the API documented
for the selected model, and create another connection when models require a
different API. For example, Grok and GPT models use Responses, many open models
use Chat Completions, and Claude models use Anthropic. Gemini's native Google API
is outside the current three gateway transports. Model availability and routing
can change; use the vendor's current catalog.

Model discovery uses the configured API's `/models` endpoint when available.
Discovery accepts the upstream `display_name` or `name` as the model's label,
including OpenRouter's published names. Internal aliases remain stable for
saved chats and routing; labels do not rename the upstream model.
When a published name repeats the vendor and the provider row already shows it,
the duplicated vendor is dropped once: `DeepSeek: DeepSeek V4.1 Flash 1017`
becomes `DeepSeek V4.1 Flash 1017`, so the catalog row reads
`OpenRouter · DeepSeek V4.1 Flash 1017`. A name that does not repeat its vendor,
such as `Z.ai: GLM 5.3`, keeps its published form. The rule is applied when
discovery stores a label and when a catalog or provider list renders one, so a
saved long label from an earlier release also renders without the repetition.
Some services expose one mixed catalog at another URL; enter explicit model IDs
when that endpoint is unavailable. The wizard supports that fallback. Never
assume an entire mixed catalog works through one protocol.

For a vLLM chat provider behind a router that rejects an otherwise supported
reasoning level, an operator can set `"chatTemplateReasoningEffort": true` on
that `chat-completions-api` provider. The gateway then sends the caller's exact
effort as `chat_template_kwargs.reasoning_effort` and sets `enable_thinking`
according to the same choice. It does not map or upgrade the effort. This is
opt-in because only servers whose chat template supports these fields can honor
it. With the option absent, the standard `reasoning_effort` field is unchanged.
Keep the model's advertised levels aligned with its actual template, and verify
the router preserves these kwargs before enabling the option.

## Grok API credits

Grok API connects with an xAI API key. API credits are managed at
[console.x.ai](https://console.x.ai). A Grok or Grok Build browser login and its
included subscription allowance are a separate authentication and billing route;
the API preset does not copy that login or claim to spend its allowance.

Example provider configuration:

```json
{
  "id": "grok",
  "label": "Grok",
  "type": "responses-api",
  "baseUrl": "https://api.x.ai/v1",
  "apiKeyEnv": "XAI_API_KEY",
  "models": { "grok/main": "grok-4.7" },
  "modelMetadata": {
    "grok/main": {
      "displayName": "Grok",
      "contextWindow": 500000,
      "inputModalities": ["text", "image"],
      "reasoningEfforts": ["low", "medium", "high", "xhigh"],
      "defaultReasoningEffort": "high"
    }
  }
}
```

The app stores API keys in its existing private credential files. Configuration
can reference an owner-only `credentialFile` instead of an environment variable.
Keys and request contents never go to gateway logs.

Grok's Responses API accepts function tools. The gateway converts the caller's
custom and namespaced tools to stable function names on that wire, then restores
the original tool identity for the caller. Custom input travels in a JSON
`input` field; schemas, grammar guidance, forced choices and replayed tool results
remain associated with their original tool. Encrypted reasoning passes through
unchanged. The client continues to execute every tool.

OpenRouter Responses uses the same function-only transport on the official
`https://openrouter.ai/api/v1` endpoint, including DeepSeek Flash. Custom tools
receive an explicit `{input: string}` schema instead of a native custom-tool
declaration that the upstream may convert without its required input envelope.
Stable, namespace-safe wire names map back to the exact caller identity; forced
choices, historical calls, results and grammar guidance follow the same mapping.
Arbitrary Responses endpoints and Codex subscriptions keep their native wire.
Responses tool-name/catalog mismatches report the separate `tool_identity_failure`
category. Fixed diagnostic reasons distinguish `missing_tool_name`,
`unknown_wire_tool`, `unexpected_tool_namespace` and `undeclared_tool`.
The error also retains the actual stream boundary and event counts. It never
records tool names, namespaces, arguments or request/response content. These
failures remain final: the rejected tool is not dispatched and inference is not
automatically replayed. This classification does not change tool matching.
The bridge sends opaque wire names, but a model may answer with the readable name
it was shown in the tool description. When the exact wire name is not found, a
returned name is accepted only if it selects exactly one declared tool: its alias
(`exec_command`, `files.read`), the alias with a `functions.` prefix, or the wire
name differing only in ASCII letter case (a look-alike Unicode letter never matches); every one of these spellings is considered together,
so a name that two tools could claim is refused. An ambiguous or undeclared name, and any
near miss, still fails as `unknown_wire_tool`; there is no fuzzy matching, and
arguments are never changed.
Malformed custom function arguments fail before tool dispatch as
`invalid_tool_call`, without automatic inference replay. A writer-level custom
output failure also reports a provider-output error, rather than blaming the
caller's request. No tool arguments or provider output are logged.

Source: [OpenRouter Responses tool calling](https://openrouter.ai/docs/api_reference/responses/tool-calling).

## OpenCode conversation routing

For official OpenCode inference endpoints, all three transports identify the
gateway with its own user agent and send `x-opencode-session` from the caller's
thread ID, falling back to its session ID. The same conversation keeps that ID
across tools, follow-ups and compaction. Native `x-opencode-session` headers on
gateway ingress are also accepted as caller session IDs. A request with no
conversation ID does not invent one or group unrelated requests together.

These headers are restricted to the official HTTPS OpenCode API routes; they are
never added to xAI, OpenRouter or arbitrary custom origins. OpenRouter receives
its own session header only at its official API endpoint, as described below. The gateway enables
no provider-hosted search, shell or coding tools.

## OpenRouter prompt-cache affinity

DeepSeek and Z.AI/GLM use automatic prefix caching. They do not require
Anthropic-style cache markers. On the official `https://openrouter.ai/api/v1`
endpoint, all API transports send `x-session-id` from the caller's explicit
`session_id`, then `prompt_cache_key`, then its existing thread/session ID.
This preserves an explicit cache key's grouping, including shared fork keys.
Missing or invalid identifiers do not create new identities or go into logs.
The Responses transport also preserves the caller's body cache fields.
For OpenRouter Responses, equivalent function/custom catalogs and namespace
members use stable declaration order and schema object keys. Conversation items,
tool arguments/results, schema arrays, explicit cache keys and instructions retain
their values and order. Native Codex and other Responses origins keep their
existing serialization.

Large cold Responses requests produce count-only `api_cache_cold` diagnostics.
They distinguish a first measured request from changes to tool declarations,
instructions, opening text or affinity. Comparisons use bounded process-memory
digests; no digests, identities or request content enter logs. Stable comparisons
do not prove that an upstream provider retained its cache.

OpenRouter documents this header for Chat and Responses. An explicit session
activates provider stickiness on the first successful request, before a cache
hit has been observed, and supplies Z.AI's session cache affinity. Without it,
OpenRouter can fall back to a cache key or hashes of the opening messages.
Manual provider order, endpoint eligibility and vendor cache expiry still apply;
the gateway does not change provider selection or cache retention settings.

`gateway diagnostics` reports `cacheHit` as cached input tokens divided by
reported total input tokens, not the fraction of requests that hit a cache.
Short/cold requests, new workers and changed prefixes can legitimately show
zero. Longer cache lifetimes can charge more for writes, so the gateway leaves
explicit TTL choices with the caller rather than forcing a long global TTL.

Checked 26 October 2026 against [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[Z.AI context caching](https://docs.z.ai/guides/capabilities/cache), and
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Self-hosted session affinity

A self-hosted Chat Completions router that hashes requests by session, such as
vllm-router with `consistent_hash`, can keep each conversation on the worker that
holds its prefix cache. Opt in with `"sessionAffinity": true` on that
`chat-completions-api` provider. The gateway then sends the caller's thread ID,
falling back to its session ID, as a `session-id` header. Subagents have their
own thread IDs, so they spread across workers while each keeps its own cache.

Without this setting the router has no session key, hashes each request body,
and sends every turn to an effectively random worker with a cold cache. The
setting is off by default, accepted only on `chat-completions-api` providers,
and never invents an ID for a request that has none.

## Self-hosted models

Set `"selfHosted": true` on a loopback or tailnet provider that runs its own model.
[Cache safety](cache-safety.md) then records repeated cache misses without stopping the
worker. Leave it off for a local proxy that forwards to a metered upstream.

## Context window cap

Discovery and the periodic metadata refresh copy each model's window from the
server, such as vLLM's `max_model_len`. A self-hosted server can accept more
than its clients should use, because a cold long prompt is slow to prefill.
Set `"contextWindowCap"` in that alias's `modelMetadata` to keep a lower
ceiling. The refresh, `gateway discover --load` and the Codex catalog then
never advertise a `contextWindow` or `maxContextWindow` above the cap. Other
discovered metadata still updates, and aliases without a cap are unchanged.

```json
"modelMetadata": {
  "qwen/qwen3.8-flash-next": { "contextWindow": 262144, "contextWindowCap": 262144 }
}
```

## Sources and verification

Checked on 19 October 2026:

- [xAI API quickstart](https://docs.x.ai/developers/quickstart)
- [xAI models](https://docs.x.ai/developers/models)
- [xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [OpenCode Console models and endpoints](https://opencode.ai/v2/docs/console/models)
- [OpenCode Go endpoints and session requirements](https://opencode.ai/v2/docs/console/go)

Mock transport tests cover every listed API shape, credential forwarding and
session-header isolation. Native tests cover preset selection and protocol
mapping. Tests do not send paid inference or verify an account's credit balance.
