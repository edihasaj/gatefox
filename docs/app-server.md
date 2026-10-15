---
summary: 'Experimental Codex desktop adapter: additive model catalog and per-chat routing.'
read_when:
  - Connecting the gateway to the Codex desktop app
  - Changing app-server routing, model selection, or configuration writes
---

# Codex app-server adapter

The experimental adapter keeps the original Codex executable and native login.
It adds configured gateway models after the native models and starts new gateway
chats with `modelProvider: subscription_gateway`. Native chats keep their provider.

Claude subscription usage observations are available at the authenticated
`GET /v1/provider-usage` endpoint. They contain only provider route IDs, recognized
window/status enums, reset seconds, and observation seconds. Private error prose,
credentials, and account identities are excluded. The daemon saves these
observations privately across restart; a changed authentication-directory route
or removed provider does not inherit an old row.

When the desktop reads `account/rateLimits/read`, the adapter adds known rejected
Claude windows to `rateLimitsByLimitId` with separate `gateway:` IDs. A rejected
window establishes 100% usage. Allowed events do not establish a percentage and
are not rendered as invented zero usage. Expired or day-old observations are
omitted until new provider data arrives. Native `rateLimits`, account identity,
usage permission, credits, upsell fields, and native map entries retain their
values. A gateway outage leaves the native response usable. The installed app's
rendering of additional usage rows still requires a desktop check. Usage updates
never modify the model catalog or create another executor generation.

```sh
gateway codex-shim --config /absolute/path/gateway.local.json \
  --codex /absolute/path/original-codex -- app-server --listen stdio://
```

Stdout carries JSON-RPC only. The adapter forwards notifications, maps server
request IDs for approvals, bounds frames to 16 MiB, and stops its child on exit.
Non-server commands, including `--version`, pass through unchanged. The adapter
accepts `stdio://` and private `unix://` listeners. A Unix listener serves the
WebSocket protocol used by desktop SSH connections. It gives each connection its
own native connection. Gateway executors are shared when the unified service has
shared execution enabled; legacy installations keep per-connection executors.
It refuses occupied sockets, requires a
user-owned directory without group/world write access, and sets the socket to
mode 0600. Network WebSocket listeners are rejected.

For the desktop SSH path, install the managed command on the remote Mac:

```sh
gateway ssh register --codex /opt/homebrew/bin/codex
gateway ssh status
```

Use the absolute path returned by `command -v codex` before registration. The
managed `~/.local/bin/codex` command decorates app-server operations and delegates
other commands to that original CLI. Registration refuses an unrelated existing
command. `gateway ssh unregister` moves only its own command to Trash. Native
configuration and authentication files are unchanged.

The app prepends `~/.local/bin` to the remote command search path and starts a
Unix listener. The managed command uses a gateway-owned control home under
`~/.local/state/gw-ssh`, scoped to the gateway configuration and native home.
It redirects only the original `app-server proxy` child's control home to that
socket. Inference and account discovery retain the original native home. Codex's
own daemon socket is not replaced. A live gateway listener is reused; a crashed
socket is recovered only when its private ownership record matches.
Add the host under Settings, Connections, SSH, then select its workspace.
The built-in Control other devices connection reaches the native engine directly
and bypasses a desktop or SSH wrapper. The separate
[native transport adapter](native-remote.md) reuses the machine's original
registration and routes that connection through the same gateway router. Its
rendered checks are still in progress on the test Mac.

On startup, a bounded native app-server process refreshes its own model metadata.
The adapter copies only public model rows from that engine's configured catalog
or model cache. It validates that the rows cover the engine's available models
and writes a combined catalog. Cache identity and authentication are excluded.
The public rows form a combined catalog for gateway executors. The original
native process keeps its native model and account defaults. The adapter registers
only the added `subscription_gateway` provider through process arguments, so
saved gateway chats can resolve that provider when read or resumed. It does not
write the native configuration. A mismatched or
unavailable cache prevents startup.

