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
and stopping the worker only moved its task onto a metered fallback. Qwen lost ten
worker turns this way between 1 and 3 November 2026. Gateway requires a loopback or
tailnet inference provider for this setting but never infers it, because a local
address can be a proxy to a metered upstream. Leave it off for anything that forwards.

During active work, a request with at least 65,536 uncached input tokens
and more uncached than cached tokens counts as a large cache miss. After two
consecutive measured misses, Gateway allows one more caller request to establish
reuse. If that request is also cold, the fourth request stops before provider
execution. This tolerates a temporary provider cache loss without an unlimited
resend loop. Cache expiry or routing changes can happen upstream during active
work; a cache miss does not establish that the person caused it.
A read covering at least 75% of the preceding cached prefix is treated
as reuse, so genuinely large new tool results do not cause a false rewrite alarm.
A miss streak containing unreported cache usage or a provider refusal keeps the
two-miss limit. Unknown cache usage has a distinct explanation and is never
presented as a measured zero.

Before a safety stop, five minutes without request activity starts a fresh warm-up period. An idle
chat can legitimately lose its provider cache or live session, so a cold seed
after that gap does not combine with an old miss to block its first continuation.
Admitted request attempts and completions refresh activity.
A per-conversation in-flight count prevents overlapping long requests from
expiring each other's history; it is released even on error or cancellation.
A long-running inference is therefore not mistaken for idle time.
Once the miss limit is reached, a fixed five-minute cooldown starts. Blocked
retries do not move its deadline. After it expires, Gateway allows one recovery
probe on the next caller request. Another large miss starts another cooldown;
expiry does not grant a full three-request warm-up. There is no background
inference or automatic replay. A probe that fails without reporting usage also
uses its one admission and starts another cooldown. Actual cache reads still clear the
consecutive-miss count. Intermittent misses separated by successful reuse do not
constitute continuous uncached processing under this policy.

A follow-up sent during a turn cancels that request, and that says nothing about
whether the cache works. It can also end the live session, as when Claude was
writing a tool call, so the next request has to rebuild the chat. Gateway therefore
does not count a request the caller cancelled before it finished, and it excuses the
one rebuild after that cancellation. On 5 November 2026 two follow-ups in a row
counted as two misses, and Gateway stopped a request that would have continued the
rebuilt session cheaply. Only a caller's own cancellation qualifies: a timeout or
shutdown still counts, and a client that disconnects after a finished response
cancelled nothing. A chat can excuse four rebuilds this way; a real cache read of at
least 65,536 tokens or an idle reset before a safety stop restores that allowance. After four, ordinary counting resumes, so
a client that disconnects and retries in a loop still reaches the stop. The stop can
therefore only follow a follow-up if more than four rebuilds in a row were cancelled
or excused with no cache reuse between them.

A rebuild that the caller caused by changing its tools, instructions, thinking or Fast
setting is excused in the same way during ordinary work. A cold recovery probe
after a cooldown still starts another cooldown, even when its miss is excused.
The provider reports client changes (for Claude, a
`fingerprint_changed` reseed), and the next request continues the rebuilt session. On
8 November 2026 a resumed chat of about 600,000 tokens seeded cold, Codex then added 39 MCP
tools 17 seconds later, and Gateway stopped the warm request that followed. These rebuilds
use the same four-rebuild allowance, so a tool list that changes on every request still
reaches the stop. A compaction window change or idle expiry is not a client change and
still counts.

The idle-aware policy's one-time adoption grants inactive inherited histories a
fresh bounded warm-up, including old entries without trustworthy timestamps.
In-flight conversations retain their history. A process-wide adoption marker
prevents later module reloads from repeatedly clearing a safety stop. A late
legacy write after that handoff stays conservative until real idle is observed.
Provider, model and caller identity remain
the scope. No new user turn, reconnect or provider reseed alone resets the guard;
only the cancellation and client-change rules above excuse a rebuild.

A provider refusal also ends the live session, so the next message rebuilds the
chat. The refused request always counts as a miss when it was cold, and a refused
request that reports no usage counts as one of unknown cache reuse if its input is
at least 262,144 bytes, about 65,536 tokens. Repeated refusals therefore stop after
two resends. A rebuild that follows a refusal gets the same single pass as one after
a cancellation, so a chat that recovers is not stopped on its warm next message.
That pass sits outside the four-rebuild allowance, because the refusal itself
counted and a refuse-and-rebuild loop therefore still reaches the stop.
A refusal is never excused, even when the caller also cancelled it.

A cache failure receives a final HTTP 400 or terminal stream error telling the
person how many seconds remain before another recovery attempt. It explains that
the history is preserved and retries do not extend the cooldown. It never reports
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
session refusals retain their existing behavior. This optimization adds no
standalone warmup or hidden inference retry.

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

## Chat overflow trimming

vLLM rejects an oversized prompt with a plain 400. Gateway maps every such rejection,
including "max_tokens must be at least 1, got 0" for a prompt that fills the window, to
`context_length_exceeded`, so the client compacts or trims. A worker forked with far more
history than the window allows can still trim one item per request for a long time; on
10 November 2026 three forked Qwen workers sent about 4,000 refused requests in 89
minutes. After 25 consecutive overflows for one conversation within ten minutes,
Gateway refuses the next request locally with a non-retryable `invalid_request` that asks
for a fresh worker with a compact handoff (`fork_turns="none"`). No provider call occurs.
A completed request resets the count; it never changes caller history.

## Recovery verification

Run `node scripts/e2e-cache-recovery.mjs --package INSTALLED_PACKAGE --code CHECKOUT
--root TASK_DIRECTORY` after building the checkout. The isolated real SDK must
allow three measured cold calls and stop the fourth without reporting context
exhaustion. An unchanged retry must remain blocked without automatic compaction
or another provider call. A separate explicit caller compaction command may then
compact once and continue with smaller input in the same chat and model. The
fixture uses synthetic inference and no account. `--sdk ABSOLUTE_CANDIDATE`
qualifies a newly built Gateway SDK before packaging.
The existing Gateway-only SDK accounting fix remains available for genuine
context overflows. Cache safety no longer invokes that context-full marker.
