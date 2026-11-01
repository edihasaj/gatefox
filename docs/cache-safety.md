---
summary: 'Shared cache-reuse safety stops for large contexts across every Gateway provider and client.'
read_when:
  - Investigating subscription drain, repeated uncached contexts or a cache safety stop
  - Adding a provider, ingress protocol or partial usage observation
---

# Large-context cache safety

Every inference request through Gateway's Responses and Messages APIs passes the
same cache guard. This includes Codex, Claude, Copilot, Grok, local models and
OpenRouter or other API providers. Desktop, CLI, mobile and other clients using
those APIs receive the same protection on every supported host OS. WebSocket
inference upgrades remain unsupported and are refused before provider execution.
SDK control WebSockets do not bypass the downstream inference guard.

Two consecutive requests that each have at least 65,536 uncached input tokens
and more uncached than cached tokens stop the next request before provider
execution. A read covering at least 75% of the preceding cached prefix is treated
as reuse, so genuinely large new tool results do not cause a false rewrite alarm.
Two large inputs whose cache usage is unreported also stop, with a distinct
explanation: unknown cache usage is never presented as a measured zero.

The client receives a final HTTP 400, or a terminal stream error, explaining the
cache problem and how to compact or start a fresh chat on the same model.
It must not reconnect and repeat unchanged inference. Gateway never truncates,
compacts, changes the model, changes permissions or executes caller tools.

The guard is scoped to the provider binding, model and stable caller thread or
session. Anonymous requests share their binding/model budget. Count-only state
survives client reconnects and in-place upgrades. It retains at most 4,096 recent
entries; a full inference-process restart or eviction resets that history.
Already-running concurrent requests cannot be recalled. This is a per-caller
safety stop, not an account-wide spending ceiling.

The client can recover with conversation input at most half the byte size of the
failed input; fixed top-level tools, instructions and metadata do not count toward
that comparison. Compaction requests have a separate budget so they remain
available for recovery, while repeated cold compactions also stop. Instructions
inside the conversation retain their roles and count as conversation input.

The guard records each request's usage once. Providers can supply an internal,
count-only observation before a terminal error: Claude CLI message-start usage,
Anthropic message-start usage, Chat Completions usage chunks and Responses
terminal usage are observed before later validation can fail. Copilot and other
adapters' running usage events also feed the guard. Missing measurements do not
erase a prior failure; input never reported by a provider cannot be measured.

`context_cache_guard` records only a hashed key, mode, fixed reason and count.
It appears in recent diagnostics. Request bodies, instructions, tools and
credentials are never saved by the guard.

Direct Claude/Codex subscriptions or other clients that bypass Gateway are
outside this enforcement boundary. No native application or external runtime
is patched by this feature.
