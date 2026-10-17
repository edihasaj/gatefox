---
summary: 'Account routing, provider execution, live configuration, and desktop isolation.'
read_when:
  - Changing account routing or configuration reload
  - Changing provider execution or desktop backend isolation
---

# Architecture

The HTTP daemon accepts authenticated OpenAI Responses and Anthropic Messages
requests. Configuration maps each public model alias to one provider, account,
and upstream model, independently of the caller's wire protocol. Messages ingress
compiles into the existing internal request contract; it does not force the
upstream to use the Responses API. Provider adapters retain their Responses,
Anthropic, Chat Completions, or subscription transport. Protocol writers produce
the caller's native JSON or streamed output. Each client executes its file and
command tools; providers receive their results through replay. See
[Messages compatibility](messages.md) for Claude Code setup and protocol limits.

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

An owner is dead when nothing it names can still be running and nothing it
advertised answers a connect. Its processes are gone when its receipt belongs to an
earlier boot, or when every pid it names is gone, belongs to another user, is the
claiming process itself, or belongs to a process that started at another time. Its
sockets are the links its receipt records and every link its host folder holds
(`host.sock`, `native.sock` and each `e-*.sock` generation link), each asked both
through the link and at the SDK socket it names. An answering socket keeps an owner
alive even when its receipt is from an earlier boot, so the two rules always agree.
Only a socket can answer: a plain file, a folder or a pipe at a socket path, or at the
SDK target a link names, never keeps an owner alive.
A receipt this release cannot validate, such as a newer release's or a damaged one,
is judged by whatever pids, stamps and socket path it still contains.

A dead owner never blocks a start. Its claim removes the socket links that are safe
to remove (an SDK link to its own target that nothing answers; a direct socket that
nobody recorded stays), moves the old receipt aside under the folder's `stale/`
directory, and records one `execution_owner_reclaimed` event with the scope and the
reason. Archiving copies a plain receipt and moves anything else, such as a link or
a pipe, aside whole without reading it; `stale/` keeps the five newest receipts of
each name. Receipts written before 0.4.4 carry no boot stamp and are judged by their
file time. A receipt naming the claiming process itself is its own leftover from an
attempt that never finished, so the claim goes on to take the home. A gateway
generation whose record or catalog file is garbled is moved aside to its own `stale/`
folder and rewritten (an `execution_owner_reclaimed` event with the scope
`generation`); a record that names another identity still refuses the generation.
A host that died between creating its control socket at its SDK target and linking it
leaves a socket nothing recorded at that configuration's own target; the next start
removes it when it is a private socket of this user that refuses a connect, and any
other file there still refuses the start as occupied.
Rollback to legacy writers treats a receipt still marked running as stopped once
its owner is proven dead by the same rule, so a crash cannot block it for good. It then
clears that owner's links the way a claim does, including a link the owner recorded
without its socket identity and every link it never recorded that nothing answers, and
when the host and the native-home owner are both proven dead it no longer requires their
native revisions to agree. A sharing-mode change that releases only the native-home
receipt uses the same native rule: a running receipt passes once its owner is proven
gone, with pids judged by their boot and start rather than by the pid alone.

