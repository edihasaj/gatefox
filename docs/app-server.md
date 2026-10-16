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
including requests from older adapters. This normalization rewrites no
native configuration file.

ChatGPT chooses which `features.*` settings to send from the native engine's
version, but gateway chats run the older pinned SDK. For gateway chats and gateway
executor launches only, the adapter trims feature settings to that SDK's schema.
This covers thread start/resume/fork overrides, executor launch flags and
settings, and the private gateway home snapshot. Runtime enablement maps
(`experimentalFeature/enablement/set`) are not covered: that request carries no
thread id, so it always goes to the native engine, which is never changed.

The rules follow the SDK. A feature that is not a structured table in the pinned
SDK must be a boolean, so a table with a boolean `enabled` field becomes that
boolean and any other value is dropped. Structured features, such as
`multi_agent_v2`, `guardianv2` and `code_mode`, keep only the fields the SDK
accepts, including the strict sub-tables below them (`guardianv2.transcript`,
`guardianv2.review_scope`, `multi_agent_v2.message_board_remote` and the
`network_proxy.credentials` entries). `tool_registry` is a plain table in the SDK,
so a boolean there is dropped. The same rules apply to dotted keys, `profiles.<name>`
in nested, dotted and flat form, and `-c` flags. A `-c` value is read as JSON or
inline TOML (bare dotted keys inside an inline table expand to nested tables), and a
flag that cannot be read is dropped. The SDK parses every `-c` value as TOML, so a
changed table is always written back as inline TOML, never JSON. Keys are read the way
the SDK applies them: an override key, from a request's `config` or a `-c` flag, is
split on every dot and never unquoted, so a quoted segment is part of the name, and
nothing is respelled. Inside a value the SDK keeps keys literal, so a dotted key inside
a `features` or profile table is a name, not a path, and only a profile's own
`features` table is trimmed.

Trimming never widens what a chat may do. `network_proxy` limits network access, so
it is never changed in any form: a value the pinned SDK cannot read fails the chat with
the SDK's own error instead of running it with fewer limits.

Static rules cannot know new enum values, the SDK's range checks or fields added
later. If the SDK still refuses a gateway `thread/start`, `thread/resume` or
`thread/fork` with `failed to load configuration` (code -32600) at a `features` or
`profiles.<name>.features` path, and the strict form differs from the request, the
adapter retries once with that strict form: each feature becomes its boolean `enabled`
or is removed, `tool_registry` is removed, and `guardianv2` is turned off. Off removes
the reviewer's cached fast approvals, so every reviewed action gets a fresh review or
goes to the user, as `approvals_reviewer` decides; it never approves more than the
reviewer would with default settings. `network_proxy` stays as sent, and
`multi_agent_v2` keeps its normally trimmed table, so the caller's limits on concurrent
threads and spawn model overrides are not replaced by the SDK's looser defaults. A failure at any other path, or one the SDK marks as an
unavailable cloud configuration bundle, is not retried. A failed configuration load
creates no thread, so the retry has no side effects. If the retry fails too, the
original error is returned.

Native chats and native launches are never changed or retried. The
`gateway_features_trimmed` event records only the site and how many entries changed.

Gateway default selections are saved to private `desktop-preferences.json` in
the gateway state directory. Model, effort, summary and speed (service tier)
writes are scoped to that file for both gateway and native model choices, and
they require string values with a `replace` or `upsert` merge strategy. Writes
to the supported `desktop.*` display keys go to that same file, but each carries
its own typed value rather than the string rule above; unsupported `desktop.*`
keys are ordinary native keys and reach the engine. Every other key belongs to
the caller's native configuration, which `config/value/write` and
`config/batchWrite` forward to the native engine unchanged: same method, same
params, with `filePath`, `expectedVersion`, `reloadUserConfig`, and
`mergeStrategy` passed through, and the engine's result or error returned
as-is. When a batch mixes kinds, its native part keeps the caller's own edit
objects in the caller's own order, including an entry the adapter cannot read,
which is forwarded unchanged. The app writes those keys the same way without the
gateway, so a setting changed in ChatGPT still reaches its own configuration.
The adapter itself never writes native configuration on its own initiative.

