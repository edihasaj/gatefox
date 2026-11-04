# Changelog

## 1.4.8 — 2026-11-02

- Give identified SDK turns one compaction recovery signal after the large-context
  cache guard stops inference. Unchanged retries and cold compactions remain bounded.
- Fix Gateway SDK full-context accounting so the next user turn compacts the same
  chat on its selected model, without rewriting cumulative usage totals. Preserve
  native behavior outside marked Gateway executors.

## 1.4.7 — 2026-11-02

- Classify rejected Copilot tool names using fixed categories and counts, without
  recording names or arguments. Distinguish malformed names, declared aliases
  and undeclared names while preserving strict refusal and no automatic replay.

## 1.4.6 — 2026-11-02

- Preserve warm Copilot sessions across documented title, warning and empty queue
  notifications. Adopt the updated event guard into existing sessions, while
  refusing unattended model starts and retaining client-owned tool execution.
- Stabilize equivalent OpenRouter Responses tool catalogs to avoid needless
  cache-prefix changes. Add content-free diagnostics for large cold requests.
- Recover a stale Claude reverse forward only with a private receipt proving
  its exact process, start time and connection, after its source client exited.

## 1.4.5 — 2026-11-02

- Grant inactive cache histories inherited from the old guard one bounded fresh
  warm-up. Resuming an hour-old or days-old chat no longer combines its cold seed
  with stale pre-upgrade strikes. Tracked active requests retain their history,
  and later module upgrades cannot repeatedly clear a new safety stop.

## 1.4.4 — 2026-11-02

- Copilot public reasoning summaries retain their type during live continuation.
  Tool results and follow-up messages can continue the original session without
  a false history mismatch, restart or full-history replay.

## 1.4.3 — 2026-11-02

- Cache safety starts a fresh warm-up after five minutes without request activity,
  allowing chats to resume after provider cache or session expiry. Repeated large
  uncached requests during active work still stop before another inference.
- Overlapping requests and long inference preserve the active cache history;
  blocked retries cannot reset their own safety stop.

## 1.4.2 — 2026-11-02

- Chat Completions providers now recover known transient connection failures
  within the existing two-minute outage budget. Retries preserve the selected
  account, model and request, keep streaming heartbeats active, and stop when
  cancelled. HTTP replies and partial streams are never replayed by this recovery.
- Tailnet diagnostics retain fixed network error codes, distinguishing temporary
  DNS and dial timeouts from certificate failures without recording addresses.

## 1.3.5 — 2026-11-01

- Fix Claude live-session recovery when tool results arrive with new caller
  messages. Apply a shared large-context cache safety stop across every provider,
  including measured failures, cancellations and repeated missing cache metrics.

## 1.3.4 — 2026-11-01

- Routine worker policies can explicitly prefer paid DeepSeek V4 Flash after
  local models and before subscriptions, while preserving existing policies and
  worker pins. OpenRouter discovery retains published model names as labels.

## 1.3.3 — 2026-10-31

- Managed coding/test profiles can advertise an explicit compaction threshold.
  Bounded 128K role settings avoid repeatedly compacting near a 32K window and
  prevent a newly added worker alias from inheriting a generic SDK context size.

## 1.3.1 — 2026-10-31

- Managed worker policies are hidden from normal model pickers while configured
  roles and existing chats retain their routes. Gateway Activity shows the pinned
  model/account for locally served managed workers without changing their saved
  model, permissions or execution state.

- Internal worker policies can explicitly configure effort for one candidate,
  allowing Qwen implementation at xhigh while subscription fallback keeps medium.
  Existing policies and fixed model requests retain their reasoning behavior.

- The remote relay no longer pauses itself after a gateway restart that coincides
  with the native Codex database being recovered. Its registration read had no busy
  timeout, failed at once with "database is locked" and exited three times in a row,
  which set the relay aside for half an hour and cut the phone off from that Mac. The
  read now waits for the lock and retries briefly, and every relay stop logs its fixed
  reason instead of the same generic line.

## 1.3.0 — 2026-10-31

- Native engine sharing accepts the Codex app engine 0.166.0-alpha.5.1 after the
  shared-native fixture passed against the signed engine over stdio and Unix.
  Macs that share native work report `ready` again instead of
  `native_owner_pending`.

## 1.2.9 — 2026-10-31

- The remote relay accepts the Codex app engine 0.166.0-alpha.5.1, which ChatGPT
  shipped on 30 October. The relay refused it, paused itself after three exits, and
  phones could no longer reach any Mac. The engine's remote-control contract was
  reviewed against 0.165 and is unchanged.

## 1.2.0 — 2026-10-29

- Opt-in managed worker aliases now enforce provider selection, fresh capacity
  checks, subscription reserves, permitted DeepSeek V4 Flash fallback and durable
  provider affinity in Gateway code. Ordinary requests retain a bounded context
  budget; client compaction has a separate capped allowance on the same existing
  provider. Explicit models, permissions and independent reviewer roles retain
  their bindings. Thanks to Edi Hasaj for requesting code-enforced routing and
  identifying the duplicated instruction policy.

- A Claude live-session reseed caused by `fingerprint_changed` now records which part
  changed (`changed`: model, thinking, Fast, instructions or tools, with added, removed
  and edited tool counts, never names), so a burst of uncached reseeds that trips the
  cache-safety stop can be traced to its cause. Behaviour is unchanged.

- The phone reaches Macs whose ChatGPT updated to 26.1029 again. The native relay is
  rebuilt to accept its engine, Codex 0.166.0-alpha.6, whose remote-control transport,
  state migrations and login are unchanged from the admitted 0.166.0-alpha.5.1; the
  installed relay refused it and was paused as `failing`. The engine is also shared by
  the native host after passing the shared-native fixture.

