---
summary: 'Supported Responses items, native tools, streaming, reasoning, and failures.'
read_when:
  - Changing Responses request parsing, tools, replay, or SSE output
---

# Responses support

Grok/xAI API connections use a function-only tool bridge for caller custom and
namespaced tools, with original identities restored on the client side and
encrypted reasoning preserved. See [API providers](api-providers.md) for this
compatibility route and named connection presets.

This document describes the OpenAI Responses ingress. The same provider catalog
also serves [native Anthropic Messages clients](messages.md), including Claude
Code. Selecting an inbound protocol does not select an upstream provider.

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
Billing refusals report: "Claude billing or extra-usage credits are unavailable.
Check your Claude billing settings and payment method, then retry." The gateway
also recognizes bounded, known credit-refusal messages inside native failure
results when the CLI omits its billing discriminant. These failures are final
`insufficient_quota` errors, so Codex does not repeatedly retry a charge that needs
account action. The gateway never returns the provider's private refusal text or
guesses whether a card was declined for insufficient funds. Ordinary successful
assistant text and an unexplained disconnection do not establish a billing failure.
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

Claude replays public reasoning summaries as explicitly identified historical
summary items, separate from ordinary assistant messages. Their readable text
is preserved; the gateway does not invent thinking blocks or native signatures.
Encrypted reasoning transport state is not exposed to the Claude model. Hosted tools are outside
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

Provider failures emit `response.failed`, including failures before the first
output delta. Nonstream requests retain the corresponding HTTP error status.
Responses upstream `context_length_exceeded` errors keep that code so Codex's
compaction recovery can trim history and retry. The gateway does not choose a
different model or account. Transport failures and deadline expiry have separate
messages; they do not imply a failed login. Responses upstream server errors retry
once after one second only before any text, reasoning state, or tool output has
been published. A clean EOF without a terminal event has the same single retry
only before any inference output has been published. Cancellation stops that
wait. Quota, authentication, malformed streams, partial responses, and unclassified
stream failures other than an `error` or `response.failed` event with an unknown code
never retry automatically. EOF and `[DONE]` never substitute
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

The daemon runs at most `maxConcurrent` providers (four by default). Up to 32
additional requests wait in a FIFO queue instead of receiving immediate capacity
errors. Waiting streams receive the same progress events; their deadline includes
waiting time. Cancellation removes waiting work without invoking a provider.
The admission bound includes body uploads. A full queue returns `busy` with HTTP
429 and `Retry-After: 1`. Health exposes `running` and `queued` counts.

The current adapters support text, inline images, and caller-dispatched tools. Audio input,
hosted tools, previous-response-ID state, and every provider's full option surface
are not supported. This is not a claim of complete Responses API compatibility.

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

Codex sends a `prompt_cache_key` in the body and `session-id` and `thread-id`
headers. The body key passes through unchanged. For the ChatGPT subscription
provider, the gateway also forwards those two headers. Without them, that
endpoint did not reuse its prompt cache: identical 27k-token requests stayed at
0 cached tokens. With them, repeats were 99.5% cached. Only well-formed
identifiers of at most 128 characters are forwarded. Official OpenCode API
routes also receive the caller's thread or session ID as `x-opencode-session`,
along with the gateway's user agent, across all three API transports. Other
Responses endpoints receive only the body key. See [API providers](api-providers.md).

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

Flex depends on the provider. The Codex subscription path passes `flex` through to
the upstream, and the model's declared tier list does not apply to it, as in native
Codex; the ordinary Responses API provider forwards it the same way. Claude and
Copilot run `flex` as Standard (see their sections below). The Anthropic API and
Chat Completions providers ignore every service tier.

Claude subscription requests map `priority` (or `fast`) to the CLI's fast mode
setting (`--settings {"fastMode":true}`) when the model's catalog row offers Fast;
`flex` has no Claude equivalent, so it runs the turn as Standard with no fast mode
setting; any other tier the model does not offer (`scale`, an unknown name) is
rejected before the CLI starts. The CLI reports its fast mode
state. When fast mode stays on, the completion reports `priority`. When Claude
refuses it (for example, no usage credits) and falls back to standard speed, the
turn still completes and reports `default`.

