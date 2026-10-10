---
summary: 'Supported Responses items, native tools, streaming, reasoning, and failures.'
read_when:
  - Changing Responses request parsing, tools, replay, or SSE output
---

# Responses support

The Claude adapter accepts text messages, function calls and outputs, custom tool
calls and outputs, and function/custom tools grouped in namespaces. It also accepts
the older nested function definition format for existing Chat Completions clients.

Claude tool definitions become native virtual MCP declarations. Native calls
return with their original name, namespace, and call ID. Custom tool input returns
as a string rather than JSON-encoded function arguments. The caller validates and
executes the tool; the gateway does not execute it or enforce grammar constraints.

Replayed reasoning summaries are treated as text. Encrypted reasoning transport
state is not exposed to the Claude model. Image input and hosted tools are outside
the current Claude adapter's scope. Unsupported item and tool types return a
client error instead of an internal crash.

Text streams through Responses SSE as the provider emits it. Tool arguments are
returned when the native call is complete. Claude's thinking events and Codex's
reasoning summaries use Responses reasoning-summary events. An effort setting
does not guarantee that a provider emits reasoning on every request. The gateway
does not invent reasoning. Claude's native thinking signatures are not replayed;
Codex's opaque encrypted reasoning state is wrapped with its account route and
restored only on that route. Switching providers or accounts retains readable
summaries as assistant history and drops incompatible opaque state. Untagged
reasoning imported from another client also retains only its readable summary.
Use a new provider ID and credential file for a new account.
Generated Codex settings explicitly request `model_reasoning_summary = "auto"`.
The client can set it to `none` to hide provider reasoning.
Some Claude CLI versions expose token progress with empty thinking text. The
gateway emits a reasoning item and empty summary deltas with an `estimated_tokens`
extension. It preserves that distinction instead of fabricating a summary.

Authentication and capacity failures before inference return HTTP errors.
Failures after streaming begins emit `response.failed`; they never emit a successful
completion. Disconnects abort inference and release capacity. Codex stream retries
are disabled to avoid repeating partially completed actions.

The current adapters support text and caller-dispatched tools. Image/audio input,
hosted tools, previous-response-ID state, and every provider's full option surface
are not supported. This is not a claim of complete Responses API compatibility.