- Releases finish without a restart. `gateway rollout` reports `ready` once a live-moved
  service's controller, execution host, inference and canary run the installed release;
  the service root and a byte-identical native relay keep their older label until a
  natural start and are counted as `retained`. A live controller swap refused only by a
  brief host probe or restart check now retries within seconds instead of every two
  minutes, which could lose every time on a Mac whose host is probed each minute, and
  logs `self_upgrade_waiting: handover_busy` once. `gateway health` no longer blames
  Claude Desktop components for a swap that simply has not happened yet.

- Releases reach every Mac without a restart, and a release that would block chats can no
  longer ship. Each release now carries a versioned forward contract
  (`forward-preparation.js`), so an older execution host prepares newer chats with the new
  release's own code whatever preparation code changed. A pre-publish check
  (`scripts/check-forward-compat.mjs`, also run by the app publisher) runs the deployed
  release's own forwarding code against the candidate and refuses to publish when it
  would refuse it. `gateway rollout` reports `blocked: release_skew` and `gateway health`
  fails while chats of the installed release are refused. `gateway service restart
  --interrupt` restarts at once, ending running turns, for the rare case nothing else covers.

- Fix chats that would not open after a Codex SDK update on a busy Mac. An older
  service refused every newer adapter whenever the release changed the feature
  schema data, which every SDK update does, and the urgent move then waited for a
  moment with no turn running that a Mac with back-to-back agents never has. A
  forwarded generation is now prepared by the installed release's own modules, so a
  schema change alone no longer blocks it. This takes effect from the release after
  the one that ships it.

- Opt-in mid-turn model changes from the desktop picker: with
  `"midTurnModelSwitch": true`, a model change made while a gateway turn runs also
  reaches that turn's next inference step, when the tokenizer recount and the SDK's
  review-group check allow it. Otherwise it applies from the next turn, as before,
  and the desktop sees no error. A running turn's model change, whoever sends it,
  now gets the same context recount as a new turn, so a mid-turn switch to Claude
  can no longer overflow its window.

- Gateway chats run on Codex 0.166.0 (from 0.163.0). Its experimental
  `wake_on_agent_messages` feature lets an idle chat continue on its own when a
  subagent finishes; set it under `[features]` in `~/.codex/config.toml`. The six
  gateway SDK patches were ported, and two 0.166 checks now treat a legacy
  `subscription_gateway` chat and the executor's `openai` alias as one gateway, so
  legacy chats still resume.

- Fix the model-switch guard refusing a switch between two aliases of one upstream
  model family (for example `team/large` to `team/small`): it read the family from
  the alias text. The catalog now publishes each row's `tokenizer_family`, computed
  from the upstream model name.

- Copilot 1.0.103 and later start again: the CLI retired `--no-remote` and exits
  when it is given, which blocked provider maintenance. A verified managed
  installation from 1.0.103 omits it (remote hosting there needs explicit flags
  the gateway never passes); older or unknown versions keep it.

- No forced restart after a release: once a live-updated service's chats drain
  (no running turn for 5 minutes), its execution host moves to the new release by
  itself, without touching inference, tunnels or Claude Desktop components. `gateway
  health` no longer reports a live-moved service as lagging or blocked by Claude.

- `gateway health` says why a lagging service has not moved: with Claude
  Desktop components it warns that only `gateway service restart --force`
  moves it; otherwise it points at `gateway activity` for the turns it waits on.

- Per-chat rollout: after a release is installed, the running service serves
  newer adapters on that release's own verified gateway SDK instead of refusing
  them with "This Mac's gateway service is moving to the newer release". New and
  resumed chats move to the new release one at a time; running chats stay on
  their engine, and old engines retire once empty. No service restart is needed.

- Fix Claude chats locking with "Claude's live session was preserved" when a
  message sent while a tool or subagent ran was recorded before the tool's
  output: the session now relays the results and then the messages.

- Fix new chats failing with "Execution operation failed" after a Harness
  Gateway app update while the service kept running: the service now accepts the
  app's signed copy of the very gateway SDK it started on. Masked execution
  failures now name a fixed reason class and are recorded as
  `execution_request_failed`.

- Fix Claude live-session recovery when tool results arrive with new caller
  messages. Apply a shared large-context cache safety stop across every provider,
  including measured failures, cancellations and repeated missing cache metrics.

- Routine worker policies can explicitly prefer paid DeepSeek V4 Flash after
  local models and before subscriptions, while preserving existing policies and
  worker pins. OpenRouter discovery retains published model names as labels.

- Managed coding/test profiles can advertise an explicit compaction threshold.
  Bounded 128K role settings avoid repeatedly compacting near a 32K window and
  prevent a newly added worker alias from inheriting a generic SDK context size.

- Managed worker policies are hidden from normal model pickers while configured
  roles and existing chats retain their routes. Gateway Activity shows the pinned
  model/account for locally served managed workers without changing their saved
  model, permissions or execution state.

- Internal worker policies can explicitly configure effort for one candidate,
  allowing Qwen implementation at xhigh while subscription fallback keeps medium.
  Existing policies and fixed model requests retain their reasoning behavior.

- The remote relay no longer pauses itself after a gateway restart that coincides
  with the native Codex database being recovered. Its registration read had no busy
  timeout, failed at once with "database is locked" and exited three times in a row,
  which set the relay aside for half an hour and cut the phone off from that Mac. The
  read now waits for the lock and retries briefly, and every relay stop logs its fixed
  reason instead of the same generic line.

- Native engine sharing accepts the Codex app engine 0.166.0-alpha.5.1 after the
  shared-native fixture passed against the signed engine over stdio and Unix.
  Macs that share native work report `ready` again instead of
  `native_owner_pending`.

- The remote relay accepts the Codex app engine 0.166.0-alpha.5.1, which ChatGPT
  shipped on 30 October. The relay refused it, paused itself after three exits, and
  phones could no longer reach any Mac. The engine's remote-control contract was
  reviewed against 0.165 and is unchanged.

