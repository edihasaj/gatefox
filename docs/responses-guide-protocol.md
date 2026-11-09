---
summary: 'Responses wire contract: collaboration transport, response ids, item replay, stream terminals, failure classes, retry budgets, capacity, and request hardening.'
read_when:
  - Changing Responses SSE events, terminals, heartbeats, or failure classification
  - Debugging a stalled, retried, throttled, or rejected Responses request
  - Changing response ids, collaboration transport, cache-affinity headers, or service tiers
---

# Responses protocol, streaming, and failures

Part of [Responses support](responses.md): how one Responses request travels. Tool declarations and tool-call rules live on [Responses tools across routes](responses-guide-tools.md), and what each inference route does with a request lives on [Responses provider adapters and images](responses-guide-providers.md).

## Collaboration tool transport and arguments

**Collaboration tool transport.** Before forwarding to a translated Responses
provider, the gateway removes the optional `encrypted` JSON Schema marker only
from `parameters.properties.message` on the exact `collaboration` namespace
function tools `spawn_agent`, `send_message`, and `followup_task`. Those caller-
executed message arguments therefore remain plaintext for a provider that cannot
decrypt Codex transport ciphertext. On the Codex subscription route only, the
reserved `collaboration` namespace is also given a collision-free
`gateway_collaboration` wire alias (with underscores appended when needed) in
top-level and `additional_tools` declarations, explicit tool choice, and replayed
function calls/results. Upstream calls are mapped back before caller catalog
resolution, so the caller still receives and executes `collaboration` tools. This
is a copy-on-write transport transform: it does not change the caller request,
tool arguments, other schemas, or encrypted output metadata. Ordinary Responses
API routes retain the original namespace.

**Collaboration tool arguments.** The three caller tools
`collaboration.spawn_agent`, `collaboration.send_message`, and
`collaboration.followup_task` are emitted with
`encrypted_function_args: []` when their provider-neutral arguments are plaintext.
This is an explicit Codex transport marker, not a content heuristic, and appears on
the added, arguments-done, final item, and final response snapshot. Other tools are
unchanged. When a Responses upstream supplies an `encrypted_function_args` string
array, the gateway preserves it opaquely instead; it never decrypts it or relabels it
as plaintext. Metadata supplied at an added boundary is validated there and must
match the later completed item or final snapshot; an early call that omits the field
may still supply it at completion. Malformed upstream metadata fails the provider output.

## Response ids, cache affinity, and turn state

