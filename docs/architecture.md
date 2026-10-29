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

For fixed aliases, the gateway does not assign agent jobs, select worker models,
inject task instructions, or execute caller tools. Explicitly configured
[managed worker aliases](managed-routing.md) opt into code-enforced provider
selection, context budgets and durable provider affinity before inference. They
do not inspect task prose to invent capability requirements. The client owns orchestration, permissions,
chat naming, and conversation lifecycle. The desktop adapter forwards those client
operations and isolates account configuration; its session ownership machinery
prevents competing writers rather than deciding what work an agent performs.
Added gateway model rows ignore task prompt text from older hosts and offline
caches. The original native model catalog and explicit client instructions remain
unchanged.

### Provider admission

Each provider has an independent FIFO admission queue with a fixed waiting capacity
of 32. Its running limit is `provider.maxConcurrent`, or the gateway-wide
`maxConcurrent` when the provider does not set one, or 4 by default. A busy Codex
provider therefore cannot delay a Claude or API-provider request. The reviewer route
uses the queue of the provider that serves its route. The pre-body flood guard allows
the larger of the gateway-wide limit and the sum of the configured provider limits,
plus 32 requests, so a lower provider override does not reduce the previous capacity.
`/health` reports the running and queued totals
across all provider queues.

Both admission settings accept integers from 1 through 64. A local inference
provider can opt into [upstream capacity discovery](upstream-capacity.md) once
instead of maintaining a numeric worker count on every Gateway. Its explicit
numeric override remains a ceiling; missing or stale discovery uses the static
fallback. Other providers keep their existing limits. This is per-Gateway
admission, not a shared reservation or measurement of farm load. Availability
reports the effective local limit; an otherwise available provider becomes busy
when it is reached or work is queued.

On a live configuration reload, existing queues keep their in-flight work, changed
limits take effect immediately, and new providers receive new queues. A removed
provider's queue remains until it is idle and no live request snapshot refers to it,
so requests accepted before the reload can finish and a later re-add reuses that
queue. Compatible hot-swapped handlers share the listener's admission queues;
retired generations keep their accepted requests and release their snapshots
once they finish. Discovered admission waits for an older incompatible
generation to drain before increasing capacity.

### Live configuration

Bare subagent model names can use an explicit account default. Set
`"defaultForBareModels": true` on one `codex-subscription` provider and/or one
`claude-subscription` provider. The default serves only models it offers; failure
or a missing model never selects another account. Explicit configured aliases
always retain precedence. Without a default, a bare name requires exactly one
matching subscription account; duplicate aliases within that account resolve
deterministically. The unnamed automatic reviewer uses the designated Codex
account too, and its catalog advertisement and request route use the same rule.
This setting does not infer the parent chat's account or select an agent model.
Changes apply to later requests, while in-flight requests keep their original
configuration and account.

An inference keeps the configuration snapshot with which it began. New requests
load atomically replaced configuration. A change that cannot be applied live is
refused, not served as an error: the last good configuration keeps serving and the
refusal is recorded once per file version as `config_rejected` with a fixed
`reason`, never a path, value or error text (see [diagnostics](diagnostics.md)).
That covers an invalid or unreadable file (`invalid`, `unreadable`), a changed
listener port, mode or state directory (`restart_required`), and an existing alias
that would change account, provider, credential source, base URL, the `tailnet` setting or upstream model
(`rebind`). The change takes effect only after the daemon restarts; to apply it
live, add another alias instead. The next file that is valid and allowed is adopted
at once and clears the refusal, and so does putting the applied file back.

A refused file that does validate still takes away what it removes. Every alias it
no longer has stops being served, and a provider left with no alias stops with them,
so a provider removed on purpose does not keep serving because another edit in the
same file was refused. Those aliases stay stopped through later unreadable or
invalid edits, until a file puts them back or the daemon restarts. Everything the
refused file kept stays on its last good binding.