- A gateway chat that switches to a model with another tokenizer is checked before
  its turn is sent. Codex decides compaction with the previous model's counters, so a
  chat that GPT-6.1-Terra counted at 591K tokens exceeded Claude Sonnet 5.5's 1M
  window and failed with "ran out of room" on every retry. The adapter now recounts
  the last measurement for the selected model and, when it would not fit, refuses the
  turn with the way out: switch back, run /compact, then switch again. Claude CLI
  overflows also keep their used and maximum token counts in `request_failed`.

- Opt-in managed worker aliases now enforce provider selection, fresh capacity
  checks, subscription reserves, permitted DeepSeek V4 Flash fallback and durable
  provider affinity in Gateway code. Ordinary requests retain a bounded context
  budget; client compaction has a separate capped allowance on the same existing
  provider. Explicit models, permissions and independent reviewer roles retain
  their bindings. Thanks to Edi Hasaj for requesting code-enforced routing and
  identifying the duplicated instruction policy.

- The desktop adapter no longer refuses to start when the native model cache lacks
  a model the engine lists. This happens when another Codex version wrote the cache
  or the engine could not refresh its models. Gateway chats start without native
  metadata for those models, the adapter records `native_catalog_incomplete`, and a
  corrupt cache or a gateway alias that equals an engine model ID is still refused.

## 1.1.1 — 2026-10-27

- SSH proxy output now crosses fresh child pipes with backpressure and complete
  draining. This prevents macOS error 35 from ending otherwise healthy Studio
  connections when the client briefly stops reading a large response.

## 1.1.0 — 2026-10-27

- Native sharing and the remote relay accept the verified Codex app engine
  0.165.0-alpha.1.2 after separate source review and signed-engine checks.

## 1.0.9 — 2026-10-27

- Desktop app distribution now requires both the native relay and gateway
  executor in its verified backend archive, preventing an incomplete desktop
  update from being signed and published.
- The complete desktop bundle restores the signed gateway executor and native
  relay omitted from 1.0.8. That incomplete release was removed from the stable
  update channel. All Copilot and Diagnostics fixes from 1.0.7 remain included.
- Copilot zero-parameter function calls accept omitted arguments as an empty
  object, matching the provider protocol. Explicit invalid arguments still fail
  validation, and custom tools continue to require their declared input.

## 1.0.7 — 2026-10-27

- Copilot tool calls now accept the SDK's documented default function type when
  the optional type field is absent. Exact catalog matching, unique call IDs,
  argument validation, and client-owned execution remain enforced. This fixes a
  compatibility error that could trigger repeated response-stream reconnects.
- The app adds Diagnostics for cache reads, writes and hit coverage, Copilot
  session rebuilds, provider failures and retry signals. Missing cache reports
  stay distinct from measured zero across provider adapters. New Copilot tool
  failures record fixed structural reasons without storing prompts or arguments.
- Loaded gateway chats retain compatible picker aliases after a Codex account
  rename, and the account-name verification checks saved-chat resume behavior.

## 1.0.6 — 2026-10-27

- Managed Macs prefer the verified, Developer ID-signed gateway executor for
  MCP Keychain access. The executor retains release compatibility checks and
  safely falls back to the matching CLI during app updates. Keychain approval
  persistence still requires verification on the target Mac.

## 1.0.5 — 2026-10-27

- The Gateway app and CLI now ship together as version 1.0.5. Selected-machine
  app releases can be published as prereleases, which automatic updaters ignore.
  This rollout targets MacBook and macbook-server; Studio remains unchanged.

- Harness Gateway has a read-only **Activity** screen and `gateway activity
  [--json]` command. They inspect existing executors and saved turns, including
  completions and failures that happened while the viewing app was disconnected.
  Unavailable execution remains **unknown**, and recorded outcomes never imply
  that work is currently running. No Codex application, read receipt, model,
  permission or turn is changed. This does not repair Codex's native unread dots.
  Thanks to Edi Hasaj for reporting the missing outcomes after closing his laptop.

- `GET /v1/availability` and `gateway availability [--json]` report what each
  provider can serve right now: local model server health per router address,
  this Mac's queue load, subscription quota (from Spendwatch when
  `availability.spendwatch` is set, joined by the account email of each local
  login, or from the gateway's own usage counters), the OpenRouter balance, and
  recent quota, throttle, authentication and connection failures. The gateway
  reports facts only and never changes routing. Collection starts on the first
  request and stops after 30 idle minutes. See `docs/availability.md`.

## 1.0.4 — 2026-10-26

- OpenRouter API routes now send their documented session-affinity header using
  the caller's existing session or prompt-cache identity. This enables sticky
  routing before the first cache hit and improves Z.AI/GLM cache affinity while
  preserving caller cache fields, provider order and retention settings. The
  header is restricted to OpenRouter's official HTTPS API endpoint.

## 1.0.3 — 2026-10-26

- Opening an unloaded subagent now reuses the loaded parent's executor, even
  when model or role changes have created a newer catalog generation. This
  prevents a blank subagent page caused by the SDK rejecting a resume on the
  wrong engine. Opening the child preserves its model and permissions and starts
  no inference. Thanks to Edi Hasaj for reporting the missing subagent content.

## 1.0.2 — 2026-10-26

- Unix/SSH sessions no longer disconnect repeatedly when a newer release is
  installed. The containing listener owns upgrade retirement; ending one session
  cannot upgrade that already-running process. Existing sessions keep their
  native executor, while stdio adapters retain their normal idle upgrade path.
  Thanks to Edi Hasaj for reporting frequent connected-machine drops.
- Connection diagnostics now distinguish local session completion or failure,
  listener shutdown, protocol and queue limits, socket errors, and unclassified
  transport closure. `gateway diagnostics` groups close causes and WebSocket codes
  without recording close-reason text, exception messages, or request contents.
- The experimental unread-receipt candidate has additional race and hydration
  guards. It remains outside the installed client; this release does not modify
  the signed ChatGPT app or claim that its unread UI has been verified.

## 1.0.1 — 2026-10-26

