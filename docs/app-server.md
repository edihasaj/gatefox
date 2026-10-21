---
summary: 'Experimental Codex desktop adapter: additive model catalog and per-chat routing.'
read_when:
  - Connecting the gateway to the Codex desktop app
  - Changing app-server routing, model selection, or configuration writes
---

# Codex app-server adapter

The experimental adapter keeps the original Codex executable and native login.
It adds configured gateway models after the native models and routes every chat by its
kind, not by its provider id. The adapter classifies a chat with the first rule that
answers, in this order: the legacy provider id `subscription_gateway`; the registry of
gateway chats; a gateway ancestor of a sub-agent, read from its saved record when this
connection has not seen it; and a model alias that is not a native model slug. Any other chat is native and keeps its provider. The registry is the file
`<state directory>/gateway-chats/<scope>.json`, where `<scope>` identifies the native
Codex home. The adapter writes a gateway chat's start or fork to the registry before it
returns the reply, a sub-agent that a gateway engine announces before it forwards
the announcement, and a chat that only its ancestors or alias identified when it routes
it to an executor. New gateway chats are recorded as `subscription_gateway` by default; a
Mac whose native relay is verified can opt in to `"chatIdentity": "openai"` (0.4.7), so a
stock engine lists them too. Existing chats keep the id they were saved with. A chat list
that asks only for the native default provider also gets the `subscription_gateway`
chats, which is how the phone sees them through the relay. See
[harness identity](harness-identity.md) for when to opt in, the executor contract, the
phone and rollback. A gateway model
alias that equals a native model slug is refused when the catalog loads, because the
native slug would otherwise take over the alias's chats.

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
WebSocket protocol used by desktop SSH connections. A listener started with
`--ssh`, which gives it a gateway control home, retires itself once a newer
release is installed and it holds no session; the next connection then starts
it on the installed release. A listener started with a custom
`--listen unix://PATH`, which has no control home, keeps its previous
behavior: it does not exit on its own after an install. The adapter gives each
connection its own native connection. Gateway executors are shared when the
unified service has shared execution enabled; legacy installations keep
per-connection executors.
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
socket is recovered only when its private ownership record matches. A bootstrap
that finds a swap cut off halfway by a crash (the record names a new listener that
never took over the address) restores the previous record and continues, so a
crash never leaves SSH refused. Under the same lock it removes dead private
`.gw-*` sockets and links and stale lease temp files, only in the managed
`gw-ssh` folder or during a replacement, never for a custom `--listen` path.
Add the host under Settings, Connections, SSH, then select its workspace.
The built-in Control other devices connection reaches the native engine directly
and bypasses a desktop or SSH wrapper. The separate
[native transport adapter](native-remote.md) reuses the machine's original
registration and routes that connection through the same gateway router. Its
rendered checks are still in progress on the test Mac.

## The native relay is optional

Nothing in the gateway depends on the native relay. Unless a live relay is really
being used, ChatGPT keeps its own remote control, so a machine without a working
relay still works, and a relay that cannot run is set aside quietly instead of
restarted forever.

An adapter, or an SSH listener, asks once when it starts whether a relay is
usable: it must be registered for this configuration and native home (its
`<state>/native-registration.json` must say `registered: true`), its `status.json`
must say `connected`, and its private control socket must answer
within one second. When any of that fails the engine is started without
`CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED` and keeps its own remote
control, and `remoteControl/*` is no longer intercepted. The answer is not asked
again while the process runs, so a relay that connects later is used from the
next app start or the next listener start, not from the current one. Gateway
executors are separate: they run headless on the gateway's own SDK, so
`gatewayEnvironment` always sets that variable and they never try remote control.
A shared native execution host is asked the same question once, when it starts: only a
registered relay whose slot the service is really running (not holding paused) owns the
machine's remote control. A relay that becomes live later takes effect at the next host
start, which an idle restart gives. A relay that is set aside after the host took the
registration for it gets the reverse: the service restarts only the host, once it is
idle, so the app keeps its own remote control.

