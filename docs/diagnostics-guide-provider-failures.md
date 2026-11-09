---
summary: "Read fixed provider failure categories, cache observations and Claude continuity diagnostics."
read_when:
  - Investigating provider failures and cache diagnostics
---

# Provider failures and cache diagnostics

Return to the [diagnostics overview](diagnostics.md).

## Claude output between requests

`claude_session_violation` records unexpected output after a Claude request has
ended: the hashed thread key, session state, pending-call count, and fixed
`messageKind`, `eventKind`, and `nativeError` categories. It also records whether
the frame reports an error and whether an assistant frame matches the completed
message. Unknown categories become `other`. No message text, IDs, tool arguments,
or diagnostic prose are recorded. The session still closes without replay.
Older `unexpected_output` records do not identify the frame that triggered them.

## Responses tool identity failures

`tool_identity_failure` separates Responses catalog/name matching failures from
malformed arguments and other `invalid_tool_call` errors. Its `upstreamCode` is
one of `missing_tool_name`, `unknown_wire_tool`, `unexpected_tool_namespace` or
`undeclared_tool`; `upstreamLastEvent` and bounded stream counts identify the
actual failure boundary. The client receives a fixed explanation and the same
final refusal behavior as other invalid tool output. No tool is dispatched by
this classification. Names, namespaces, arguments and response content remain
private, and no automatic inference retry is added.

## Chat Completions malformed tool calls

`malformed_tool_call` records a sampled Chat Completions model returning a tool call
the client cannot run. Its `upstreamEvent` is `chat.tool_call` and its `upstreamCode`
is `unknown_tool` or `invalid_tool_arguments`. Unlike `invalid_tool_call`, this failure
is retryable, so one event does not mean a worker stopped. Tool names and arguments
stay out of telemetry.

## Cache and failure screen

`api_cache_cold` records large measured cold OpenRouter Responses requests, with
token counts and flags for changed catalogs, instructions, sampled opening history
or affinity. Idle time runs from the previous measured completion to the next
request. Content and digests never enter telemetry; unchanged sampled fields do
not prove that the full prefix matched or that the provider retained its cache.
`copilot_session_violation` records a fixed event type, guard reason, session
state, pending-call count and whether a request was attached. Unknown event names
become `unknown`; event payloads are never recorded.
`copilot_tool_rejected` distinguishes missing, non-string and empty names,
declared or ambiguous caller aliases, names shaped like retired native tools,
and other undeclared names. It records only that fixed category and catalog/call
counts. The unknown name and arguments remain private. All unknown calls still
fail without execution or an automatic conversation replay.

The native app's **Diagnostics** screen reads local telemetry over the last 1, 6
or 24 hours. It shows input tokens, cache reads and writes, failed requests per
model, Copilot session reuse/rebuild reasons, and the latest provider failures
and reconnect signals. It names the Mac being inspected; a client-only setup
does not silently present another host's usage as local data.

`gateway diagnostics --since HOURS` includes the same `cacheUsage`,
`copilotSessions` and `issues` fields alongside its existing summary. Cache hit
percentages use the input tokens of requests that actually reported cache reads.
Explicit zero means a measured cold cache; absent or incomplete counts remain
unreported. Sample counts show partial coverage. Failed requests retain whatever
usage the provider reported before failing. Copilot requests with multiple model
calls report cache totals only when every call supplied those counts. Claude
cache percentages also require its native input, read and write counts because
native input excludes both kinds of cache tokens.
Historical records from older versions may already have normalized missing
counts to zero; that original observation coverage cannot be recovered.
Copilot session token totals have separate read/write sample counts; a total of
zero with no samples is unreported usage, not a measured cold cache.

Claude, Copilot and Grok `blocked`/`preserved` continuity decisions appear among
diagnostic issues. They indicate that Gateway stopped instead of silently replaying
history. Deterministic tool/protocol failures keep their original diagnostic class
and usage even when the client-facing response is a final HTTP 400 or terminal
stream error. See [provider reuse](provider-reuse.md).

New Copilot failures record fixed discriminants such as `unknown_tool`,
`duplicate_tool_id`, `malformed_tool_call`, `invalid_tool_arguments`,
`nontext_custom_input` and `tool_request_missing`. They preserve the existing
tool checks and retry behavior. No tool names, arguments, prompts or private error
prose are added. Old generic `invalid_tool_call` records cannot be reconstructed;
the app labels those as lacking a detailed reason. Routine filesystem lookup
errors remain in the CLI's existing `recentProblems` rather than burying provider
failures in the app. A retrying turn and a failed provider request are separate
signals; the screen does not claim they are correlated without a shared identifier.