The adapter normalizes three retired feature keys in app-server CLI flags,
thread start/resume/fork overrides, runtime enablement maps, and private snapshots.
It maps `features.codex_hooks` to `features.hooks` after reading the SDK's current
settings. An explicit current `hooks` value in those settings or the incoming
request takes precedence over the legacy alias. Workspace settings are resolved
for the chat's directory; an unavailable required workspace or configuration
layer returns application error `-32001` before applying the alias. It removes
`features.code_mode_tool_description_first` and `features.guardianv2.thread_context`,
which the pinned SDK ignores. Code Mode, other Guardian settings, and reasoning
choices keep their values. Equivalent legacy and current settings share the same
executor identity. Already loaded sessions keep their settings until they reload.
Metadata discovery also drops those retired CLI keys before starting its SDK
preflight. It removes the legacy hooks alias without overriding the native
`hooks` setting while reading that base. Normal inference arguments then apply
the compatible alias only when no explicit current setting exists. Shared
execution hosts enforce the same normalization before spawning their SDK,
including requests from older adapters. Native configuration files are unchanged.

Gateway default selections are saved to private `desktop-preferences.json` in
the gateway state directory. Model, effort, summary, and service-tier writes are
scoped to that file for both gateway and native model choices. String `replace` and
`upsert` operations are supported. Writes into native profiles, native version
guards, and batches mixing native changes with gateway defaults are rejected.
All other configuration writes are rejected, including the legacy whole-config
write. Obsidian-managed native settings remain the source of truth.

The current app also saves its display settings through `desktop.*` configuration
writes. The adapter validates supported display fields and stores them in that
same private preference file. It merges them over native desktop defaults when
the app reads settings. This allows Max and Ultra display choices to survive
restart without writing the Obsidian-managed file. Pending desktop migration
batches are validated before any preference changes are saved.

Each adapter connection rereads private preferences when reading settings or
starting a chat. Preference updates use a shared file lock and merge the latest
saved values. Two desktop connections cannot return a cached reasoning level or
overwrite an unrelated preference change with an older snapshot.

The installed desktop build recognizes `CODEX_CLI_PATH` and
`CODEX_APP_SERVER_FORCE_CLI`. These are implementation hooks, not an established
public desktop integration API. `scripts/codex-desktop-shim` is an executable
wrapper for the first hook. The generated desktop wrapper sends only `app-server`
commands through the adapter; other commands, such as the desktop's exec-server,
run the original CLI directly with no extra process. The unified service
re-registers the wrapper when it starts. It accepts `GATEWAY_CONFIG`, `GATEWAY_NODE_PATH`, and
`GATEWAY_CODEX_PATH` when its defaults do not match the machine.

Desktop startup reads organization requirements and native configuration through
the adapter before opening the main UI. A backend startup failure can therefore
appear as an organization-settings error.

Natively, the desktop is the only launcher of its app-server. With shared native
ownership, the relay or an SSH client can start the writer first with fewer
settings. The host compares launches by setting key, not by exact argument list:

| Request compared with the running writer | Result |
| --- | --- |
| Same settings, or a subset (relay ⊂ SSH ⊂ desktop) | Attaches to the running writer |
| Only adds settings, and every loaded chat is idle | Replaces the writer with the richer launch |
| Only adds settings while a chat is working | Refused; the desktop's Retry succeeds after it finishes |
| Changes a value, a profile, the directory, or the provider registration | Refused; ownership is preserved |

The desktop adds `features.code_mode_host` and its bundled plugin MCP toggles.
The analytics-default flag is ignored. A replacement disconnects the old writer's
clients, as an app restart would. A writer that a settings-free client starts
later reuses the richest launch the host has seen.

To test a fresh desktop launch, quit the app normally with Command-Q and keep
the gateway daemon running. The launcher refuses to stop a running app. It starts
the signed binary directly with explicit environment variables and saves a private
receipt with its PID. A launch receipt does not prove rendered model selection.

```sh
gateway desktop --config /absolute/path/gateway.local.json
```