- Stock desktop adapters no longer replay a historical completion when a chat resumes.
  The renderer can mark the chat read before that replay arrives, then keep its blue dot
  because its automatic read hook ignores the same completed turn. Live completion
  notifications and saved history remain intact. Offline completions may lack a blue
  dot until the client can reconcile durable read receipts safely. Thanks to Edi Hasaj
  for reporting unread dots that remained after opening a chat.

## 1.0.0 — 2026-10-26

- Desktop SSH app-server proxies now preserve the native HTTP/WebSocket handshake while
  carrying their optional private device pseudonym in the opening Unix-socket upgrade.
  The listener validates it only after the upgrade and keeps malformed, duplicate, absent,
  or oversized headers as ordinary local sessions. Thanks to Edi Hasaj for reporting the
  SSH regression.

- Release versions now roll both minor and patch numbers over at nine, so
  `0.9.9` advances to `1.0.0` and `1.9.9` advances to `2.0.0`.

## 0.9.9 — 2026-10-26

- A secondary route with reasoning levels now appears in Claude Desktop's picker as
  `claude-opus-5[hg-route-<decimal>]`, keeping its real provider and model in the label, so the
  app shows its native reasoning slider for GPT, Qwen and other routed models. The row is capped
  at the route's highest supported level, the adapter clamps a level the route cannot serve
  (including the levels kept in a tool continuation's history) without adding one the client never
  chose, and the old `claude-hg-route-<decimal>` ID stays as a hidden alias so saved chats keep
  working. Routes without reasoning levels keep their opaque IDs, and no route gains a Claude
  account, family tier, or verified context window it does not have.

- Responses routes now wait longer for a ChatGPT throttle before ending a Codex chat. The Codex
  backend often returns HTTP 429 `rate_limit_exceeded` without `Retry-After` and keeps
  throttling for minutes; the gateway retried once after one second and then Codex gave
  up. Responses routes now give throttles their own 120-second budget before any output:
  one, two, four and then eight seconds per retry, jittered, or the provider's
  `Retry-After`. Stream throttles are retried too. A named throttle can use the full
  budget while an otherwise unnamed 429 retains its 60-second header compatibility limit.
  The throttle no longer reports the
  misleading "Provider usage limit reached"; it says "Provider is temporarily rate
  limiting requests; retry shortly", and real usage limits keep their own messages.
  `provider_recovered` now records its recovery `class` (`throttle` or `network`) for a
  request that outlasted an outage. Retry windows are checked again after a sleep, so a
  machine wake or event-loop stall cannot start a late retry; an in-flight attempt remains
  bounded by the caller deadline. `request_failed` now keeps only a bounded numeric
  `retryAfterMs`, and desktop telemetry separates `rate_limit` from usage and quota limits.
  Thanks to Edi Hasaj for reporting frequent rate-limit failures on Codex models.

- A short internet outage no longer ends a Codex chat. The gateway now absorbs a
  transient connection failure before any output with its own backoff — one second,
  then two, four and eight seconds per retry, jittered, for up to 120 seconds — while
  the stream's existing heartbeats keep the client alive, instead of spending the single
  retry it shared with every other temporary failure class. Other classes keep exactly one
  retry as before. `provider_retry` records the real attempt number and how long the outage
  has lasted, a new `provider_recovered` records a request that made it through one, and a
  connection failure whose happy-eyeballs attempts reported different socket codes now names
  them in `networkCodes` rather than losing them.
  Thanks to Edi Hasaj for reporting chats that ended during a short network outage.

- Desktop adapters now replay one verified terminal completion after a chat
  resumes from a sleep-time disconnect, so the current renderer can set its
  unread dot and completion alert. A private bounded ledger proves the adapter
  did not deliver the terminal to an app, and shared live/replay deduplication
  prevents a duplicate event, tool action, or read-state change. The ledger now
  records delivery per device, so each Mac that missed a completion receives one
  replay on its next resume while a device that received it live receives none.

## 0.9.8 — 2026-10-26

- Explicitly selected tools work with Chat Completions providers that end named tool calls with `stop`, including local Qwen through vLLM. Both Responses and Messages clients receive the validated tool call. Tool selection, call IDs, JSON, custom input, truncation, and stream-terminal checks remain enforced.

## 0.9.7 — 2026-10-25

- Restarted desktop clients recover running indicators when their first shared-executor discovery or metadata read is unavailable. The adapter retries saved rows from the client's own chat list and sends verified status snapshots after the executor answers, without requiring a manual refresh or starting another turn. Newer SDK status events, native live rows, and pending approvals retain their authority. Thanks to Edi Hasaj for requesting automatic running-agent discovery after restarting ChatGPT.
- A registered native relay now owns every remote-control request while its private
  socket reconnects. The app engine's startup-only suppression could be undone by a
  later `remoteControl/enable` request after a relay outage, racing the managed relay
  and leaving it at HTTP 409. Unavailable control requests now fail closed and can be
  retried through the same adapter when the relay returns; ordinary app-server requests still
  use their normal engine. Thanks to Edi Hasaj for reporting the loaded chats that
  could not regain control.
- A shared executor host that drops a chat's control connection no longer leaves that machine's chats broken until someone kills the listener. Sessions built on the shared native host now notice the loss, record `execution_host_control_lost`, and end the session the way a native engine exit does — with the engine's frame drain and the report of a confirmed engine death both bounded, so an app that stopped reading cannot hold the teardown open — and the app reconnects to a session that acquires a fresh host connection. Chats that were mid-turn keep their saved history and are not reported failed, because a lost control socket is not proof that the engine died. Thanks to Edi Hasaj for reporting the chats that never loaded again.

## 0.9.6 — 2026-10-25

- `gateway diagnostics` now includes shared-executor outcomes after desktop disconnects. Bounded, short-lived inspections collect persisted terminal turns and fixed error classes from shared gateway and native engines, including failures after a laptop sleeps. The separate `executorTurns` summary avoids adding the same outcome to adapter counts twice. Inspection clients close after each pass, never answer approvals, and never log error text. Thanks to Edi Hasaj for asking why chats stopped.
- `gateway desktop api-mode on|off|status` is a new opt-in desktop mode for macOS. The ChatGPT app starts its own signed Codex engine and uses Harness Gateway only as a plain Responses model provider, which keeps the app's `codex_app` tools (automations, thread management) working on gateway models, because the app only authorizes those tools for an OpenAI-signed engine process chain. API mode changes the native configuration through the app's own engine rather than by editing `config.toml`, remembers what it replaced so `off` can restore it, and holds every adapter path (the daemon's login preset, the service's desktop restore and a hand-run `gateway desktop register`) back while it is on. Every model, GPT included, is served through the gateway provider in this mode; see [API mode](docs/api-mode.md). Thanks to Edi Hasaj for asking for the app tools on gateway models.
- The TCP activity probe no longer mistakes Xcode's unrelated CoreDevice filesystem warning for an unanswered socket inspection. It recognizes only the complete mount-stat warning and fallback block; socket activity, other diagnostics, timeouts, and process identity changes still refuse the check. Thanks to Edi Hasaj for asking to fix the recurring macOS test failure.

## 0.9.5 — 2026-10-25

- `gateway service restart` no longer fails with a misleading "could not restart while idle" on Macs with Claude Desktop components. It now explains that those components hold every idle restart, and `gateway service restart --force` performs the documented operator restart: it still requires ChatGPT to be quit and inference to be idle, then has launchd stop and start the service and waits for the new process. Thanks to Edi Hasaj for asking for a restart that works.

- Chats saved under a retired connection alias open again. After the `claude` connection was split into `claude-primary` and `claude-secondary`, chats saved as `claude/<model>` failed with "This model alias is no longer offered by the gateway". A resume now maps a retired alias to the `-primary` replacement, or to the only matching replacement, before the chat is classified and routed. Offered aliases are unchanged. Thanks to Edi Hasaj for reporting the unopenable chats.

- Client tools that a caller declares as deferred stay reachable on gateway models that lack tool search. The gateway engine now exposes them directly while preserving their schemas, namespaces, permissions and search behavior on models that support it. Thanks to Edi Hasaj for reporting the missing tools.

- Codex scheduled tasks can now run on gateway models. Projectless automations send the home folder as the exact `~` workspace root, which the gateway engine refused as a relative path, so the run never started. Gateway chats now receive the user's home directory for that exact entry; every other path, permission and model choice is forwarded unchanged. Thanks to Edi Hasaj for asking for native scheduling parity.

- ChatGPT startup diagnostics now reach the app's own engine without adapter preflight. App-bundle replacement and native path changes no longer take the independent gateway executor offline, and the verified 0.164.0-alpha.11.1 engine is supported for native sharing and relay transport. Thanks to Edi Hasaj for reporting the update failures.

- Claude Desktop profiles list one picker row per gateway model. Recognized Claude models use the app's native effort control with an accurate `maxEffort` that keeps any lower cap already set, and opaque GPT and Qwen rows gain no Claude identity or invented controls. Explicit effort and speed aliases remain adapter-only so saved chats keep working; configuration fails above 1000 of them instead of dropping any, and also refuses catalogs whose visible rows exceed the app's 200-entry limit.

- Responses providers now recover known transient connection failures through the existing single pre-output retry and retain safe network diagnostics. Partial output, authentication refresh, and permanent connection faults are not replayed. Thanks to Edi Hasaj for reporting the Studio disconnects.

- Existing Claude Desktop adapters, private inference and SSH forwards can move under the single signed app-owned gateway service without changing their isolated settings. Loaded legacy jobs require explicit transaction-scoped force authorization; automatic restarts and wake handling preserve Claude components. Standalone adapter installation no longer creates another background job. Thanks to Edi Hasaj for identifying the extra jobs.

- Metadata maintenance settles stalled policy reads on shutdown while retaining the bounded cleanup wait for reconciliation work.

- Installed desktop-wrapper verification now uses the selected launcher's authentication helper consistently across stdio and Unix clients. Native ownership checks remain strict. Thanks to Edi Hasaj for requiring verification through the normal installed connector.

- Claude replay now preserves public reasoning-summary identity instead of presenting summaries as ordinary assistant speech. The session ledger retains genuine string assistant messages, and adopted sessions safely reseed once. Saved chats and public history stay intact. Thanks to Edi Hasaj for reporting the replay failure.


- Claude request rejections now stop retrying and preserve a safe, specific explanation when Claude refuses a chat under its private-reasoning protection policy. Caller history and model choices remain unchanged. Thanks to Edi Hasaj for reporting the failed chat.


- Subscription accounts can designate a default for bare subagent model names. Account-qualified aliases keep their own routing, and automatic review uses the same designated Codex account. Adding a second account no longer makes these names ambiguous when a default is configured.

- Codex subscription routes can report provider-supplied quota windows alongside Claude observations without changing native account usage. Missing counters remain unavailable, and replacing a credential file invalidates its old observations.

- The gateway now distinguishes unsupported subscription capabilities and policy refusals carried in an error type from generic inference failures. HTTP quota failures retain their safe diagnostic class, and sharing-limit messages identify gateway subscription sharing without claiming the native account is exhausted.

Legacy standalone service installation now confirms that the previous job and
process have stopped before loading a replacement or a restored definition.
Provider maintenance failures retain bounded, scrubbed diagnostic metadata so
failed checks can be investigated without saving private output. Thanks to Edi
Hasaj for identifying the recovery and diagnostic gaps.

The native relay and shared native host now accept ChatGPT engines
`0.163.0-alpha.11` and `0.163.0-alpha.11.1`. Both engines use the same
`app-server-transport` source as the relay's linked `0.163.0-alpha.10.2` SDK and
passed the isolated shared-native checks for disconnect, reconnect, steering,
Stop, pending approvals, and commands that run exactly once. Gateway chats keep
using the gateway SDK pin. Thanks to Edi Hasaj for reporting the startup blocker.

Desktop wrappers now pass ChatGPT's signed Codex engine to app-server sessions, and
the shared-native ownership check recognizes the app's first-party launcher as that
same engine. Older generated wrappers remain compatible, while a different executable
still fails closed. Thanks to Edi Hasaj for identifying the launcher ownership mismatch.

Updates now delete retired gateway releases instead of moving them to the Trash.
The installer still keeps the current release, the previous one and the newest
other one, and still deletes nothing while a running process or LaunchAgent uses a
release. Each retired release is renamed inside the gateway's own folder before it is
removed, so an interrupted deletion is finished by the next install. Every published
release can be downloaded again, so the Trash no longer fills with old versions.
Thanks to @edihasaj for asking for cleanup that happens on its own during updates.

Three search fixes from an independent review. With the tool search bridge on, a
caller's own function named `tool_search` in the default `functions` namespace is
no longer mistaken for the client's search: the bridge name avoids those names, and
calls are intercepted only when the request declares search. On a generic Responses
route, a tool declared in an `additional_tools` item, including one inside the default
`functions` namespace, now wins over an older copy that an earlier search loaded. A `tool_choice` naming `web_search` is accepted on the Codex
route when the request declares the tool, and becomes `auto` on routes that cannot run
hosted search. The bridge, hosted web search and a Claude-to-Codex goal switch also
passed live checks on 22 October 2026.
Thanks to @edihasaj for asking for the live checks and review.

Shared gateway executor connections now rejoin a known active chat after a
client-socket drop. The adapter restores only SDK-recorded state and never
replays prompts, steering requests, tool results or approval decisions. A genuine
pending approval remains available for an explicit answer.
Thanks to @edihasaj for reporting chats that required manual reconnection.

The service now starts the native relay from the installed release even when its plan names an older release folder. A plan written by an older installer could pin `releases/0.5.0/package/native/gateway-native-relay`, so every update and every service restart kept starting that 0.5.0 relay and health kept reporting it as lagging. The supervisor now uses `current/package/native/gateway-native-relay` whenever that relay is installed, and it leaves the plan file unchanged so staged native-sharing receipts still match it.

`gateway tool-search on`, `off` and `status` turn the tool search bridge on or off for every
Codex subscription provider without editing `gateway.json` by hand. The command validates the
file before saving it, changes no other setting, and the running service picks the change up
without a restart. The bridge stays off by default. It now gives the `additional_tools` item it
inserts after a search result the role the backend requires; without it, a Responses lite
request that loaded tools would have failed with HTTP 400. `scripts/probe-tool-search-bridge.mjs`
checks both search rounds offline with `--dry-run`, or against the real backend, where every
bridged request shape passed the backend's request validation.
Thanks to @edihasaj for asking for a dry run and an easy switch.

Codex tool search can work through the gateway as an opt-in. With `"toolSearch": "bridge"`
on a `codex-subscription` provider, the gateway sends Codex's `tool_search` as an ordinary
function, which the shared-subscription backend accepts, and returns the model's search to
Codex, which still runs it. Loaded tools are declared again where the search returned them,
so a Responses lite chat keeps its prompt prefix. The default stays off, and every other
route now drops search items instead of refusing the request, keeping the tools a search
loaded, so a chat can switch away from Codex 2. The Claude session ledger also no longer
counts search and hosted web search items as conversation messages. The bridge has not yet
been checked against the real backend, because the account's sharing usage limit was reached.
Thanks to @edihasaj for asking to keep tool search available even before it is needed.

The rollout readiness probe accepts gateway SDKs that ship the Code Mode host.
Its direct-tools canary previously required a hostless SDK, so every package
carrying the new host failed readiness before it could be installed. The canary
now gives a hosted SDK explicit direct native rows and still proves that child
chats edit files and make commits through direct tools.

Codex 2 chats can use OpenAI's hosted web search. A Codex 2 row now copies the
native model's `web_search_tool_type`, and the Codex subscription route forwards the
`web_search` tool and its replayed `web_search_call` items exactly as native Codex
sends them; the ChatGPT backend accepts this one hosted tool (`tool_search` stays
off, and its refusal names web search as allowed). Claude, Copilot and every API
route drop the tool and its items instead of failing the request, so a chat can
switch models mid-work, and each drop is counted in a `web_search_dropped`
telemetry event. The gateway no longer forces `web_search` off when it starts or
resumes a chat, and the Codex config it generates leaves the setting at Codex's
own default.
Thanks to @edihasaj for asking to make gateway Codex match native web search.

Gateway executors now get native Code Mode. The packaged gateway SDK ships
Codex's `codex-code-mode-host` beside `gateway-codex`, and its build receipt pins the
companion as `codeModeHostSha256`, so an executor only runs Code Mode after the
verifier has matched that file byte for byte. A package whose receipt names no host,
including every release before this one, keeps the explicit `tool_mode: "direct"`
catalog it has today. A host file that the receipt does not name fails the SDK's
verification instead of enabling Code Mode. App signing gives the companion its own identifier and the two JIT
entitlements V8 requires, and the host statically links V8 through Codex's code-mode
runtime, whose license is listed with the other Cargo packages in the SDK's
`dependencies.json`. The SDK build fetches that V8 library from OpenAI's own
`rusty-v8` release, the same way Codex's CI does, and checks it against a checksum
pinned in the verified Codex source. `scripts/e2e-code-mode-host.mjs` runs a Code Mode
cell through the built SDK and a mock provider, and confirms that the same SDK without
the host fails.
Thanks to @edihasaj for asking to make gateway Codex match native Code Mode.

The bundled runtime and release checks use Node 24.22.1, including the security
fixes released on 21 October 2026. Existing signed macOS apps receive the runtime
through the normal signed app update.

Grok models can run on a Grok subscription through the official Grok Build CLI
in a private, gateway-owned Grok home. Grok's own tools, xAI-side tools and
personal MCP servers are switched off; caller tool calls return to the client,
which executes them. Requests that would let Grok act on its own fail closed.
Thanks to @edihasaj for asking to use the Grok allowance from the model picker.

Turn telemetry now records the engine and model of chats that an engine starts
on its own, such as sub-agents and reviews. These turns were previously logged as
`provider: "unknown"` with no model, which hid about three quarters of all turns.
A new real-inference check, `scripts/e2e-goal-switch.mjs`, switches an active
goal's chat from Claude to Codex 2 and requires the next automatic turn to run on
the new model.
Thanks to @edihasaj for asking whether silent model switches really took effect.

A ChatGPT account that has used its shared-subscription allowance now stops
the turn with a usage-limit message. Previously the gateway did not recognize
`subscription_sharing_usage_limit_exceeded`, so Codex retried five times and
reported a stream disconnect.
Thanks to @edihasaj for reporting the misleading message after Codex 2 ran out.

Claude requests can recover one explicit upstream authentication rejection before
any output or tool dispatch. Expired, revoked, missing and unclassified logins
remain final, and a repeated rejection stops with its original error. Diagnostics
record a fixed failure reason without retaining provider text or credentials.
Thanks to @edihasaj for reporting chats that resumed without signing in again.

Native executor sharing can be staged for the service's next natural start,
without quitting applications or changing the active service plan. Adoption
preserves existing gateway sharing and components, rechecks the signed SDK and
old writers, and remains pending while ownership is uncertain. Managed private
native engines reserve the matching native home before starting, preventing a
shared host from racing them. Rollout readiness also requires staged adoption
to finish and the native home to be owned when native sharing is enabled.
The signed native 0.163 engine passed detached completion, single-execution
command recovery, and approval replay checks over stdio and Unix.
Thanks to @edihasaj for reporting interrupted work during travel and disconnects.

Release readiness now requires evidence from loaded processes and the serving
execution host, including an isolated SDK tool canary. Older adapters cannot
create a gateway catalog that requires an unavailable Code Mode host. The live
upgrade regression keeps a chat connection open while replacing its host and
checks that tools and child-agent commits continue without replaying prior work.
Thanks to @edihasaj for reporting the incomplete executor adoption after updates.

Gateway updates preserve the release files that open desktop and SSH connections
still use. A connection whose older release was already removed can recover its
gateway SDK from the installed release after validating it against the loaded
code's compatibility and integrity checks. Saved chat identities stay unchanged.
Executors without the optional Code Mode host keep direct tools available,
including for sub-agents, so file edits and Git commands do not depend on a
missing helper.
Thanks to @edihasaj for reporting the failed chat resume after an update.

Claude billing and extra-usage credit refusals now explain how to check billing
settings and payment methods. These failures stop automatic stream retries and
keep private provider diagnostics out of responses and telemetry.
Thanks to @edihasaj for reporting the unclear billing error.

The service publishes the release it actually loaded, independently of the
installed `current` link and signed app runtime. The watchdog checks that report
against the live service process, so an older JavaScript service cannot appear
updated merely because installation changed the link.

Gateway generation cleanup runs in the background after release or disconnect
and periodically, so an older engine that stops answering cannot block a new
catalog. Loaded chats and live client leases preserve their writers. The
watchdog also fails a service that remains on any older release for more than
one hour after installation, including patch updates.

Gateway chats can load more than four catalog generations without closing older
chats. Loaded chats and client leases keep their original executors, and unused
executors are reclaimed before another generation starts. This fixes the
"Four gateway generations have loaded chats" resume failure.

Claude's private Qwen route can preserve generated no-tools text that the
upstream tool parser silently discarded. A pinned tokenizer decodes complete
raw output, and unsolicited XML remains text rather than an executable call.
The policy requires explicit private opt-in and preserves the existing
tool-enabled path. Thanks to @edihasaj for requesting the root-cause fix.

Claude's private inference service can recover a clean, empty Qwen completion
with one identical request to the same model. A second empty reply becomes an
explicit failure. Retry spend remains in the ledger while Claude receives the
final attempt's context usage. The policy requires explicit private opt-in.
Thanks to @edihasaj for reporting the blank replies.

Both registered GPT accounts passed native automatic compaction at about 193K
input tokens, including exact fact recall after a separate resume. A fresh Qwen
check stopped on empty initial replies before reaching its large-input phase;
an unchanged repeat passed at 193,210 tokens. The failed sample remains a
first-attempt reliability limit.
Thanks to @edihasaj for requesting the additional verification.

Claude Desktop's private inference service can run genuine native Claude Auto
reviews with their original generation controls and protocol metadata. A
Claude-only context proxy also preserves recognized Qwen input-overflow errors,
so scoped reactive compaction can recover beyond the unknown-model estimate.
The private rollout passed native Auto review and mixed-model subagent tasks
on three Macs. Thanks to @edihasaj for the acceptance testing.

Claude's private frontend now refuses to start backend work when a client
disconnects during asynchronous classifier selection. A regression reproduces
the abandoned request before the fix and verifies the listener stays available
after cancellation. Native cancellation and bounded live Qwen manual compaction
also passed their dedicated checks. A rendered Desktop Auto task passed with
the default Fable parent, Qwen reader, and second-account GPT writer.

## 0.8.9 — 2026-10-24

Successful app updates now clean up their verified download and extraction
staging folder after the installation transaction finishes. Pending updates,
rollback app bundles, installed releases and foreign or changed files are
preserved. Cleanup failures do not roll back a completed update. Thanks to
@edihasaj for requesting the remaining cleanup.

## 0.8.8 — 2026-10-24

Automatic model updates now run inside the existing signed app-owned gateway
service instead of registering a separate background job. Migration removes only
the verified legacy metadata job and preserves the app's icon, current models,
accounts and active chats. The app reports live maintenance ownership rather
than assuming that an installed job is running. Thanks to @edihasaj for catching
the duplicate background item.
The older standalone developer provider-build schedule is also retired to keep
one startup item. Provider compatibility builds remain manual; automatic model
discovery continues inside the app-owned service.

## 0.8.7 — 2026-10-24

The macOS app can automatically follow new versions of selected model families.
Enabling the switch preserves the current selection and known disabled models;
metadata checks run every five minutes, unrelated models remain unchecked, and
older picker entries retain their original routes for saved chats. Provider
dates complement numeric versions without inventing release times or switching
accounts. Native picker preferences refresh without restarting active chats.
Thanks to @edihasaj for requesting selected-family automatic updates.

Release packaging now always compiles a clean checkout before packing and
verifies the backend manifest before creating an archive. The incomplete 0.8.6
CLI archive was withdrawn before app deployment; its version is not reused.

## 0.8.4 — 2026-10-23

The macOS app can place native GPT fallback models first, last, or hide them from
the picker. This local execution-host preference preserves the selected native
models, existing chats, explicit native requests, authentication and account
routing. Shared clients can change their own native picker placement without
editing the serving host's providers. Hidden-model discovery remains available.
Thanks to @edihasaj for requesting native fallback picker controls.

## 0.8.2 — 2026-10-23

Connections can be moved up or down in the macOS app or moved directly to the top.
The saved order also determines gateway provider-group order in the model catalog,
without changing authentication, model aliases, or the default subagent account.
The native app updater also accepts safe staging directories below macOS's
root-owned sticky temporary directory; other writable ancestors remain refused.
Thanks to @edihasaj for requesting configurable connection ordering.

## 0.8.1 — 2026-10-23

- Native desktop model lists can be limited to explicit model IDs with `nativeModelPicker`. Older native models remain usable by saved chats and explicit requests, and hidden-model discovery, gateway aliases, authentication and routing remain unchanged. Thanks to @edihasaj for requesting a focused native picker.

## 0.8.0 — 2026-10-23

Completed native callbacks no longer fill the unanswered-request limit and block
later tools. Bounded completed-ID tracking prevents old callbacks from becoming
new tool executions, while shared-socket approvals and dynamic tools retain
their original IDs after ambiguous delivery. Native file-read and process-start
diagnostics distinguish verified missing-path and permission causes without
changing requests or hiding failures. The signed Codex 0.163.0-alpha.11.2 engine
passed the shared-native checks and is accepted by the rebuilt relay. Thanks to
@edihasaj for requesting the runtime and cache audit.

## 0.7.9 — 2026-10-23

The macOS app recognizes existing Grok subscription connections instead of hiding
every connection when one is present. Disabling and re-enabling a Grok model
preserves every alias and its metadata without borrowing another account's
catalog. Hosts identify their local connection scope, while shared clients show
an authenticated, read-only catalog from the serving host and clear it when
unavailable. Obsolete refreshes cannot clear a newer catalog. Thanks to
@edihasaj for reporting the missing connections and asking for clearer
host/client behavior.

## 0.7.8 — 2026-10-23

Subscription accounts can designate a default for bare subagent model names,
including automatic review. Explicit account aliases retain their routes, and
missing models never fall back to another account. The release also improves
subscription refusal diagnostics and records Codex quota counters when the
provider supplies them. Native account usage remains unchanged. Real SDK tests
verified child tools, saved history, queued messages, and follow-up work with
two configured Codex accounts. Thanks to @edihasaj for identifying the account
routing gap and testing phone continuation.

## 0.7.7 — 2026-10-23

SSH listeners and shared executor hosts now recover their managed stale sockets
when a reboot changes the filesystem device number. Recovery recognizes prior
boot ownership, including legacy records, rechecks the current socket identity,
and preserves live listeners and uncertain ownership. Each machine recreates its
own runtime endpoints through the existing connection and service retry paths.
Thanks to @edihasaj for reporting the Studio reconnect failure.

## 0.7.6 — 2026-10-22

Shared app-server connections now keep reading after a message handler fails,
instead of rejecting unrelated pending requests and disconnecting the client.
Failed server callbacks receive a fixed error and safe diagnostics identify the
socket transport. Thanks to Edi Hasaj for reporting the submission failure.

## 0.5.4 — 2026-10-19

Claude Desktop can use an opt-in model catalog with real account labels for
Claude, multiple GPT registrations, and local API models. The separate adapter
preserves native tool and subagent execution, handles optional GPT tool
arguments, and includes explicit configure, serve, install, and status commands.
The existing Codex client and its routing are unchanged.

Thank you to Edi Hasaj for testing the Claude Desktop integration across three Macs.

Harness Gateway now has a native macOS app with the fox icon, a setup wizard,
connection and model management, and a signed background launcher. The app keeps
the existing gateway running when its window closes and preserves its settings.
The signed runtime keeps the app identity stable across installed CLI updates.

Production releases can update the app and gateway together through the existing
background service. Updates verify the signed app and canonical gateway archive
before installation, preserve the previous app for recovery, and wait for the
settings window to close.

GitHub builds require an explicit production-branch dispatch and build opt-in.
Ordinary pushes, pull requests, and default dispatches do not allocate runners.

Thank you to Edi Hasaj for the native macOS app.

## 0.5.3 — 2026-10-18

Codex subscription providers now receive plaintext collaboration message schemas.
This prevents the upstream from encrypting delegated tasks that gateway providers
cannot replay, completing the task-delivery fix for Codex 2.

## 0.5.2 — 2026-10-18

Delegated tasks and follow-up messages now reach Codex sub-agents as plaintext.
The gateway preserves the protocol marker that prevents Codex from treating
these messages as encrypted payloads and dropping their contents.

## 0.5.1 — 2026-10-18

Codex can open sub-agents spawned from gateway chats when the child uses a native
model name. Resuming a child preserves its saved provider and reasoning settings.

## 0.5.0 — 2026-10-18

Connected clients now receive real runtime status from private gateway engines.
Thank you to Edi Hasaj for [#2](https://github.com/edihasaj/harness-gateway/pull/2).

## 0.4.9 — 2026-10-18

Connected clients now preserve live native and gateway chat status without
resuming chats or starting inference.
Thank you to Edi Hasaj for [#1](https://github.com/edihasaj/harness-gateway/pull/1).