Copilot uses the same normalized text and replay contract. It registers native
SDK custom tools and returns their real calls before any execution. SDK reasoning
summaries stream separately; `auto` requests a concise summary. The adapter rejects
BYOK usage, unexpected model/provider changes, host permission requests, foreign
tools, inconsistent final text, unsupported SDK versions, and incomplete turns.
By default the thread keeps one live CLI session, and a request sends only the
items that are new; see [live Copilot sessions](copilot-sessions.md). Cancelling a
live request aborts its session and kills its CLI process (about 2 seconds: the abort is bounded to
2 seconds, then the CLI is killed and its folder removed); the
request hands over the usage the CLI reports meanwhile and then ends. The next request
starts a new session and sends the caller-supplied history once. Cancelling a one-shot request stops
its CLI process and waits for it to exit; a process outside the CLI's group that keeps its output open
delays that by half a second of silence on the CLI's output, or by at most about 5 seconds (100 ticks) when output keeps arriving, after which the gateway closes its pipes. Either way, usage the CLI reported before the
cancellation, or reports while it is being aborted, still reaches the usage ledger and telemetry. A request a live session
cannot serve gets its own session, with the same system message, the caller's whole tool
catalog and one user message per history item. That happens, for example, for a request
without a thread id; a compaction, prewarm or memory request; a second request while the
thread's first still runs; no free slot; a session that fails to start, does not accept a
tool result or dies before its first event; or `copilotSessions.mode: "oneshot"`. The
[full list](copilot-sessions.md#how-a-request-is-served) names each case.
The current Copilot CLI exposes no selected-model priority tier. Direct
`priority` or `fast` requests return `invalid_request` before opening a session.
`flex` also runs as Standard: the request is accepted and no tier is sent to the CLI.
Normal requests retain the selected model, reasoning, and subscription route.

## Repeated tool declarations

A long chat can declare the same tool more than once: in several Responses lite
`additional_tools` input items, or in an `additional_tools` item and again in the current
top-level `tools` list. The ChatGPT backend accepts this, so the gateway merges the
declarations into its own catalog instead of refusing the request (`duplicate_tool`).

- **Identity.** A function or custom tool is identified by its name, qualified by its
  namespace for a namespace tool (the default `functions` namespace is unqualified, like a
  top-level tool). Any other typed tool, such as `tool_search`, is identified by its
  `type`. The same local name in two different namespaces stays two tools.
- **Precedence.** The current request's top-level `tools` win over any history
  declaration. Among `additional_tools` items a later item wins over an earlier one, and
  within one list a later entry wins over an earlier one. An exact duplicate is dropped; a
  differing one is replaced by the winner. A tool or its namespace keeps the position of
  its first declaration.
- **Scope.** Only the gateway's own catalog is merged. On the Codex route the original
  input items still go upstream unchanged (apart from the `tool_search` drops below).
- **Telemetry.** When anything merged, the gateway records `tool_declarations_merged` with
  the counts `replaced` and `identical`, once per request, never a name, definition or
  argument ([diagnostics](diagnostics.md#local-telemetry)).

Malformed declarations still fail with their own reasons (`invalid_shape`,
`unsupported_tool`) unless a valid declaration of the same tool supersedes them; only a
repeated name no longer fails a request.

## Tool search on the Codex subscription route

Native Codex rows can enable `supports_search_tool`, so the client sends a `tool_search`
tool, declares it either at the top level or inside a Responses lite `additional_tools`
input item, and later replays `tool_search_call` and `tool_search_output` items. The
search itself runs in the client (`execution: "client"`): Codex searches its deferred
tools and replays the matching definitions in `tool_search_output`. The ChatGPT backend
refuses the `tool_search` type through the gateway's shared-subscription login (HTTP 400
`subscription_sharing_unsupported_capability`, quoted in [hosted web search](#hosted-web-search);
first seen on 0.4.4, where every Codex 2 turn failed with "Provider returned HTTP 400").
**Search is therefore off by default.** A `codex-subscription` provider can opt in to a
bridge with `"toolSearch": "bridge"` in `gateway.json`; `"off"` is the default, and any
other provider type refuses the setting. `gateway tool-search on`, `off` and `status` set,
remove and show it for every `codex-subscription` provider; the command validates the edited
file before saving it and changes no other field. The setting is capability metadata, so a change
applies live, without a rebind; a chat started before the change keeps its catalog until
Codex loads the new one.

- **Codex subscription route, off.** Before sending upstream, the gateway drops any
  `tool_search` tool, at the top level or inside an `additional_tools` item (an item left
  with no tool is dropped too), and any `tool_search_call` or `tool_search_output` input
  item. This covers an engine that still holds an older catalog with search on. The rest
  of the request is unchanged and keeps its order, including `tool_choice`, so the turn
  runs as it would without search. When anything was dropped, the gateway records
  `tool_search_dropped` with the count of tools and items
  ([diagnostics](diagnostics.md#local-telemetry)).
- **Codex subscription route, bridged.** The gateway sends search with tool types the
  backend accepts (`src/protocol/tool-search-bridge.ts`). The `tool_search` tool becomes an
  ordinary function with the same description and parameters, where it was declared: a
  top-level one joins the gateway namespace, and one inside an `additional_tools` item stays
  there. Its name is `tool_search`, or `tool_search_` and so on when a flat tool already
  has that name. A replayed `tool_search_call` becomes a `function_call` of that function,
  and its `tool_search_output` becomes a `function_call_output` that names the loaded
  tools, followed by the loaded tools themselves: in a new `additional_tools` item right
  after the output on a Responses lite request, so everything before that point (and the
  prompt cache for it) is unchanged, and appended to the top-level tools otherwise. That item
  carries the role of the request's own `additional_tools` item (Codex sends `developer`),
  because the backend refuses one without a role. A tool
  already declared is not declared again, `defer_loading` is removed because the bridge
  loads the tool explicitly, and only function, custom and namespace tools are loaded.
  When the model calls the function, the client receives a `tool_search_call` with the
  parsed arguments and runs the search; it is never dispatched as a caller tool, an
  interrupted unfinished one is withheld like an unfinished function call, and invalid
  arguments fail as `invalid_tool_call`. Calls of loaded tools resolve like any caller
  tool. Codex resends the whole history every turn, so the gateway keeps no state. The
  gateway records `tool_search_bridged` with counts only.
- **Verification.** `node scripts/probe-tool-search-bridge.mjs --dry-run` runs both rounds
  (the model searches, then calls the tool the search loaded) through the gateway's own
  provider code against a scripted backend, for a top-level and a Responses lite request, and
  checks that nothing of the `tool_search` type or `defer_loading` reaches the wire. Without
  `--dry-run` it makes the same four requests to the real backend. On 23 Oct 2026 all four
  completed: for both shapes the model called the search bridge, then called the fixture
  tool returned by that search. The dry run passed too. This establishes the bridge's
  real inference and replay behavior; it does not make the raw `tool_search` type supported
  by the subscription endpoint. The installed setting remains off until explicitly enabled.
- **Bridge risks.** Loading tools on a request
  that is not Responses lite changes the top-level tool list, which can lower prompt cache
  hits from that point. The model sees a function rather than the tool type it was trained
  with, so it may use search a little differently. In the seven days before the bridge was
  built, no native Codex chat on the test Mac used tool search at all, so its benefit
  depends on connecting many deferred MCP or connector tools.
- **Upstream search items.** If the upstream ever produces a `tool_search_call` or
  `tool_search_output`, it still streams back to the client as sent, once each; an
  interrupted final snapshot withholds a search item whose status is not `completed`.
- **Every other route.** Claude, Copilot, Grok, chat-completions, anthropic-api and generic
  Responses routes drop the `tool_search` tool and both item types instead of rejecting
  them, so a chat that switches away from a Codex route keeps working. The tools an earlier
  search loaded stay declared (ranked below any tool the request declares itself), so the
  new model can still call them. Each drop is recorded as `tool_search_dropped`. A forced
  `tool_choice: "required"` with only the search tool has nothing to call there and still
  fails with `unsupported_tool_choice`. Anthropic Messages requests carry only function tools.
- **Catalog.** `supports_search_tool` is published on only for a bridged route's rows, and
  a Codex 2 row keeps it on only when its native row has it on too. Every other row, and
  every native row carried for sub-agents, has it off, because a bare model name resolves to
  a route only when the request runs
  ([details](app-server.md#codex-2-rows-and-the-native-catalog)).
- **Ownership.** The client executes search and owns the deferred tool list. The gateway
  never runs a search; it only changes how search items travel. Tool names, queries and
  outputs are never logged; failures record only the fixed reason and the allowlisted item
  type.

## Hosted web search

Native Codex rows that carry `web_search_tool_type` send OpenAI's hosted `web_search`
tool, and the ChatGPT backend accepts exactly that one hosted tool through a shared
subscription: forwarding `tool_search` answers HTTP 400 `subscription_sharing_unsupported_capability`
-- "User subscription sharing currently supports only 'web_search' and developer-defined
'function' and 'custom' tools, including 'namespace'" -- which is why [tool search](#tool-search-on-the-codex-subscription-route)
is not forwarded as such (it is off, or bridged as a function) while web search is forwarded.

`scripts/probe-hosted-tools.mjs` asks the backend directly, one short request per case,
and records only status codes and fixed error fields. On 21 Oct 2026 it showed the refusal
above for `tool_search`, and showed that `web_search` passed the backend's tool check.
On 23 Oct 2026 a real request through `ResponsesAPI` completed with a completed
`web_search_call`, establishing actual hosted search execution too. The earlier run showed that
`https://chatgpt.com/backend-api/codex`, which native Codex uses, answers 401 to the
gateway's own login, so the gateway keeps `https://api.openai.com/v1`.

- **Codex subscription route.** The `web_search` tool, declared at the top level or inside a
  Responses lite `additional_tools` item, is forwarded upstream unchanged and never wrapped into
  the gateway namespace, and replayed `web_search_call` input items go upstream as sent. A
  `web_search_call` the backend produces streams back to the client as received, once each, and
  an interrupted final snapshot withholds one whose status is not `completed`, as it does a
  search item. `response.web_search_call.*` progress events are ignored. A forced
  `tool_choice: "required"` counts a declared `web_search` as satisfying the call.
- **Every other route.** Claude, Copilot, chat-completions, anthropic-api and generic Responses
  routes drop the tool and its replayed items before anything is translated or sent, so a chat
  that switches here from Codex 2 mid-turn keeps working; a `tool_choice` naming `web_search`
  drops to `auto` on those routes. When anything was dropped, the gateway records
  `web_search_dropped` with the count of tools and items
  ([diagnostics](diagnostics.md#local-telemetry)) -- counts only, never a name, query or result.
  Every other hosted tool type (`file_search`, `computer_use`, `image_generation`, ...) keeps
  failing with `unsupported_tool` on every route, exactly as before.
- **Catalog.** A Codex 2 row copies the native row's `web_search_tool_type`, so Codex sends the
  tool on it exactly as it does natively; Claude, Copilot and other rows lose the field, and
  `supports_search_tool` -- a different tool's flag -- stays off unless a route bridges tool search
  ([details](app-server.md#codex-2-rows-and-the-native-catalog)).
- **Ownership.** The backend runs the search and the client renders its items. The gateway never
  runs a search itself and never logs a query or result.

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
separate setting of the desktop adapter (`chatIdentity`, `subscription_gateway` by default). Since 0.4.7
executors reach this server through the gateway's own provider definition even for chats recorded as
`openai`, so they do not depend on these two behaviors; see [harness identity](harness-identity.md).

## Ordinary Anthropic API

Configured reasoning effort maps to `output_config.effort`; unsupported model
levels fail before inference. `summary: "none"` hides thinking deltas. Tool calls
must have distinct IDs, valid object input, and names allowed by the current
catalog and tool selection. Required tool selection cannot finish without a call.
Outbound requests carry up to four ephemeral prompt-cache breakpoints
(`cache_control: { "type": "ephemeral" }`): the last tool, the last system block,
and the tails of the last two messages, regardless of their role. A block already
marked is never marked twice, nested tool-result content never receives a marker
of its own, and markers never reorder or merge caller blocks.

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
Copilot receives a history item's images as file attachments on the message that owns
them: the gateway writes each image (mode 0600) into the CLI's private folder, which is
removed with the session, because one RPC message to the CLI is limited to 16 MiB.
Tool-output images travel inline as binary results of the waiting tool call while the
result stays within 12 MiB; a larger one starts the thread's session over, which sends
those images as files too.
Their text conversation contains labels for image ownership and order, never the
image bytes. Each native harness controls its own image preprocessing. Codex and
ordinary Responses upstreams retain the original image parts and detail setting.
Anthropic API requests retain ordered native image blocks, including tool results.

Model metadata carries `inputModalities`. The desktop adapter preserves those
capabilities rather than declaring every added model text-only. Updating an older
adapter executable requires a fresh launch; later catalog capability changes use
the normal live refresh path.