Use `--native-home PATH` for an isolated native test home. Omit it to keep the
original native account home. The launcher does not edit either native config
or authentication files. LaunchServices can reuse an existing instance, so an
`open -a` invocation alone is insufficient evidence that overrides took effect.

`gateway desktop register` stores a managed per-user LaunchAgent and sets only
the desktop CLI override variables for future launches. The agent restores them
at login and does not open or quit the app. Registration refuses an unrelated
existing CLI override. `gateway desktop unregister` removes its own overrides.
This keeps normal Dock launches configured after initial activation without
editing the Obsidian-managed native configuration.

The client owns chat naming. The adapter forwards native `thread/name/set`,
saved-title reads, and live name notifications; it adds no title tool or naming
instructions. Caller-supplied dynamic tools remain unchanged. Read-only saved-chat
metadata needs neither gateway inference nor model discovery.

Choose a gateway model in a **new chat**. A loaded chat cannot switch between
native and gateway providers in this Codex version. The adapter rejects that
change before inference. Switching Claude and Codex 2 inside a gateway chat works
because they share the gateway provider and its account-scoped replay handling.
Native return from gateway history is not supported: a real probe failed on
foreign item IDs. The adapter does not rewrite stored native history to bypass it.

Gateway executors enable Codex's active-step model switching. The adapter forwards
`thread/settings/update`, `turn/settings/update`, `turn/steer`, and goal operations
with their original turn IDs and authorization fields. A thread-level model
selection remains the default after a saved chat resumes. An active-turn model
update applies at the next inference step. A captured tool step keeps its approval
requirements; changing thread access updates subsequent turns.

These controls passed live tests with Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol.
Goal creation, reads, updates, notifications, and clearing were tested. Automatic
goal continuation and every rendered control remain separate desktop checks.

## Compaction and model changes

The pinned SDK normally compacts a long chat with its previous model before
switching to a model with a smaller context window. An unavailable or exhausted
previous provider can therefore block a model change even after the new selection
has been saved.

Releases containing the verified gateway-only SDK perform ordinary automatic
compaction with the selected model inside the caller's original turn. The SDK
uses its actual token estimate, reasoning effort, goal state, cancellation, and
history replacement. Every compaction item retains that user turn's ID; the
adapter does not submit a preceding manual turn. Declared compatibility-hash
changes retain the upstream SDK's compatibility handling. This executable is
used only in private gateway homes. The original signed native SDK and its
authentication remain unchanged.

The installer records the pinned SDK revision, exact runtime patch, dependency
lock repair, and binary checksum. Invalid or mismatched artifacts refuse a new
gateway executor. A shared generation advertises selected-model compaction only
after its host verifies the requested binary checksum. Its checksum participates
in generation identity, so a newer executable cannot replace loaded work.

Legacy packages without that artifact retain the adapter recovery below. For
those per-connection gateway executors, the adapter checks public current-window
usage against the selected model's frozen context metadata. It also records real
failed compaction events. On the next explicit user message, a qualified idle chat
is compacted with the selected gateway model before that message is submitted.
The adapter waits for the actual compaction item and successful turn completion;
an empty RPC acknowledgement alone does not establish success. Stop cancels only
the observed compaction turn and prevents submission of the waiting message.
Failure returns one application error and requires another explicit retry.

Active turns retain normal SDK steering. Recovery never pauses an active goal;
pause or finish that goal first. Shared executors require explicit compaction
because the SDK cannot atomically check idle state and start compaction across
independent clients. Unknown context metadata is not replaced with cumulative
billing totals. A confirmed rollback clears the recovery metadata. Known non-null
compaction hashes are rejected because the SDK does not expose the previous-turn
hash needed to prove format compatibility.

The SDK owns history replacement and retains its original rollout. Summaries are
lossy, and the SDK can trim the request copy to fit the selected model; this does
not guarantee exact preservation of every detail in a smaller context window.
An uncertain late SDK start remains guarded until its actual completion. Reconnect
the chat's computer connection if that guard requests it. The adapter never
fabricates a completion or clears a live writer lock.

