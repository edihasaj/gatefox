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

## The name macOS shows

For CLI-only installations, macOS names a LaunchAgent item after the first `ProgramArguments`
entry, and shows that name in System Settings, Login Items, under "Allow in the
Background", and in the "Background Items Added" notification. Since 0.4.7 the
installer writes `~/.local/bin/harness-gateway` as the managed launcher, plus
`~/.local/bin/gateway` as a second launcher with the same contents (both set
`GATEWAY_COMMAND` to the `harness-gateway` path), so every plist written from
either command names `harness-gateway`. The service, desktop login, native
relay (its `--gateway` argument) and consolidated plans all use it. The
login environment agent (0.4.7, and a standalone registration today) runs
`<state>/harness-gateway-login-env`, a private script, instead of `launchctl`, so it is
not listed as "launchctl" either. With the unified service it does not exist since
0.4.8. The launchd labels stay `com.edihasaj.subscription-gateway*`.

Older plists keep working, and a rollback to 0.4.5 needs no plist change: the checks that
read a plist's arguments (service plans, login consolidation, consolidation collection, uninstall)
accept both `.../bin/gateway` and `.../bin/harness-gateway`. A running standalone native relay
whose plist names `bin/gateway` in its `--gateway` argument counts as the same registration as
one written now within the same release, so `gateway native install` there no longer asks you to uninstall it first; across releases the relay path differs too and the existing refusal stands. An existing
`harness-gateway` link to `gateway` is replaced by the launcher file; any other file with that
name is left alone and the installer refuses to continue. Plists name `harness-gateway` only
while that file carries the installer's marker line; otherwise they keep `gateway`.

Migration is one-time and happens when a plist is next written by 0.4.7:

- A standalone service: `gateway service install`, which upgrades the running
  service when it is idle like any other install.
- `gateway service consolidate --apply` and `--next-login` write a newly unified
  service with the new name. They do nothing to a Mac that is already unified.
- `gateway desktop register` rewrites the standalone desktop login agent and, without a
  unified service, the login environment agent.
- An already-unified service (a `service-plan.json` exists, as on every production Mac):
  `gateway service install` renames the launcher in the service plist file, and in the
  desktop login plist if one exists. It changes only the first program argument, writes
  atomically, keeps the label, and does only that and what it always did (start the service if it
  is not loaded or has no process). It never boots out, restarts or replaces a running
  service, and it rewrites a file only when it carries the gateway's marker and names a managed
  `gateway` launcher whose sibling `harness-gateway` is managed too. The result says
  `programRewritten: true|false` (and `desktopRewritten`), and `appliesAt: "next login"`:
  launchd reads the file at its next load, so the running service keeps its current definition
  until you log in again (or restart through `launchctl bootout` and `bootstrap`), and shows the
  new name from then. `appliesAt` is `"now"` when that same call had to load a stopped service.
  Run it once per Mac after installing 0.4.7.

At the first load of a renamed plist macOS posts one "Background Items Added" notification
for `harness-gateway`, and the old "gateway" entry disappears from the list once the old
definition is no longer loaded, which is the next login for a unified service.
The signed native app can attribute the existing gateway job to its fox identity
without registering another job or restarting the service. See
[macOS background identity](macos-background-item.md). This association does not
change service ownership or replace consolidation.

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

