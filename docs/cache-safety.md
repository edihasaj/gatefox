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

A provider declared `selfHosted: true` is measured but never stopped. It records
`outcome: observed` where another provider would record `blocked`, and the request
runs. A cache miss on a model you run yourself costs prefill time, not quota or credit,
and stopping the worker only moved its task onto a metered fallback. Qwen lost eleven
worker turns this way between 1 and 3 November 2026. Gateway requires a loopback or
tailnet inference provider for this setting but never infers it, because a local
address can be a proxy to a metered upstream. Leave it off for anything that forwards.

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

The idle-aware policy's one-time adoption grants inactive inherited histories a
fresh bounded warm-up, including old entries without trustworthy timestamps.
In-flight conversations retain their history. A process-wide adoption marker
prevents later module reloads from repeatedly clearing a safety stop. A late
legacy write after that handoff stays conservative until real idle is observed.
Provider, model and caller identity remain
the scope. No new user turn, reconnect or provider reseed alone resets the guard.

A cache failure receives a final HTTP 400 or terminal stream error explaining
that cache/session continuity needs repair. It never reports
`context_length_exceeded`, marks a client's context full, or instructs automatic
compaction. Real provider context overflows retain their normal context-limit
code. Unchanged reconnects cannot repeat costly inference. Legacy
`x-harness-cache-recovery: 1` headers remain accepted for compatibility but do not
authorize compaction or bypass the budget.

Claude's default live policy avoids a redundant one-shot warmup for identified
histories whose serialized conversation is at least 256 KiB: it seeds the live
CLI directly, so the next request can append to that same native history. This
is a transport-size heuristic, not a tokenizer or context-window limit. Explicit
`claudeSessions.warmup` choices remain authoritative. Small requests, standalone
compaction/prewarm/memory requests, replay mode, capacity checks and preserved-
session refusals retain their existing behavior. No extra cache miss or hidden
inference retry is allowed.

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

## Recovery verification

Run `node scripts/e2e-cache-recovery.mjs --package INSTALLED_PACKAGE --code CHECKOUT
--root TASK_DIRECTORY` after building the checkout. The isolated real SDK must
allow two measured cold calls and stop the third without reporting context
exhaustion. An unchanged retry must remain blocked without automatic compaction
or another provider call. A separate explicit caller compaction command may then
compact once and continue with smaller input in the same chat and model. The
fixture uses synthetic inference and no account. `--sdk ABSOLUTE_CANDIDATE`
qualifies a newly built Gateway SDK before packaging.
The existing Gateway-only SDK accounting fix remains available for genuine
context overflows. Cache safety no longer invokes that context-full marker.
