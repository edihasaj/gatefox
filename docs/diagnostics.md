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
only a fixed class such as `stream_disconnected` or `usage_limit`.

| Process | Events |
| --- | --- |
| Adapter | `turn_started`, `turn_completed`, `turn_empty_completion` (completed with no answer and no tool call), `turn_error`, `turn_quiet` (no events for five minutes), `rpc_error`, `adapter_client`, `adapter_session_end` |
| Server | `request_completed`, `request_empty`, `request_failed` (queue time, time to first event, tool calls, input, cached and output tokens), `provider_retry`, `claude_cli`, `keep_awake` |
| Service | `component_exit`, `execution_host_failed`, `execution_host_recovered`, `native_acquire` (attached, launched, replaced, refused), `sharing_disabled` |

`gateway diagnostics [--since HOURS]` summarizes the log: turn outcomes and
failure classes per model, request outcomes, cache-hit ratio and first-event
latency per model, retries, RPC errors, component exits, host events, and the 25
most recent problems. Set `GATEWAY_TELEMETRY=off` to disable the log.

## Exception reports

Only exceptions go to `errors.applifyer.com`, project `harness-gateway`. The DSN
is the 1Password item `GlitchTip DSN - harness-gateway` (vault `applifyer`) and
lives on each Mac in `<state>/glitchtip.dsn` (mode 0600, owned by the user); a
file other users can read is ignored. Without it nothing is sent.

| Source | Sent as |
| --- | --- |
| Uncaught exception or rejection in the server, adapter or service | `fatal`, written synchronously to `<state>/error-spool/` and sent by the next process start |
| Untyped provider failure (`provider_failed`), internal adapter RPC failure, adapter start failure, execution host start failure | `error`, sent in the background with a five-second timeout |

Typed provider and protocol failures, cancellations and turn anomalies stay in the
local log. Events carry the exception type, a scrubbed message (credentials, long
secrets, home paths and URL paths removed) and file, function and line frames.
The machine is a hashed label; no user, request, environment, device or local
variables are sent. Repeats of one failure within ten minutes are dropped, and a
process sends at most 30 reports an hour. Set `GATEWAY_ERROR_REPORTS=off` to
disable reporting.