The refusal is visible while it lasts. `/health` still answers 200, so the service
does not restart-loop, and adds `configRejected` with the same fixed reason.
`gateway health` reads that answer and warns "gateway.json change not applied
(reason); fix it or restart the service" for as long as the file stays refused,
and `gateway discover --load` checks it after writing and says when the daemon did
not take the routes. The diagnostics problems list includes `config_rejected`.
A release hot swap builds a fresh live configuration from the file in place, as a
start does, so a file the release before it had refused and that loads is adopted by
the new release, rebound aliases included. A gateway whose configuration is
invalid at startup still fails to start. Retiring an alias does not release its identity until the
daemon restarts. Labels and capability metadata can update live.

A macOS user LaunchAgent keeps the daemon alive across app and terminal exits.
Its environment contains PATH, not provider credentials. Credentials and gateway
client tokens are private files. Logs exclude request bodies, tool arguments,
provider tokens, and environment values.

Existing installations can consolidate their gateway jobs into one supervised
LaunchAgent. See [service ownership and migration](services.md). Migration is
explicit and requires a maintenance window; release installation preserves
running chats.

Native executor sharing may instead be staged for a subsequent primary service
start. The staging receipt is separate from the active plan, so clients keep
their existing ownership mode until activation. Activation verifies the same
plan and signed SDK again, and defers while old adapters or unknown writers
remain. Private native starts matching the existing native relay service plan
reserve the home before spawning, which prevents a concurrent shared host from
creating another owner. See
[travel recovery](travel-recovery.md).

`gateway service restart` asks the daemon to stop only while idle. The daemon
checks all HTTP requests, including unfinished body uploads, before closing its
listener. Active work refuses the restart and keeps its process. Older daemons
without this capability refuse the command; upgrade those during an idle window.
Explicit stop, `gateway service restart --force` or uninstall still stops the
service and cancels active work; see [services](services.md).

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
Loaded gateway chats can retain as many catalog generations as they need; a fifth
catalog does not require closing an older chat. Released and disconnected
generations are checked in the background and periodically. Only an unleased
generation proven to have no loaded chats is stopped. An older engine whose
probe fails stays owned and does not block acquisition of a new catalog.
A gateway executor
failure does not stop the native connection; saved gateway history can be resumed.

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
catalog generations. The execution host retains every generation still in use
and only retires an engine with no client leases and no SDK-loaded chats. A missing or
changed managed owner fails closed. It never deletes live locks or takes over an
old executor. Existing per-connection executors must finish before migration.

The execution host belongs to the unified service and owns its SDK children. There
is no separate per-generation LaunchAgent. The native account connection and
provider credentials keep their current ownership.

Before a shared host creates or looks up a gateway generation, it verifies the
selected SDK executable. If that executable's verified receipt names no adjacent Code
Mode helper, the host changes every row in that generation's gateway catalog to
`tool_mode: "direct"`. This includes missing and unknown modes, while preserving
the row's instructions, model, provider, permissions, review policy and every
other catalog field. A changed catalog receives a deterministic replacement
revision derived from the adapter revision and normalized catalog. It therefore
cannot reuse a persistent generation directory created for the incompatible
catalog. A catalog already entirely in direct mode keeps its adapter revision.

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
removes it when it is a socket of this user, whatever its mode, that refuses a connect
(ECONNREFUSED) twice, 200 ms apart (a live listener with a full accept queue also refuses
on macOS), and any other file, or any socket that answers, still refuses the start
as occupied and is never removed. The host creates its socket under a private umask
(`0077`, restored right after the bind) so that a host killed before its `chmod` leaves a
socket closed to others; the `chmod` stays as a second guard. Releases before 0.4.7
bound with the process umask and could leave a `0755` socket, which the next start now
reclaims too.
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
launch marked `starting`, then the engine's pid once it runs. The marker it keeps in
`owner.json` holds the engine identity and the whole receipt the first lease replaced.
When the last lease's engine exits (the adapter stopping, or the engine leaving by
itself), its adapter puts that receipt back with its file time, set before the atomic
rename so no reader sees the restored receipt with the current time, or removes the
file when there was none, so the host and rollback see the home as they did before the
fallback. An adapter that fails to build after taking the lease spawned nothing and
gives the lease straight back. An engine that still runs when the lease is released keeps the home: its lease's receipt then names only that
engine (`hostPid` 0) until the dead owner rules release it.

