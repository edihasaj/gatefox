---
summary: 'Supported Responses items, native tools, streaming, reasoning, and failures.'
read_when:
  - Changing Responses request parsing, tools, replay, or SSE output
---

# Responses support

The Claude adapter accepts text and inline-image messages, function calls and outputs, custom tool
calls and outputs, and function/custom tools grouped in namespaces. It also accepts
the older nested function definition format for existing Chat Completions clients.

Claude tool definitions become native virtual MCP declarations. Native calls
return with their original name, namespace, and call ID. Custom tool input returns
as a string rather than JSON-encoded function arguments. The caller validates and
executes the tool; the gateway does not execute it or enforce grammar constraints.
The private gateway MCP server loads before Claude begins inference. It disables
nonblocking startup and marks its catalog `alwaysLoad`, keeping the caller action
surface available at startup. Rejected Claude calls log fixed categories for
unknown tools, internal search/wait helpers, duplicate IDs, malformed input, or a
missing required call. Names and arguments are never included in those logs.
Claude's private MCP names derive from the caller identity rather than its index
in a particular request. Reordering, deferred tools, and forced-tool filtering
therefore retain each binding. Replayed call/result names use those same native
names without altering arguments, IDs, results, or message content. Native tool
events can also use an exact caller alias or an unambiguous caller-local name;
ambiguous names, stale numeric aliases, and foreign tools are rejected.
Native Claude `assistant.error` discriminants identify subscription rate limits,
authentication, billing, and server failures before an opaque result is handled.
In particular, `is_error: true` with `subtype: success` is not successful inference.
Rate limits produce a clear usage-limit failure and are not retried or routed to
another account automatically. Unknown result subtypes remain bounded diagnostic
metadata; private error text is never returned or logged.
The native `rate_limit_event` supplies the affected five-hour or weekly window
and reset timestamp. A rate-limit failure includes that provider-reported time
in the inference host's local timezone and UTC. Missing metadata remains unknown;
the gateway does not guess a reset or retry across a subscription limit.

Replayed reasoning summaries are treated as text. Encrypted reasoning transport
state is not exposed to the Claude model. Hosted tools are outside
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
For Responses upstreams, `none` removes the summary field on the wire and hides
text summaries locally. Opaque replay state remains available on its account route.
Some Claude CLI versions expose token progress with empty thinking text. The
gateway emits a reasoning item and empty summary deltas with an `estimated_tokens`
extension. It preserves that distinction instead of fabricating a summary.

Gateway authentication, capacity, and request-validation failures return HTTP
errors. A validated streaming request emits `response.created` before waiting for
the provider. During a quiet period, genuine `response.in_progress` data events
keep the Codex connection alive every fifteen seconds. They retain the response
identity and sequence and contain no invented text or completion. Heartbeats stop
on completion, failure, disconnect, or deadline.

Provider failures emit `response.failed`, including failures before the first
output delta. Nonstream requests retain the corresponding HTTP error status.
Responses upstream `context_length_exceeded` errors keep that code so Codex's
compaction recovery can trim history and retry. The gateway does not choose a
different model or account. Transport failures and deadline expiry have separate
messages; they do not imply a failed login. Responses upstream server errors retry
once after one second only before any text, reasoning state, or tool output has
been published. Cancellation stops that wait. Quota, authentication, unclassified
stream failures, and partial responses never retry automatically. Private failure logs contain bounded
request/provider/model identifiers, elapsed time, error code, and status, excluding
request bodies, exception messages, stacks, and credentials. Failed Responses
streams retain allowlisted upstream error codes, event types, and request IDs.
HTTP 500/502/503/504 failures have the same single retry before output. An HTTP 429
retries only when its body identifies a temporary rate limit, honoring
`Retry-After` between one and 30 seconds. Longer waits and unidentified usage or
quota limits return immediately. Cancellation and the request deadline bound all
backoff waits; no quota or account switch is attempted.

The default total request deadline is ten minutes; explicit `timeoutMs` settings
remain authoritative. Disconnects abort inference and release capacity. Codex
stream retries are disabled to avoid repeating partially completed actions.

The daemon runs at most `maxConcurrent` providers (four by default). Up to 32
additional requests wait in a FIFO queue instead of receiving immediate capacity
errors. Waiting streams receive the same progress events; their deadline includes
waiting time. Cancellation removes waiting work without invoking a provider.
The admission bound includes body uploads. A full queue returns `busy` with HTTP
429 and `Retry-After: 1`. Health exposes `running` and `queued` counts.

The current adapters support text, inline images, and caller-dispatched tools. Audio input,
hosted tools, previous-response-ID state, and every provider's full option surface
are not supported. This is not a claim of complete Responses API compatibility.

Responses upstreams retain `service_tier`. For Codex subscription requests, the
`fast` alias becomes `priority`, as required by the tested subscription resource
endpoint. Declared model capabilities reject unsupported tiers before inference.
Standard requests omit a null tier; explicit `default` and `auto` keep their wire
values. A successful completion reports the upstream's actual `service_tier`
only when it is a recognized public value. It never reports the requested tier
as proof of the tier served. An upstream may return `default` after a priority
request; the gateway preserves that result and does not retry to chase Fast.

Copilot uses the same normalized text and replay contract. It registers native
SDK custom tools and returns their real calls before any execution. SDK reasoning
summaries stream separately; `auto` requests a concise summary. The adapter rejects
BYOK usage, unexpected model/provider changes, host permission requests, foreign
tools, inconsistent final text, unsupported SDK versions, and incomplete turns.
Cancellation stops the request's CLI process and waits for it to exit. The next
request starts a separate session and replays caller-supplied history.
The current Copilot CLI exposes no selected-model priority tier. Direct
`priority` or `fast` requests return `invalid_request` before opening a session.
Normal requests retain the selected model, reasoning, and subscription route.

## Ordinary Anthropic API

Configured reasoning effort maps to `output_config.effort`; unsupported model
levels fail before inference. `summary: "none"` hides thinking deltas. Tool calls
must have distinct IDs, valid object input, and names allowed by the current
catalog and tool selection. Required tool selection cannot finish without a call.

Only `end_turn`, `stop_sequence`, and valid caller `tool_use` turns complete.
Paused, truncated, refused, and unknown stop reasons fail, including
`model_context_window_exceeded`. These rules follow Anthropic's
[effort](https://platform.claude.com/docs/en/build-with-claude/effort) and
[stop reason](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
contracts. The gateway does not retry or choose another billing route.

## Images

User messages and caller tool results accept `input_image` with an inline base64
`image_url`. PNG, JPEG, GIF, and WebP signatures and encoding are validated before
inference. An image is limited to 8 MiB encoded; the whole request remains limited
to 10 MiB. Remote URLs and uploaded file IDs are rejected. The gateway does not
fetch image URLs or borrow the primary account's file access.

Claude receives native image blocks through the official CLI's streamed input.
Copilot receives private SDK image attachments, deleted with the request session.
Their text conversation contains labels for image ownership and order, never the
image bytes. Each native harness controls its own image preprocessing. Codex and
ordinary Responses upstreams retain the original image parts and detail setting.
Anthropic API requests retain ordered native image blocks, including tool results.

Model metadata carries `inputModalities`. The desktop adapter preserves those
capabilities rather than declaring every added model text-only. Updating an older
adapter executable requires a fresh launch; later catalog capability changes use
the normal live refresh path.