The unified service keeps the same rule for its `native` component. Before it
spawns the relay it reads `<state>/native-registration.json`, and a slot whose
relay was never registered, or was uninstalled, is left `paused` with reason
`not_registered` and is never started. A relay with three non-zero exits in a row,
each within 60 s of its start, is left `paused` with reason `failing`; a relay killed
by a signal and one whose binary is missing count as such exits, and one whose log
cannot be opened is set aside at once, so a relay that cannot start at all is set aside
rather than retried once a minute forever.
A paused slot writes no log lines and reports no exits, and `gateway service
status` shows `paused` with its reason instead of a process id; because no
relay process is running, `gateway versions` does not list one either. Every five
minutes the service looks at the paused relay once and starts it again when
these hold:

| Condition to start a paused relay again | Where it comes from |
| --- | --- |
| The registration says the relay is registered | `<state>/native-registration.json` |
| Something a restart would use has changed | `dev:inode:size:mtime` of the app's `codex` executable, the relay binary and that registration file; a relay paused for `not_registered` only needs the registration to exist |
| No ChatGPT app is open | a `ps -axo comm=` line for `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`, the same check native installation makes, so a newly connected relay never competes with an app's own remote control |
| The same relay has been set aside for half an hour | the time it was paused, so a relay that failed once during a busy start-up is started again on its own, and a relay that fails again within a minute of a resume is set aside at once instead of being given a fresh three-strike budget. Two such starts an hour is all a broken relay ever costs. A resumed relay that runs past its first minute gets three strikes again |

A re-check whose questions cannot all be answered leaves the rest of the service
untouched. A process list that does not come counts as an open app, so the slot stays
paused with no new event; only a probe that throws sets it paused again as `failing`,
with one `component_paused`.

Consolidation and the two shared-service migrations treat a paused relay as ready: it
is a `components_not_running` gap only for components that are neither running nor a
paused relay, and they wait for a relay to connect only on a machine whose registration
says one is set up and whose relay slot is running. A native migration additionally
only waits for the machine's own relay to reconnect when that relay was connected
before the migration.

On startup, a bounded native app-server process refreshes its own model metadata.
The adapter copies only public model rows from that engine's configured catalog
or model cache. It validates that the rows cover the engine's available models
and writes a combined catalog. Cache identity and authentication are excluded.
The public rows form a combined catalog for gateway executors. The original
native process keeps its native model and account defaults. The adapter registers
only the added `subscription_gateway` provider through process arguments, so
saved gateway chats can resolve that provider when read or resumed. Gateway
executors get it too, and serve `openai` as a second name for it
([harness identity](harness-identity.md)). It does not
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
| A `model_catalog_json` key, at the top level or anywhere inside a value, set to the gateway's catalog file or to anything inside the gateway state directory. Files and folders that exist are compared by identity, by device and inode, so a symlink, a firmlink such as `/System/Volumes/Data/private/var/...`, or another letter case of the same name on a case-insensitive volume is refused like the path written out directly; a file or folder that does not exist yet is judged by the identity of its existing ancestor folders as well as by its spellings, the lexical and the resolved one. A path longer than 4096 bytes, the longest any platform accepts and the same cutoff on every platform, is compared by its spelling only, without touching the file system; a single value of about 512 KiB or more (the exact length depends on how many spellings the native home has: 1 MiB divided by that number) is refused outright, because its size charge alone could not fit the budget below. One request may spend at most 16384 units of work on the paths its edits name. A unit is one folder passed while walking a path, whether or not its answer is already remembered; one file-system read (`stat`, `lstat` or `readlink`); or a size charge on every path value judged, of 1 for each full 64 characters of its text, paid each time the value is tried against a base (the native home has up to two spellings) before any of it is resolved. A short name has no size charge, but the first time the guard meets a value it also pays 1 unit per base, and it remembers the answer for that exact value (up to 4096 values): a repeat of a short value costs nothing more, while different short values such as `0/../a`, `1/../a` and so on spend the budget two units apiece. Each time a value is tried against a base also counts as one judgment, and one request may make at most 65,536 of them, remembered answers included; 20,000 profiles judged against two spellings of the native home make 40,000. The size charge is paid for a repeated path too, and for a path whose first folder does not exist, so the string work of a long path is bounded as well as its reads: no more than a few hundred paths of 4000 bytes, distinct or repeated, fit in one request. Links are followed one folder at a time and each step is charged; the resolver gives up after 40 links, and the operating system stops sooner (32 on macOS, 40 on Linux). A folder shared by several paths is read once, but a deep path still costs a unit for every folder each time it is walked. A request that spends the budget is refused whole with "This configuration write names too many different paths to check" instead of being checked by spelling alone, and so is a request past the judgment cap; a single value too long to ever fit is refused with "This configuration write names a path too long to check". A real batch stays far below this limit: one or two catalog paths of ten folders cost under 150 units, 50 edits about 15 folders deep cost about 3400, and 50 edits 33 folders deep about 6200. Every spelling the engine reads is tried: a `~` on its own or `~/rest` is the home directory, and any other relative path is read below the native home in both its lexical and its resolved spelling, never below the directory of the request's `filePath`. With the native home at `~/.codex` and the state directory at `~/.codex/state`, that makes `state/codex-models.json`, `~/.codex/state/codex-models.json` and `../.codex/state/codex-models.json` all the gateway's catalog; `../state/codex-models.json` reaches it only where the state directory sits beside the native home. A name the engine does not expand, such as `~rest`, stays one of the caller's own files and is forwarded | The gateway catalog cannot be saved into native Codex configuration |
| On Windows, where the guard cannot read a path, a `model_catalog_json` key whose value is any string, at the top level or anywhere inside a value; clearing the key with `null` is still forwarded | A catalog file path cannot be saved into native Codex configuration on Windows, where the gateway cannot check which file it names |
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

