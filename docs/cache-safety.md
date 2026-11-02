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
The separate Claude Desktop native auxiliary classifier also uses this guard,
with its own account/model budget. Its runner reports count-only cache usage
before a later stream failure as well as on success. Missing cache fields remain
unknown; the helper cannot reset the ordinary chat budget or opt into its
compaction recovery budget.

During active work, two consecutive requests that each have at least 65,536 uncached input tokens
and more uncached than cached tokens stop the next request before provider
execution. A read covering at least 75% of the preceding cached prefix is treated
as reuse, so genuinely large new tool results do not cause a false rewrite alarm.
Two large inputs whose cache usage is unreported also stop, with a distinct
explanation: unknown cache usage is never presented as a measured zero.

Five minutes without request activity starts a fresh warm-up period. An idle
chat can legitimately lose its provider cache or live session, so a cold seed
after that gap does not combine with an old miss to block its first continuation.
Request attempts (including blocked retries) and completions refresh activity.
A per-conversation in-flight count prevents overlapping long requests from
expiring each other's history; it is released even on error or cancellation.
A long-running inference is therefore not mistaken for idle time, and continuous
retry loops cannot age their own block away. Actual cache reads still clear the
consecutive-miss count. Intermittent misses separated by successful reuse do not
constitute continuous uncached processing under this policy.

Hot-adopted entries from an older release without activity timestamps keep their
existing block until the new guard observes an idle interval; missing historical
timestamps never manufacture a reset. Provider, model and caller identity remain
the scope. No new user turn, reconnect or provider reseed alone resets the guard.

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