These changes require a fresh adapter connection and gateway executor. Installing
a release preserves an already-loaded older adapter and its active chats. The
legacy manual recovery can bind the desktop's pending message to the preceding
compaction turn; backend completion alone does not prove rendered association.
The selected-turn fixture checks the actual SDK event IDs and replays the tested
desktop handlers; a rendered check remains a separate release gate.

The launch procedure and real Claude/Codex 2 conversations have been verified
in the rendered desktop on MacBook Pro 2. Initial activation requires a fresh
app launch with these environment variables. Test on another machine before
relaunching a working app.

Max and Ultra are separate desktop display choices. Under Model features, enable
the offered levels in Available reasoning efforts. Availability varies by model
and the app's feature settings. Enable the choices in the app that renders the
picker; enabling them on a remote Mac does not change this Mac's controls.
The gateway persists these explicit display changes in its private settings and
does not advertise unsupported provider effort levels.

Ultra is Codex's top effort plus Codex's own task delegation. Native rows mark
it with `multi_agent_version` and `multi_agent_reasoning_effort`; with `v2`,
Codex offers its `collaboration` tools (spawn, follow up, message, wait, list and
interrupt agents). Model discovery copies both fields from the upstream catalog,
so gateway Codex models behave like native ones. Claude rows that support `max`
offer Ultra with `v2` delegation at `xhigh`. Codex sends `max` on the wire for
Ultra, and the Claude CLI's top level is `max`.

Model metadata follows each provider's own catalog. The inference server refreshes
it a minute after start and every six hours: Codex, Copilot and OpenAI-compatible
providers from their `/v1/models`, and Claude from the CLI's model list. Only the
metadata of configured models changes; adding or removing routes stays an explicit
`gateway discover PROVIDER --load`. A discovery failure keeps the saved metadata.
Claude also reports the context window the CLI actually used in every response
(`modelUsage.contextWindow`); the server saves it in `observed-context-windows.json`
and the next refresh adopts it, so a window never needs a manual table. Clients
receive the new catalog the next time the app starts its app-server.

The initial Claude windows were measured on a subscription on 13 Oct 2026. The 5.x
models, Opus 4.8 and Opus 4.7 run with 1M under their plain IDs. Opus 4.6 runs
as the CLI's `claude-opus-4-6[1m]` variant, which the subscription includes; its
gateway alias keeps the plain ID so saved chats keep working. Sonnet 4.6's 1M
variant needs paid usage credits and Haiku 4.5 has none, so both report 200K.
Other personal Claude settings are not applied: a fallback model would silently
change the caller's model, and hooks, MCP servers and permissions must not run
inside an inference backend.

