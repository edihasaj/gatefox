---
summary: 'Supported Responses items, native tools, streaming, reasoning, and failures.'
read_when:
  - Changing Responses request parsing, tools, replay, or SSE output
---

# Responses support

The gateway translates the caller's instructions and tool catalog. It does not
assign agent roles, choose workers, add task instructions, or provide agent-only
tools. Its catalog rows carry an empty instruction template, and the desktop
adapter blanks any template an inference host or old cache supplies. On the
desktop, Codex 2 rows take the base prompt and model messages from the client's
own native catalog row for the same upstream model, so Codex sends what it sends
that native model ([details](app-server.md#codex-2-rows-and-the-native-catalog)).
Claude, Copilot and other rows, and clients without a native catalog, get no
model-specific base prompt. Explicit and resumed client instructions remain
authoritative.

**Response ids.** Every response id is `resp_<32 hex>`. While the usage ledger is on
([diagnostics](diagnostics.md#usage-ledger)), responses from Copilot and Claude
subscription routes use `resp_gl_<request id without dashes>`, the same hex as the
`X-Request-Id` header. Usage and billing detail (cache writes, reasoning tokens,
Copilot credits) stay in the local ledger and never appear in the response.

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
The CLI reports every 429 as `rate_limit`, including a transient subscriber
capacity throttle ("not your usage limit"). Only a `rate_limit_event` with status
`rejected` earlier in the same request proves a subscription limit; that becomes
a clear, final usage-limit failure. Any other Claude rate limit is a retryable
`rate_limit_exceeded`, so Codex retries it as it did before usage limits became
final. Neither is routed to another account automatically. Unknown result
subtypes remain bounded diagnostic metadata; private error text is never returned
or logged.
The native `rate_limit_event` supplies the affected five-hour or weekly window
and reset timestamp. A rate-limit failure includes that provider-reported time
in the inference host's local timezone and UTC. Missing metadata remains unknown;
the gateway does not guess a reset or retry across a subscription limit.

Replayed reasoning summaries are treated as text. Encrypted reasoning transport
state is not exposed to the Claude model. Hosted tools are outside
the current Claude adapter's scope. Unsupported item and tool types return a
client error instead of an internal crash.

Codex also replays `agent_message` items: text one agent wrote to another, with its
encrypted transport state beside it. The public Responses endpoint the gateway uses
rejects `agent_message` items (HTTP 400, verified), unlike the native Codex backend, so
every route, Responses upstreams included, receives one user-role message whose text is the item's
`input_text` and `output_text` parts joined in order; encrypted parts contribute
nothing, and an item with no text adds no message. Author and recipient are never
rendered into the transcript as labels or prose. Any other part type, including an
image, fails as a client error before a provider is invoked.

A Codex subscription request whose token refresh fails on the network, with an
unreadable or malformed reply, or with any HTTP error status other than 400, 401 or 403 (for example
a 429 or a 5xx, often right after the Mac wakes) returns a retryable
`upstream_unavailable`, so Codex reconnects instead of ending the chat. Only a
missing login, a stored login without a refresh token, an unreadable credential file, a stored
login or refresh reply without the plan scopes, or a refresh rejected with HTTP 400, 401 or 403
reports "ChatGPT provider requires login". When the token endpoint names a reason, the message adds its OAuth error code. A rejected login reads
"ChatGPT provider requires login (refresh rejected: refresh_token_reused)" and a temporary failure
reads "ChatGPT login refresh failed temporarily (temporarily_unavailable); retry shortly". A code
outside the fixed list shows as `other`, and a reply without a code adds nothing. `request_failed`
telemetry records the same code (see `docs/diagnostics.md`); only the code is kept, and the reply's
description, body and tokens are never recorded or shown. A failed refresh is not retried inside the request, because a second token request
could spend the single-use refresh token again; Codex reconnects on the retryable 503 instead.

The refresh token is single-use, so only a real request or an explicit
`gateway discover` ever spends it. The six-hour model-metadata refresh never refreshes
the Codex login: whenever serving the Codex access token would need a refresh (it has expired, or
it is within two minutes of expiring unless the issuer's `earliest_refresh_at` has not passed yet),
that provider is skipped for the round (`model_metadata_skipped`) without any network
call, and the next real request refreshes it. This keeps a refresh from being started
while the Mac is asleep, where the reply can be lost after the token was spent. Claude and
Copilot discovery in the same refresh still run their own CLI or SDK, which may refresh its
own login; guarding them is left to a later release. When a refresh reply arrives, any
replacement refresh token is written to the credential file (atomically, mode 0600) in the
same save that records the outcome, so a reply that fails a check never loses the rotated
token. How the reply is handled:

- A valid reply that omits `scope` (or sends `null`) keeps the scope granted earlier (RFC 6749 sections 5.1
  and 6) and is used normally; a `scope` that is present but not a string counts as malformed.
- A reply whose `scope` lacks the plan scopes can only be fixed by signing in again (`gateway login ID`
  with plan usage enabled). The gateway keeps the old access token and only the scopes that
  reply granted, so that request and every later one report "ChatGPT provider requires
  login" without another token request, in this process or another one waiting on the
  refresh lock.
- A malformed reply (no bearer access token or no positive lifetime) is temporary, whatever its
  scope says, and is checked before the plan scopes. The
  request returns the retryable `upstream_unavailable`, the stored access token, scopes and
  expiry stay as they were, and the next real request refreshes again with the saved
  replacement token, or with the stored one when the reply carried none.
- A valid reply without a replacement refresh token is used. The new access token is saved
  and the stored refresh token stays, because a server may keep a refresh token instead of
  rotating it (RFC 6749 section 6).

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

Provider failures emit `response.failed`, including failures before the first
output delta. Nonstream requests retain the corresponding HTTP error status.
Responses upstream `context_length_exceeded` errors keep that code so Codex's
compaction recovery can trim history and retry. The gateway does not choose a
different model or account. Transport failures and deadline expiry have separate
messages; they do not imply a failed login. Responses upstream server errors retry
once after one second only before any text, reasoning state, or tool output has
been published. A clean EOF without a terminal event has the same single retry
only before any inference output has been published. Cancellation stops that
wait. Quota, authentication, malformed streams, unclassified stream failures, and
partial responses never retry automatically. EOF and `[DONE]` never substitute
for a genuine Responses terminal.
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
The gateway retries a throttle once before output when its wait is at most 30
seconds (one second when no wait is given); a longer wait returns at once and
stays retryable for Codex. A 429 that names a quota, billing, spend or plan class
(such as `insufficient_quota` or `usage_limit_reached`), and any other 429, is a
final usage limit. Cancellation and the request deadline bound all backoff waits;
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
A usage limit is final: Codex receives it as `invalid_prompt` and stops instead of
retrying five times (verified: one upstream request instead of six). An HTTP 429
throttle, as defined above, stays retryable on every HTTP route, including the
Anthropic API and Chat Completions servers, so per-minute API limits still clear
by themselves. A Claude rate limit without a
rejected `rate_limit_event`, and a Copilot error that names a rate limit without
usage-limit or quota wording, are retryable throttles too.
Upstream rejections that would repeat identically (`invalid_prompt`,
`invalid_encrypted_content`, `cyber_policy`, `bio_policy`,
`misalignment_policy_violation`, `usage_not_included`), from a stream or an HTTP
body, become `upstream_rejected` with a fixed message per class. Diagnostics keep
the exact upstream code and HTTP status. `content_filter`, `max_output_tokens` and
unknown stream codes stay retryable, as they are in native Codex. A body code such
as `server_is_overloaded` marks a transient failure only in a stream; an HTTP 4xx
is never retried for it. Codex receives those rejections as their own code when
it is one of Codex's final codes, and as `invalid_prompt` otherwise; an HTTP 400,
404, 413 or 422 from an upstream also becomes `invalid_prompt`. Timeouts,
`upstream_unavailable` and rate limits stay retryable.

The daemon runs at most `maxConcurrent` providers (four by default). Up to 32
additional requests wait in a FIFO queue instead of receiving immediate capacity
errors. Waiting streams receive the same progress events; their deadline includes
waiting time. Cancellation removes waiting work without invoking a provider.
The admission bound includes body uploads. A full queue returns `busy` with HTTP
429 and `Retry-After: 1`. Health exposes `running` and `queued` counts.

The current adapters support text, inline images, and caller-dispatched tools. Audio input,
hosted tools, previous-response-ID state, and every provider's full option surface
are not supported. This is not a claim of complete Responses API compatibility.

Codex sends a `prompt_cache_key` in the body and `session-id` and `thread-id`
headers. The body key passes through unchanged. For the ChatGPT subscription
provider, the gateway also forwards those two headers. Without them, that
endpoint did not reuse its prompt cache: identical 27k-token requests stayed at
0 cached tokens. With them, repeats were 99.5% cached. Only well-formed
identifiers of at most 128 characters are forwarded. Other Responses endpoints
receive only the body key.

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

Responses upstreams retain `service_tier`. For Codex subscription requests, the
`fast` alias becomes `priority`, as required by the tested subscription resource
endpoint. Declared model capabilities reject unsupported tiers before inference.
Standard requests omit a null tier; explicit `default` and `auto` keep their wire
values. A successful completion reports the upstream's actual `service_tier`
only when it is a recognized public value. It never reports the requested tier
as proof of the tier served. An upstream may return `default` after a priority
request; the gateway preserves that result and does not retry to chase Fast.

Claude subscription requests map `priority` (or `fast`) to the CLI's fast mode
setting (`--settings {"fastMode":true}`) when the model's catalog row offers Fast;
other tiers are rejected before the CLI starts. The CLI reports its fast mode
state. When fast mode stays on, the completion reports `priority`. When Claude
refuses it (for example, no usage credits) and falls back to standard speed, the
turn still completes and reports `default`.

Copilot uses the same normalized text and replay contract. It registers native
SDK custom tools and returns their real calls before any execution. SDK reasoning
summaries stream separately; `auto` requests a concise summary. The adapter rejects
BYOK usage, unexpected model/provider changes, host permission requests, foreign
tools, inconsistent final text, unsupported SDK versions, and incomplete turns.
By default the thread keeps one live CLI session, and a request sends only the
items that are new; see [live Copilot sessions](copilot-sessions.md). Cancellation
aborts the session, stops its CLI process and waits for it to exit; the next request
starts a new session and sends the caller-supplied history once. A request a live
session cannot serve (no thread id, compaction, a concurrent request, every slot busy,
or `copilotSessions.mode: "oneshot"`) gets its own session, with the same system
message, the caller's whole tool catalog and one user message per history item.
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
inference. An image is limited to 8 MiB encoded. The whole request is limited to
64 MiB, above what upstreams accept, so a long chat with many screenshots reaches
the provider as it would natively and the provider's own limit applies. (Before
0.3.8 the cap was 10 MiB, which refused such chats with a 413.) Remote URLs and
uploaded file IDs are rejected. The gateway does not
fetch image URLs or borrow the primary account's file access.

Each Claude inference starts the official CLI with one user message. The adapter
sends each conversation item as its own content block, oldest first, and puts
per-request instructions last. Earlier blocks stay byte-identical as a tool loop
grows, so Claude reuses its prompt cache. In a measured three-round loop, the
second and third rounds were about 98% cached; the former single-string prompt
was 0% cached after the first change. Claude cache reads are reported as
`input_tokens_details.cached_tokens`.

Each item block is plain text: a header line such as `<<item 3 user>>`,
`<<item 4 tool_call NAME ID>>` or `<<item 5 tool_result ID>>`, the raw text, and a
closing line `<</item>>`. A body line that starts with `<<item ` or is `<</item>>` is
escaped with a backslash, so item boundaries cannot be forged. The closing line
matters for spend: Claude never reuses a cached prefix whose last block ends in
whitespace once more blocks follow, and tool output usually ends in a newline.
Without it (0.3.2 to 0.3.5), each one-shot request reused only the system and tool
prefix and rewrote the whole conversation; measured on Haiku, the cached prefix
stayed at 921 tokens for five rounds, and grows every round with it. This replaces the earlier JSON-escaped items, which
cost 3–13% more characters. The first block is fixed text and no longer lists tool
names, so a catalog change no longer rewrites it. `claudeSessions.replayFormat:
"json"` on the Claude provider restores the JSON encoding. The format change means
each active Claude chat pays one full cache write on its first request after the
update.

The CLI runs with `--allowedTools` limited to the gateway's MCP tools, so it cannot
answer a caller call itself. When Claude asks for several tools at once, every
complete call reaches the caller in one response; the CLI is stopped when the API
message ends, before it can act on the calls. A message cut short by `max_tokens`
returns only the calls it completed. Output tokens come from the final
`message_delta`, so tool turns report what was actually generated. Cancelling a
request stops the CLI at once instead of waiting 1.5 seconds. A forced
`tool_choice` keeps the full catalog, so it does not break the prompt cache; a final
block names the required tool, and one retry with only that tool follows a
mismatched call when no text was streamed.

With `claudeSessions.mode: "live"`, the gateway instead keeps one CLI session per
Codex thread, so history, thinking and the prompt cache stay native; see
[live Claude sessions](claude-sessions.md). Replay stays the default. After streamed text, a mismatched call
fails with a code Codex treats as final, because a caller retry would repeat the
same full-catalog inference.

The caller's instructions and the system and developer messages before the first
other message become the CLI's system prompt, after the gateway's fixed backend
text, which is where Claude Code keeps its own instructions. The prompt is written
to a private file and passed with `--system-prompt-file`, so caller text never
appears in the process list. The rest of the history renders as item blocks,
numbered from its first message. A later developer message stays an item in the
history, and a history that holds only system and developer messages keeps them
all as items. With Codex, its three leading developer messages (about 24,500
characters) moved from the user message into the system prompt.

Each Claude row's default effort is the CLI's own default for that model. Model
discovery reads it without inference: after `initialize`, it sets the
session-scoped model with `apply_flag_settings` and reads the applied effort from
`get_settings`, because the `initialize` model list carries no default. CLI
2.1.293 reported medium for Opus 5.5, Sonnet 5.5 and Haiku 5.5; high for Fable
5.1, Fable 5, Opus 5, Sonnet 5, Opus 4.8, Opus 4.6 and Sonnet 4.6; and xhigh for
Opus 4.7. The value is stored as `defaultReasoningEffort` in the model metadata. A
model for which the CLI reports no level, or a level the row does not offer, keeps
medium. Each discovery replaces the stored value, so a refresh in which the CLI
reports no level, or `get_settings` fails, returns the row to medium.

One-shot and live CLIs both run with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` and
`ENABLE_TOOL_SEARCH=false`, so the CLI declares only the gateway's tools (one-shot
CLIs used to add two of their own). Neither inherits the host's `CLAUDECODE`,
`CLAUDE_CODE_*` or `CLAUDE_AGENT_SDK_*` variables. A desktop entrypoint inherited
from a Claude Code shell made each one-shot CLI send an extra post-turn summary
request and print its result about 2 seconds after the turn ended. The gateway
sets `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` to the longest caller tool
description, and never below the CLI's default of 2,048 characters, so every
description reaches the model whole. Before, the CLI cut longer ones at 2,048
characters.

A one-shot text turn ends at the `message_delta` whose stop reason is `end_turn`.
The request completes with that message's usage, without waiting for the CLI's
result. The gateway then reads the CLI's output for at most 100 ms, to keep the
rate limit the CLI prints right after the turn and the context window a prompt
result reports, and stops the CLI. Any other stop reason still waits for the
result and keeps its error classification. Measured with CLI 2.1.293 on Haiku 5.5
and Sonnet 5.5, the time from `message_delta` to `done` fell from 1.6–2.8 seconds
to under 2 ms for a gateway started from a Claude Code shell, and from 4–8 ms to
under 2 ms in the installed service's environment. Live sessions already received
their result within 7 ms and still end there. A Fast turn also waits for the
result, because only the result reports the tier served: when Claude refuses or
throttles a fast request, the CLI retries at standard speed without printing a
line, so the `on` state from its first line can be stale.

The system prompt, the item numbering, the smaller tool list and the uncut tool
descriptions all change Claude's cached prefix. They ship in one release, so each
active Claude chat pays one full cache write on its first request after the
update. Live sessions reseed once after an inference restart anyway, so they pay
that same single write.

Claude receives native image blocks through the official CLI's streamed input.
Copilot receives images as inline blob attachments on the message that owns them, and
tool-output images as binary results of the waiting tool call. The gateway writes no image file.
Their text conversation contains labels for image ownership and order, never the
image bytes. Each native harness controls its own image preprocessing. Codex and
ordinary Responses upstreams retain the original image parts and detail setting.
Anthropic API requests retain ordered native image blocks, including tool results.

Model metadata carries `inputModalities`. The desktop adapter preserves those
capabilities rather than declaring every added model text-only. Updating an older
adapter executable requires a fresh launch; later catalog capability changes use
the normal live refresh path.