A whole request is refused, before anything is written or forwarded, when a
native edit would store gateway identity in native configuration. A key path is
parsed into segments exactly as the Codex engine parses it: dots separate
segments, a segment may open with `"` to carry separators literally, and inside
quotes a `\` escapes the next character. Every rule below reads those segments,
so a quoted spelling such as `model_providers."subscription_gateway".base_url`
is refused like the dotted one. A gateway default spelled another way, such as
`"model"`, is not a key the adapter can save: it reads as a native key to the
engine, so the write is refused rather than sent. A byte-order mark is not
whitespace here, which is how the engine reads it, and a path made only of
whitespace carries no name and is refused.

| Refused native edit | Error |
| --- | --- |
| A gateway default key given another spelling, such as `"model"` or `desktop."appearanceTheme"`: the engine reads those segments as a native key, so the adapter neither saves nor forwards it | Gateway defaults must be written with their plain key |
| A key path the engine cannot parse: empty, or whitespace in the Unicode sense that carries no name, with an empty segment, with a quote that can neither open nor close a segment, or with an unterminated quote or escape | This configuration key is not valid |
| A key whose last segment is `model` set to a gateway alias | Gateway defaults cannot be saved into a native Codex profile |
| `model_provider` or `oss_provider`, at the top level or below a profile, set to `subscription_gateway`; a `model_providers.subscription_gateway` key, or any key below it, given a value other than `null`; a `model_providers` key whose value holds that provider with a non-null value | Gateway models and the gateway provider cannot be saved into native Codex configuration |
| A key whose last segment ends with `_model` (such as `review_model`, `profiles.work.review_model` or `features.guardianv2.review_model`) set to a gateway alias | Gateway models and the gateway provider cannot be saved into native Codex configuration |
| A value that anywhere holds a gateway alias under a `model` or `*_model` key, that provider under a `model_provider` or `oss_provider` key, or that provider as a non-null key of a `model_providers` value. Values are searched through objects and arrays to 65 nested levels, counting the written value as level 1; a value containing a 66th level is refused. | Gateway models and the gateway provider cannot be saved into native Codex configuration |
| A `model_catalog_json` key, at the top level or anywhere inside a value, set to the gateway's catalog file or to anything inside the gateway state directory. Files and folders that exist are compared by identity, by device and inode, so a symlink, a firmlink such as `/System/Volumes/Data/private/var/...`, or another letter case of the same name on a case-insensitive volume is refused like the path written out directly; a file or folder that does not exist yet is judged by the identity of its existing ancestor folders as well as by its spellings, the lexical and the resolved one. A path longer than 4096 bytes, the longest any platform accepts and the same cutoff on every platform, is compared by its spelling only, without touching the file system. One request may spend at most 16384 units of work on the paths its edits name. A unit is one folder passed while walking a path, whether or not its answer is already remembered, or one file-system read (`stat`, `lstat` or `readlink`); links are followed one folder at a time, at most 40 of them as the operating system does, and each step is charged. A deep path therefore costs a unit for every folder each time it is walked, while the same path repeated is answered from memory at no cost and a folder shared by several paths is read once. A request that spends the budget is refused whole with "This configuration write names too many different paths to check" instead of being checked by spelling alone; at the deepest tree a platform allows, that takes a fraction of a second. A real batch stays far below this limit: one or two catalog paths of ten folders cost under 150 units, and 50 edits about 15 folders deep cost about 3300. Every spelling the engine reads is tried: a `~` on its own or `~/rest` is the home directory, and any other relative path is read below the native home in both its lexical and its resolved spelling, never below the directory of the request's `filePath`. With the native home at `~/.codex` and the state directory at `~/.codex/state`, that makes `state/codex-models.json`, `~/.codex/state/codex-models.json` and `../.codex/state/codex-models.json` all the gateway's catalog; `../state/codex-models.json` reaches it only where the state directory sits beside the native home. A name the engine does not expand, such as `~rest`, stays one of the caller's own files and is forwarded | The gateway catalog cannot be saved into native Codex configuration |
| Any native edit in a request whose `filePath` is the gateway preference file | Native configuration changes cannot target the gateway preference file |

Clearing stays possible: an edit whose value is `null` removes a gateway
provider row or field instead of storing one, so it is forwarded rather than
refused. Chat starts and settings reads overlay the gateway's own catalog
through `model_catalog_json`; that file is gateway state, and saving its path,
or any file from inside the gateway state directory, into native configuration
is refused like the rows above. The guard compares the file the engine would
open, or the path itself when the engine could not open it, so a link that
points at either one is refused the same way.

A batch that mixes both kinds first checks every gateway-default rule, then
sends the native edits to the engine in their original order, and saves the
private file only after that write succeeds. A native write that fails returns
its own error and saves nothing, and an invalid private part forwards nothing.
A request that carries a native part answers with the engine's result or error;
a write that is private-only answers with the gateway's own saved result. Every
configuration write from one connection, native-only ones included, waits
behind the writes sent before it, so the engine sees them in send order and a
failing write does not hold back the ones queued behind it. The legacy
whole-config `config/write` stays refused.

The current app also saves its display settings through `desktop.*` configuration
writes. The adapter validates supported display fields and stores them in that
same private preference file. It merges them over native desktop defaults when
the app reads settings. This allows Max and Ultra display choices to survive
restart in the private file instead of a native one. Pending desktop migration
batches are validated before any preference changes are saved.

Each adapter connection rereads private preferences when reading settings or
starting a chat. Preference updates use a shared file lock and merge the latest
saved values. Two desktop connections cannot return a cached reasoning level or
overwrite an unrelated preference change with an older snapshot.

The installed desktop build recognizes `CODEX_CLI_PATH`. This is an implementation
hook, not an established public desktop integration API. `scripts/codex-desktop-shim`
is an executable wrapper for it. The generated desktop wrapper sends only
`app-server` commands through the adapter; other commands, such as the desktop's
exec-server, run the original CLI directly with no extra process. The unified
service re-registers the wrapper when it starts. It accepts `GATEWAY_CONFIG`,
`GATEWAY_NODE_PATH`, and `GATEWAY_CODEX_PATH` when its defaults do not match the
machine.

The gateway no longer sets `CODEX_APP_SERVER_FORCE_CLI`. With `CODEX_CLI_PATH`
alone, new local chats use the gateway catalog while durable chats and the
desktop's SSH connection rows keep their native behavior: an SSH row runs Codex
on the remote Mac, and gateway models reach it only through that Mac's own
registration.

An older gateway also exported `CODEX_APP_SERVER_FORCE_CLI=1`, which ran durable chats and
SSH rows as extra local app-servers. Registration removes that value only when a registration receipt
proves the gateway set it; after upgrading, run `gateway desktop register`, check `gateway desktop status`
shows `legacyForceCli: false` and `forceCliSet: false` (status counts the variable as set when anything
remains after it removes exactly one trailing newline), then restart ChatGPT once. While the session still
names an older gateway wrapper, status reports `staleWrapper: true` and `activeForFutureLaunches: false`
until a register writes the current one. Details and the ownership rules are in
[legacy FORCE_CLI cleanup](desktop-legacy-force-cli.md).

Desktop startup reads organization requirements and native configuration through
the adapter before opening the main UI. A backend startup failure can therefore
appear as an organization-settings error.

If the app's native engine is not the verified one (for example after an app
update), the host starts without native sharing and keeps offering gateway chats;
it records `native_sharing_unavailable` with a fixed `reason` (`sdk_version`,
`sdk_signature` or `other`). When the plan also shares gateway chats, the desktop
adapter then falls back to its own native engine, exactly as without native
sharing, and records `native_sharing_fallback`. Gateway chats keep using the
host. Any other failure to reach the host still fails the connection. While the
fallback lasts, the native relay cannot share the engine either, so remote control
of that Mac is unavailable. The fallback lasts until a release verifies the app's
engine. That release must also handle the return to sharing: it has to release the
stale native lease the earlier host left and must not start a shared native writer
while a desktop's private native engine still runs on the same native home.

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

`gateway desktop register` stores a managed per-user LaunchAgent and sets
`CODEX_CLI_PATH` for future launches. The agent restores it at login and does not
open or quit the app. Registration refuses an unrelated existing CLI override and
clears only a legacy `CODEX_APP_SERVER_FORCE_CLI=1` that an older gateway set.
`gateway desktop unregister` removes its own overrides.
This keeps normal Dock launches configured after initial activation without
editing native configuration.

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
update applies at the next inference step, unless the destination differs in
node_repl or review settings: the SDK then rejects it, as natively, and the adapter
forwards the error ([which rows](node-repl.md#switching-models-during-a-running-turn)).
A captured tool step keeps its approval requirements; changing thread access updates
subsequent turns.

These controls passed live tests with Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol,
which were then in one node_repl group; only adapter tests cover a rejected switch.
Goal creation, reads, updates, notifications, and clearing were tested. Automatic
goal continuation and every rendered control remain separate desktop checks.

## Native chats keep their model

The adapter never changes a native chat's model or provider. When "Authenticated
workspace changed" restarts the desktop's local engine, ChatGPT 26.1007.71326
resumes each open chat with `model: null` and `modelProvider: null`. The signed SDK
then restores the model, provider and reasoning effort saved with the chat. It skips
that restore when the request names a model or a provider, or carries a
`config.model` or `config.model_reasoning_effort` key, and then runs the configured
default model. The adapter therefore forwards such a resume unchanged. A native
fork never takes its parent's model: it runs the model it names or the configured
default, so a fork that names no model, such as a side chat, is forwarded unchanged
as well.

The adapter adds nothing to a native chat's request. `thread/resume`, `thread/fork`,
`turn/start` and the settings updates reach the SDK exactly as the desktop sent them:
the adapter never adds or changes `model`, `modelProvider`, `config.model` or
`config.model_reasoning_effort`. A fork that names the chat's model without an effort
therefore gets the SDK's own effort, as it does natively. Gateway chats are different:
the SDK cannot restore a gateway alias, so the adapter still restores a gateway chat's
reasoning ([compaction](app-server-compaction.md)), and only gateway chats are written to that
reasoning store. Releases 0.3.9 and 0.4.0 added the
saved effort to the desktop's resume, whose null model is no override, so after every
engine restart a chat on GPT-6.1-Sol came back on the configured default model with
its saved effort. Release 0.4.1 first limited that to requests naming the chat's model
and now removes it, so the `reasoning_restored` event no longer reports `provider: native`.

The signed SDK (0.162.0-alpha.17.2) with a localhost mock upstream confirmed both
rules: the desktop's resume kept GPT-6.1-Sol, and the same resume with an added
effort returned the configured default. A fork that named no model ran the
configured default whether or not it carried an effort. `scripts/e2e-native-model.mjs`
requires the adapter to give every desktop shape the same model and effort as the SDK
gives it directly.

## Compaction and model changes

Moved to [Compaction and model changes](app-server-compaction.md).

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
  upstream window stays;
- `node_repl_disabled`, `node_repl_auto_review_required`, `guardian`,
  `auto_review_model_override`, `requires_sandboxed_review` (data only: no SDK reads
  it) and `model_specialty` ([node_repl](#node_repl-browser-chrome-and-computer-use)).

Everything else keeps the upstream value: service tiers, multi-agent fields, the
window maximum, the auto-compaction limit, input modalities and reasoning levels.
`comp_hash` is never copied. `supports_search_tool` stays off and the adapter keeps
web search disabled, because `tool_search` does not pass through the gateway. A
slug without a native row, and every Claude, Copilot or other row, stays as the
gateway published it, apart from the strictest native node_repl policy and the
native confirmation and classifier texts ([node_repl](#node_repl-browser-chrome-and-computer-use)).
The rows the adapter builds drop `upstream_slug`. At each launch the native-catalog
preflight first writes `desktop-models.json` with the plain gateway rows, marker
included; the adapter replaces that file with the copied rows on its first
successful cache restore or host refresh, and every
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
to spawn code-mode host". Those carried rows keep tool search off, as the Codex 2
rows do, because the gateway does not translate `tool_search`; before 0.4.4 every
such sub-agent request failed with `unsupported_tool`. The native engine keeps its
own catalog unchanged.

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

### node_repl (browser, Chrome and computer use)

Gateway rows get the native node_repl policy, and rows with no native counterpart
always require review. The gateway serves the reviewer `codex-auto-review` through the
Codex subscription for every Auto-review approval in a gateway executor, not only
node_repl; 0.3.9 declined them, and their context now leaves the chat's own provider.
The rules, evidence and fail-closed cases are only in [node_repl on gateway rows](node-repl.md).

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

## Processes and prediction forks on connected machines

Moved to [Processes and prediction forks on connected machines](app-server-forks.md).

## Speed controls

Moved to [Speed controls](speed-controls.md).