Codex 2 rows use Codex's native tool-output truncation (10,000 tokens) and window
share (95%), and keep the upstream's `truncation_policy`, `max_context_window` and
`auto_compact_token_limit` when discovery returns them. Other provider types keep
12,000 tokens and 90%. The upstream reports GPT-6.1-Sol at 500K with a maximum of
872K. On the desktop the adapter then applies the native row for the same model
([below](#codex-2-rows-and-the-native-catalog)). The
refresh overwrites a hand-set `truncationPolicy` with the upstream value; an
`effectiveContextWindowPercent` override lasts while the upstream omits that field.
After an update the public catalog changes twice: once for the new defaults, then
about a minute later when the first refresh saves the upstream limits.

Native GPT-6.1-Sol rows also set `use_responses_lite` and
`supports_reasoning_effort_updates`. Discovery carries both, so Codex sends gateway
Sol the same lite request as native Sol: `reasoning.context: all_turns`, with tool
definitions in an `additional_tools` input item. The gateway reads tools from that
item for tool-call mapping, passes the item to the ChatGPT endpoint unchanged, and
applies its own default namespace only to calls of top-level tools. Other
providers skip the item when building their transcript.

Picking a model in the desktop that lacks the chat's speed tier (a Fast Codex chat
switched to Claude) moves the chat to Standard. Only that explicit settings change
does this; turn starts, resumes, forks and active-turn updates still refuse a
missing tier, so a stale peer cannot silently drop another client's Fast setting.

Sub-agents that Codex spawns from a gateway chat (delegation, Ultra, or agent
roles in the native configuration) inherit the gateway provider but take their
model from the role, often a bare name such as `gpt-5.6-terra`. The server serves
such a name through its vendor's subscription route when exactly one alias there
has that upstream model: `gpt-…`, `o…` and `codex-…` names use the Codex
subscription, `claude-…` names the Claude subscription. Other routes serving the
same model, such as Copilot, are not used for a bare name. An unknown or ambiguous
name still fails with `model_not_found`. Each resolution is logged as
`model_alias_resolved`. Before this, such sub-agents failed silently: Codex retried
the 404 five times and ended the turn with nothing.

Resuming or forking a gateway chat on the same model restores the chat's own
reasoning. The adapter records the effort and summary each chat last ran with in
a private `desktop-thread-reasoning-<scope>.json` under its state directory,
fed by applied thread settings, turns that carry an effort, and chat
start/resume/fork results; an unknown (null) value never erases a saved level,
and a chat's record never transfers to another chat. When nothing is recorded
yet, for example after a gateway restart, the adapter seeds from the chat's own
rollout file in the executor's sessions directory, reading only records that
carry reasoning. A saved level belongs to the model it was saved with: a newer
observation for another model carries no effort or summary over to it, so
switching chats never inherits the previous model's Max. A gateway model whose
row offers no reasoning levels at all receives nothing restored, because there
is no level to restore to. A restored level the model does not offer is fitted down to
the closest offered level, or to that model's default when none qualify; the
adjustment is reported as `reasoning_effort_reset`. A resume that switches
models still receives a level the new model supports. A caller that sends its
own effort always wins over the restored one. Native chats need an override
only where a typed model blocks the engine's own restore, and only with a
level the native catalog row offers.

## Codex 2 rows and the native catalog

Codex 2 rows serve the same models as native Codex, so the desktop adapter gives
them the harness half of the native row. Each Codex 2 row in the public catalog
names its upstream model in `upstream_slug`. The adapter looks that slug up in the
local native catalog it loaded at startup and copies these fields:

- `model_messages`: the base prompt (`instructions_template`) and Codex's other
  model messages, together with `include_skills_usage_instructions`,
  `include_plugin_usage_instructions` and `include_apps_usage_instructions`. Native
  GPT-6.1-Sol turns all three off because its template already holds that
  guidance. With the gateway's own `true` values Codex repeated it: with skills
  alone, 2,554 characters (about 550 input tokens) on every request. Without a
  native template the gateway values stay;
- `tool_mode`, `apply_patch_tool_type` and `shell_type`;
- the `default_reasoning_level`, `default_verbosity` and `default_reasoning_summary`
  defaults, and `support_verbosity`. A default effort the route does not offer is
  not copied;
- `effective_context_window_percent` and `truncation_policy`;
- `context_window`, but only when the native value is at or below the upstream's
  `max_context_window`. Otherwise, or when the upstream reports no maximum, the
  upstream window stays.

Everything else keeps the upstream value: service tiers, multi-agent fields, the
window maximum, the auto-compaction limit, input modalities and reasoning levels.
`comp_hash` is never copied. `supports_search_tool` stays off and the adapter keeps
web search disabled, because `tool_search` does not pass through the gateway. A
slug without a native row, and every Claude, Copilot or other row, keeps the
published fields except the two node_repl fields, which take the strictest native
policy described below. The rows the adapter builds drop `upstream_slug`. At each
launch the native-catalog preflight first writes `desktop-models.json` with the
plain gateway rows, marker included; the adapter replaces that file with the
copied rows on its first successful cache restore or host refresh, and every
gateway chat start refreshes first. Codex 0.160.0 and the gateway SDK both
ignore the marker, as they do in the plain catalog that CLI and remote clients
read. Those clients have no native catalog, so they keep the gateway rows
unchanged.

The inference host still never supplies instructions. The offline cache stores
only the host's public rows; the adapter rebuilds the copy from the native catalog
on every start, and a changed native row changes the catalog revision, which starts
a new executor generation for new chats.

Code mode runs in a separate `codex-code-mode-host` process that Codex starts from
beside its own executable. The gateway SDK package does not ship that host yet, so
code mode in its executors fails closed. When the installed package has a gateway
SDK without the host, the adapter keeps the gateway's `direct` tool mode and still
copies the other fields. Without a gateway SDK, executors run the desktop's own
Codex and take the native code mode. The same rule covers the native rows that the
executor catalog carries for sub-agents naming a model directly (a role's model,
`default_subagent_model` or Ultra delegation): without the host those rows get
`direct` tools in executors, so their commands run instead of failing with "failed
to spawn code-mode host". The native engine keeps its own catalog unchanged.

node_repl (the browser, Chrome and computer-use tools) follows the ModelInfo fields
`node_repl_disabled`, `node_repl_auto_review_required`, `guardian` and
`auto_review_model_override` (the native catalog also has `requires_sandboxed_review`, which
the gateway SDK ignores). Observed read-only on ChatGPT 26.1007:

- It does not depend on code mode: the bundled `unified-computer-use` plugin declares
  `cua_repl` with `omit_tools_from: ["code_mode", "deferred"]`, and `~/.codex/config.toml`
  runs `[mcp_servers.node_repl]` from the app. Only `tool_mode` follows code mode.
- Every native row has `node_repl_disabled: false`. Review is required on `gpt-6-astra`,
  `gpt-6.1-sol` and `gpt-6-sol`; the other three fields are null or absent.
- The rows that require review carry only `auto_review.rejection_instructions`. The
  node_repl review text (`node_repl_policy`) is on the hidden reviewer row
  `codex-auto-review`, which the executor catalog carries as a native row. The four 6.x rows
  share `confirmation_policies` and `guardian_v2`, which a Codex 2 row gets with its
  copied `model_messages`; Claude, Copilot and API rows have neither.

Rules:

- A Codex 2 row copies the review flag, `guardian`, `auto_review_model_override` and
  `requires_sandboxed_review` from its native row, with code mode on or off. A value that is
  not plainly typed is not copied, and a flag that is not a boolean becomes `true`.
- Auto review cannot run in a gateway executor, so a row that needs it (the flag, or a
  `guardian` that reviews computer use) has node_repl off there. That covers `gpt-6.1-sol`,
  `gpt-6-astra`, `gpt-6-sol` and the same native rows when sub-agents name them; rows such as
  `gpt-6-luna` keep it on. The reviewer runs through the gateway, which answers the SDK's
  `codex-auto-review` with 404 `model_not_found` unless exactly one Codex subscription alias
  serves it (the live config has none), and review errors fail closed. This comes from source
  and config, not a live run. Routing that slug would send a Claude or Copilot chat's actions
  to an OpenAI reviewer, which is Edi's decision (`executorRunsAutoReview`).
- A row with no native counterpart (Claude, Copilot, API, or a Codex row whose upstream is
  missing) takes the strictest native policy: off when any is off or needs review, review
  required when any requires it, sandboxed review when any does; with no native catalog both
  are `true`. Off, it has nothing to review, so it gets neither the confirmation and classifier
  texts nor `guardian`. The plain catalog (CLI, remote clients) publishes `true` and `true`.
- Executors start from the machine with the native catalog and settings, so the node_repl
  server resolves as natively; none was found that cannot start it.

`node scripts/check-node-repl.mjs catalog.json` prints both fields per row of a copy of an
executor home's combined catalog and counts the rows that keep node_repl off and those that
enable it without review. It is advisory and exits 0, also for unreadable or malformed input.

Every gateway row publishes `max_context_window`: the provider's own maximum when it
reports one, otherwise the row's window. Without it a row inherited Codex's global
cap of 872K, which cut Claude's 1M window.

Gateway executor homes link the native `AGENTS.md`, `agents`, `skills`, `plugins`,
`hooks.json` and `prompts`, so client hooks (for example memory hooks) and saved
prompts work in gateway chats as in native ones. Authentication and `config.toml`
are never linked.

On 13 Oct 2026 a low-effort GPT-6.1-Sol turn through a development gateway sent
the native 21,769-character base prompt as a developer message (Responses lite has
no top-level `instructions`). With Codex 0.160.0 the model called the code-mode
`exec` tool; with the gateway SDK and the copied `direct` mode it called
`exec_command`. Both turns completed, and the second request of each turn read
97-98% of its input from the cache. Native and upstream both reported GPT-6.1-Sol
at 500K that day, so its window did not change.

A resumed chat keeps the base instructions saved with it, as natively; chats
started before this change keep their empty base prompt. When it starts a new
gateway chat without a saved preference, the adapter still selects medium effort
and auto summaries, so the native default shows in the model list but does not
yet start the chat. Those defaults never replace an existing chat's settings on
resume; the chat's own reasoning is restored instead, as described above.

## Empty chats and message order

The SDK answers a `thread/start` or `thread/fork` request before it announces the
new thread. The desktop depends on that order: it hides a prewarmed chat (the empty
chat behind an unsent draft) only when the reply arrives before `thread/started`.
The adapter records a gateway chat's tier before it answers, so it holds the new
thread's notifications until the reply is written and then releases them in SDK
order. Chats that are already known keep streaming while a start is pending, a
failed start still releases the held notifications, and a buffer of more than 512
held messages is written out in order rather than growing. A server request (an
approval or elicitation, which carries its own id and never waits) still follows
every message already held for its own chat: those held notifications are written
first, so the desktop is never asked to answer an event it has not seen. Before this, a gateway
prewarm showed up in the sidebar as an empty chat, and opening it failed with
"Failed to resume chat".

A request for a chat that no SDK knows (no rollout, nothing loaded) goes to the
native SDK unchanged, so the desktop receives the SDK's own answer: an empty
attachment list, a `notLoaded` unsubscribe, or "no rollout found for thread id",
which the desktop recognizes when it archives or deletes such a chat. Any other
failure of the provider lookup still fails closed.

## Queued messages (Cmd+Enter)

`thread/queue/*` goes to the chat's own engine like any other chat request, and the
SDK owns the queue: it is saved on disk in the shared queue database, the next
message starts when the running turn completes, and an interrupt pauses the queue.
The SDK reads every attached local image or audio file while it enqueues a message.
macOS gives file access to the desktop app, not to the service that owns shared
executors, so a screenshot from a protected folder failed there with `-32600`
"local queued attachment is invalid: Operation not permitted". For `thread/queue/add`
and `thread/queue/update`, the adapter (which runs under the app) now copies each
attached local file into a private `queued-attachments` directory under the gateway
state directory, sends the SDK the copy, and removes the copy when the call returns;
copies older than ten minutes left by a crash are removed. The copy keeps the
file extension, because the SDK takes the audio type from it, and is cut one byte past
the SDK's own size limit so oversized files still get the SDK's size error. A file the
adapter cannot read is sent unchanged, so the SDK reports the same error as before.
Executors that run under the app (per-connection engines) are not changed. Paths and
file contents are never logged.

## Speed controls

Gateway discovery retains the provider's public `service_tiers`,
`additional_speed_tiers`, and `default_service_tier` fields. The adapter validates
them through live discovery and its private offline cache, then exposes the same
capabilities in local and connected-machine `model/list` responses. Native rows
retain their original capabilities. No speed tier is inferred from a model name.

Standard remains the default in this installation. Choose Fast only for a model
that advertises it; the pinned SDK identifies Fast as `priority`. Gateway-only
preferences restore a saved new-chat default for the exact selected model. An explicit
`serviceTier` or `config.service_tier` takes precedence, including explicit null
for Standard. A model-only preference change clears the preceding model's tier.
Resume and fork inherit their chat's tier; new-chat preferences never replace it.
The pinned SDK does not restore speed from saved history. The gateway therefore
keeps public per-chat model/tier metadata in its own private state, scoped to the
original native home. Fresh connections reread this record. Runtime settings are
recorded from the SDK's applied settings notification, not its queued update ACK.
SDK source timestamps reject delayed settings events. Private revisions prevent
an older resume reply from replacing a newer choice. Conflicting events stamped
in the same millisecond resolve conservatively to Standard; an explicit confirmed
SDK snapshot can establish the current choice again. Clock uncertainty never
restores Fast from an uncertain older notification.
The adapter passes the known parent tier explicitly when forking because the SDK
otherwise uses executor defaults. If that parent tier is unavailable, resume the
parent or specify a tier before forking.
The SDK's returned tier is authoritative. Resuming an already-loaded chat keeps
its loaded settings even when resume parameters request another tier; change it
through `thread/settings/update`. A cold resume can apply an explicit override.
Temporary active-turn tiers remain separate from the chat default.
Gateway executors enable the SDK's Fast feature when their validated catalog
offers priority. Native feature flags and configuration files retain their values;
enabling that private capability does not select Fast automatically.

A loaded Fast chat cannot switch to an unsupported model without explicitly
choosing Standard. When a connection cannot determine the saved tier, resume the
chat to read its settings or explicitly choose Standard before changing models.
These checks return application errors rather than a misleading native-config
warning. Reasoning effort is independent of speed.

Claude rows offer Fast when Claude's own model list marks the model as supporting
fast mode (currently the Opus models). Fast turns on Claude Code's fast mode for
that request, which Claude bills to the account's usage credits. Discovery
refreshes this capability with the rest of the catalog, so every connected
machine sees the same option.

The current Copilot CLI does not offer a selected-model Fast tier. Its four
configured models expose no speed options. A direct Fast request is rejected
before starting the CLI. The integrator-only Auto Fast API is a different route
and is not enabled by this installation.

Installing updated adapter code preserves open apps and running services.
Already-loaded older adapters need their next normal launch to expose these new
fields. Catalog updates use the usual live discovery path after activation.

The circular arrow in the model control is **Reset to default**. It chooses a
default power preset; it does not fetch a fresh model catalog. That preset can
belong to the native account, so a gateway chat cannot always apply it. Provider
switch refusals use an application error code rather than the app's configuration
validation code, avoiding a false warning that `config.toml` is broken. Explicit
saved model defaults are also reflected in the catalog's default flag. The app's
power presets can still exclude custom aliases, so this flag does not permit a
loaded chat to change providers.

The adapter fetches the inference host's public catalog when listing models and
starting gateway work. A changed catalog starts a fresh gateway executor for new
chats. Loaded native and gateway chats keep their connections. To select a newly
added model in an older loaded gateway chat, close and resume that saved chat, or
start a new one. Ephemeral chats cannot be resumed after their executor exits.

Gateway model names remain listed during a connection outage, including after
an adapter restarts. A private cache stores the last valid public model rows,
scoped to the local gateway port and a hash of its client token. Selecting a
gateway model still requires fresh discovery. An unavailable gateway returns
application error `-32001` before creating a chat or using the native account.
When the connection recovers, normal discovery reloads the catalog without an
app restart. Invalid or differently scoped caches leave native models usable.

The desktop query itself has a five-minute cache and refetches on focus in the
installed build. Catalog changes require no app restart after initial activation,
but immediate visible picker updates are not guaranteed. There is no fabricated
account-change notification to force a refresh.

Gateway executors use a private configuration home and share native chat storage.
They do not copy the primary auth file. See [architecture](architecture.md) for
configuration isolation, catalog generations, and failure recovery.