**Response ids.** Every response id is `resp_<32 hex>`. While the usage ledger is on
([diagnostics](diagnostics.md#usage-ledger)), responses from Copilot and Claude
subscription routes use `resp_gl_<request id without dashes>`, the same hex as the
`X-Request-Id` header. Usage and billing detail (cache writes, reasoning tokens,
Copilot credits) stay in the local ledger and never appear in the response.

Codex sends a `prompt_cache_key` in the body and `session-id` and `thread-id`
headers. The body key passes through unchanged. For the ChatGPT subscription
provider, the gateway also forwards those two headers. Without them, that
endpoint did not reuse its prompt cache: identical 27k-token requests stayed at
0 cached tokens. With them, repeats were 99.5% cached. Only well-formed
identifiers of at most 128 characters are forwarded. Official OpenCode API
routes also receive the caller's thread or session ID as `x-opencode-session`,
along with the gateway's user agent, across all three API transports. Other
Responses endpoints receive only the body key, except official OpenRouter routes,
which also receive their documented `x-session-id` affinity header. See
[API providers](api-providers.md).

The subscription endpoint also returns `x-codex-turn-state` on a new turn (about
780 characters, verified live), which Codex echoes on the following requests of
that turn to keep it on the same backend. The gateway returns it to Codex wrapped
with a per-account scope, and forwards it upstream only when the scope matches the
same account route. Values from another route, malformed values and upstream
values over 6000 characters are dropped; none is ever logged. For a streaming
request to the Codex 2 route, the response head waits for the provider's first
event so it can carry the header, because a streaming response cannot add a
header later. The provider reports that event as soon as the upstream response
head arrives, which took between 1.5 and 4.7 seconds in live checks. The wait
lasts at most one heartbeat interval (15 seconds) after admission, the same
silence an open stream allows before a progress event; a request that has to
queue opens its head at once. `request_completed` and `request_failed` record
only whether a turn-state was echoed and returned.

## Service tiers on Responses upstreams

Responses upstreams retain `service_tier`. For Codex subscription requests, the
`fast` alias becomes `priority`, as required by the tested subscription resource
endpoint. Declared model capabilities reject unsupported tiers before inference.
Standard requests omit a null tier; explicit `default` and `auto` keep their wire
values. A successful completion reports the upstream's actual `service_tier`
only when it is a recognized public value. It never reports the requested tier
as proof of the tier served. An upstream may return `default` after a priority
request; the gateway preserves that result and does not retry to chase Fast.

Per-provider tiers, including how `flex` and Fast are mapped on the Claude and Copilot routes, are on [Responses provider adapters and images](responses-guide-providers.md#service-tiers-and-flex-per-provider).

## Replayed items and turn terminals

Codex also replays `agent_message` items: text one agent wrote to another, with its
encrypted transport state beside it. The public Responses endpoint the gateway uses
rejects `agent_message` items (HTTP 400, verified), unlike the native Codex backend, so
every route, Responses upstreams included, receives one user-role message whose text is the item's
`input_text` and `output_text` parts joined in order; encrypted parts contribute
nothing, and an item with no text adds no message. Author and recipient are never
rendered into the transcript as labels or prose. Any other part type, including an
image, fails as a client error before a provider is invoked.

Responses upstream completion retains an actual boolean `end_turn` when present.
An absent value remains absent. This lets the SDK distinguish a continuation
from the end of a turn, including a response containing only caller tools.
Assistant message boundaries and supplied `commentary`, `final_answer`, or
`partial_answer` phases are retained. Actual text found in an output-item or
final snapshot fills only a confirmed unstreamed suffix; repeated snapshots
cannot duplicate text or execute a tool twice. Conflicting identities, phases,
or text prefixes fail explicitly instead of silently discarding content.
An actual `response.incomplete` with reason `interrupted` retains that terminal,
its incomplete message statuses, and `end_turn: false`. The SDK can continue the
same user turn with the supplied history. Unfinished tool arguments are never
dispatched. A completed terminal cannot discard an unfinished tool call; a
genuine completed call must resolve it first. Other incomplete reasons remain failures. A minimal actual
`response.completed` with a valid response ID is accepted when its status field
is absent, matching the tested SDK contract.

## Streaming, reasoning summaries, and heartbeats

Text streams through Responses SSE as the provider emits it. Tool arguments are
returned when the native call is complete. Claude's thinking events and Codex's
reasoning summaries use Responses reasoning-summary events. An effort setting
does not guarantee that a provider emits reasoning on every request. The gateway
does not invent reasoning. Claude's native thinking signatures are not replayed;
Codex's opaque encrypted reasoning state is wrapped with its account route and
restored only on that route. Switching providers or accounts retains readable
summaries and drops incompatible opaque state. Claude CLI replay preserves their
reasoning-summary identity instead of relabeling them as ordinary assistant
speech; other translating routes retain their existing text representation.
Untagged reasoning imported from another client also retains only its readable summary.
Use a new provider ID and credential file for a new account.
Generated Codex settings explicitly request `model_reasoning_summary = "auto"`.
The client can set it to `none` to hide provider reasoning.
For Responses upstreams, `none` removes the summary field on the wire and hides
text summaries locally. Opaque replay state remains available on its account route.
Newer Claude models omit thinking text unless asked. When thinking is on and the
summary is not `none`, the adapter starts the CLI with `--thinking-display
summarized`, so long Max turns stream readable reasoning. When the CLI still
reports only token progress, the gateway emits empty summary deltas with an
`estimated_tokens` extension instead of fabricating a summary.

Gateway authentication, capacity, and request-validation failures return HTTP
errors. A validated streaming request emits `response.created` before waiting for
the provider. During a quiet period, genuine `response.in_progress` data events
keep the Codex connection alive every fifteen seconds. They retain the response
identity and sequence and contain no invented text or completion. Heartbeats stop
on completion, failure, disconnect, or deadline.

## Provider failures and retry budgets

Provider failures emit `response.failed`, including failures before the first
output delta. Nonstream requests retain the corresponding HTTP error status.
Responses upstream `context_length_exceeded` errors keep that code so Codex's
compaction recovery can trim history and retry. The gateway does not choose a
different model or account. Chat Completions servers such as vLLM report the same
overflow as a plain HTTP 400 whose message says "maximum context length is N
tokens", with no code. The gateway maps that message to `context_length_exceeded`
too, keeping only the token counts, so a long local Qwen chat compacts instead of
resending the same oversized request until it fails. Other 400s keep their
ordinary classification. Transport failures and deadline expiry have separate
messages; they do not imply a failed login. Responses upstream server errors retry
once after one second only before any text, reasoning state, or tool output has
been published. Known transient connection failures before output, including
socket resets and temporary DNS failures, get their own budget instead: the
gateway waits one second, then two, four and eight seconds per retry (each
within twenty percent of jitter) for up to 120 seconds, so a short outage is
absorbed here rather than ending the chat. No attempt starts at or after that
deadline: a wait that would cross it is refused, and the deadline is checked
again after an abortable wait in case sleep or an event-loop stall overshot it;
the triggering failure is returned unchanged. An attempt already in flight may
finish after its retry window; the caller deadline remains its bound. The budget
is timed from the first connection failure, so a throttle earlier in the request
cannot spend it. The stream keeps sending its
heartbeat while the provider has produced nothing, so the wait stays covered.
Every other retryable class keeps the single retry above, whichever attempt it
lands on. A connection failure after any inference output is not replayed. Certificate
failures, permanent DNS failures, refused connections, unknown network faults,
OAuth refresh failures, and cancellations receive no additional internal retry.
A clean EOF without a terminal event has the same single retry
only before any inference output has been published. Cancellation stops that
wait. Quota, authentication, malformed streams, partial responses, and unclassified
stream failures other than an `error` or `response.failed` event with an unknown code
never retry automatically. EOF and `[DONE]` never substitute
for a genuine Responses terminal.

Chat Completions routes (including Qwen over the checked tailnet transport) use
the same 120-second connection budget while acquiring an HTTP response. Each
retry preserves the model, account, request and routing headers, and rechecks
the tailnet destination. Only allowlisted transient connection failures qualify;
HTTP replies, certificate errors, permanent DNS failures, address refusals,
unknown faults and cancellation do not. Once any HTTP response arrives, its
body is consumed exactly once: a disconnect after headers, buffered tool
fragments, usage or partial output never enters this retry loop. The existing
opt-in Messages empty-completion recovery remains separate.
As with Responses connection retries, a failure before HTTP headers does not
prove the upstream never accepted the request. A retry can repeat computation
whose usage was never reported; this is transport recovery, not an exactly-once
inference guarantee.

Private failure logs contain a UTC timestamp, bounded request/provider/model
identifiers, elapsed time, error code, and status, excluding request bodies,
exception messages, stacks, and credentials. Failed Responses streams retain
allowlisted upstream error codes, event types, and request IDs. Missing-terminal
EOF records include only event counts, an allowlisted last event, reasoning
add/done event counts, text-delta counts, and distinct dispatched tool-call counts.
HTTP 500/502/503/504 failures have the same single retry before output. An HTTP 429
is a throttle when its `error.code` or `error.type` names a temporary rate limit
(for example `rate_limit_exceeded`, `rate_limit_error` or `limit_requests`), or
when it names no quota class and asks for a `Retry-After` of at most 60 seconds.
On a Responses route, a throttle (an HTTP 429 throttle or a stream `error` naming a
temporary rate limit) has its own retry budget before output, separate from the
connection budget and from the single retry of other classes. The gateway waits
one, two, four and then eight seconds per retry, jittered by ±20%, or a provider's
`Retry-After` of at least one second, for up to 120 seconds from the first throttle.
The 60-second header rule applies only to an otherwise unnamed 429; a named
temporary throttle may use the remaining 120-second budget. It never starts a wait
that would end past the budget, and checks again after the abortable wait before it
starts the next request; an already-started request remains bounded by the caller
deadline. The ChatGPT backend usually
throttles without `Retry-After` and for longer than Codex's own retry schedule
(about 10 seconds), so earlier releases, which retried once after one second,
failed the turn while the throttle was still active. When the budget runs out, the
throttle returns as `rate_limit_exceeded` (HTTP 429) with the message "Provider is
temporarily rate limiting requests; retry shortly" and stays retryable for Codex.
A 429 that names a quota, billing, spend or plan class
(such as `insufficient_quota` or `usage_limit_reached`), and any other 429, is a
final usage limit. ChatGPT reports a shared subscription that has used its
allowance as `subscription_sharing_usage_limit_exceeded`, with the generic type
`invalid_request_error`, either in a 429 body or in a stream `error` and
`response.failed` event. That code is a final usage limit too, and the message
says the ChatGPT account reached its usage limit. Earlier releases treated it as
an unknown stream failure, so Codex retried five times and showed a stream
disconnect. Cancellation and the request deadline bound all backoff waits;
no quota or account switch is attempted.

`timeoutMs` (ten minutes by default) bounds silence, not total length. It covers
the upload and queue wait, then restarts at admission and on every provider
event, so a long Max or Ultra stream continues while a stalled provider still
fails. Every request also has a one-hour cap. Disconnects abort inference and
release capacity.

Codex keeps its own stream retry policy. The gateway sets Codex's stream idle
timeout to 90 seconds, independent of `timeoutMs`, because healthy streams
receive progress every 15 seconds; a dead path fails in 90 seconds instead of
freezing the turn. Failures that would repeat identically (invalid request or
JSON, unknown model, oversized request, unsupported protocol, authentication) are
reported inside a stream with Codex's non-retryable `invalid_prompt` code and
the gateway's message, so Codex stops at once instead of retrying five times.
Codex ends a failed turn without a final answer and does not save the error in
the chat transcript, so a client that reconnects later sees only the ended turn.
Claude failures without a native error code record the CLI's allowlisted result
subtype, such as `error_max_turns`.
A usage limit or exhausted credit balance is final: Codex receives it as
`invalid_prompt` and stops instead of retrying five times (verified: one upstream
request instead of six). An HTTP 429
throttle, as defined above, stays retryable on every HTTP route, including the
Anthropic API and Chat Completions servers, so per-minute API limits still clear
by themselves. A Claude rate limit without a
rejected `rate_limit_event`, and a Copilot error that names a rate limit without
usage-limit or quota wording, are retryable throttles too.
Responses streams recognize explicit usage, credit, quota, and billing classes
in either the upstream error's `code` or `type`. A named quota takes precedence
over a temporary rate-limit class. HTTP quota failures retain the allowlisted class,
HTTP status, and validated request ID for diagnostics too. Exhausted credits report
"Provider credits or quota are exhausted"; a subscription usage limit reports
"Provider usage limit reached". Private upstream error prose is never shown.
Upstream rejections that would repeat identically (`invalid_prompt`,
`invalid_encrypted_content`, `cyber_policy`, `bio_policy`,
`misalignment_policy_violation`, `usage_not_included`), from a stream or an HTTP
body, become `upstream_rejected` with a fixed message per class. A recognized refusal
in `error.type` is retained even beside a generic `error.code`. The
`subscription_sharing_unsupported_capability` refusal also becomes final, with guidance
to use a supported gateway tool or native Codex instead of retrying the same request.
These classifications do not bypass provider policy, grant capabilities, or change
subscription allowances. The sharing-limit message names gateway subscription sharing;
it does not establish the native account's remaining allowance. Diagnostics keep
the exact upstream code and HTTP status. `content_filter`, `max_output_tokens` and
unknown stream codes stay retryable, as they are in native Codex. A body code such
as `server_is_overloaded` marks a transient failure only in a stream; an HTTP 4xx
is never retried for it. Codex receives those rejections as their own code when
it is one of Codex's final codes, and as `invalid_prompt` otherwise; an HTTP 400,
404, 413 or 422 from an upstream also becomes `invalid_prompt`. Timeouts,
`upstream_unavailable` and rate limits stay retryable.

## Capacity and supported surface

The daemon runs at most `maxConcurrent` providers (four by default). Up to 32
additional requests wait in a FIFO queue instead of receiving immediate capacity
errors. Waiting streams receive the same progress events; their deadline includes
waiting time. Cancellation removes waiting work without invoking a provider.
The admission bound includes body uploads. A full queue returns `busy` with HTTP
429 and `Retry-After: 1`. Health exposes `running` and `queued` counts.

The current adapters support text, inline images, and caller-dispatched tools. Audio input,
hosted tools, previous-response-ID state, and every provider's full option surface
are not supported. This is not a claim of complete Responses API compatibility.

## WebSocket refusals, internal fields, and control items

The gateway serves `/v1/responses` over plain HTTP only. A WebSocket (or any other) upgrade
attempt to `/v1/responses` with a valid bearer gets `HTTP/1.1 426 Upgrade Required` with no body
and `Connection: close`. The checks run in this order: a request target that cannot be parsed
(`GET http://[ HTTP/1.1`) gets `400`; a request with an `Origin` header gets `403`; a missing or
wrong bearer gets `401`; an upgrade to any other path gets `404`. The refusal runs in the server's
`upgrade` listener. On Node builds that pass upgrades to the request handler instead, that handler
gives an upgrade to `/v1/responses` the same checks and the same 426, and serves an upgrade to any
other path as an ordinary request; there a request counts as an upgrade only when `Connection`
names the `upgrade` token beside an `Upgrade` header, as Node's own parser requires, so a `POST`
with `Upgrade: h2c` is served normally. It never admits a request, changes the health admission
counters, or invokes a provider.

The upgrade listener closes the socket as soon as the refusal is flushed, and after two seconds
at the latest if the client never reads it. A server accepts half-open sockets and applies no
timeout once a request has asked for an upgrade, so a client that keeps its side open would
otherwise hold the socket, and the server's `close()` with it, until the process ends.

An unreadable request target on an ordinary request also gets `400` (`invalid_request`). If the
request handler fails in a way nothing else caught, the client gets `500` (`internal_error`) while
the response head is unsent, or the connection is cut once it is not. The failure is reported as a
scrubbed exception and never ends the process.

Recent Codex builds carry internal transport state beside the conversation. Before translation or
any provider sees a request, the gateway removes it once in the request handler:
`internal_chat_message_metadata_passthrough` from every input item, `encrypted_function_args` from
`function_call` items (their plaintext `arguments` stay), and `mcp_attribution` from
`client_metadata`; every other `client_metadata` key passes through untouched. When nothing is
removed the parsed body is forwarded as the same object, so Responses upstreams receive
byte-identical requests to before the strip existed. The strip covers every route, including a
Messages request after it has been translated. Shapes that are not objects (`client_metadata`
that is `null`, an array or a string, an input item that is `null`, a number or an array) are not
read as maps and are left for translation to accept or reject.

Two input items are executor control, not model input. A `configuration_update` item is removed
before translation and counted in the request's telemetry record as `droppedControlItems` (a count
only, never item content). A `compaction_trigger` item fails the request as final: streams get a
`response.failed` with Codex's non-retryable `invalid_prompt` code and the fixed message "This
gateway serves compaction inside the gateway executor; this Codex build sent remote compaction,
which the gateway does not support yet."; nonstream requests get HTTP 400 `invalid_request` with
that message. `request_failed` records `translation_reason: unsupported_compaction`, and the
stderr `provider_failure` line and `gateway diagnostics` carry it too
([diagnostics](diagnostics.md#local-telemetry)). Neither invokes a
provider nor takes an admission slot, and the refusal is final. A gateway at capacity (the larger of
top-level `maxConcurrent` and the sum of effective provider limits, plus 32 requests in flight)
answers every inference request (`/v1/responses` and `/v1/messages`)
with a retryable `429` before reading its body,
so an overload never buffers bodies; a compaction refused that way is retried and gets this final
refusal once a slot is free.

`/health` adds `features`: `["responses-ws-426", "openai-internal-strip", "native-identity-v1"]`,
the behaviors this release guarantees (the exported `gatewayFeatures`), so an operator can tell an
updated daemon from an old one without reading its code. `responses-ws-426` is the WebSocket
refusal above. `openai-internal-strip` is the removal of internal fields and control items.
`native-identity-v1` means this inference server accepts requests from a gateway executor that runs
under the native `openai` provider identity: the two behaviors above, which such an executor needs,
are both present. It describes the server only; whether executors run under that identity is a
separate setting of the desktop adapter (`chatIdentity`, `gatefox` by default; `subscription_gateway` before 1.8.0). Since 0.4.7
executors reach this server through the gateway's own provider definition even for chats recorded as
`openai`, so they do not depend on these two behaviors; see [harness identity](harness-identity.md).