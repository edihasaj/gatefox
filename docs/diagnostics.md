---
summary: 'Local telemetry, gateway diagnostics, and scrubbed exception reports to GlitchTip.'
read_when:
  - Investigating stopped turns, failures, restarts or cache behavior
  - Changing what the gateway logs or reports
---

# Diagnostics

The gateway keeps a private event log on every Mac and sends only exceptions to
the private GlitchTip project. Neither runs on a request path.

## Local telemetry

Each process appends one JSON line per event to
`<state>/telemetry/events-YYYY-MM-DD.jsonl` (mode 0600, kept 14 days). Fields pass
a strict filter: only strings, numbers and booleans; names that could carry
secrets or content (token, prompt, body, content, text, input, argument, env,
header, auth) are dropped, except numeric token counts; text is reduced to a safe
character set and home paths to their last segment. Error text is never stored,
only a fixed class such as `stream_disconnected`, `usage_limit` or `attachment` (a queued or attached local file the engine could not read). A status code such as 503 counts as `overloaded` only as a standalone number, never as digits inside a chat id.

| Process | Events |
| --- | --- |
| Adapter | `turn_started`, `turn_completed`, `turn_empty_completion` (completed with no answer and no tool call), `turn_error`, `turn_quiet` (no events for five minutes), `rpc_error`, `adapter_client`, `adapter_session_end`, `reasoning_restored` (provider, method and source `record`, `rollout` or `thread` of a chat's recovered effort, adjusted), `reasoning_effort_reset` (from, to, model and method when a restored level had to be fitted), `reasoning_unrecovered` (model when no effort could be recovered) |
| Server | `request_completed`, `request_empty`, `request_failed` (queue time, time to first event, tool calls, input, cached and output tokens, whether a Codex turn-state was echoed and returned, and `abortCause` such as `shutdown`), `provider_retry`, `claude_cli` (mode, toolCalls, input, cache read and write, and output tokens, interrupted, retry, `threadKey` — the same first 8 hex `claude_session` reports, when the request carried a thread id, so one thread's one-shot and live events line up — and `systemPrefixOnly` set when its cache read reached only the system prefix, the same test `claude_session` applies below; also on tool turns and cancellations), `claude_session` (live sessions: outcome such as spawned, continued, reseeded, fallback, interrupted, reaped, evicted or crashed, the miss reason (a `fallback` outcome carries `capacity` when every slot held a warm session, or the replay-hold reason `prefix_diverged`, `unexpected_tail`, `forced_choice`, `effort_midturn` or `session_dead`), cache read and write, input and output tokens, `threadKey` — the first 8 hex of the thread's session key — and `systemPrefixOnly` on a spawn or reseed that read only the system prefix — reported once the request's cache read plus write pass that prefix by a margin, since the threshold (32,035 tokens) is calibrated to the Codex system prefix and a shorter prompt says nothing either way), `model_alias_resolved`, `server_hot_swap`, `model_metadata_refreshed`, `model_metadata_skipped` (the six-hour metadata refresh left one provider out: `provider` and a fixed `reason`, `refresh_deferred` when a Codex login's access token had expired and the refresh was left to the next real request, or `discovery_failed`), `server_shutdown_signal`, `server_drain` (requests drained, drain time, requests aborted) |
| Service | `component_exit`, `execution_host_failed`, `execution_host_recovered`, `native_acquire` (attached, launched, replaced, refused), `system_wake`, `tunnel_stale_listener_cleared`, `sharing_disabled`, `sharing_disable_failed`, `self_upgrade` |

A request whose Codex login refresh was rejected or failed records `request_failed` with
`upstreamEvent` `oauth_refresh` and `upstreamCode` set to the OAuth error code the token
endpoint returned: one of `invalid_grant`, `refresh_token_reused`, `refresh_token_expired`,
`refresh_token_invalidated`, `invalid_request`, `invalid_client`, `unauthorized_client`,
`unsupported_grant_type`, `invalid_scope`, `access_denied`, `invalid_token`, `token_expired`,
`server_error`, `temporarily_unavailable`, `slow_down`, `rate_limit_exceeded`, `other` for any
code outside that list, or `none` when the reply carried no code. Only the code is read; the reply's
description, body and tokens are never recorded.

A request the gateway could not translate records the same `request_failed` event plus
two fixed fields: `reason` is one of `invalid_shape`, `unsupported_input_item`,
`unsupported_content`, `unsupported_role`, `invalid_tool_call`, `unsupported_tool`,
`duplicate_tool`, `unsupported_tool_choice`, `invalid_image`, `invalid_reasoning_state`,
`invalid_instructions`, `invalid_provider_output`; `itemType` names the rejected item or
tool type, but only from a fixed allowlist of Responses wire types, and as `other` for
anything the list does not contain. A value outside those sets is dropped rather than
recorded, so no caller text, tool name, or identifier can ride in on them.
`gateway diagnostics` groups those failures by code and reason, which separates a
malformed request from an unsupported item without storing either's contents. The
message the client receives stays "Responses request contains invalid or unsupported
data" whatever the reason.

`gateway diagnostics [--since HOURS]` summarizes the log: turn outcomes and
failure classes per model, request outcomes, cache-hit ratio and first-event
latency per model, retries, RPC errors, component exits, host events, live Claude
sessions per outcome (and per miss reason) with their cache reads, writes and a rewrite
count — the spawns and reseeds whose cache read reached only the system prefix — and the 25
most recent problems. Set `GATEWAY_TELEMETRY=off` to disable the log.

## Native relay records

The native relay writes its own JSON records to its managed log, one record per
write: session lifecycle, `session_activity` and `session_ended` with transport
counters, `transport_activity`, and audited SDK transport events (`sdk_log`). Client
and stream IDs appear only as per-process hashes, and SDK message text is never
printed. See [native connected machines](native-remote.md#reading-the-logs).

## Exception reports

Only exceptions go to `errors.applifyer.com`, project `harness-gateway`. The DSN
is the 1Password item `GlitchTip DSN - harness-gateway` (vault `applifyer`) and
lives on each Mac in `<state>/glitchtip.dsn` (mode 0600, owned by the user); a
file other users can read is ignored. Without it nothing is sent.

| Source | Sent as |
| --- | --- |
| Uncaught exception or rejection in the server, adapter or service | `fatal`, written synchronously to `<state>/error-spool/` and sent by the next process start |
| Untyped provider failure (`provider_failed`), internal adapter RPC failure, adapter start failure, execution host start failure | `error`, sent in the background with a five-second timeout |

Typed provider and protocol failures (including malformed stream frames and
invalid historical tool arguments), cancellations and turn anomalies stay in the
local log. JSON parser messages are replaced with "JSON parse failed", because
they quote the text they failed on. Crash reports are written to a temporary file
and renamed, and a spool file that cannot be read is discarded. Events carry the exception type, a scrubbed message (credentials, long
secrets, home paths and URL paths removed) and file, function and line frames.
The machine is a hashed label; no user, request, environment, device or local
variables are sent. Repeats of one failure within ten minutes are dropped, and a
process sends at most 30 reports an hour. Set `GATEWAY_ERROR_REPORTS=off` to
disable reporting.
