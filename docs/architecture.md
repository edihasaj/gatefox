---
summary: 'Account routing, provider execution, live configuration, and desktop isolation.'
read_when:
  - Changing account routing or configuration reload
  - Changing provider execution or desktop backend isolation
---

# Architecture

The HTTP daemon accepts authenticated OpenAI Responses requests. Configuration
maps each public model alias to one provider, account, and upstream model.
Provider adapters own authentication and inference. The Responses translator
owns request compilation, replay, and streamed output. Codex executes file and
command tools; providers receive their results through replay.

The gateway does not assign agent jobs, select worker models, inject task
instructions, or execute caller tools. The client owns orchestration, permissions,
chat naming, and conversation lifecycle. The desktop adapter forwards those client
operations and isolates account configuration; its session ownership machinery
prevents competing writers rather than deciding what work an agent performs.
Added gateway model rows ignore task prompt text from older hosts and offline
caches. The original native model catalog and explicit client instructions remain
unchanged.

An inference keeps the configuration snapshot with which it began. New requests
load atomically replaced configuration. Invalid configuration fails closed until
repaired. Existing aliases cannot change account, provider, credential source, or
upstream model live. Add another alias or restart after active work finishes.
Retiring an alias does not release its identity until the daemon restarts.
Labels and capability metadata can update live. Listener and state-directory
changes require a restart.

A macOS user LaunchAgent keeps the daemon alive across app and terminal exits.
Its environment contains PATH, not provider credentials. Credentials and gateway
client tokens are private files. Logs exclude request bodies, tool arguments,
provider tokens, and environment values.

Existing installations can consolidate their gateway jobs into one supervised
LaunchAgent. See [service ownership and migration](services.md). Migration is
explicit and requires a maintenance window; release installation preserves
running chats.

`gateway service restart` asks the daemon to stop only while idle. The daemon
checks all HTTP requests, including unfinished body uploads, before closing its
listener. Active work refuses the restart and keeps its process. Older daemons
without this capability refuse the command; upgrade those during an idle window.
Explicit stop or uninstall still stops the service and cancels active work.

## Desktop connections

The stdio adapter keeps one original native app-server connection. Account
requests and native chats use that connection. Gateway chats use separate
executors with private configuration homes. The adapter reads effective native
settings for a private snapshot, excludes native provider authentication settings,
and never copies the primary auth file. Automatic project-trust writes therefore
land in the gateway executor's private configuration.

Before creating a gateway executor, the adapter rereads client settings. Native
agent limits and user-authored roles pass through unchanged. The gateway does not
generate agent profiles or replace the user's default worker or reasoning effort.
Existing work keeps its loaded settings until its session reloads.

Executors share native chat storage and SQLite metadata so saved gateway chats
remain discoverable through the desktop's normal thread list. User instructions,
skills, and plugins keep one source through links. The global AGENTS.md link
also follows a file created after an executor starts. Native configuration is never
linked. All model preferences are saved in gateway-owned state.

The adapter fetches authenticated public model metadata from the inference host.
A catalog change creates a fresh gateway executor for new chats. Loaded chats
retain their original executor, including active turns and terminal state.
At most four catalog generations can retain loaded gateway chats. Close an older
gateway chat before adding another generation at that limit. Idle generations
without loaded chats are stopped. A gateway executor failure does not stop the
native connection; saved gateway history can be resumed.

Gateway-owned compaction metadata contains only current-window counters and SDK
compaction lifecycle events, scoped to the native storage home. Recovery uses
the loaded executor's frozen model limits and the next explicit user request.
It preserves active steering, goals, native account ownership, and original
rollouts. See [compaction and model changes](app-server-compaction.md)
for completion, cancellation, and shared-ownership limits.

Each adapter keeps a separate private cache of public gateway model rows.
Startup validates its source against the local port and client-token hash, then
restores those names even if the inference host is offline. Cache files contain
no native cache identity, provider authentication, or token values. Discovery
can retain cached names; gateway work requires a successful fresh fetch and
returns application error `-32001` during an outage. Successful discovery
atomically updates the cache. Recovery needs no app restart.

The unified service can own shared gateway executors. This is an explicit
maintenance migration described in [services](services.md). Each catalog and
execution-settings generation gets one signed Codex app-server with a private
Unix socket. Desktop and connected-machine adapters attach as independent
clients to that process. Closing an adapter closes its connection and leaves
the executor running. Reopening a loaded chat finds its owning generation before
starting another executor.

Shared generation homes use the native home's writer-lock directory as well as
its rollout storage. An unrelated writer therefore remains protected even across
catalog generations. The execution host retains at most four generations and only
retires an engine with no client leases and no SDK-loaded chats. A missing or
changed managed owner fails closed. It never deletes live locks or takes over an
old executor. Existing per-connection executors must finish before migration.

The execution host belongs to the unified service and owns its SDK children. There
is no separate per-generation LaunchAgent. The native account connection and
provider credentials keep their current ownership.

Native ownership can also be shared independently of gateway generations. Its
one original signed SDK keeps the original native home and normal authentication;
private gateway homes never receive that authentication. A per-native-home lease
prevents two managed configurations from creating separate native owners. Adapter
disconnection releases its client, not the SDK. Compatible process arguments,
actual signed executable identity, private socket identity, and exact launch death
records govern reconnect and recovery. See [native migration](services.md#shared-native-session-ownership)
for maintenance requirements and the SDK's Unix capability limits.

Desktop SSH uses a private Unix socket carrying WebSocket JSON-RPC. The socket
adapter reuses the same session router as stdio and bounds frames to 16 MiB,
pending requests to 256 per connection, and simultaneous clients to eight.
Without shared execution, disconnect stops that connection's executors. With
shared execution enabled, disconnect closes only the SDK client connection.
Other clients keep their sessions in both modes.
The transport uses the MIT-licensed `ws` package, bundled in the installer.