The host shares only the app engine this release verified for sharing,
`0.162.0-alpha.17.2`. The native relay also accepts `0.163.0-alpha.10.2`, because it
never needs the host's engine ([verified app engines](native-remote.md#verified-app-engines)).
If the app's native engine is not the verified one (for example after an app update),
the host starts without native sharing and keeps offering gateway chats;
it records `native_sharing_unavailable` with a fixed `reason` (`sdk_version`,
`sdk_signature` or `other`). When the plan also shares gateway chats, the desktop
adapter then falls back to its own native engine and records `native_sharing_fallback`
with `reason: other` and `holders`, how many private engines hold the native home once
its lease is taken. Gateway chats keep using the host. The relay cannot use the host's
engine either, but a registered relay that is live keeps remote control available while
the fallback lasts: each phone stream runs the gateway router, whose adapter runs a
private native engine of its own on the same home, and the SDK refuses a second writer
for a chat another engine holds
([relay sessions](native-remote.md#relay-sessions-and-native-chats)). The fallback lasts
until a release verifies the app's engine. It runs under a private native-home lease,
like the host-down fallback below.

Private leases share the native home with each other and never with the host's writer.
The Mac's own ChatGPT app and a connected machine's SSH session therefore each run
their own engine on the same home, as stock Codex runs one app-server for the app and
another for an SSH remote. A chat open in both at once carries the same risk it carries
in stock Codex; the gateway adds no per-chat lock, and its own per-chat records (the
chat registry and the speed, reasoning and compaction stores) are merged under a file
lock and replaced atomically, so two adapters never lose each other's entries.

| On one native home | Together? |
| --- | --- |
| Private engines of this release (any number) | Yes |
| A private engine and the host's shared native writer | No: a host that regains native sharing claims the home only after every private engine has exited, and a private engine never starts while the host's writer runs |
| A private engine of this release and one that release 0.4.5 or earlier started | No: the older engine keeps the home to itself, and a new adapter fails closed naming its process, until that connection moves to this release (an idle adapter does after an install) |

Each private engine keeps a receipt of its own beside the native-home receipt, and
`owner.json` names them for older releases while any is live; the rules are in
[architecture](architecture.md#desktop-connections).

If the host stays down through the adapter's 20-second wait, the desktop adapter
also falls back to its own native engine, so native chats keep working. It does so
only when nothing still owns the native home: no live or starting native engine,
and nothing answering at the host's native socket. Before it starts the engine, it
takes a private native-home lease, and it holds that lease until the engine exits. A
host that comes back meanwhile therefore finds a live owner: it keeps serving gateway
chats, refuses native ownership, and claims the native home at the first native
request after every fallback has ended, so the next adapter start returns to sharing.
The adapter records `native_sharing_fallback` with `reason: host_unavailable`. An
adapter that starts while the host refuses native ownership that way, such as an SSH
session after a reboot where the app's adapter started first, does not fail: it joins
the private engines with one of its own and records `native_sharing_fallback` with
`reason: native_owner`. It only joins: when no private engine is left by then, it asks
the host once more and shares the host's engine, and a second refusal fails the
connection. Chats its engine verifies as native never wait for the host;
gateway chats still need the host and fail closed until it returns. A host that does
not match the adapter, a changed host socket, an unreadable host receipt, a live host
writer or a private engine of release 0.4.5 or earlier still fails the connection.
Several adapters may each
run such a fallback engine on one native home, by the sharing rule above, and the
remote-control rules for a private engine apply to each. The lease rules are in
[architecture](architecture.md#desktop-connections).

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

### The login environment agent

ChatGPT is a login item and can start before the unified service has set
`CODEX_CLI_PATH`. When that happens the app launches its own bundled engine and
runs without the gateway until it is restarted; this was seen on a Mac that
rebooted after a power outage.

**With the unified service (0.4.8 and later)** the gateway has one background item,
`harness-gateway`, and no separate agent. The service daemon closes the race itself:
its very first step, before consolidation, any wait, the network or any child, is
`/bin/launchctl setenv CODEX_CLI_PATH <registered wrapper>`. It runs only when
`desktop-registration.json` names this gateway's own wrapper (the same ownership proof
registration uses), the wrapper is executable, the release runtime exists, and the
login session holds no value or one of the gateway's own wrappers. A foreign override is
never replaced. A failure never stops the daemon: it records one
`desktop_env_preset_failed` event with a fixed `reason` (`read` or `setenv`, see
[diagnostics](diagnostics.md)), never a value or a path. The `desktop-restore` child that
runs at every service start no longer writes the agent; it removes a managed one that
0.4.7 left, so a 0.4.7 Mac loses the `harness-gateway-login-env` item at its first 0.4.8
start. A plist at that label without the gateway's marker is left alone and reported as
`unmanaged`.

**Standalone registration (no unified service and no pending login plan)** keeps the
agent described below. To close the race there, registration also writes a
small LaunchAgent, `com.edihasaj.subscription-gateway.desktop-env`. It runs one
command at login and exits. macOS names a background item after the program a
LaunchAgent runs, so the agent does not run `launchctl` directly (Login Items would
list "launchctl"). Its only program argument is a private script in the gateway
state directory, `harness-gateway-login-env`, which Login Items lists by that name:

```text
#!/bin/sh
# Managed by subscription-gateway desktop-env
exec /bin/launchctl setenv CODEX_CLI_PATH '<state>/desktop-wrapper-<hash>'
```

It has `RunAtLoad`, no `KeepAlive`, `LimitLoadToSessionType` `Aqua`, no node and no
other environment. The script names the stable registered wrapper in the gateway state
directory, never a release path, and registration refuses any other path; the wrapper
is single-quoted for the shell. The script (mode 700) and the plist (mode 600) are
private and written atomically, the script first, and the agent is bootstrapped into
`gui/<uid>` when written. An agent written by 0.4.5 or earlier ran `launchctl`
directly; registering again replaces it with the script form. A script at that
path without the gateway's marker is refused, like an unmanaged plist.
A standalone `gateway desktop register` writes or updates it, so it follows the
registration. A plist with that label that does not carry the gateway's marker is
refused, and nothing is changed (on the unified service path it is only reported).

Where the unified service owns the variable (the desktop component's `desktop-restore`,
or a registration while a unified or staged plan owns it) no agent is written, and
registration returns `envAgent: false` and `loginEnv: "service"`, plus `envAgentRemoved:
true` when it removed a 0.4.7 agent. A failure to remove the agent or an unmanaged plist at
its label is caught: registration keeps going, and the service records a
`desktop_env_agent_failed` event with a fixed `reason` (`other` or `unmanaged`, see
[diagnostics](diagnostics.md)), never the error text or a path. The next start tries
again. A hand-run `gateway desktop register` on such a Mac takes the same path and records
the event under the component `service`. Only on a Mac without a unified plan does a
hand-run `gateway desktop register` write the agent, fail loudly when it cannot, and
record no event.

The script sets nothing unless the gateway can still run: before the `launchctl setenv` it
checks that the registered wrapper is executable and that the installed release's
`package/dist/cli.js` exists, and otherwise exits 0. A login after the gateway was
uninstalled, or unregistered by an older release, therefore does not set the variable again.

Rolling back to 0.4.5 or earlier: those releases do not know this agent, so their
`gateway desktop unregister` and `gateway uninstall` leave its plist and script behind. Before
running either, remove them: `launchctl bootout gui/$UID/com.edihasaj.subscription-gateway.desktop-env`,
then move `~/Library/LaunchAgents/com.edihasaj.subscription-gateway.desktop-env.plist` and
`<state>/harness-gateway-login-env` to the Trash. Even if you do not, the guard above stops
the script from setting the variable once the release is gone.

`gateway desktop unregister` and `gateway uninstall` boot the agent out and move its
script and plist to the Trash (the script only when it carries the gateway's marker),
before they clear the variable. The agent is not a service
component: consolidation does not collect or retire it.

`gateway desktop status` reads `CODEX_CLI_PATH` from the login (GUI) domain: it
parses only that key from the `environment` block of `launchctl print gui/<uid>`,
and falls back to `launchctl getenv` only when the print fails. `launchctl getenv`
over SSH reads a different domain and reported `activeForFutureLaunches: false`
even when the login session held the right value. Status also reports
`envAgent: true` when the agent exists, is the gateway's, and its script sets the
registered wrapper. `loginEnv` says who sets the variable at login: `"service"` when a
unified service (or its pending login plan) exists, `"agent"` when the standalone agent
is in place, otherwise `"none"`. `forceCliSet` and `legacyForceCli` come from the same block: status keeps
only whether `CODEX_APP_SERVER_FORCE_CLI` is present and non-empty (and whether it is
`1`), never its value, and uses `launchctl getenv` for both variables only when the
print fails.

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
Goal creation, reads, updates, notifications, and clearing were tested.
`scripts/e2e-goal-switch.mjs` checks automatic goal continuation with real inference in an
isolated native home: an active goal whose chat switches gateway model mid-goal with
`thread/settings/update`, as the picker does, must start its next turn by itself and send
that turn's requests on the new model. Every rendered control remains a separate desktop check.

## Re-attaching a gateway chat

A gateway chat runs on an executor that can go away under a loaded chat: the shared host
restarts (a service upgrade or restart), a private executor exits, or the host drops this
adapter's connection. Since 0.4.7 the chat's next request does not fail for that. The
adapter first loads the chat again: it finds the host again (a kick and up to 20 seconds
of waiting, taken once however many chats wait), takes the generation that still owns the
chat or the current one, and sends `thread/resume` the way a desktop resume does, then the
request itself. The resume carries only what the SDK cannot restore from the chat's own
history (config, instructions, personality and the speed tier), always with
`excludeTurns: true`, and never a model, provider id, approval policy, approvals reviewer,
permissions, folder or workspace roots: the SDK applies the latest values saved with the
chat to a resume that omits them (an explicit folder wins over the saved one, and explicit
roots skip their restore), so a chat that tightened its approvals, changed its model and
effort or moved to another folder after loading keeps those changes through a re-attach. A chat this connection
did not load, such as a sub-agent, one it has forgotten, or one whose parameters it
evicted (a connection keeps the most recent 512), is resumed with its saved settings
alone; the replayed `config` drops the keys that would block that restore.

- One re-attach per chat at a time: requests that arrive meanwhile wait on the flight
  claimed before anything is awaited, so the chat is resumed once.
- Nothing of a turn that died with the executor is sent again. Stopping or steering that
  turn afterwards gets the executor's own answer.
- The host's owner and generation rules still decide, so a chat never gets a second
  writer: a live generation that owns the chat serves it again.
- `thread/unsubscribe` asks nothing of an executor: on a closed engine the adapter clears
  the chat's records and answers `notLoaded` itself instead of waking the host.
  `thread/delete` and `thread/archive` still re-attach first, because the SDK must load
  the chat to unload or remove it. An unsubscribe that arrives while that chat's re-attach
  is running waits for it and then unloads the chat on the executor it landed on, so the
  re-attach never undoes it.
- A host that stays down fails fast: after one failed lookup, attempts on that connection
  for the next 5 seconds get the old error at once instead of kicking and waiting through
  the host again, and one such window records at most one failure. Only a failed host
  lookup opens the window; a refusal from the gateway itself (the catalog, the generation
  limit, a changed provider) or from the resume is the chat's own failure and opens none.
  The window ends as soon as any host lookup on the connection finds the host alive.
- A throwaway chat (a composer prediction) lived only in the executor that is gone and
  is not re-attached, and a host that stays down past the wait, an executor that refuses
  the resume, or a shutdown that has begun gives the error from before: "The gateway
  executor connection was lost; resume this chat to reconnect to its saved or running
  session." (code -32001), or for a private executor "The gateway executor exited; …".
- Native chats are unchanged: when the native engine goes away, the app reconnects.
- A host that runs another release's gateway SDK (an app and a service that moved to a
  new release at different times) refuses the generation with a fixed message that the
  adapter shows for the request, in place of the generic failure above. When this app is
  the newer one: "This Mac's gateway service is moving to the newer release; this chat
  continues as soon as no turn is running". Otherwise: "This app and this Mac's gateway
  service run different gateway releases; quit and reopen ChatGPT to load the installed
  release". The request that triggered a re-attach gets it too, and it is the chat's own
  failure, not a lost host, so it opens no fail-fast window. The service moves promptly
  when the adapter is the newer one, see
  [release skew](services.md#release-skew-a-newer-adapter-beside-an-older-host).

Each re-attach is logged as `executor_reattached` or `executor_reattach_failed`
([diagnostics](diagnostics.md)).

### A listener that outlives its release

An adapter can stay open after the installer prunes the release directory it
started from. When its complete original `package` directory is gone, it may load
the SDK from the managed installation's `current` release and continue saved chats
without reconnecting. That replacement is accepted only when the installation
marker, `current` link, selected release marker, package version, SDK receipt,
component hashes, capability and pinned SDK source all verify. The link must select
a direct, user-owned release beneath that installation; a checkout, escaped link,
partial old package, or present package whose SDK is missing or invalid never falls
back.

The connection keeps the provider it selected for new chats. A legacy
`subscription_gateway` connection can use a newly verified SDK without changing its
identity. A connection that selected `openai` continues only when the replacement
proves the gateway executor capability; it never resumes gateway history on a stock
executor.

An already-loaded executor retains the catalog it loaded. Changing a catalog file
cannot alter that generation, and a live owner continues serving its loaded chats.
After an update, let the shared service adopt the release when it is quiet; do not
force-kill it. To move one affected chat sooner, unsubscribe it from every frontend,
wait for its `thread/closed` event (or for the host to report no owner), then resume
it through an adapter on the fixed release. A resume before the old owner unloads
returns to that owner.

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

### Gateway sub-agents on native rows

A gateway executor can spawn a Codex 2 or Claude sub-agent whose saved model is a
native catalog slug such as `gpt-6.1-sol`. That child remains a gateway chat: its
saved provider stays `subscription_gateway` or (on an opted-in Mac) `openai`, and
the adapter routes reads, history, interrupts, turns and resumes to the executor
that owns it. A resume with no model or reasoning override lets the SDK restore
its saved state. The child's web search settings are forwarded as the caller saved them,
as on gateway aliases: the adapter no longer forces `web_search` off, because the Codex
route forwards the hosted tool and every other route drops it.
If an explicit model/provider or a `config.model` or
`config.model_reasoning_effort` key opens the SDK's restore gate without selecting a
different child, the adapter repeats the child's saved native model and provider.
It recovers an unspecified effort only from the child's saved reasoning record,
rollout, or thread metadata; it never invents a launch default or replaces a
caller-supplied effort. A conflicting model or provider is refused.

This is deliberately not a general native-to-gateway model switch. The adapter
allows it only when the backend's saved child metadata records a parent, returns the
requested thread id, classifies as a gateway child in this adapter, and its actual
current model equals the requested native slug. The frozen executor applies this same
check to `config.model`. Another native model, an unknown alias, a mismatched rollout
record, or a parent-shaped native child is still refused.

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
`comp_hash` is never copied. `supports_search_tool` is on for a Codex 2 row only when
its provider bridges tool search (`"toolSearch": "bridge"`) and the native row has it on.
Otherwise it stays off: the ChatGPT backend refuses a `tool_search` tool that the gateway
forwards, so without the bridge the gateway drops it on that route
([details](responses.md#tool-search-on-the-codex-subscription-route)). The hosted
`web_search` tool is a separate setting and is on there: the adapter copies the native row's
`web_search_tool_type`, so a Codex 2 chat sends that tool exactly as native Codex does and the
Codex route forwards it. A slug without a native row, and every Claude, Copilot or other row,
loses the field -- those routes cannot run hosted search and the gateway drops the tool
([details](responses.md#hosted-web-search)). Every row otherwise stays as the
gateway published it (tool search off unless bridged), apart from the strictest native node_repl policy and the
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
beside its own executable. The gateway SDK package ships that companion and records
its digest in the build receipt as `codeModeHostSha256`; the execution host enables
Code Mode only after that verified receipt. A host file the receipt does not name,
or one whose bytes differ from it, fails the whole SDK's verification, as any other
changed component does. When the installed package has a gateway SDK whose
receipt names no host (a package built before the companion shipped), the adapter
keeps the gateway's `direct` tool mode and still
copies the other fields. Without a gateway SDK, executors run the desktop's own
Codex and take the native code mode. The same rule covers the native rows that the
executor catalog carries for sub-agents naming a model directly (a role's model,
`default_subagent_model` or Ultra delegation): without the host those rows get
`direct` tools in executors, so their commands run instead of failing with "failed
to spawn code-mode host". Those carried rows have the search flag off, as the Codex 2
rows do: a bare model name resolves to the Codex subscription route, which drops
`tool_search` because the ChatGPT backend refuses it. No provider can take that name first, because a gateway
model alias spelled exactly like a native slug is refused whenever the adapter loads the
gateway catalog, at launch and at each refresh, against the native slugs it read at launch;
a native model that appears later is checked at the next launch. (Before 0.4.4 every such sub-agent request failed with
`unsupported_tool`.) The native engine keeps its own catalog unchanged.

The executable selected for each new executor generation decides whether Code Mode
is available; the adapter does not reuse that decision from the package that opened
the desktop connection. A recovered SDK without the companion host gives every
gateway and carried native row an explicit `tool_mode: "direct"`, including rows
whose native metadata omitted or named an unknown mode. Direct mode overrides Code
Mode feature flags. It preserves node_repl, permissions, review and instructions,
and never changes the native engine's catalog.

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
With gateway SDK capability `gateway-executor-v3`, a failed gateway turn also
pauses automatic queue dispatch. This applies to every provider routed through
that executor, including Claude, Codex, Copilot, and ordinary API models. Queued
messages keep their IDs, contents, and order in the native database. Adding or
editing a queued message, another connection writing to the queue, or resuming
the chat after a restart does not release the pause.

An explicit new turn can continue the failed work from saved history. After it
succeeds, queued messages run in their existing order. An explicit
`thread/queue/start` can instead start the selected queued message. The failed
turn remains a real failure; the gateway does not fabricate an interruption,
retry a subscription limit, or choose another account or model. Unmarked native
Codex engines keep their own queue behavior. Clients outside this executor,
such as Claude Code or Claude Desktop, own their own queues.

The automatic queue start checks the pause while reserving an idle turn, so a
concurrent failure cannot slip past a prior queue inspection. Older SDK artifacts
retain their previous behavior; the release must build the v3 SDK before this
protection is available.

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
