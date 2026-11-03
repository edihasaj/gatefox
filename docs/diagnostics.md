---
summary: 'Local telemetry, gateway diagnostics, and scrubbed exception reports to GlitchTip.'
read_when:
  - Investigating stopped turns, failures, restarts or cache behavior
  - Changing what the gateway logs or reports
---

# Diagnostics

The gateway keeps a private event log on every Mac and sends only exceptions to
the private GlitchTip project. Neither runs on a request path.

## Responses tool identity failures

`tool_identity_failure` separates Responses catalog/name matching failures from
malformed arguments and other `invalid_tool_call` errors. Its `upstreamCode` is
one of `missing_tool_name`, `unknown_wire_tool`, `unexpected_tool_namespace` or
`undeclared_tool`; `upstreamLastEvent` and bounded stream counts identify the
actual failure boundary. The client receives a fixed explanation and the same
final refusal behavior as other invalid tool output. No tool is dispatched by
this classification. Names, namespaces, arguments and response content remain
private, and no automatic inference retry is added.

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

## Local telemetry

`provider_connection_recovered` records a Chat Completions connection that
obtained an HTTP response after transient retries: `provider`, `attempts`,
`elapsedMs` and `httpStatus` only. It proves restored transport reachability;
`request_completed` remains the evidence that inference actually finished.
Tailnet connection failures retain allowlisted network codes and the fixed
`connect` stage, so temporary DNS and dial timeouts can be distinguished from
certificate failures without recording addresses or exception prose.

`context_cache_guard` reports `outcome: blocked`, `mode: seed|oneshot|continued|provider`, a hashed
`threadKey` and a numeric `rewrites` count. It appears in recent problems when
the shared guard stops another large uncached request before inference.
See [cache safety](cache-safety.md).

Each process appends one JSON line per event to
`<state>/telemetry/events-YYYY-MM-DD.jsonl` (mode 0600, kept 14 days). Fields pass
a strict filter: only strings, numbers and booleans; names that could carry
secrets or content (token, prompt, body, content, text, input, argument, env,
header, auth) are dropped, except numeric token counts; text is reduced to a safe
character set and home paths to their last segment. Error text is never stored,
only a fixed class such as `stream_disconnected`, `usage_limit`, `rate_limit` or `attachment` (a queued or attached local file the engine could not read). A status code such as 503 counts as `overloaded` only as a standalone number, never as digits inside a chat id.