The [native view render](evidence/gateway-diagnostics-2026-10-27.png) uses sampled
server telemetry for visual QA. It does not establish deployment or retrospective
recovery of missing error details.

## Gateway-rule refusals and dropped control items

Two fixed fields describe how the gateway treated a Responses request before any provider ran
([details](responses.md#websocket-refusals-internal-fields-and-control-items)).

| Field | Where | Meaning |
| --- | --- | --- |
| `translation_reason` | `request_failed`, and the stderr `provider_failure` line | The gateway refused the request by its own rule, not because translation failed. The only value is `unsupported_compaction`: the request carried a `compaction_trigger` item. Any other value is dropped. |
| `droppedControlItems` | `request_completed`, `request_empty`, `request_failed` | How many `configuration_update` items were removed. A count only, never item content; absent when it is zero. |

`gateway diagnostics` counts a refused compaction as `failed:invalid_request:unsupported_compaction`
beside the translation reasons (`failed:invalid_request:<reason>`), so it does not hide among plain
`failed:invalid_request` rows.

## Provider connection diagnostics

Responses transport failures retain only an allowlisted low-level network code
(`upstreamCode`) and a fixed `upstreamStage` of `connect`, `stream`, or `unknown`. Raw
exception messages, socket addresses, URLs, certificate details, stacks,
credentials, and request content are excluded. Unknown faults remain unknown;
the gateway does not infer a DNS or TLS cause from message text.

Known transient Responses connection failures and named temporary throttles have
independent pre-output 120-second budgets. Each uses a jittered one-, two-, four-,
then eight-second schedule (or a throttle's bounded `Retry-After`); all other
retryable failures share one retry. A wait that would reach a class deadline is
not shortened, and the deadline is checked again after the abortable wait before
another upstream request starts. An already-started request may outlast that retry
window but remains bounded by the caller deadline. `request_failed` may include a
descriptor-safe integer `retryAfterMs` only from 0 through 3,600,000. Any inference
output makes the failure final for this provider call so recovery cannot duplicate
visible text or caller tool calls. Certificate, permanent DNS, connection-refused,
unknown, cancellation, and OAuth refresh faults are excluded from this additional
internal retry.

## Claude credential failures

Claude authentication failures carry `upstreamReason` only when a native
`claude.assistant` or `claude.result` failure reports `authentication_failed`.
The value is a fixed reason listed in [Claude sessions](claude-sessions.md#authentication-failures);
provider diagnostic text and credentials are never recorded. A
`claude_credential_recovery` event records only the reason, attempt number and
fixed outcome (`attempted`, `recovered`, `failed`, or `cancelled`). These records
distinguish a bounded recovery from a final login failure without treating local
credential presence as proof of working authentication.

## Claude request rejections

Native Claude `invalid_request` failures are final request errors. JSON clients
receive HTTP 400; Responses streams receive `invalid_prompt`, and Messages
streams receive `invalid_request_error`. Clients must not repeat the unchanged
request as a transient disconnect. Context overflow still uses its separate
`context_length_exceeded` classification so the client can compact normally.

When a bounded native failure diagnostic begins with `API Error:` and carries
the fixed `reasoning_extraction` details marker line, the gateway returns a fixed
explanation of Claude's private-reasoning refusal. Telemetry stores only
`upstreamReason: reasoning_extraction`. It never stores the diagnostic prose,
provider request/message IDs from that prose, caller content or credentials.
The gateway does not rewrite the chat, remove caller instructions, switch
models, or try to bypass the provider's refusal. A refusal is not a crash: the
session ends as `claude_session` `closed` with `missReason: refused` and no replay
hold. The next message goes to Claude, and the cache stop limits repeated resends.

## Grok CLI records

Each Grok subscription request writes one `grok_cli` event: `model`, `effort`,
`durationMs`, `result` (`tool_use`, `end_turn`, `result` or `none`), `exitCode`,
`spawnFailed`, `aborted`, `toolCalls`, `inputTokens`, `cacheReadTokens`,
`outputTokens` and `costUsd`, the allowance cost the CLI reported. Failures use
the upstream events `grok.assistant`, `grok.result` and `grok.tool_use`. See
[Grok subscription](grok-sessions.md).