Private leases share the native home with each other and never with the host's
writer, the rule stock Codex follows when it runs one app-server for the app and
another for an SSH remote on one home. Each lease keeps a receipt of its own beside
`owner.json`, `private-<adapter pid>-<lease id>.json`, judged by the same liveness rules
(boot, pid and start of the adapter and of its engine, the startup grace, the native
socket); a dead one is moved to `stale/` under one shared name, so the newest five are
kept. Under the receipt's lock, a lease joins live ones of the same configuration and
native home spelling; a live or unconfirmed host receipt, an unreadable or foreign
private receipt, or anything answering at the host's native socket refuses it. The
host's claim is refused while any private receipt may still be live, and archives the
dead ones first. Releases 0.4.5 and earlier read only `owner.json`, so while any lease
is live it holds a marker in the private receipt format of 0.4.4 and 0.4.5 (which
0.4.3 reads as a plain owner) with `privateOwner.shared` added. The marker keeps the receipt the first
lease replaced and names live processes: the adapter and engine of a single lease, or
the engines (the adapters before they run) of the two longest-running leases. It is rewritten whenever a lease comes, starts its engine or
goes, and every lease looks at it again every 45 seconds, rewriting it only when
something changed, and the last lease to go puts the kept receipt back. An older
release therefore keeps its host's writer and its own private engine out while any
named process runs. With three or more leases, an older release could miss the others
for up to 45 seconds after both named leases crash; this release's host reads every
receipt. The marker reads as `absent` to the private-writer check, so it keeps no other
private engine out, while rollback still waits for it to stop; it reads as `live` while
anything answers at the host's native socket. A private engine of release 0.4.5 or
earlier keeps its own `owner.json` (no `shared`) and holds the home alone: a new adapter
fails closed, saying such a release started that engine and naming its process, until
that connection moves to this release. A lease that cannot write the marker removes its
own receipt again and brings the marker back in line with the remaining leases. A
release that fails (a busy lock, say) is retried by the lease's own timer until it
succeeds, and once more when the adapter stops; the timer ends only after a release has
succeeded, so a long-lived SSH listener never keeps the host out after its engine has
gone.
Rollback and `shared-native --disable` treat a live lease like any live native owner:
they refuse (and the disable restores the previous plan) until every lease's engine
has exited.

While any lease is live, a host that
starts claims everything but the native home: it records `native_sharing_unavailable`
with `reason: native_owner`, serves gateway chats, and refuses native requests
(`native_acquire` with `refused_owner`) until one finds the home free and claims it,
so the next adapter start returns to sharing. An adapter whose native request the host
refuses that way joins the private engines instead of failing (`native_sharing_fallback`
with `reason: native_owner`). Its lease may only join: with no live private receipt it
is refused as retryable, before anything is written, and the adapter asks the host once
more (the refusal may have come from a busy lock, or the engines ended meanwhile), so it
never starts a private engine beside a host that could share. It skips the check that keeps a private engine away from a
live host with native sharing, since its lease is taken under the receipt's lock and is
refused beside the host's writer, a private engine of 0.4.5 or earlier, or anything
answering at the host's native socket. A receipt from a dead owner that names
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

Provider version maintenance runs on the build host, outside inference and
session ownership. [Stable update validation](provider-updates.md) prepares
isolated candidates and advances generated source pins only after compatibility
checks pass. Installed engines continue through the normal gateway release path.

The app-owned supervisor can also replace its versioned controller in process.
The root retains its lock, signal handlers, children and execution host; the new
controller receives the same ownership broker. Child exit observers dispatch to
the current controller, preserving backoff across a handover. See
[live supervisor updates](services.md#live-supervisor-controller-updates) for
bootstrap, strict host-idle replacement and readiness limits.