With the unified service the gateway has exactly one background item, `harness-gateway`.
ChatGPT can start at login before this service has set `CODEX_CLI_PATH`, so the
daemon (`gateway daemon`) runs `/bin/launchctl setenv CODEX_CLI_PATH <registered
wrapper>` as its very first step, before consolidation, any wait or any child. It does so
only when the registration receipt names this gateway's own executable wrapper, the
release runtime exists, and the login session holds no value or one of the gateway's own
wrappers; a foreign override is never replaced. The 0.4.7 login environment agent,
`com.edihasaj.subscription-gateway.desktop-env`
(`harness-gateway-login-env` in Login Items), is no longer written next to a unified
service, and the service's desktop component removes a managed one it finds, so a 0.4.7
Mac loses that extra item at its first 0.4.8 service start. A standalone
`gateway desktop register` (no unified service, no pending login plan) keeps the agent.
Consolidation does not collect it into the plan, and `gateway desktop unregister` and
`gateway uninstall` remove any that is left. See
[the registration section](app-server.md#the-login-environment-agent).

The supervisor retries failed children with a delay that grows from one second
to thirty seconds. A child failure does not replace the other children. An
inference or tunnel child that exits within a minute of its start five times in a
row is reported once as `component_failing` and keeps being retried, so a fault
that passes heals by itself. Desktop login setup exits after success. Logs and the
component status file are private. The status file is advisory: a write that fails
(a full disk, a read-only folder) never stops the service, is reported at most once
a minute as `status_write_failed`, and the next heartbeat five seconds later writes
it again. A lease prevents two supervisors from owning the same state directory.
Launchd restarts the supervisor and retains ownership of its child process group.
The supervisor also runs the watchdog heartbeat ([health](health.md#schedule)) for
the configuration its plan names, and stops it, with any smoke run in progress, when
the service stops. Every self-heal event is listed in
[diagnostics](diagnostics.md#service-self-heal).

`gateway service restart` requires the same maintenance window. When the running
plan has no inference component (a Mac moving from client-only to standalone),
the window skips the inference health check because nothing listens yet. The inference
child must accept its own idle guard before the supervisor stops its other
components. `gateway service uninstall` explicitly stops all owned components
and moves the plan and LaunchAgent to Trash. Provider credentials remain. A job
launchd has already dropped (`launchctl bootout` reporting `3: No such process`)
can be absent while its process still drains. Legacy standalone installation
requires both job removal and process exit before replacement or rollback; see
[service installation recovery](service-install-recovery.md).

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
inference process itself leaves the drain plus 1.5 seconds after the stop began, after it
has recorded the requests still running (a `failed` ledger row with the usage received so
far); the supervisor gives it the drain plus 2.5 seconds before SIGKILL, and closes
the shared execution host after inference exits, which takes up to 2.5 seconds
more. A stop with a busy stream therefore takes at most the drain plus 5 seconds:
9 seconds by default and 10 seconds at the maximum, within the 10-second timeout
that service install, uninstall and consolidation give `launchctl bootout`.
Reverse SSH tunnels and the
native relay still stop at the same moment as inference, so streams from other
Macs do not get the drain. The drain deadline in `cli.ts` and the supervisor take
effect only after a service or inference restart; an in-place upgrade keeps the
running process's previous deadline.

After consolidation, `gateway tunnel install` and `gateway native uninstall` refuse
changes that would create competing jobs. `gateway native install` installs no job
either: it only registers the relay the service already runs, for a relay slot that
waits as `not_registered`. It uses the plan's own relay binary, relay home, native
home and app CLI, refuses while ChatGPT is open, runs the relay's `--check` and
`--enable` against the existing, enabled Codex Desktop registration (it never enrolls
a new machine), and then writes `<state>/native-registration.json`. The service starts
the relay at its next five-minute check while ChatGPT stays closed. Their status
commands inspect the unified service. Desktop registration can refresh the launch environment without creating
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
  addresses. That name counts in either spelling: the full `hostname()`
  (`Mac-Studio.local`) or its bare first label (`Mac-Studio`), and an interface
  address counts in its IPv4-mapped spelling (`[::ffff:192.0.2.7]`) as well as in
  the dotted one. A provider host that is a name is also resolved (the system
  resolver, so DNS and `/etc/hosts`, every address it returns), but only when its
  port is the tunnel's: any loopback address reaches a loopback forward, and a
  loopback or own-interface address reaches a wildcard one. So `qwen.internal`
  mapped to `127.0.0.1` is refused, and one that resolves to a remote address is
  not. A lookup that fails or takes more than 3 seconds fails with `Cannot
  determine whether provider <id>'s host <name> reaches tunnel <id>'s local port
  <port>; the tunnel was not removed`, because the answer is unknown. A slow
  lookup is refused after 3 seconds, but the resolver call is not cancelled, so
  the command can still take until that system lookup ends to exit. A provider
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
  login` before it looks the tunnel up in the plan or changes the plan, whatever
  well-formed tunnel id was given, so the staged plan can still be activated. The
  check runs again under the plan lock and the login lock, so a consolidation
  staged while the command waited for either of them is refused too.

The plan it replaces is saved first to a private
`service-backups/tunnel-removed-<id>-<timestamp>.json` file. The re-read, the
check that the plan did not change since it was read, the backup, the plan write
and the record all happen under the same plan-file lock `service shared-executors`,
`service shared-native` and their disable commands hold, so a concurrent change
is never overwritten: the removal refuses with `Gateway service plan changed`, or
waits up to 5 seconds for the lock and then fails with `Gateway service plan is busy;
the tunnel was not removed`. The removal takes the plan lock first and the login
registration lock second, the order `service shared-executors`, `service
shared-native` and their disable commands use, so it never holds the login lock
while it waits for the plan lock. The commands that move the plan itself are not
plan-lock writers: `service uninstall` trashes the plan and `service consolidate
--next-login` stages one, each under the login lock alone, so a plan that was
moved or staged while this removal waited is caught by that second lock and
refused instead of written back. A lock that cannot be created at all (for
example an unwritable state directory) fails with `Cannot lock the gateway
service plan (<code>); the tunnel was not removed`, or `Cannot lock the gateway
service registration (<code>)` once the plan lock is held; a login lock still
held after 5 seconds fails as `Gateway service registration is busy; the tunnel
was not removed`. The `(<code>)` suffix appears only when the system reports an
error code; a lock file that is not a private regular file owned by you gives
the same message with no code. Either way nothing was backed up or written.
A plan write that fails after the backup leaves the backup in place and records
nothing, so a plan someone later edits by hand is still refused as `No tunnel <id>`.

Nothing restarts: the result says `appliesAt: next service restart`, and a repeat
says the same. The tunnel stops when the unified service next starts from the
shorter plan. That is any restart, not only one you run: `gateway service
restart`, a self-upgrade restart after an update, a launchd restart after a
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

Staging records which process staged. If that process is gone before the staging
finished (a crash, a reboot, or a rollback of its own that failed), the gateway
LaunchAgent can still start at the next login with an unfinished `preparing` record.
The daemon starts only from the staged LaunchAgent, so the staging got as far as its
last file write and missed only its `ready` mark. The daemon therefore finishes it
first: it runs the same checks as for a `ready` record (the staged LaunchAgent is
unchanged, no retired job came back or is still loaded, no other gateway job appeared,
and launchd runs this daemon as the primary job), promotes the plan, logs
`login_consolidation_completed`, and runs it. A check that cannot run at all (launchctl
or the disk failing) changes nothing, and launchd's next start tries again. So do the
two checks that only mean "not yet": a retired job that is still loaded, and a start
that is not launchd's primary job (a manual start). They fail this start and keep the
record, so a fully staged consolidation is never rolled back for timing.

Only a check that refuses rolls the staging back. The daemon puts back each original
login job whose saved copy still has the digest recorded at staging, writes the private
mark `<state>/service-login-recovered.json` (its boot and the restored job labels), and
only then moves the record into the backup as `login-recovered.*.json`, so a daemon that
stops between the two rolls back again at its next start and one that stops later finds
the mark. It then loads every restored job except the
primary one with `launchctl bootstrap`, so tunnels, the relay and desktop setup run in
this session; a job that is already loaded is left alone, and one that fails to load
is counted. Every relaunch in the same boot loads, again, each restored job that is
still not loaded, so a daemon that stopped before its loads finishes them. `login_consolidation_restored` reports how many jobs were put back,
started and failed. The primary job, normally inference, cannot be loaded while the
daemon holds its label, so inference stays down until the next login or the recovery
below. The daemon has no plan to run and stays idle. Every relaunch in the same boot
(a crash, `launchctl kickstart -k`, a stop) finds the mark and stays idle too, instead
of failing every ten seconds, and an idle-restart `SIGUSR2` does not end it. A saved
copy that changed stops the rollback with the record kept, as it does for repeated
staging. A staging process that is still alive keeps the old refusal. Records written
before 0.4.4 name no process; the login lock the staging holds throughout is the proof
that it is gone.

To recover after a rollback without logging out:

1. Check that it happened: the service log has the line `an interrupted next-login
   consolidation was rolled back`, and `<state>/service-login-recovered.json` exists.
2. Replace the idle daemon with the restored primary job:

   ```sh
   launchctl bootout gui/$(id -u)/com.edihasaj.subscription-gateway
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.edihasaj.subscription-gateway.plist
   ```

   When the staging had no original primary job, there is no plist to load; the
   bootout alone stops the idle daemon.
3. Run `gateway service status` and `gateway health` to confirm inference answers.
4. Stage again with `gateway service consolidate --next-login` when you want the
   unified service. A promoted staging removes the mark.

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
host as `failed` with a fixed reason and retries after 1, 2, 5, 10 and 30 seconds,
then every 60 seconds. An adapter that needs the host asks for an earlier retry
through the host folder's `kick` file and waits up to 20 seconds; a kick never brings
a start within five seconds of the previous one, and a failure that retrying cannot
fix (another live owner, a changed identity, an invalid engine or receipt) gets one
kicked start per backoff step. Adapters that need the host fail closed until a retry
succeeds.

Previous-boot socket receipts also recover when macOS assigns a new filesystem
device number. The host reclaims only validated dead runtime entries, preserving
live listeners and uncertain ownership. See [reboot recovery](reboot-recovery.md).

The first host start after an install is the first run of that release's engine
binary, and macOS checks a newly written executable before its first run prints
anything: about 3 seconds for the 335 MB gateway SDK on an M5 Pro, 0.01 seconds
from the second run on. The host's `codex --version` check therefore allows 15
seconds. Its earlier 5-second limit could fail that start as `sdk_invalid` on a
slower or busier Mac, and the retry a second later passed (`execution_host_recovered`),
which matches the pair one Mac logged at its 0.4.4 switch on 2026-10-17.

The service probes a running host every 60 seconds: its ownership receipt, its
control socket and one `execution/status` answer within 5 seconds, and, when native
chats are shared, whether the app's engine was replaced under it. The host answers
`execution/status` at once, ahead of any acquire or idle check it is working on, so a
busy host does not time out. A host that fails two probes in a row, for example
because the periodic `/tmp` cleanup removed its SDK socket, is restarted on its own,
without the other components, but only while it is idle (no adapter lease and no
loaded chat); a busy host is probed again a minute later. A kick from an adapter also
probes it, so an adapter that cannot reach the host shortens the wait. A probe that
is still running holds a restart back until it ends, and a verdict about a host that
another start replaced in the meantime is dropped. The same idle restart gives the app
its remote control back when the host took the registration for a relay that the
service then set aside.

If the old host cannot be closed during that restart, its receipt still names the
running service, so no new host could start in the same process. The service keeps
the old host, so a stop still closes it, and restarts as a whole once inference is
idle; launchd then starts a fresh process that reclaims the receipt. A busy service is
asked again at the next probe tick, and no host start is tried meanwhile.

`gateway service shared-executors --disable --apply` and `gateway service
shared-native --disable --apply` turn a sharing mode off again. Without `--apply`
they preview the remaining plan. With it, they require the maintenance window,
save the current plan in `service-backups`, write the plan without that mode, and
restart the service onto it. The restart waits for the service's idle guard to
release every lease and loaded chat; launchd's KeepAlive then starts the service
from the new plan, so the relaunch cannot take the shared host back. The relaunch
is not immediate: launchd's 10 second ThrottleInterval can pass first, and the
service has no process while it waits. The command waits for the new process.
Once the service runs the new plan, the stopped host receipt is archived, but only
when no relaunched host can claim it. If the other mode stays on, the relaunched
host claims `owner.json` itself and takes over the stopped receipt, so nothing is
archived. When shared-native goes off and shared-executors stays, only the stopped
native-home receipt is moved into the backup.

If any step fails, the previous plan is written back through a temporary file and a
rename, and the service is brought onto it:

| State when the change failed | Result | Message says |
| --- | --- | --- |
| The service refused the idle restart and never left the previous plan | Plan restored, service untouched | the service kept running |
| The service was down (for example in the throttle gap), so the restore starts it | Plan restored, service started | the service, which was down, was started |
| The service already relaunched on the new plan | The command waits up to 30 seconds for the relaunched service to be current and answer `/health` (it starts its host before inference), then retries the idle restart up to three times | the service was restarted |
| Every retry was refused (loaded chats, or the service never became healthy) | Plan file restored; the service still runs the plan without the mode | run `gateway service restart` when idle |
| The service was down and could not be started | Plan file restored; the service is down | run `gateway service install` |
| The service could not be read (launchctl failed) | Plan file restored; which plan runs is unknown | run `gateway service status`, then `gateway service restart` when idle |
| The previous plan could not be written back | The plan file still holds the plan without the mode (the new plan) | the plan that runs, taken from the process id before and after: the original process still runs the previous plan (copy `<backup>/service-plan.json` back; no restart needed), any other process runs the new plan (copy it back, then `gateway service restart` when idle), no process means copy it back, then `gateway service install`, and an unreadable service means `gateway service status` first |

In the fourth case the plan file and the service differ until the restart runs.
The next restart or crash relaunch reads the restored plan, so it heals itself.
`gateway service install` does nothing while the service has a process, so the
message never suggests it in that state.

`gateway service shared-executors --apply` and `gateway service shared-native
--apply` undo a failed migration the same way: the previous plan goes back first,
the replacement restarts onto it through its idle guard, and the stopped host
receipt is archived once the service runs it (not when the previous plan still
shares executors itself). A replacement that cannot be restarted keeps running its
own plan, so there the plan file is put back to name that plan and the command
says which mode still runs and gives `gateway service <mode> --disable --apply`
for when the service is idle. Every other failed rollback ends with a message
that names the plan that runs and one command: `gateway service restart` when
the service still runs the new plan, `gateway service install` when it is down,
`gateway service status` first when it could not be read. When only the stopped
host receipt could not be archived, the plan file and the service match and the
receipt stays for the next host to take over. When the previous plan could not
be written back, the message names the plan that runs and says to copy
`<backup>/service-plan.json` over the plan file first.

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

There is no fixed limit on live catalog generations. A connected adapter lease or
loaded chat keeps its generation, so resuming a chat never requires closing an
unrelated chat. Background maintenance checks for unused generations after leases
are released, after adapters disconnect, and periodically. The checks are bounded
and coalesced, and run outside the acquisition queue. The host retires a generation
only after all leases close and the signed SDK reports no loaded chats, rechecking
the engine's identity and leases before stopping it. An unreadable engine remains
owned and cannot prevent a new catalog from loading. Unknown sockets and live
processes survive recovery checks. A stopped ownership receipt remains in place;
clients report an unavailable managed host instead of starting a competing writer.

The execution host runs inside the supervisor process. Its SDK workers are owned,
non-detached children in the same launchd process group. Service shutdown stops
those workers with a bounded TERM/KILL sequence. Idle restart first checks leases
and loaded SDK chats, then freezes new acquisitions while the HTTP daemon checks
its own idle guard. A refusal resumes the host and keeps its workers. A finished
turn can leave a chat loaded; close or unsubscribe it and allow SDK idle unload
before retrying the restart. An upgrade that has waited 15 minutes uses the quiet
rule instead (see [Moving to a new release](#moving-to-a-new-release)).

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

# Moving to a new release

Installing a release only switches the `current` link. The supervisor checks once a
minute and, when `current` names another release, restarts itself; launchd starts it
again on the installed release. It waits for one of three moments:

1. **Idle**, tried first at every attempt: the execution host has no adapter lease and
   no loaded chat, then inference accepts its own idle guard.
2. **Quiet**, once the newer release has been installed for 15 minutes and the idle
   restart still refuses: no turn is running in any engine, gateway or native, no chat
   keeps a background terminal, and no turn ended in the last 5 minutes. A turn waiting
   for an approval or for user input counts as running. Leases and loaded chats do not
   block it. Inference must still accept its idle guard, so a running inference request
   still refuses, and the next attempt asks again.
3. **Urgent**, when a newer adapter is waiting beside this older host (see
   [release skew](#release-skew-a-newer-adapter-beside-an-older-host)): no 15 minute
   grace, and the quiet check ignores recently ended turns. Only a running turn, a
   background terminal or busy inference holds it back.

The 15 minutes count from when the running service first saw the release, on the
monotonic clock, which stops while the Mac sleeps: they are 15 minutes of awake time,
so a Mac that sleeps right after an install waits that much longer after it wakes.

The idle rule alone can wait forever: a ChatGPT on another Mac stays connected over
SSH for days, holds a lease, and its SDK keeps its chats loaded. On 2026-10-17 a Mac
stayed on the previous release for this reason until an operator stopped the
service.

The host never sees turn notifications: adapters talk to engine sockets directly, and
a client the host kept open would be subscribed to new chats by the SDK and keep them
loaded. So each quiet check opens one short admin connection per engine and asks the
engine itself (the pinned gateway SDK, or for native chats the app's own signed codex)
about every loaded chat:

- its live `thread/read` status;
- its background terminals (`thread/backgroundTerminals/list`). They are on by
  default, outlive the turn that started them and end only when the engine closes the
  chat's session, so a dev server an agent left running would die with the restart. A
  chat that keeps one is never quiet, and the upgrade waits until the terminal ends or
  is closed;
- its newest turn (`thread/turns/list`, with the running turn merged in), which ended
  at its `completedAt`, or, when it has none, at the later of its start and the chat's
  `updatedAt`. Reading it replays the chat's whole saved history, so a saved chat whose
  `updatedAt` is more than the quiet time plus a minute old is judged by its read
  alone: the SDK touches `updatedAt` whenever it appends to that history, at most 5
  seconds apart. A chat with no turns has nothing that ended.

A throwaway chat, and one that has saved nothing yet, cannot list its turns, and its
`updatedAt` is the time of the read, so neither tells when a turn ended. Only such
chats are judged by the host's own watch: one is quiet once the host has seen it
settled (not running, no terminal) at every check for 5 minutes; a check that sees it
running, or that cannot read an engine, starts that watch again. The watch cannot see a
throwaway chat's turn that starts and ends entirely between two checks, which run about
every 2 minutes. A saved chat with a real `updatedAt` whose turn list fails is not
watched: it ended its newest turn no later than its `updatedAt`. A chat or a status the
check cannot read, or more than 256 loaded chats in one engine, counts as not quiet. A
chat that was running at the previous check and is not now (its turn ended, the chat was
unloaded, or its engine exited) counts as having ended at this check. Each reason a
quiet attempt waited is logged once per pending release as `self_upgrade_waiting`
([diagnostics](diagnostics.md)).

The check runs in the host's control queue like the idle check and closes the gate the
same way: once it passes, `execution/acquire`, `execution/find` and `native/acquire`
are refused as quiescing until the service stops or the attempt is refused and the gate
reopens, which takes up to 3 seconds when inference refuses its idle guard. An adapter
asks again every 100 ms for up to 5 seconds before it reports that refusal.

The service then stops as it does for any restart, and connected clients see the host
go away as they do after a host restart. An adapter's engine connections close: when
native chats are shared too, the adapter closes the app's connection and the app
reconnects; otherwise, since 0.4.7, the adapter re-attaches a gateway chat on its next
request: it kicks the service, waits up to 20 seconds for the new host, resumes the chat
there and then sends the request ([re-attaching gateway chats](app-server.md#re-attaching-a-gateway-chat)).
Only when the host stays down does the request still report that the executor
connection was lost. Turns start on engine sockets, not through the host, so the
check cannot hold one back: a turn started in the second or two between the quiet check
and the host's close (inference exits first) is cut, as at any service restart, and
continues from saved history after a resume. `gateway service restart` keeps the idle
rule and its maintenance window. Each move is logged as `self_upgrade` with `mode`
`idle`, `quiet` or `skew`, and for `quiet` and `skew` the number of chats still loaded.

## Release skew: a newer adapter beside an older host

On 2026-10-18 an operator installed 0.4.7 while Studio's service ran 0.4.6. Agents kept
turns running, so neither the idle rule nor the quiet rule (no turn ended in the last 5
minutes) ever fired. Studio's ChatGPT restarted and its adapter came up on 0.4.7, the
installed release. Every request from it failed for hours: the 0.4.6 host refuses a
generation whose `gatewaySdkSha256` is not its own gateway SDK, and the host masked that
refusal as "Execution operation failed; managed chat ownership was preserved", which the
app showed as "Failed to resume chat".

The host now says what is happening, and the service moves promptly:

1. **The message.** The host answers a generation request that names another release's
   gateway SDK with a fixed text for the direction (item 2), which it passes through
   unchanged and the adapter shows for the request: starting or resuming a chat, and a
   chat re-attaching after its executor went away. For `adapter_newer`: "This Mac's
   gateway service is moving to the newer release; this chat continues as soon as no
   turn is running". For `adapter_older`, or a direction that could not be told: "This app
   and this Mac's gateway service run different gateway releases; quit and reopen ChatGPT
   to load the installed release". The refusal is the chat's own failure, not a lost
   host, so it opens no fail-fast window. The host records `release_skew_refused` with a
   `direction` and a `count`, at most once a minute per direction
   ([diagnostics](diagnostics.md)). A host with no gateway SDK of its own cannot tell the
   sides apart and keeps the generic refusal.
2. **The direction.** The adapter is `adapter_newer` when its SDK checksum is the
   installed (pending) release's, read from `gateway-sdk/build.json` in that release's
   package; otherwise `adapter_older`. That receipt is not held to the running release's
   pins (patch, capabilities, revision, codex version, lockfiles): a release changes its
   SDK exactly when those change, so holding it to them would never find the new one. The
   reader checks the file as the runtime does (a regular file this user owns, not
   writable by others, at most 16 KiB, schema 1, this platform), takes `binarySha256` and
   does not hash the binary: the service that starts on that release verifies its SDK
   fully. A positive answer is kept per release; a receipt that cannot be read is read
   again at the next refusal.
3. **Urgent move.** A refused `adapter_newer` marks the pending release urgent. The
   supervisor then drops the 15 minute grace, tries the move every 10 seconds, and uses
   the quiet check with a quiet time of zero: no turn running in any engine and no
   background terminal, while a turn that ended seconds ago does not block it. Inference
   must still accept its own idle guard. A running turn is never stopped. The move is
   logged as `self_upgrade` with `mode: "skew"`. A refused SDK that is not the pending
   release's marks nothing urgent.
   Agents that run turns back to back may never be caught idle by a look every 10
   seconds, so while a release is urgent the host also looks at its engines, once a
   second, and tells the supervisor the moment no turn is running, no approval or input
   is pending and no chat keeps a background terminal, once per such gap. The supervisor
   then tries the move at once, through the same quiet check and inference guard. The
   look is cheap by design: one short admin connection per engine, a `thread/read` status
   per loaded chat (an `active` status covers a running turn and one waiting for an
   approval or input) and, only when no chat is active, its background terminals. It never
   asks for a turn list, so it never replays a chat's saved history, and it ends at the
   first chat that is busy. A look blocked by a background terminal, an unreadable chat or
   more than 256 chats backs off (1 s, doubling up to the 10 second tick) and returns to
   one second when a gap appears. Each look first checks that the release is still the
   pending one: after a rollback or a newer install the urgency is dropped, and the look
   stops until another refusal. The 10 second tick stays as the backstop.
   The host also does not stop a turn: it cannot hold one back, because turns start on
   engine sockets, not through the host. The quiet check reads every chat, then looks
   once more at every engine's chat statuses right before it closes the gate, which
   leaves a window of a few milliseconds. A turn that starts inside it can still be cut
   when the service stops, as at any service restart, and continues from saved history
   after a resume.
4. **The reverse case.** Once the service has moved, an adapter of the older release
   that asks for a generation gets the `adapter_older` message above, recorded as
   `adapter_older`. Nothing else changes: that adapter moves when the app restarts.

# Shared native session ownership

Native sharing has a separate `sharedNativeExecutor` setting. It does not enable
`sharedExecutors` for gateway chats. One original signed SDK owns the original
native home, while local and connected-machine adapters attach as independent
Unix clients. A second client can read the actual running turn and Stop it,
rather than reading a saved rollout through an unrelated SDK process.

For laptops that sleep or disconnect, executor ownership must outlive the client
connection. See [sleep, travel, and reconnects](travel-recovery.md) for the
durability boundary and the checks that prove reconnect does not replay work.

Native sharing can also be staged without closing active applications:

```sh
gateway service shared-native --on-restart
```

This writes a separate pending intent and leaves the current service plan and
processes alone. Only a subsequent primary LaunchAgent start can activate it.
Startup rechecks the original plan, verified SDK, and existing writers. An old
adapter, a changed plan, or an uncertain owner leaves activation pending; nothing
is killed to make it pass. Existing gateway sharing and service components keep
their values.

On an installation that also needs service-owned gateway executors, explicitly
include them in that staged adoption:

```sh
gateway service shared-native --on-restart --with-gateway
```

Staging and installation are not proof of activation. Check the live service after
natural adoption; combined native and gateway sharing also requires
`gateway rollout --verify`. That command's canary requires gateway sharing, so
native-only adoption is checked through service status and the native fixture.
The immediate migration below continues to require its existing maintenance window.

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

## Automatic model selection maintenance

The optional [automatic latest models](auto-latest-models.md) setting owns a
separate configuration-specific LaunchAgent, named
`com.edihasaj.harness-gateway.models-<path-hash>`. It checks model metadata every
five minutes through the installed managed launcher. It is not an inference
service and never restarts one. Disabling the setting removes only its owned
maintenance job. Install a release supporting `auto-latest probe` before enabling
the setting; the app reports a scheduling failure if that command is unavailable.