An adapter whose required host is missing, not running, dead, or no longer matches
its socket asks the service for an immediate retry by writing the private file
`kick` in the host folder, and waits up to 20 seconds, looking every 250 ms, for a
running, live host. The service watches that file once a second. A kick only brings a
failed host's next start forward, never within five seconds of the previous start and
never while a start or restart is running; a failure that retrying cannot fix (another
live owner, a changed identity, an invalid engine or receipt) gets one kicked start per
backoff step. A kick to a running host never stops it: the service probes it and
restarts it only when the probe fails and the host is idle (see
[diagnostics](diagnostics.md#service-self-heal)). A host that stays down fails with the
same error as before the wait; a live host that does not match fails at once.

Process start times come from the operating system (`ps`, read in UTC with the C
locale) both for the stamp a process records about itself and for every check, so a
long-running supervisor never drifts away from its own receipt, and a daylight-saving
change cannot move a start by an hour. When `ps` does not answer, a process records no
start at all rather than an estimate: a checker then skips the start comparison and
keeps the owner while its pid answers, and the boot stamp still tells a reboot apart.
Only an answer is remembered, so the next stamp asks `ps` again. Private file locks
follow the same process rule but never the file-time boot rule, because a clock that
steps forward would otherwise free a live lock. A lock has one name however its folder
is spelled (`/tmp` and `/private/tmp`, or a linked folder), so two spellings never
hold it together. Only the caller that created a lock removes it, and only while the
path still names its file; one breaker at a time removes a stale lock.

A native launch that a dead host recorded as `starting` may have left an SDK
child that is still coming up. Its receipt is reclaimed only when it is from an
earlier boot, or when it is older than 60 seconds, and in both cases only when nothing
answers a connect at the native socket or its SDK target. Until then the claim is
refused as unconfirmed, so two writers never share a chat. A native-home receipt that
names no process is given up only when no host folder's native socket (nor any socket
it records) answers, and its file is from an earlier boot or older than ten minutes;
the native SDK always listens while it runs, so ten quiet minutes prove its writer gone. A private, unshared native writer obeys the same
verdict as a claim: a live host (even with its SDK idle), a launch inside its startup
grace, or a receipt nothing can prove dead keeps it from starting.

A desktop adapter whose plan shares native chats falls back to its own native engine
when its host stays down through the wait, so native chats keep working. Discovery
must have failed because there is no host receipt, or because a valid receipt names
no running, live host; a host that does not match, a changed host socket, an
unreadable receipt and every other failure still fail closed. An adapter whose plan
also shares gateway chats falls back the same way when the running host offers no
native sharing (an app engine it could not verify). Either fallback needs the
adapter's native home to be the plan's own: the same folder, spelled the same way.
The host folder is keyed by that spelling, so an adapter that reaches the folder
through a link or another path looked at a host folder the service never runs, and
it is refused with a message saying so. The native-home
verdict must also be clear: a live or unconfirmed owner, or anything answering at the
host's native socket, keeps the adapter out. Before it spawns the engine, the adapter
takes the per-native-home lease under the receipt's own lock. Its receipt names the
host's configuration and native socket path, the adapter as the owner process and a
launch marked `starting`, then the engine's pid once it runs. It also keeps the
engine identity and the whole receipt it replaced. When the engine exits (the adapter
stopping, or the engine leaving by itself), the adapter puts that receipt back with
its file time, set before the atomic rename so no reader sees the restored receipt with
the current time, or removes the file when there was none, so the host and rollback see
the home as they did before the fallback. An adapter that fails to build after taking
the lease spawned nothing and gives the lease straight back. An engine that still runs
when the lease is released keeps the home: the receipt then names only that engine
(`hostPid` 0) until the dead owner rules release it.

The lease allows one fallback engine per native home. A second adapter on the same
home, such as a connected machine's SSH session while the desktop's fallback runs,
fails closed instead of becoming a second writer. When the host is down it reports the
host's own failure; when the host only lacks native sharing it says that another
connection's native engine (naming that adapter's process) already writes the home, and
that native sharing returns once the gateway supports the app's new engine (see
`gateway service status`). A host without native sharing
used to let every adapter run its own engine on the home; correctness wins over that
convenience, so such a second adapter now fails closed until the first one closes or
native sharing returns.
Rollback and `shared-native --disable` treat a live lease like any live native owner:
they refuse (and the disable restores the previous plan) until that adapter's engine
has exited.

While the lease is live, a host that
starts claims everything but the native home: it records `native_sharing_unavailable`
with `reason: native_owner`, serves gateway chats, and refuses native requests
(`native_acquire` with `refused_owner`) until one finds the home free and claims it,
so the next adapter start returns to sharing. A receipt from a dead owner that names
another configuration or another spelling of the native home is not the host's to take
either: the host records `native_sharing_unavailable` with `reason: native_identity`, serves gateway chats, and refuses
each native request (`Native execution ownership changed`, naming the receipt
`~/.local/state/gw-native/<scope>/owner.json` to move aside) until the receipt is moved
aside. A native-only host still fails its start in both cases, as before. A host that
never claimed the home claims it once when it stops, if the home is free by then (a
fallback ended and put back, say, a crashed host's receipt that still says running), so
its stop writes a clean stopped receipt and rollback is not blocked by a stale one. A
fallback adapter that crashes leaves a receipt naming its own
process and its engine; once both are gone, the host (or the next fallback, which
keeps the receipt the crashed one had replaced) reclaims it as a dead owner.

The host pins the binary its gateway generations actually run: the release's own
gateway SDK (`gateway-sdk/gateway-codex`, 0.162.0-alpha.17.2), not the app's
native engine. An app update therefore neither stops the host from starting nor
refuses new generations while the host runs; the runtime's checksum, carried in
every generation descriptor, guards the binary. A host that pinned its runtime
refuses a descriptor without that checksum instead of spawning the app's unchecked
codex. Only a layout without a gateway SDK (or a runtime that cannot be resolved)
pins the app's codex at start, as releases before 0.4.3 did; then that codex must
report the pinned version and stay unchanged while the host runs. Because a
gateway-only host runs the pinned runtime, adapters and rollback do not compare the
app's codex with its receipt: an update that removes, moves or relinks that codex
neither stops the host from starting nor makes adapters reject it. A host that shares
native execution still has to match the app's codex.

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
