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
must respond; the native relay must report a fresh connected status. When a
failed startup proves that the new supervisor is unloaded, rollback restores the
previous jobs. Each restore step runs on its own, so one failing step cannot
leave the other jobs stopped, and `launchctl bootout` of a job launchd no longer
has (`3: No such process`) counts as already stopped. When rollback cannot prove
the replacement unloaded (`replacement_still_loaded`), the new service stays
running instead: rollback leaves the supervisor plist and the service plan in
place, keeps that plist equal to what the loaded supervisor is running (it does
not overwrite it with the old job that shared its label), and does not restart
the old jobs, so two sets of writers never run together. Superseded plists move
to Trash only after the replacement starts, so in that case the old non-service
plists are still in `~/Library/LaunchAgents`, next to the running supervisor,
and their text is saved in the backup. Move them aside (for example to Trash)
and reload, or rerun `gateway service consolidate --apply`, or uninstall the
service, so a later login never loads a duplicate. The original error is
reported, followed by the names of any rollback steps that failed, and a startup
timeout names which readiness condition never held (`status_not_current`,
`components_not_running`, `inference_unhealthy` or
`native_relay_not_connected`). The installed native binary replaces earlier
test paths while retaining the original relay home and connected-machine
registration.

The supervisor retries failed children with a delay that grows from one second
to thirty seconds. A child failure does not replace the other children. Desktop
login setup exits after success. Logs and the component status file are private.
A lease prevents two supervisors from owning the same state directory. Launchd
restarts the supervisor and retains ownership of its child process group.

`gateway service restart` requires the same maintenance window. When the running
plan has no inference component (a Mac moving from client-only to standalone),
the window skips the inference health check because nothing listens yet. The inference
child must accept its own idle guard before the supervisor stops its other
components. `gateway service uninstall` explicitly stops all owned components
and moves the plan and LaunchAgent to Trash. Provider credentials remain. Install, upgrade and uninstall of the single-job service treat a job launchd has already dropped (`launchctl bootout` reporting `3: No such process`) as stopped and continue.

On SIGTERM or SIGINT, inference stops listening at once and lets running requests
finish for `GATEWAY_SHUTDOWN_DRAIN_MS` (default 4000, clamped to 0 to 5000).
The LaunchAgent sets only `PATH`, and service plans allow only `PATH` and
`SSH_AUTH_SOCK`, so the variable applies to a foreground `gateway serve`. A managed
service uses the default unless launchd's user environment sets it with
`launchctl setenv GATEWAY_SHUTDOWN_DRAIN_MS <ms>`, which lasts until logout and
takes effect the next time the service starts. Requests not yet admitted (queued, still uploading, or loading
configuration) fail at once with a retryable `upstream_unavailable` "Gateway is
restarting; retry shortly", and no provider call is made, so nothing is paid for
twice. Requests still running at the deadline end the same way and are not
reported to GlitchTip. Codex retries them against the restarted server. The
supervisor gives inference the drain plus 2.5 seconds before SIGKILL, and closes
the shared execution host after inference exits, which takes up to 2.5 seconds
more. A stop with a busy stream therefore takes at most the drain plus 5 seconds:
9 seconds by default and 10 seconds at the maximum, within the 10-second timeout
that service install, uninstall and consolidation give `launchctl bootout`.
Reverse SSH tunnels and the
native relay still stop at the same moment as inference, so streams from other
Macs do not get the drain. The drain deadline in `cli.ts` and the supervisor take
effect only after a service or inference restart; an in-place upgrade keeps the
running process's previous deadline.

After consolidation, a separate native install or `gateway tunnel install` refuses
changes that would create competing jobs. Their status commands inspect the unified
service. Desktop registration can refresh the launch environment without creating
another login job. Transport changes other than tunnel removal currently require
stopping the unified service and registering the required components again before
reconsolidation.

Retire one tunnel the unified service owns:

```sh
gateway tunnel uninstall --tunnel-id spark
```

This edits the service plan rather than registering another LaunchAgent. It
refuses a tunnel name that is not in the plan, and it refuses a component of that
name that is not a tunnel. Repeating a removal that already landed reports
`alreadyRemoved` instead of failing again. A repeat is recognised only from the
removal record the command writes after the plan edit succeeds
(`service-backups/tunnel-removals.json`, private), by an exact comparison of the
recorded tunnel id, and only while the plan file is the one that removal left
(the record stores its content hash, inode, modification time and change time, so
even a copy with identical content and modification time is another file). Removing another tunnel
with this command keeps earlier records valid; restoring a saved plan, editing
it by hand, replacing it, or `gateway service uninstall` followed by a new
consolidation ends them, so such a plan reports `No tunnel <id>` again. A backup
file by itself, whatever its name, proves nothing: a failed edit, or a plan
someone changed by hand, never makes an unknown name look removed, and
`spark-2026` never makes `spark` look removed. If only the record write fails, the
removal still succeeds and the result says a repeat will not be recognised. A
record that cannot be read counts as no record, so an unknown or repeated name is
still refused as `No tunnel <id>`.

Before it writes anything, it runs the same maintenance check as `gateway service
restart` on a unified plan and consolidation: the ChatGPT desktop must be quit,
and when the plan runs inference, `/health` must answer with status `ok` and no
active inference (a busy, unhealthy or unreachable gateway is refused). The
refusals say `Quit ChatGPT normally after local and remote chats finish` or
`Gateway inference is busy or unhealthy`, each followed by `the tunnel was not
removed`; they do not use the consolidation wording. A plan
with no inference component, and a remote-client configuration, have nothing
listening locally, so no probe is made and it never depends on the tunnel being
removed. A remote-client configuration is never probed even when its plan still
lists an inference component (a Mac that moved from standalone to client).

