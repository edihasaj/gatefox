---
summary: 'Inventory and consolidate gateway processes under one macOS service.'
read_when:
  - Changing daemon ownership, restart, or service cleanup
  - Consolidating gateway jobs or retiring test services
---

# One managed service

The gateway can run its inference server, SSH tunnels, native relay, and desktop
login setup under one user LaunchAgent. Provider CLIs and chat executors remain
separate child processes. The GitHub Actions runner and other applications are
outside this service.

Preview the existing installation:

```sh
gateway service consolidate
```

The preview changes no files or processes. It lists the jobs that would be
replaced and the components that the single service would own. It excludes CI,
unrelated LaunchAgents, app-owned executors, and unknown job names. Jobs must
carry the gateway's management marker. The earlier MacBook Pro 2 tunnel is also
recognized by its original label and loopback endpoint.

Apply during a maintenance window:

```sh
gateway service consolidate --apply
gateway service status
gateway doctor
```

Finish chats on this machine and every client using it first. Application refuses
an open ChatGPT app or busy inference. An idle inference snapshot cannot prove
that a remote chat between inference steps has finished. Explicit application
stops the old transports, so it briefly disconnects clients. The command does not
quit ChatGPT or change native account settings.

The migration saves the original plists in private `service-backups` storage,
starts the supervisor, and checks its components. The inference HTTP listener
must respond; the native relay must report a fresh connected status. Failed
startup restores the previous jobs. Superseded plists move to Trash only after
the replacement starts. The installed native binary replaces earlier test paths
while retaining the original relay home and connected-machine registration.

The supervisor retries failed children with a delay that grows from one second
to thirty seconds. A child failure does not replace the other children. Desktop
login setup exits after success. Logs and the component status file are private.
A lease prevents two supervisors from owning the same state directory. Launchd
restarts the supervisor and retains ownership of its child process group.

`gateway service restart` requires the same maintenance window. The inference
child must accept its own idle guard before the supervisor stops its other
components. `gateway service uninstall` explicitly stops all owned components
and moves the plan and LaunchAgent to Trash. Provider credentials remain.

After consolidation, the separate native and tunnel installers refuse changes
that would create competing jobs. Their status commands inspect the unified
service. Desktop registration can refresh the launch environment without creating
another login job. Transport changes currently require stopping the unified
service and registering the required components again before reconsolidation.

Consolidation is opt-in. Installing an updated CLI prepares the command but does
not migrate a running service or interrupt an open chat.

To keep current work running and consolidate the next login instead:

```sh
gateway service consolidate --next-login
```

This saves the original jobs and a private pending plan, prepares one gateway
LaunchAgent, and moves its superseded owned startup files to Trash. It does not
unload or stop their currently running services. Native and SSH connections keep
their processes until logout. The one remaining entry starts desktop setup,
inference, native relay, and required tunnels as applicable to that machine.
Unrelated apps and CI jobs remain registered.

The new daemon promotes the pending plan only when launchd identifies it as the
primary gateway job and every retired gateway job is unloaded. This prevents a
manual start from creating competing relays or inference listeners. Activation
uses the same configuration, native home, relay home, and connected-machine
registration. Pending consolidation blocks separate registration changes that
could recreate duplicate startup jobs. Repeating staging is safe after its file
checks pass. Startup-file count and macOS's cached Login Items display are
separate checks; historical records can remain visible after registration ends.

Explicit tunnel installation and desktop registration enable their managed
LaunchAgent before loading it. This repairs a disabled registration without
restarting an already loaded job. New tunnel jobs limit the initial SSH connection
to one ten-second attempt; launchd or the unified supervisor retries after failure.
Existing active tunnel arguments stay unchanged until a maintenance update.
The unified supervisor also adds these defaults when it starts a newly owned SSH
child from an older plan. Explicit command-line timeout and attempt values,
forwarding endpoints, and SSH profile paths remain unchanged. It does not rewrite
the stored plan or replace a running tunnel to add defaults.
Network loss can interrupt forwarding, but a loaded KeepAlive job keeps retrying.
An unloaded job needs registration again; its plist alone does not start a process
in the current login session.

# Shared chat executors

Shared executors let local and remote clients resume the same gateway chat through
one signed Codex app-server. Each catalog and settings generation owns one
app-server with a private Unix socket. Disconnecting an adapter closes its client
connection; the service keeps the shared app-server and its loaded chats.

Existing plans keep their earlier executor behavior until this explicit migration:

```sh
gateway service shared-executors
gateway service shared-executors --apply
gateway service status
gateway doctor
```

Consolidate first if the installation still has separate jobs. Finish local and
remote chats, then quit ChatGPT normally on the machine being migrated. The
command checks the existing SDK version, saves the previous plan, and restarts
the unified service during that maintenance window. It checks the execution
host's actual control socket, component readiness, and a fresh native relay
connection before reporting success. A refused idle restart keeps the old process.
Preview also lists gateway adapters and catalog executors outside the supervisor.
Application refuses those processes. Close their SSH or desktop connections
normally before migrating. The inventory uses known gateway configuration and
catalog arguments; it does not inspect or stop unrelated native Codex sessions.

The service reads the signed SDK and native home from its existing native relay
component. A desktop-only plan uses its registered app's SDK and the original
native home. The service starts the execution host before launching transports.
If the host cannot start, for example after an app update changes the bundled
SDK, the service still starts inference, tunnels and the relay. It reports the
host as `failed` and retries with backoff from 10 seconds up to 5 minutes.
Adapters that need the host fail closed until a retry succeeds.

