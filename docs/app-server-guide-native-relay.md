---
summary: 'How the desktop adapter decides whether to use the native relay, shares the native engine, trims SDK features and guards native configuration writes.'
read_when:
  - Deciding whether a Mac needs the native relay or its remote control
  - Changing shared native engines, private native-home leases or the desktop fallback
  - Reviewing the refused native configuration writes or the gateway preference file
  - Debugging CODEX_CLI_PATH, the desktop wrapper or a fresh desktop launch
---

# Native relay, remote control and native sharing

Part of the [Codex app-server adapter](app-server.md).

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

## Paused relay recovery

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

## Native catalog discovery

On startup, a bounded native app-server process refreshes its own model metadata.
The adapter copies only public model rows from that engine's configured catalog
or model cache. It validates that the rows are well formed and writes a combined
catalog. Cache identity and authentication are excluded.
The public rows form a combined catalog for gateway executors. The original
native process keeps its native model and account defaults. The adapter registers
only the gateway's own providers (`gatefox` and `subscription_gateway`) through process arguments, so
saved gateway chats can resolve that provider when read or resumed. Gateway
executors get it too, and serve `openai` as a second name for it
([harness identity](harness-identity.md)). It does not
write the native configuration. An unavailable or structurally invalid cache
prevents startup. A cache that lacks models the engine lists starts anyway; this
happens, for example, when another Codex version wrote the cache or the engine
could not refresh its models. Gateway chats get no native metadata for those
models, the adapter writes one line to standard error, and it records
`native_catalog_incomplete`. A gateway alias that equals any model ID the engine
lists is still refused, whether or not the cache has a row for it.

## Settings compatibility

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

## Gateway defaults and native settings

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
Desktop registration is the one exception, and it writes only the gateway's own rows:
`model_providers.gatefox` and `model_providers.subscription_gateway`, so saved gateway chats open in any
engine. See [the provider row](harness-identity.md#the-provider-row-in-native-configuration).
A client edit that saves that row is still refused, as below, because only
registration maintains it.

## Native configuration write protection

A whole request is refused, before anything is written or forwarded, when a
native edit would store gateway identity in native configuration. A key path is
parsed into segments exactly as the Codex engine parses it: dots separate
segments, a segment may open with `"` to carry separators literally, and inside
quotes a `\` escapes the next character. Every rule below reads those segments,
so a quoted spelling such as `model_providers."gatefox".base_url`
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
| `model_provider` or `oss_provider`, at the top level or below a profile, set to `gatefox` or `subscription_gateway`; a `model_providers.gatefox` or `model_providers.subscription_gateway` key, or any key below it, given a value other than `null`; a `model_providers` key whose value holds that provider with a non-null value | Gateway models and the gateway provider cannot be saved into native Codex configuration |
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

The wrapper and the adapter ignore a `CODEX_HOME` that points inside the gateway's
state directory or its `~/.local/state/gw-exec`, `gw-native`, `gw-ssh` and
`gw-runtime` roots. Gateway executors run with such a home, and every command a
gateway chat runs inherits it. When one of those commands started ChatGPT (an agent
restarting the app with `open -a ChatGPT`), the adapter looked for
`models_cache.json` in that internal home and the app failed to start with "The
native model catalog is unavailable". With the guard, an agent-started ChatGPT reads
`~/.codex` exactly as a launch from the Dock does. Any other `CODEX_HOME`, such as the
isolated home of `gateway desktop --native-home`, is kept. The adapter records
`codex_home_ignored` when it drops one (`src/native-home-env.ts`).

## Signed engine launchers

For an `app-server` command, a newly generated wrapper passes the signed
`CodexCLI.app/Contents/MacOS/codex` engine to the adapter. ChatGPT's ordinary
`codex-cli/bin/codex` launcher stays in use for every other command. The shared host
records its verified signed engine separately from the launcher's identity, so both
paths identify the same native writer. Existing
wrappers that still pass the first-party launcher remain compatible: the adapter
resolves that known launcher to the signed engine before it checks ownership. It never
accepts a different executable as the shared writer. This prevents the startup
organization-settings error that a launcher-versus-engine mismatch could surface as.
The [launcher verification checks](native-launcher-verification.md) cover generated
wrappers, both host receipt forms, and startup after a service restart.

## Legacy desktop launch overrides

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

## Native sharing compatibility

The host shares only app engines verified for sharing in
`hostVerifiedAppEngines` (`src/native-engine-versions.ts`). The newest verified
engine is `0.167.0-alpha.3.2`; earlier verified versions remain accepted. The relay
has its own accepted list and does not share the host's engine
([verified app engines](native-remote.md#verified-app-engines)).
If the app's native engine is not in the verified list (for example after an app update),
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

## Private native-home ownership

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

## Host-down fallback

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

## Launch setting admission

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

## Fresh desktop launch

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

## Desktop registration

`gateway desktop register` stores a managed per-user LaunchAgent and sets
`CODEX_CLI_PATH` for future launches. The agent restores it at login and does not
open or quit the app. Registration refuses an unrelated existing CLI override and
clears only a legacy `CODEX_APP_SERVER_FORCE_CLI=1` that an older gateway set.
`gateway desktop unregister` removes its own overrides.
This keeps normal Dock launches configured after initial activation without
editing native configuration.
