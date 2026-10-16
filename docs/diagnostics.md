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
| Adapter | `turn_started`, `turn_completed`, `turn_empty_completion` (completed with no answer and no tool call), `turn_error`, `turn_quiet` (no events for five minutes), `rpc_error`, `adapter_client`, `adapter_session_end`, `native_sharing_fallback` (no fields: the plan shares native chats, but the host runs without native sharing, so this adapter started its own native engine and kept gateway chats on the host), `reasoning_restored` (provider `gateway`, method and source `record`, `rollout` or `thread` of a gateway chat's recovered effort, adjusted; native chats are never restored by the adapter, so 0.4.1 no longer logs `provider: native`), `reasoning_effort_reset` (from, to, model and method when a restored level had to be fitted), `reasoning_unrecovered` (model when no effort could be recovered), `gateway_features_trimmed` (exactly `site`, one of `request`, `spawn`, `home` or `retry`, and `count`: how many feature settings were dropped, reduced to a boolean or rewritten so the pinned gateway SDK accepts them; a structured table that had fields removed also counts, once per entry however many fields went; `retry` is the strict form sent once after the SDK refused a thread request's configuration; never names or values; only when count is above zero), `service_tier_dropped` (exactly `model`, `tier` and `method`: a speed tier the selected gateway row does not offer was dropped, so the session starts as Standard; `method` is `thread/start`, `thread/resume` or `thread/fork`; `tier` is one of `priority`, `fast` or a tier id from the gateway model catalog, and any other value is logged as `other`; Flex is never dropped, so it is never logged; recorded only after the SDK accepted the request, and only when the SDK's answer carries no tier, `null` or `default`, because a loaded chat that kept its tier was not dropped) |
| Server | `request_completed`, `request_empty`, `request_failed` (queue time, time to first event, tool calls, input, cached, cache-write, reasoning and output tokens, `providerType`, Copilot `nanoAiu` credits with `nanoAiuStatus` and the `initiator` of its model calls (`user`, `agent` or `mixed`), whether a Codex turn-state was echoed and returned, and `abortCause` such as `shutdown`), `provider_retry`, `claude_cli` (mode, toolCalls, input, cache read and write, and output tokens, interrupted, retry, `threadKey` — the same first 8 hex `claude_session` reports, when the request carried a thread id, so one thread's one-shot and live events line up — and `systemPrefixOnly` set when its cache read reached only the system prefix, the same test `claude_session` applies below; also on tool turns and cancellations), `claude_session` (live sessions: outcome such as spawned, continued, reseeded, fallback, interrupted, reaped, evicted or crashed, the miss reason (a `fallback` outcome carries `capacity` when every slot held a warm session, or the replay-hold reason `prefix_diverged`, `unexpected_tail`, `forced_choice`, `effort_midturn` or `session_dead`), cache read and write, input and output tokens, `threadKey` — the first 8 hex of the thread's session key — and `systemPrefixOnly` on a spawn or reseed that read only the system prefix — reported once the request's cache read plus write pass that prefix by a margin, since the threshold (32,035 tokens) is calibrated to the Codex system prefix and a shorter prompt says nothing either way), `copilot_session` (live Copilot sessions, on by default: `outcome` spawned, continued, reseeded, fallback, interrupted, reaped, evicted, crashed or closed; `missReason`, which is the reseed or fallback reason of a request and the reason a session ended; `threadKey`; `liveSessions`; `divergedAt`; `parkedMs`; `failed`; and the request's own `initiator` (`user`, `agent` or `mixed`), `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `nanoAiu` and `toolCalls`; every outcome, field and reason is listed in [live Copilot sessions](copilot-sessions.md#billing-and-diagnostics)), `model_alias_resolved`, `server_hot_swap`, `model_metadata_refreshed`, `model_metadata_skipped` (the six-hour metadata refresh left one provider out: `provider` and a fixed `reason`, `refresh_deferred` when serving a Codex login's access token would need a refresh (it has expired, or expires within two minutes unless the issuer's `earliest_refresh_at` is still in the future) and the refresh was left to the next real request, or `discovery_failed` for any other failure; the error text is never recorded), `server_shutdown_signal`, `server_drain` (requests drained, drain time, requests aborted) |
| Service | `component_exit`, `execution_host_failed`, `execution_host_recovered`, `native_acquire` (attached, launched, replaced, refused), `native_sharing_unavailable` (exactly `reason`: `sdk_version`, `sdk_signature` or `other`; the host started without native sharing because the app's native engine was not the verified one), `system_wake`, `tunnel_stale_listener_cleared`, `sharing_disabled`, `sharing_disable_failed`, `self_upgrade` |

An adapter `rpc_error` records the method, the JSON-RPC code and either `reason` (the
adapter's own fixed routing message) or `errorClass`. It also records `rejection`, named
from the engine's or adapter's message, which is itself never stored: `adapter_routing`,
`unknown_method`, `experimental_api`, `invalid_params`, `relative_path` (a path such as
the desktop's projectless `~` that is not absolute), `prediction_fork_overrides`,
`prediction_fork_parent`, `no_active_process`, `process_not_running`,
`duplicate_process_handle`, `spawn_failed`, `rollout_not_found`, `thread_not_loaded`,
`thread_not_persisted`, `engine_closed`, `engine_timeout`, or `other`. `gateway
diagnostics` groups non-routing RPC errors by `rejection` when it is more specific
than `other` (and by `errorClass` otherwise); adapter routing errors stay grouped by
their fixed `reason`.

A request whose Codex login refresh was answered with an HTTP error status (400, 401 or 403
for a rejected login; any other HTTP error status, for example 429 or 5xx, for a temporary
failure) records `request_failed` with `upstreamEvent` `oauth_refresh` and `upstreamCode` set to the OAuth error code the token
endpoint returned: one of `invalid_grant`, `refresh_token_reused`, `refresh_token_expired`,
`refresh_token_invalidated`, `invalid_request`, `invalid_client`, `unauthorized_client`,
`unsupported_grant_type`, `invalid_scope`, `access_denied`, `invalid_token`, `token_expired`,
`server_error`, `temporarily_unavailable`, `slow_down`, `rate_limit_exceeded`, `other` for any
code outside that list, or `none` when the reply carried no code. Only the code is kept; the reply's
description, body and tokens are never recorded or shown. Other refresh failures record only `code` and
`status`. A temporary `upstream_unavailable` 503 covers a network error, a busy refresh lock, an
unreadable or malformed reply, and a credential file that could not be written after a successful
reply. `authentication` 401 means the stored login needs the user to sign in: there is no login,
the credential file is unreadable, the stored login has no refresh token or lacks the plan scopes,
or a refresh reply lacked the plan scopes.
A failed refresh is never retried inside the request, so the single-use refresh token is spent
once and no `provider_retry` follows it.

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
latency per model, Auto-review requests (`autoReview`, below), retries, RPC errors,
component exits, host events, live Claude
sessions per outcome (and per miss reason) with their cache reads, writes and a rewrite
count — the spawns and reseeds whose cache read reached only the system prefix — and the 25
most recent problems. Set `GATEWAY_TELEMETRY=off` to disable the log.

A request whose model is the reviewer `codex-auto-review` carries `autoReview: true` on
`request_completed`, `request_empty` and `request_failed`, including its 404. Gateway
executors send every Auto-review approval there (node_repl, shell, `apply_patch`,
network, MCP and permissions), so `gateway diagnostics` counts them together in an
`autoReview` bucket: `completed`, `empty` and `failed:<code>`
([node_repl](node-repl.md#scope-data-and-decision)).

## Native relay records

The native relay writes its own JSON records to its managed log, one record per
write: session lifecycle, `session_activity` and `session_ended` with transport
counters, `transport_activity`, and audited SDK transport events (`sdk_log`). Client
and stream IDs appear only as per-process hashes, and SDK message text is never
printed. See [native connected machines](native-remote.md#reading-the-logs).

## Usage ledger

The gateway also appends one content-free row per finished request to
`<state>/usage/usage-YYYY-MM.jsonl` (UTC month). The directory is mode 0700 and the
files 0600. The current month and the previous 12 are kept; older files are removed
on the first write and whenever the month changes. Set `GATEWAY_USAGE_LEDGER=off` to
disable it: nothing is created, imported or marked. It is independent of
`GATEWAY_TELEMETRY`.

A row holds only `v`, `at`, `host`, `requestId`, `responseId` (marked responses
only), `provider`, `providerType`, `model`, `status` (`completed`, `empty` or
`failed`), `origin` (`gateway`, or `telemetry` for imported rows), `session`
(imported rows only), `inputTokens` (gross, including cached), `cachedTokens`,
`cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `nanoAiu` and `nanoAiuStatus`.
`nanoAiu` is Copilot's credit amount in billionths of a credit; `null` means none
was reported, which is not zero. `nanoAiuStatus` is present on every Copilot row that
has usage: `complete` when every model call of the request was priced, `partial` when
only some were priced or Copilot itself called a figure partial (the amount is then a
floor), and `unavailable` when none was. A request that fails after a provider reported
usage keeps that usage, and so does a request whose caller disconnected after the
provider reported it, so a Copilot call that is billed and then rejected or abandoned
still shows up. When a request stops early (the caller left, it was cancelled or timed
out, or the gateway is shutting down), even while the gateway waits for a slow client to
take earlier output, the server reads the provider on for up to 3 seconds, for usage
only, so usage the provider received before the stop is not lost. At shutdown the
server waits for those requests to write their rows before it flushes telemetry and the
ledger, but a stopping process leaves 1.5 seconds after the drain deadline at the
latest. Before it leaves, it records every request still running as `failed` (a ledger
row and a `request_failed` event with `abortCause` `shutdown`) with the usage received so
far, and then flushes both, so usage that arrives later than that is not recorded but
usage already received is.
A row with no tokens and no credit amount is not written.

Never stored: prompts, instructions, messages, tool names, arguments or outputs,
images, thread, session or turn ids, account ids, credentials, error text or
environment values.

**Marker.** For `copilot-subscription` and `claude-subscription` routes, while the
ledger is on, the Responses id is `resp_gl_<request id without dashes>` instead of a
random `resp_<hex>`. Codex records that id in its own rollout, so a spend tool counts
a gateway request once, from the ledger, and skips the matching Codex record. A
Messages request on those routes gets the message id `msg_gl_<request id without
dashes>` instead of a random `msg_<hex>`, and its row records that id.

**Telemetry import.** The first time the ledger is prepared, and
`<state>/usage/telemetry-import.json` is absent, each `request_*` telemetry event with
input or output tokens becomes one `origin: "telemetry"` row (no response id), and the
marker file records the count. This keeps request history that telemetry would drop
after its 14 days. An imported row keeps the cache-write, reasoning and credit figures
its event carries (`cacheWriteTokens`, `reasoningTokens`, `nanoAiu`, `nanoAiuStatus`);
an event from before those fields existed has none, so its row reads 0 for the token
figures and `null` for `nanoAiu`.
`providerType` is set only for providers in the current configuration. The import skips
every request this process records and any request already in the ledger, and writes in
one append per month, so a request is never counted twice; a reader also keeps one row
per request id and prefers the gateway's own row over an imported one.

`gateway diagnostics` also sums Copilot credits per model from `nanoAiu`.

## Running component releases

An install only moves the `current` link, so a process that started earlier
keeps running the release it loaded. Its command line still says
`.../current/...`, a link the operating system resolved when the process
started, which is why it says nothing about what that process is running.
`gateway versions [--json] [--check]` answers that question: it lists this
user's gateway processes, names each one's role (`service`, `inference`,
`desktop-adapter`, `ssh-listener`, `ssh-proxy`, `executor-host`,
`gateway-engine`, `native-relay`, `tunnel` or `other`) and reads the release
from the text files the process actually has mapped, found with `lsof`,
rather than from its command line. The report skips this process itself, so
running the command never adds a row.

A command line is only read where the program sits: at argv[0], or at argv[1]
behind a node interpreter for the CLI script. A wrapper that merely mentions
one of our paths inside a quoted string
(`zsh -c node .../current/package/dist/cli.js serve`), a wrapper program such as
`/usr/bin/time` that starts node, another product's `releases/` folder, or one
of our paths used as an argument, runs none of ours and is left out. Short-lived
helper scripts a request starts (such as the Claude tool helper) are not listed. The install root is matched
both as written and with its links resolved, so a tree reached through a
symlink is still recognized.

The one exception is the inference process. A release that replaced itself in
place keeps the node runtime it started with mapped, so `lsof` names the
release it started from rather than the code it serves. There the health
endpoint answers instead, and its `X-Gateway-Release` header wins: the command
asks `lsof` which loopback ports the process listens on, and sends one
`GET http://127.0.0.1:PORT/health` with a two second timeout to each in turn,
lowest port first, until one answers. The port comes from the process's own listening socket,
never from its arguments, so a server started with a quoted configuration path
and no `--port` is still found. When nothing answers, the report falls back to
the mapped release. Those requests are the only thing here that leaves the
process, and they never leave the machine.

What is printed is limited to roles, pids, start times and release versions;
command arguments, paths and environment values are never shown. A release
that neither `lsof` nor the command line can name reads `unknown`, and a
process started from a source checkout reads `checkout`. The human form
prints the installed release, one row per process with its start time on the
local clock, then a summary: `all on RELEASE` or `N lagging: role@release`,
one mention per distinct pair.
`--json` prints the same data as
`{ installed, processes: [{ role, pid, startedAt, release }], lagging }`,
where `installed` is the release the `current` link points at and `startedAt`
is that start time as a UTC instant. A run from a checkout or worktree, which
has no `current` of its own, names the release the default install's link
points at, `~/.local/share/subscription-gateway`, and still calls its own
processes `checkout`. When neither link resolves, `installed` is null, which
`--json` always prints.

`--check` exits 1 when a process runs another release than the installed one,
or `unknown`, and 0 when none does. It exits 2 when there is no installed
release to compare against, because a run that names none cannot tell a lagging
process from an up to date one; the report itself is still printed. A flag
outside `--json` and `--check`, and a process list `ps` cannot read, exit 2
too; `--help` or `-h` prints the usage line and exits 0. See
[release](RELEASING.md#updating-without-quitting-the-app) for how long a
lagging process may legitimately take to move.

## Exception reports

Only exceptions go to `errors.applifyer.com`, project `harness-gateway`. The DSN
is the 1Password item `GlitchTip DSN - harness-gateway` (vault `applifyer`) and
lives on each Mac in `<state>/glitchtip.dsn` (mode 0600, owned by the user); a
file other users can read is ignored. Without it nothing is sent.

| Source | Sent as |
| --- | --- |
| Uncaught exception or rejection in the server, adapter or service | `fatal`, written synchronously to `<state>/error-spool/` and sent by the next process start |
| Untyped provider failure (`provider_failed`), internal adapter RPC failure, adapter start failure, execution host start failure | `error`, sent in the background with a five-second timeout |
| A live Copilot session's own bookkeeping failing: `copilot_live_attach` (placing a request in its session raised something other than a provider failure; the request is served one-shot), `copilot_live_close` (closing a session or reporting its end failed), `copilot_live_abort` (ending a cancelled request failed) | `error`, sent in the background like the row above |

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