It checks the tunnel's local listeners, which are its `-L` and `-D` forwards (also
written as `-o LocalForward` or `DynamicForward`, attached to the flag, clustered
like `-NTL`, or with a bracketed IPv6 bind). It reads the ssh arguments with the
same option table the service uses for ssh (so `-P tag` and `-PLab` are a tag, not
a forward) and stops at `--`. It also asks `/usr/bin/ssh -G` with the same
arguments what ssh resolves (it does not connect), and merges that with the
arguments: forwards that `-F` or the host alias add through ssh_config count as
the tunnel's own, and so does `GatewayPorts`. Because `ssh -G` evaluates the
ssh configuration, a `Match exec` line in it runs, as it does whenever that tunnel
starts. A reverse `-R` forward only listens on the other machine, so it is not
checked. It refuses when:

- a configured provider's `baseUrl` connects to one of those ports, naming the
  provider; point that provider at another endpoint or remove it from the gateway
  configuration, then repeat the removal. A forward bound to loopback (the default)
  is reached through every spelling of this machine: `localhost` (with or without
  a trailing dot, and `*.localhost`), the whole `127.0.0.0/8` range, `0.0.0.0`,
  `::`, `::1`, and IPv4-mapped forms such as `[::ffff:127.0.0.1]`. A forward bound
  to every interface (`*`, `0.0.0.0`, an empty bind such as `:port`, any other
  non-loopback bind address, or `GatewayPorts yes` or `-g` without a bind
  address) is also reached through this machine's hostname and interface
  addresses. A provider host that is a name is also resolved (the system
  resolver, so DNS and `/etc/hosts`, every address it returns), but only when its
  port is the tunnel's: any loopback address reaches a loopback forward, and a
  loopback or own-interface address reaches a wildcard one. So `qwen.internal`
  mapped to `127.0.0.1` is refused, and one that resolves to a remote address is
  not. A lookup that fails or takes more than 3 seconds fails with `Cannot
  determine whether provider <id>'s host <name> reaches tunnel <id>'s local port
  <port>; the tunnel was not removed`, because the answer is unknown. A provider
  that plainly matches is reported before any name is looked up;
- on a remote client, one of those ports is the configured `port`, because that
  tunnel is how the client reaches its gateway; stop the client with `gateway
  service uninstall` instead. Another tunnel on the same machine still retires
  normally;
- the tunnel's local port cannot be determined, because the checks above cannot
  run: a forward's port cannot be identified (a socket path, a malformed spec, port
  0, which asks ssh for a free port), a trailing `-L`, `-D` or `-R` has no value, or
  `ssh -G` cannot resolve the arguments (for example an unreadable `-F` file). It
  fails with `Cannot determine tunnel <id>'s local port`; edit the service plan
  manually;
- the component's command is not `/usr/bin/ssh` (for example a hand-edited plan
  that runs `autossh` or a Homebrew `ssh`), because its options would be read with
  OpenSSH's table and guessed. It fails with the same `Cannot determine tunnel
  <id>'s local port` error;
- neither the arguments nor ssh's resolved configuration declare any forward (no
  `-L`, `-D`, `-R`, `LocalForward`, `DynamicForward` or `RemoteForward`). It
  fails with `Cannot determine tunnel <id>'s local port`, like the cases above;
- the tunnel is the plan's only component; uninstall the gateway service instead;
- a next-login consolidation is pending (`service-login-pending.json`): the
  command fails with `Tunnel startup is staged under the unified service at next
  login` before it reads or changes the plan, whatever tunnel id was given, so
  the staged plan can still be activated. The check runs again under the plan
  lock, so a consolidation staged while the command waited for that lock is
  refused too.

The plan it replaces is saved first to a private
`service-backups/tunnel-removed-<id>-<timestamp>.json` file. The re-read, the
check that the plan did not change since it was read, the backup, the plan write
and the record all happen under the same plan-file lock `service shared-executors`,
`service shared-native` and their disable commands hold, so a concurrent change
is never overwritten: the removal refuses with `Gateway service plan changed`, or
waits up to 5 seconds for the lock and then fails with `Gateway service plan is busy;
the tunnel was not removed`. The removal never holds the login registration lock while it waits for the plan
lock. Every plan writer takes the plan lock first and the login lock second, so
a removal that held the login lock could block a writer that already holds the
plan lock, and make it fail as busy (a shared-executors disable could then leave
the service stopped). A lock that cannot be created at all (for example an
unwritable state directory) fails with `Cannot lock the gateway service plan
(<code>); the tunnel was not removed`. Either way nothing was backed up or written.
A plan write that fails after the backup leaves the backup in place and records
nothing, so a plan someone later edits by hand is still refused as `No tunnel <id>`.

Nothing restarts: the result says `appliesAt: next service restart`, and a repeat
says the same. The tunnel stops when the unified service next starts from the
shorter plan. That is any restart, not only one you run: `gateway service
restart`, an idle self-upgrade restart after an update, a launchd restart after a
crash, or the next login. Until then `gateway tunnel status --tunnel-id <id>`
shows `component: null` because the tunnel is gone from the plan, but its ssh
process keeps running. Restore the saved file over `service-plan.json` and restart
to bring the tunnel back.

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
restarts SSH tunnels at once instead of waiting about 45 seconds for keepalives. A component starts at most once at a time: a wake that arrives while a tunnel is still clearing a stale listener no longer starts a second tunnel for the same port, which made tunnels flap.
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