`gateway service shared-executors --disable --apply` and `gateway service
shared-native --disable --apply` turn a sharing mode off again. Without `--apply`
they preview the remaining plan. With it, they require the maintenance window,
stop the service only after its idle guard releases every lease and loaded chat,
archive the stopped host receipt in `service-backups`, restore the plan without
that mode, and start the service. If any step after the stop fails, the previous
plan is restored and the service started again; the error names the backup.

The service never keeps a Mac awake. While the inference host sleeps, other Macs'
gateway requests fail and Codex retries them. When the supervisor sees a timer tick
arrive more than 30 seconds late, the system slept: it logs `system_wake` and
restarts SSH tunnels at once instead of waiting about 45 seconds for keepalives.
Before starting a reverse tunnel, it frees the forwarded port on the remote Mac if
a leftover sshd session of the same user still holds it. Without this, a tunnel
dropped uncleanly (sleep, network change) can block reconnection until the remote's
TCP keepalive notices, by default two hours later. Nothing else listening on that
port is touched.

Installing a release leaves `sharedExecutors` absent in an existing plan; it does
not enable this migration or restart an open app.

The execution host writes each private configuration snapshot once. It shares
chat storage and the SDK's native writer-lock directory, so another generation
cannot write the same saved chat at the same time. It does not copy authentication
or replace native configuration and IPC sockets. Adapter lookups find the live
owning generation before attempting a new executor.

At most four generations can remain live. A connected adapter lease or loaded
chat keeps its generation. The host retires a generation only after all leases
close and the signed SDK reports no loaded chats. Unknown sockets and live
processes survive recovery checks. A stopped ownership receipt remains in place;
clients report an unavailable managed host instead of starting a competing writer.

The execution host runs inside the supervisor process. Its SDK workers are owned,
non-detached children in the same launchd process group. Service shutdown stops
those workers with a bounded TERM/KILL sequence. Idle restart first checks leases
and loaded SDK chats, then freezes new acquisitions while the HTTP daemon checks
its own idle guard. A refusal resumes the host and keeps its workers. A finished
turn can leave a chat loaded; close or unsubscribe it and allow SDK idle unload
before retrying the restart.

A failed migration restores the previous service plan. To restore legacy writers,
rollback first stops its own replacement daemon and proves every recorded SDK
writer is dead. It archives only the matching stopped ownership receipt before
starting the old transports. Unrelated, live, or unproven ownership stays in place
and blocks fallback. The command reports incomplete recovery in that case.

For an isolated foreground test, supply an isolated gateway config and native home:

```sh
gateway executor-host --config /absolute/test/gateway.json \
  --codex /absolute/path/to/matching-codex --native-home /absolute/test/native
```

The command requires both explicit paths and the pinned SDK version. Ctrl-C stops
its owned host and workers. Use the unified service for normal desktop work.

# Shared native session ownership

Native sharing has a separate `sharedNativeExecutor` setting. It does not enable
`sharedExecutors` for gateway chats. One original signed SDK owns the original
native home, while local and connected-machine adapters attach as independent
Unix clients. A second client can read the actual running turn and Stop it,
rather than reading a saved rollout through an unrelated SDK process.

Preview and apply migration through the existing unified service:

```sh
gateway service shared-native
gateway service shared-native --apply
```

Migration requires the existing native relay registration. A desktop-only plan
cannot take over the primary app's remote registration through this command.
Finish local and remote work, close the app normally on the execution machine,
and close remaining connections. The migration refuses pending startup cleanup,
an unrelated LaunchAgent, or any remaining native or gateway writer. It verifies
the actual OpenAI-signed Mach-O before changing the service plan. Authentication,
native configuration, registration IDs, and saved chats stay in their original
locations. No additional LaunchAgent is installed.

The SDK starts lazily from a real adapter's compatible process arguments. The
host uses the native home's parent as its stable launch directory; a new chat
without an explicit workspace keeps the requesting client's original directory.
Resume and fork preserve the saved workspace. The desktop's
`--analytics-default-enabled` flag is compatible with a relay started without it.
The first SDK launch keeps its analytics default, and explicit analytics settings
remain authoritative. Different process profiles or configuration arguments are
refused instead of creating a second native owner.
An updated adapter can also attach while an older host remains running. On the
older host's exact startup-settings refusal, it retries ownership acquisition
once with only the analytics-default flag changed. The host must still accept
every other setting. No inference is retried, and the existing writer continues.
Desktop startup also explicitly enables the Code Mode host. An adapter may treat
that flag as redundant only after the existing signed SDK reports the feature
enabled. Disabled, unavailable, or conflicting settings remain errors. The
feature query is read-only and does not answer frontend approvals.
Compatibility is bounded to four ownership requests, never inference requests.
Administrative reads use short-lived, non-originating SDK connections and never
answer frontend approvals. Identical pending approvals replay with their original
mapped client ID after resume.

A client disconnect leaves the SDK running. Confirmed SDK death has an exact
launch identity and can report failure for real unfinished turns; losing only a
socket does not prove a turn failed. A subsequent compatible acquisition can
recover a proven dead SDK under the same native-home ownership lease. Lost work
requires an explicit retry from saved history. Unknown or live socket ownership
blocks recovery. Idle service restart checks native leases and SDK-loaded chats
as well as gateway work. Rollback proves both host and native-home ownership
receipts stopped before restoring legacy writers.

The pinned SDK's Unix transport lacks its local-stdio biometric capability.
Clients receive the SDK's actual capabilities, and the adapter does not bypass
that restriction. Unix ownership tests do not establish every rendered desktop
control or the built-in cloud connection.
