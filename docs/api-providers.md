---
summary: 'Grok/xAI, OpenCode Console and Go, OpenRouter, and custom API connections behind Harness Gateway.'
read_when:
  - Connecting Grok, OpenCode or another API model service
  - Changing named API presets, upstream protocols or conversation headers
---

# API providers

API model services are upstream gateway providers. Existing clients keep their
normal tool execution, permissions and instructions:

```text
Codex / Claude / other client → Harness Gateway → API model service
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
Some services expose one mixed catalog at another URL; enter explicit model IDs
when that endpoint is unavailable. The wizard supports that fallback. Never
assume an entire mixed catalog works through one protocol.

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

## OpenCode conversation routing

For official OpenCode inference endpoints, all three transports identify the
gateway with its own user agent and send `x-opencode-session` from the caller's
thread ID, falling back to its session ID. The same conversation keeps that ID
across tools, follow-ups and compaction. Native `x-opencode-session` headers on
gateway ingress are also accepted as caller session IDs. A request with no
conversation ID does not invent one or group unrelated requests together.

These headers are restricted to the official HTTPS OpenCode API routes; they are
never added to xAI, OpenRouter or arbitrary custom origins. The gateway enables
no provider-hosted search, shell or coding tools.

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