| Process | Events |
| --- | --- |
| Adapter | `turn_started`, `turn_completed`, `turn_empty_completion` (completed with no answer and no tool call), `turn_error`, `turn_quiet` (no events for five minutes), `rpc_error`, `adapter_client` (`client` and `clientVersion`, the names the desktop gave in `initialize`), `adapter_session_end` (`durationMs`, `requests` and `nativeClosed`, whether the native engine had already closed), `adapter_start_failed` (`errorClass` and `code`, such as -32001 when a required host is unavailable: the adapter could not start its engines; a host that is restarting, busy or owned elsewhere is not also reported as an exception), `native_catalog_incomplete` (exactly `missing`, a count, and optionally `cacheVersionMatches`; recorded once per adapter start when the native model cache lacks models the engine lists), `native_relay_skipped` (exactly `reason`: `not_registered`, `not_connected` or `unreachable`; the adapter or SSH listener starts without routing to the native relay; with `not_registered` the engine keeps its own remote control, and from 0.4.8 with `not_connected` or `unreachable` it does not, because a registered relay owns remote control; once per process, see [when the relay is set aside](#when-the-relay-is-set-aside)), `native_activation_refused` (exactly `reason`, recorded by `gateway native install` under a unified plan before anything changed or after a clean rollback: `app_running` (ChatGPT was open), `listener_busy` (an SSH listener had a request or turn in flight, or declined to retire), `listener_unknown` (a listener kept no usable activity record, such as one from a release before 0.4.8, or its start time no longer matches), `adapter_running` (another Codex session on this Mac holds an engine), `listener_stuck` (a listener that agreed to retire did not exit in 10 s), `host_busy` (the shared host's native engine did not stand down within 30 s), `process_list` (the process list could not be read or parsed) or `signal_failed` (asking a listener to retire failed)), `native_activation_failed` (exactly `reason`: `timeout`, `exit`, `start` or `other`; the relay's `--enable` did not connect, and the previous registration was kept byte for byte), `native_listener_retired` (exactly `count`: idle SSH listeners that retired themselves before `--enable`), `ssh_listener_retire_request` (exactly `outcome`, `retired` or `declined`: recorded by an SSH listener when an activation asked it to retire; it retires only if no request is in flight, no turn runs and it has been silent for 30 s), `engine_exit` (`engine`, `code`, `signal`, `uptimeMs`, `activeTurns`, `initiatedBy` and `reason`: one engine process this adapter spawned ended, once per process), `engine_frame_dropped` (`engine` and `sizeMiB`), `engine_frame_invalid` (`engine`), `engine_message_failed` (`engine`, and `method` only when it is a plain method name), `native_turns_evicted` (`count`; at most once a minute), `execution_host_control_lost` (exactly `sharedGateway`: the executor host closed this desktop session's control connection, so the session ended and the app reconnects and acquires a fresh one, see [the shared host's control connection](engine-exits.md)); the engine events are explained in [engine exits](engine-exits.md), `native_sharing_fallback` (exactly `reason` and `holders`: `reason` is `host_unavailable` when the plan shares native chats but the host stayed down through the adapter's wait and no live native owner remained, so this adapter took a private native-home lease and started its own native engine, `other` when the host runs without native sharing, so this adapter started its own native engine and kept gateway chats on the host, or `native_owner` when a running host with native sharing refused native ownership because private engines that ran while it was down still hold the native home, so this adapter joined them with its own engine instead of failing; `holders` is a number only, how many private engines held the native home once this adapter's lease was taken, this one included: private engines share the home with each other and never with the host's native writer, see [native fallback](app-server.md); recorded only once the fallback was allowed), `compaction_switch_refused` (exactly `sourceFamily`, `targetFamily`, `measuredTokens`, `estimatedTokens` and `limitTokens`: a turn that switched a gateway chat to another tokenizer was refused before it was sent, because the last measurement recounted for the selected model would not fit its usable window; see [compaction](app-server-compaction.md#switching-to-another-tokenizer)), `model_switch_promoted` (no fields: with `midTurnModelSwitch` on, a picker model change was also applied to the running gateway turn), `model_switch_deferred` (exactly `reason`: `context` when the tokenizer recount refused it, `review_group` when the SDK's active-step check refused it, `not_applied` or `error`; the change still applies from the next turn; see [mid-turn model changes](app-server.md#mid-turn-model-changes-from-the-picker)), `reasoning_restored` (provider `gateway`, method and source `record`, `rollout` or `thread` of a gateway chat's recovered effort, adjusted; native chats are never restored by the adapter, so 0.4.1 no longer logs `provider: native`), `reasoning_effort_reset` (from, to, model and method when a restored level had to be fitted), `reasoning_unrecovered` (model when no effort could be recovered), `gateway_features_trimmed` (exactly `site`, one of `request`, `spawn`, `home` or `retry`, and `count`: how many feature settings were dropped, reduced to a boolean or rewritten so the pinned gateway SDK accepts them; a structured table that had fields removed also counts, once per entry however many fields went; `retry` is the strict form sent once after the SDK refused a thread request's configuration; never names or values; only when count is above zero), `service_tier_dropped` (exactly `model`, `tier` and `method`: a speed tier the selected gateway row does not offer was dropped, so the session starts as Standard; `method` is `thread/start`, `thread/resume` or `thread/fork`; `tier` is one of `priority`, `fast` or a tier id from the gateway model catalog, and any other value is logged as `other`; Flex is never dropped, so it is never logged; recorded only after the SDK accepted the request, and only when the SDK's answer carries no tier, `null` or `default`, because a loaded chat that kept its tier was not dropped), `ssh_listener_replaced` (`from` and `to` releases, no paths: a bootstrap on the installed release replaced a remote listener that was running another release; `from` is `unknown` when that listener recorded no release, which means it started from a checkout or from a release before 0.4.4, so the first 0.4.4 rollout logs `from: "unknown"` for every listener it replaces), `gateway_chat_classified` (exactly `rule` and `method`: `rule` is the first rule that identified the chat, `legacy_provider`, `registry`, `parent`, `alias` or `native`, in the order the adapter checks them, and `native` when none matched; `method` is the request or notification that made the adapter classify the chat, one of `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/settings/update`, `turn/settings/update`, `thread/settings/updated`, `thread/unsubscribe` or `compaction`, and any other method is logged as `other`; recorded once per chat per desktop connection, never with a chat id), `gateway_registry_write_failed` (no fields: the adapter could not write a gateway chat to its registry; recorded once per connection; a chat saved as `subscription_gateway` is still identified by that id, and one saved as `openai` through its gateway alias or, for a sub-agent, the ancestor chats the adapter reads, see [harness identity](harness-identity.md)), `gateway_alias_unscoped` (exactly `count`: how many configured model aliases have no `/`, such as `claude/sonnet`, so a native model added later with the same name would take their place; recorded once per process), `gateway_registry_unreadable` (no fields: the registry file could not be read, so it counted as empty; recorded once per registry, and the next write sets the unreadable file aside as `<scope>.json.unreadable`), `executor_reattached` (exactly `reason`, `ms` and `requests`: a gateway chat whose executor was gone was loaded again on a live one before its request was sent, see [re-attaching a gateway chat](app-server.md#re-attaching-a-gateway-chat); `reason` is `engine_closed` when the host went away or a private executor exited, or `generation_retired` when the host was still connected but no longer served this connection; `ms` is how long the re-attach took and `requests` how many requests waited for it; never a chat id, model or path), `executor_reattach_failed` (exactly `reason` and `requests`: the re-attach failed and the request got the old -32001 error; `reason` is `host_unavailable` when the shared host could not be found or asked within the wait, or `resume_failed` when the gateway refused to provide an executor for the chat (for example its catalog, generation limit or a changed provider) or the executor refused to resume it; while a `host_unavailable` fail-fast window is open, refused requests raise the same error but record nothing, so one window logs the reason at most once, and a host lookup that finds the host alive ends the window). The turn records (`turn_started`, `turn_completed`, `turn_empty_completion`, `turn_error` and `turn_quiet`) of a gateway chat also carry `identity`: `legacy` when the chat was saved with the provider id `subscription_gateway`, and `openai` when it was saved with the native identity; native chats carry no `identity` |
| Chat Completions | `chat_request_rejected` (`provider`, a fixed `reason` and an allowlisted `param` for every HTTP 400 from a Chat Completions server; never its message) |
| Adapter startup | `codex_home_ignored` (`reason: gateway_internal`: an inherited gateway-internal `CODEX_HOME` was dropped so the adapter reads the native home) |
| Server | `request_completed`, `request_empty`, `request_failed` (queue time, time to first event, tool calls, input, cached, cache-write, reasoning and output tokens, `providerType`, Copilot `nanoAiu` credits with `nanoAiuStatus` and the `initiator` of its model calls (`user`, `agent` or `mixed`), whether a Codex turn-state was echoed and returned, and `abortCause` such as `shutdown`; when one connection attempt held more than one transient code, `networkCodes` names them in sorted, comma-joined form; a `context_length_exceeded` whose provider reported its native counts adds `contextUsedTokens` and `contextMaximumTokens`), `request_unsupported` (a Messages `count_tokens` call, which the gateway declines with a 501: `requestId`, `route` and `endpoint` only, with no `request_failed` and no stderr line), `provider_retry` (the real `attempt` about to run, its `code`, `elapsedMs` since the first failure, `backoffMs`, the `upstreamCode` or — when happy-eyeballs tried both address families and their codes differed — the sorted comma-joined `networkCodes`, and `upstreamStage`), `provider_recovered` (`provider`, `attempts` and `elapsedMs`: a request that finished after at least one transient connection retry), `tool_search_dropped` (exactly `provider`, `tools` and `items`: a `tool_search` tool or replayed `tool_search_call` / `tool_search_output` items were removed, by the Codex subscription route without the bridge before sending upstream, because the ChatGPT backend refuses a forwarded `tool_search`, or by any other route before translation, so a chat that switched from a Codex route keeps working; counts only, never a definition, query or argument; only when something was dropped, see [tool search](responses.md#tool-search-on-the-codex-subscription-route)), `tool_search_bridged` (exactly `provider`, `tools`, `calls`, `outputs` and `loaded`: a Codex subscription route with `"toolSearch": "bridge"` sent the client's search declarations, replayed calls and outputs as function items, and declared `loaded` tools that earlier searches returned; counts only, never a name, query or definition; once per request and only when the request carried search), `web_search_dropped` (exactly `provider`, `tools` and `items`: a route that does not forward the hosted `web_search` tool removed a `web_search` tool or replayed `web_search_call` items before translation, so a chat that switched from the Codex subscription route keeps working; counts only, never a name, query or result; only when something was dropped, see [hosted web search](responses.md#hosted-web-search)), `tool_declarations_merged` (exactly `replaced` and `identical`: a request declared the same tool more than once, in `additional_tools` input items or again in its top-level `tools`, and the gateway merged them into its catalog instead of refusing the request; counts only, never a tool name or definition; once per request and only when something merged, see [repeated tool declarations](responses.md#repeated-tool-declarations)), `claude_cli` (mode, toolCalls, input, cache read and write, and output tokens, interrupted, retry, `threadKey` — the same first 8 hex `claude_session` reports, when the request carried a thread id, so one thread's one-shot and live events line up — and `systemPrefixOnly` set when its cache read reached only the system prefix, the same test `claude_session` applies below; also on tool turns and cancellations), `claude_session` (live sessions: outcome such as spawned, continued, reseeded, preserved, fallback, interrupted, reaped, evicted or crashed, the miss reason (a `fallback` outcome carries `warmup` before a thread has completed its configured admission requests, `capacity` when every slot held a warm session, or `session_dead` for a crashed-session replay hold; `preserved` reports `prefix_diverged`, `unexpected_tail`, `forced_choice` or `effort_midturn` when a request is refused without closing the session or starting inference), cache read and write, input and output tokens, `threadKey` — the first 8 hex of the thread's session key — `afterWarmup` on a spawned session promoted after its warmup, and `systemPrefixOnly` on a spawn or reseed that read only the system prefix — reported once the request's cache read plus write pass that prefix by a margin, since the threshold (32,035 tokens) is calibrated to the Codex system prefix and a shorter prompt says nothing either way), `copilot_session` (live Copilot sessions, on by default: `outcome` spawned, continued, reseeded, fallback, interrupted, reaped, evicted, crashed or closed; `missReason`, which is the reseed or fallback reason of a request and the reason a session ended; `threadKey`; `liveSessions`; `divergedAt`; `parkedMs`; `failed`; and the request's own `initiator` (`user`, `agent` or `mixed`), `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `nanoAiu` and `toolCalls`; every outcome, field and reason is listed in [live Copilot sessions](copilot-sessions.md#billing-and-diagnostics)), `model_alias_resolved`, `server_hot_swap`, `config_rejected` (exactly `reason`: why a change to `gateway.json` was not applied, so the last good configuration keeps serving every model: `rebind` when an existing model alias would change its provider, account, credential source, base URL or upstream model, `restart_required` when the port, mode or state directory changed, `invalid` when the file does not parse or validate, or `unreadable` when it cannot be read; once per file version, never with a path, value or error text, and listed among the recent problems of `gateway diagnostics`; `/health` reports the same word as `configRejected` while the change stays refused, and a valid refused file still stops the aliases it removed; a later valid, allowed file is applied and clears it, and the first load at startup still fails, see [architecture](architecture.md#live-configuration)), `provider_address_refused` (exactly `provider` and `reason` `not_tailnet`: a provider with `"tailnet": true` resolved its host to an address outside Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48), on inference or model discovery; that address was dropped before any connection, so the key was not sent to it; never the address or host; if no Tailscale address remained the call failed with `provider_unreachable` 502, while a Tailscale router that does not answer is the retryable `upstream_unavailable` 503), `model_metadata_refreshed`, `model_metadata_skipped` (the six-hour metadata refresh left one provider out: `provider` and a fixed `reason`, `refresh_deferred` when serving a Codex login's access token would need a refresh (it has expired, or expires within two minutes unless the issuer's `earliest_refresh_at` is still in the future) and the refresh was left to the next real request, or `discovery_failed` for any other failure; the error text is never recorded), `server_shutdown_signal`, `server_drain` (requests drained, drain time, requests aborted) |
| Server request fields | Every `request_completed`, `request_empty` and `request_failed` record uses `model` for the resolved catalog alias. It includes `requestedModel` only when the caller used a different name, and `clientProtocol` is either `responses` or `messages`. |
| Service | `component_exit` (`component`, `kind`, `code`, `uptimeMs` and `restarts`; a desktop setup that exits 0 is not an exit), `component_paused` (the optional native relay was set aside: `component`, `kind` and a fixed `reason` — `not_registered` when `<state>/native-registration.json` is missing or says the relay is gone, `failing` after three non-zero exits in a row, each within 60 s of its start, or after one such exit following a resume that has not yet run past its first minute; a signal death or a binary that never spawned counts as one; once a slot is paused nothing more is logged until the next re-check starts it), `component_resumed` (`component` and `kind`: a paused relay was started again by the five minute re-check, which also restarts a relay that is still failing every half hour), `component_failing` (an inference or tunnel child exited within 60 s of its start five times in a row: `component`, `kind`, `failures` (5) and `reason`, `exit_<code>`, `signal_<NAME>` or `spawn_failed`; once per streak, and a run of a minute or more ends the streak; the component stays `waiting` between starts and keeps its backoff), `execution_host_failed` (`failures` and `reason`, see [service self-heal](#service-self-heal)), `execution_host_recovered` (`failures` before the start that worked), `execution_host_unhealthy` (`reason` of the second of two failed probes in a row of the running host, once until the reason changes or a probe passes), `execution_host_restarted` (`reason`: the probe's, or `relay_registered` when a host that started before the relay was registered restarts while idle so its native engine stands down; only the host was stopped, while idle, and started again; 0.4.7 and earlier also logged `relay_paused`), `execution_owner_reclaimed` (`scope`: `host`, `native_home` or `generation`; `reason`: `previous_boot`, `dead_pids` or `invalid_receipt`; a dead owner's receipt was moved aside, see [architecture](architecture.md)), `status_write_failed` (exactly `code`, an errno name such as `ENOSPC` or `EACCES`, or `other`; at most once a minute), `login_consolidation_completed` (`jobs`: an interrupted next-login consolidation passed its checks and was finished and promoted at the daemon's start), `login_consolidation_restored` (`jobs`: how many original login jobs were put back after an interrupted next-login consolidation failed its checks; `started` and `failed`: how many of the restored jobs other than the primary one were loaded at once, or failed to load), `native_acquire` (`outcome`: `attached`, `launched`, `replaced`, `refused`, `refused_busy`, or `refused_owner` when another live owner, such as a desktop's private native engine, still holds the native home; `relation` of the requested launch to the running one, `same`, `subset`, `superset` or `conflict`, on every outcome but `launched` and `refused_owner`; `busyChats` on `replaced` and `refused_busy`; `richerLaunchReused` on `launched`), `native_sharing_unavailable` (exactly `reason`: `sdk_version`, `sdk_signature` or `other`; the host started without native sharing because the app's native engine was not the verified one; `native_owner`: the native home had another live or unconfirmed owner when the host started, so the host serves gateway chats and claims the native home at the next native request instead; `native_identity`: a dead owner's native-home receipt names another configuration or another spelling of the native home, so the host serves gateway chats and refuses each native request with `Native execution ownership changed` until that receipt is moved aside), `system_wake` (`sleptSeconds`), `executor_turn_settled` (shared-engine outcomes; see [executor outcomes](#executor-outcomes-without-a-window)), `desktop_api_mode` (`action`: `on`, `off` or `preset`; `outcome`: `applied`, `refused`, `rolled_back`, `failed` or `skipped`; `reason` is one fixed code and never a path, model, configuration value or environment value: `app_running`, `already_on`, `not_on`, `client_only`, `foreign_cli_path`, `native_write`, `clear_cli_path` or `rollback`. `on`/`off` records what that call did; `preset`/`skipped` is logged once per process when an adapter path stood down because API mode owns the desktop, see [API mode](api-mode.md)), `tunnel_stale_listener_cleared` (`component` and `processes`), `sharing_disabled` (`mode`), `sharing_disable_failed` (`mode` and `outcome`, how the failed change was undone), `release_skew_refused` (exactly `direction` and `count`: the host refused a generation request whose gateway SDK is not its own, because the app and the service run different releases; `direction` is `adapter_newer` when the adapter's SDK is the installed, newer release's (read from that release's `gateway-sdk/build.json`): the service has not moved yet, the adapter is told "This Mac's gateway service is moving to the newer release; this chat continues as soon as no turn is running", and that release's move becomes urgent; it is `adapter_older` otherwise, or when the direction could not be told: the service already moved, and the adapter is told "This app and this Mac's gateway service run different gateway releases; quit and reopen ChatGPT to load the installed release"; `count` is the refusals since the last record; at most once per direction; see [services](services.md#release-skew-a-newer-adapter-beside-an-older-host)), `execution_host_quiet_upgrade` (exactly `loadedChats`, a count: after a live controller update the execution host moved to the new implementation when its chats drained, without the strict idle gate; see [services](services.md#live-supervisor-controller-updates)), `execution_host_upgrade_waiting` (exactly `reason`, the quiet check's fixed vocabulary as in `self_upgrade_waiting`; once per reason per pending move), `execution_generation_forward` (exactly `to`, a release: an older service spawned a generation on the installed release's gateway SDK, verified by that release's own verifier, for a newer adapter instead of refusing it; see [services](services.md#per-chat-rollout-newer-adapters-run-on-the-installed-releases-sdk)), `execution_request_failed` (exactly `method`, the control method such as `execution/acquire`, or `other`, and `reason`, the same fixed class as `execution_host_failed`: the host refused a control request with an error whose own text it does not pass through, so the adapter was told "Execution operation failed (`reason`); managed chat ownership was preserved"; never the error's text, a path or a value; see [services](services.md#masked-execution-failures)), `self_upgrade` (`from` and `to` releases; the moved process names itself in `component`: `adapter`, `service`, `server`, or `ssh_listener` when an idle SSH listener retired itself after an install; a listener replaced by a bootstrap logs `ssh_listener_replaced` on the Adapter row instead; `mode`: `idle` for a move at an idle moment, which is every move but the service's quiet and skew ones, `quiet` when the service moved under the quiet rule after the release had waited 15 minutes, or `skew` when it moved urgently because the host had refused an adapter of the installed release, with no 15 minute grace and no wait for recently ended turns (only a running turn, a pending approval or input, a background terminal or busy inference held it back), see [services](services.md#moving-to-a-new-release); `loadedChats` on `quiet` and `skew`: how many chats the host's engines still had loaded, a count), `self_upgrade_waiting` (`from` and `to` releases and exactly `reason`, why a quiet upgrade attempt after the 15 minute grace, or at once for an urgent move, did not restart the service: `running` (a turn is running or waiting for an approval or input), `background_terminal` (a chat keeps a background terminal, such as a dev server an agent left running), `recent_turn` (a turn ended within the last 5 minutes), `ephemeral_settling` (a throwaway chat, or one that has saved nothing yet, has not been seen settled for 5 minutes), `unreadable` (an engine, a chat or its status could not be read), `too_many` (more than 256 loaded chats in one engine) or `inference_busy` (the host was quiet but inference refused its idle guard); each reason once per pending release, see [services](services.md#moving-to-a-new-release)) |

The Adapter row records `unix_session_end` for each accepted Unix connection:
process-local `sessionId`, fixed `cause`, numeric `closeCode`, and `durationMs`.
`gateway diagnostics` groups these under `connectionEnds` by cause and close code.
Local session completion/failure and listener shutdown are distinct from an
unclassified transport close; code 1006 alone does not identify a network fault.
Peer close-reason strings and exception text are never recorded. See
[remote connection diagnosis](remote.md).

The Adapter row also records `completion_replayed` with exactly `outcome`:
`delivered`, `stale`, `turn_changed`, `not_terminal`,
`already_delivered_in_session`, or `lookup_failed`.

Claude consolidation records only its fixed lifecycle events:
`claude_consolidation_staged`, `claude_consolidation_activated`,
`claude_consolidation_deferred`, `claude_consolidation_rolled_back` and
`claude_consolidation_failed`. Their fields are numeric job counts or fixed
reason/phase names, never plist contents, command arguments or environment
values. `self_upgrade_waiting` can also report `claude_busy` when a Claude
child's connection check refuses a service restart or cannot be answered.

A chat that an engine starts on its own, such as a sub-agent or a review, has no
route on this connection. Its turn records take `provider` from the engine that
announced the chat, `model` from its `thread/started` notification (updated by later
`thread/settings/updated` notifications), and `identity` by the same rule as routed
gateway chats. Earlier releases logged these turns as `provider: "unknown"` with no
model. A chat that has a route always reports its route.

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

Verified native file-read failures distinguish `file_not_found` from
`path_permission_denied`. Native process startup distinguishes
`spawn_path_missing` from `spawn_permission_denied`; a missing program and a
missing working directory share the same native error, so the gateway does not
guess which one was absent. Classification is restricted to exact known method,
code and message combinations. Replies and caller paths remain unchanged, every
failure remains in diagnostics, and permission failures are not treated as benign
misses. These names do not alter the watchdog's separate session-refusal rules.

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

A Responses request that succeeds after retries records `provider_recovered` with `provider`,
`class` (`network` or `throttle`), `attempts` and `elapsedMs` from the first failure of that
class. Throttle `provider_retry` events carry `code: "rate_limit_exceeded"`, the wait in
`backoffMs`, and the time since the first throttle in `elapsedMs`.

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
latency per model, turn outcomes the shared executor recorded itself (`executorTurns`, per engine, status and error class),
Auto-review requests (`autoReview`, below), retries (keyed by the socket code they reported, or by the sorted `networkCodes` set when one connection attempt held more than one), RPC errors,
component exits, host events (every `execution_host_*` event and `native_acquire` outcome), live Claude
sessions per outcome (and per miss reason) with their cache reads, writes and a rewrite
count — the spawns and reseeds whose cache read reached only the system prefix — and the 25
most recent problems: failed, empty and quiet turns, executor turns that failed or carried an error, failed (not cancelled) and empty requests, RPC errors, component exits,
`adapter_start_failed`, `execution_host_failed`, and the self-heal reports
`component_failing`, `execution_host_unhealthy` and `status_write_failed`. Set
`GATEWAY_TELEMETRY=off` to disable the log.

## Executor outcomes without a window

`executor_turn_settled` records a terminal turn from a shared gateway or native
engine. Its fields are `engine`, `threadId`, `turnId`, the SDK's `status`, a fixed
`errorClass` when the turn carries an error, and `durationMs` when both timestamps
are available. Error text and chat contents are never logged. An SDK status of
`completed` with an attached error remains distinguishable by its error class.

The service inspects engines every 30 seconds through short-lived connections,
as its existing activity checks do. It validates socket ownership, ignores
server callbacks, and closes each inspection client. Inspection never creates or
resumes a chat or executes a tool. Bounded batches and pagination limit work;
failed reads remain pending for a later inspection. Recent terminal turns can be
collected even when another turn is already running. Old idle histories are
skipped when their timestamps conclusively predate this host's tracking window.
Each pass handles up to 32 chats and 16 history pages, with a 96-request ceiling
and a ten-second deadline. Busy batches rotate fairly; a new head arriving during
a history walk remains pending for a fresh head scan.

`gateway diagnostics` reports these observations separately as `executorTurns`
and includes failed or error-carrying outcomes in `recentProblems`. It does not
add them to the adapter's `turns` counts, because an attached adapter may have
observed the same turn. This is best-effort diagnostics, not a complete audit:
throwaway histories, unavailable metadata, work outside the tracking window,
and chats never observed by the inspector can remain unavailable.

Verify automatic collection against an isolated real SDK with:

```sh
node scripts/e2e-chat-state.mjs --package /absolute/verified/package \
  --root /tmp/task-specific-evidence --executor-diagnostics
```

The fixture uses a local mock provider. It disconnects both application clients
before a synthetic subscription-limit failure, waits for the host's inspection,
then compares the recorded error class and outcome with the persisted SDK turn.
It uses no account or paid inference and does not modify production chats.

A request whose model is the reviewer `codex-auto-review` carries `autoReview: true` on
`request_completed`, `request_empty` and `request_failed`, including its 404. Gateway
executors send every Auto-review approval there (node_repl, shell, `apply_patch`,
network, MCP and permissions), so `gateway diagnostics` counts them together in an
`autoReview` bucket: `completed`, `empty` and `failed:<code>`
([node_repl](node-repl.md#scope-data-and-decision)).

## Subagent startup checks

An agent's `pending_init` status alone does not establish a model startup failure.
On 23 October 2026, a Qwen child reported that status even though its saved turn
contained model output and 16 executed tool calls. Another child had no model
output and no terminal error, so those records do not establish its failure cause.
A fresh Qwen role check subsequently executed a command and returned its result.
Check actual turn events and tool results before attributing a failure to login,
model routing, or the provider. Delays and missing terminal events need separate
investigation; do not turn a status observation into a claimed authentication error.

`scripts/e2e-subagent-sidebar.mjs --v2 --openai` verifies real SDK delegation,
child tool execution, readable history, queued messages, and follow-up work with
mock inference. Add `--accounts` to require every bare-model child request to use
the designated account while two Codex accounts offer the same model. This does
not test real provider latency or the desktop's rendering.

Add `--role-fork` with `--v2` to verify a named role selects its configured
model during a full-history fork, without an explicit spawn-model override.
The fixture keeps the default child model equal to the parent, requires a
parent-only history marker in child inference, and checks real child tool work,
saved model, reasoning and follow-up. It uses the installed SDK with local mock
inference. Legacy MultiAgentV1 rejects named-role overrides on full-history forks.
The [26 October 2026 receipt](evidence/subagent-role-fork-2026-10-26.json)
records the installed SDK check and matching actual binary hashes on all three Macs.

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

## When the relay is set aside

The native relay is optional, so a machine without a working one is not broken.
A service slot that owns the relay reports `component_paused` once and then says
nothing at all: no exit, no restart and no log line, until something changes.
`gateway service status` shows the slot as `paused` with its reason, and a
paused slot has no process to print, so `gateway versions` simply leaves it
out. A relay whose log cannot be opened is set aside at once, without waiting for
three exits. The service looks again every five minutes and starts the relay once a
registration exists, no ChatGPT app is open, and the binaries or the registration
changed since the pause — or, with nothing changed at all, once half an hour has passed
since it was set aside, so a brief start-up problem never pauses a working relay for
good. That start reports `component_resumed`. A resumed relay is out of retries: one
more non-zero exit within a minute of its start sets it aside again at once, so a relay that
cannot run costs at most two starts an hour. A resumed relay that runs past its first
minute has proved itself and gets three strikes again. A re-check whose questions cannot
all be answered leaves the rest of the service untouched: a process list that will not
come counts as an open app, so the slot simply stays paused with no new event, and only
a probe that throws sets the slot paused again as `failing` (one `component_paused`).
When the shared execution host started while the relay still looked usable, it took the
machine's remote-control registration for the relay. From 0.4.8 a registered relay owns remote control even while it is set aside: the host and every adapter keep their engines' remote control off whenever the relay is registered or an activation is pending, so no other engine takes the one remote-control connection the Mac has (another holder made the relay's connect fail with 409 Conflict). The phone cannot reach that Mac until the relay is back; `gateway health` warns once the relay has been registered but paused or not connected for five minutes, and `gateway native uninstall` gives remote control back to ChatGPT. (0.4.7 and earlier restarted the host with reason `relay_paused` to hand remote control back instead.) An adapter decides once when it starts and records `native_relay_skipped` when the relay it was registered for is not connected or not reachable, so a relay that comes up
later is used from the next app start or the next listener start. Consolidation
and the shared-service migrations accept a paused relay as ready, and wait for a relay
to connect only where a registration says one is set up and its relay slot is actually
running. See the
[app-server adapter](app-server.md#the-native-relay-is-optional).

## Service self-heal

The unified service repairs its own parts without restarting the others. Each event below
carries fixed words and counts only, never paths, error text or environment values.

| Event | When | What the service does |
| --- | --- | --- |
| `status_write_failed` | `service-status.json` could not be written (a full disk, a read-only folder). | Keeps running; the status file is advisory. The next five-second heartbeat writes again. Reported at most once a minute. |
| `execution_host_failed` | A shared execution host start failed. | Retries after 1, 2, 5, 10 and 30 s, then every 60 s. Inference, tunnels and the relay keep running. |
| `execution_host_unhealthy` | The running host failed two probes in a row; the probe runs every 60 s and on an adapter's kick. | Restarts only the host, and only while it is idle; a busy host is probed again a minute later. A probe that passes again cancels the restart. |
| `execution_host_restarted` | An idle host was stopped and started again. | A start that then fails reports `execution_host_failed` and backs off as above. |
| `component_failing` | An inference or tunnel child exited within 60 s of its start five times in a row. | Keeps restarting it with its usual backoff (up to 30 s), so a passing fault heals; the event is not repeated during the streak. |
| `desktop_env_agent_failed` | The unified service's desktop setup (`desktop-restore`, or a registration while a unified or staged plan owns it) could not remove the 0.4.7 login environment agent it no longer keeps, or found a plist at its label that is not the gateway's. `reason` is `unmanaged` (that plist is left alone) or `other` (the removal failed). | Keeps going: `CODEX_CLI_PATH` is already set, no agent is needed beside the unified service, and the registration reports `envAgent: false` and `loginEnv: "service"`. The next service start tries again. On a Mac with a unified or staged plan, `gateway desktop register` run by hand takes the same path (event recorded under component `service`). Only without a plan does a hand-run register write the agent, fail loudly and report no event. |
| `desktop_env_preset_failed` | The service daemon's first step could not set `CODEX_CLI_PATH` for the login session. `reason` is `read` (the receipt or the session's current value could not be read) or `setenv` (the `launchctl setenv` failed). A foreign value, a missing wrapper or a missing release runtime are not failures and record nothing. | Keeps going: the daemon starts normally and the `desktop-restore` child sets the variable a little later, so only an app that launched in between runs without the gateway until it is restarted. No value or path is recorded. |
| `login_consolidation_completed` | A `--next-login` consolidation was interrupted after its last file write (its staging process is gone) and passed the promotion checks at the daemon's start. | Promotes the plan and runs it. |
| `login_consolidation_restored` | Such a consolidation failed a promotion check instead (`jobs` put back; `started` and `failed`, the restored jobs other than the primary one that were loaded at once or failed to load). A check that only means "not yet" (an old job still loaded, or a start that is not launchd's primary job) records nothing and leaves the staging for the next start. | Puts the original login jobs back, loads all but the primary one at once, and stays idle, across relaunches, until the next login; each relaunch loads, again, a restored job that is still not loaded. See [services](services.md#one-managed-service) for the recovery. |

`execution_host_failed` names its `reason` from a fixed set, never the error text:

| Reason | Meaning | Retried by a kick |
| --- | --- | --- |
| `live_owner` | Another live host or writer still owns the folder, a generation or the native home. | Once per backoff step |
| `identity_changed` | The folder's live owner has another configuration, native home, engine or socket. | Once per backoff step |
| `receipt_invalid` | An ownership receipt is invalid and its owner cannot be proven gone. | Once per backoff step |
| `sdk_invalid` | The engine binary is missing, changed, unsigned or the wrong version. | Once per backoff step |
| `sdk_dir_missing` | The SDK socket folder (`/tmp/codex-daemon-<uid>`) is gone, as after a reboot. | Each kick, five seconds apart |
| `socket_occupied` | A socket path is held by another listener. | Each kick, five seconds apart |
| `io_error` | A file system error, such as a folder with the wrong permissions. | Each kick, five seconds apart |
| `other` | Anything else. | Each kick, five seconds apart |
| `close_failed` | An idle host restart could not close the old host, whose receipt still names the running service. | Never: no host starts in that process again. The service restarts as a whole once inference is idle, asked again every 60 s. |

An adapter that finds the host down writes the private `kick` file in the host folder.
The service watches it once a second. A kick only brings a failed host's next start
forward, never sooner than five seconds after the previous start and never while a start
or restart is running; the first four reasons above cannot pass by retrying, so they get
one kicked start between two backoff starts. A kick to a running host never stops it: it
probes the host, which restarts only when the probe fails and the host is idle.

The probe (`execution_host_unhealthy`) reads the host's receipt, its control socket and one
`execution/status` answer, and on a Mac that shares native chats also the app's engine. The host
answers `execution/status` ahead of any work it has queued, and only two failed probes in a row
count; a verdict about a host that another start replaced while the probe ran is dropped:

| Reason | Meaning |
| --- | --- |
| `receipt_mismatch` | `owner.json` no longer says this service runs the host at its control socket. |
| `socket_mismatch` | The control link, or the SDK socket it names, is gone or replaced, for example by the periodic `/tmp` cleanup; no adapter can reach the host. |
| `status_timeout` | `execution/status` did not answer within 5 s. |
| `status_failed` | The socket refused the connection or answered for another process. |
| `sdk_changed` | The app's engine was replaced under a host that shares native chats, as an app update does. The file is hashed once per host start and again only when its size, times or inode change. |

The service also runs the watchdog heartbeat ([health](health.md#schedule)) in-process
for the configuration its plan names; stopping the service stops it and a smoke run
still in progress.

`gateway health` records no telemetry events of its own. Its `service` and `errors` checks
read this log for the last 15 minutes, using only the fields `at`, `event`, `component`,
`kind`, `method`, `code`, `site`, `errorClass` and `rejection`: `execution_host_failed`,
`component_exit` per `kind`, `rpc_error` for a chat-session method refused with -32001 or
with `rejection` `other`, `gateway_features_trimmed` with `site` `retry` followed by such a
refusal, and `native_sharing_unavailable` and `native_sharing_fallback`.

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
models, or try to bypass the provider's refusal.

## Grok CLI records

Each Grok subscription request writes one `grok_cli` event: `model`, `effort`,
`durationMs`, `result` (`tool_use`, `end_turn`, `result` or `none`), `exitCode`,
`spawnFailed`, `aborted`, `toolCalls`, `inputTokens`, `cacheReadTokens`,
`outputTokens` and `costUsd`, the allowance cost the CLI reported. Failures use
the upstream events `grok.assistant`, `grok.result` and `grok.tool_use`. See
[Grok subscription](grok-sessions.md).

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
dashes>` instead of a random `msg_<hex>`, and its row records that id. Claude Code
records that `msg_gl_` id in its transcripts, so a spend tool that dedupes transcript
records by id sees the same id the ledger holds. A consumer must accept both
prefixes (`resp_gl_` and `msg_gl_`; the `gatewayMarkerPrefixes` list in
`src/usage-ledger.ts`), not only `resp_gl_`, or it counts Messages requests twice.

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
keeps running the release it loaded. Its command line can still say
`.../current/...`, which no longer identifies that code after an install.
Managed releases keep a read-only descriptor for their immutable CLI entrypoint
and release marker, so `lsof` can preserve that release during installer
cleanup even when the app-owned Node itself only names `current`. A hot-swapped
server retains each old marker only until that generation's requests drain.
`gateway versions [--json] [--check]` answers that question: it lists this
user's gateway processes, names each one's role (`service`, `inference`,
`desktop-adapter`, `ssh-listener`, `ssh-proxy`, `executor-host`,
`gateway-engine`, `native-relay`, `tunnel` or `other`) and reads the release
from mapped files found with `lsof`. For CLI roles, it reads all descriptors
for that same PID and accepts only one open immutable
`releases/V/package/dist/cli.js` entry beneath this install root. A floating
`current` launch path is never evidence: if the immutable CLI descriptor cannot
be read, the release is `unknown` unless the process was launched directly from
one unambiguous immutable release path. A release marker alone does not prove
the bootstrap release, because an older CLI can hot-load a newer server
generation and retain its marker. It rechecks the PID and its start time after
reading descriptors, dropping a row if that process exited or its PID was
reused during the scan. The report skips this process itself, so
running the command never adds a row.

For the service, `gateway health` instead uses the optional `runningRelease`
published by that service at startup. It accepts the release only when the status
names the live service PID and was published after that process started. This
keeps an older JavaScript service visible after an install even with an app-owned
Node. Older services without the field retain the inventory fallback until they
restart on a release that publishes it.

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

Staged native executor adoption records `native_sharing_staged`,
`native_sharing_activated`, and `native_sharing_deferred`. Records carry only
fixed mode or reason codes. A deferral means the staged change was not applied
and the current service plan remains authoritative, for example because an old writer remained, the plan changed, or the
SDK could not be verified. It does not report a failed chat or authorize
replaying a turn. See [travel recovery](travel-recovery.md).

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
