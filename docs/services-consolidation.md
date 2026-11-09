---
summary: "Keep one signed GateFox background item and consolidate only proven-owned legacy jobs."
read_when:
  - Changing service ownership and consolidation
---

# Service ownership and consolidation

Return to the [managed service overview](services.md).

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

## Preview and apply consolidation

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

## Child lifecycle and recovery

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

## Restart and uninstall

`gateway service restart` requires the same maintenance window. When the running
plan has no inference component (a Mac moving from client-only to standalone),
the window skips the inference health check because nothing listens yet. The inference
child must accept its own idle guard before the supervisor stops its other
components. When a Claude component is configured, the supervisor always declines
that idle restart, so the command refuses up front and says why.

`gateway service restart --force` is the explicit operator restart. It still
requires the maintenance window (ChatGPT quit, inference idle), then has launchd
stop and start the service (`launchctl kickstart -k`): the supervisor's SIGTERM path
drains inference for `GATEWAY_SHUTDOWN_DRAIN_MS` and stops every component, including
Claude components, which can interrupt Claude work. It waits up to a minute for the
new process and reports `restart: "forced"`; a plain restart reports `restart: "idle"`.
Use it to adopt an installed release when Claude components hold the automatic move,
then confirm with `gateway rollout --verify`.

`gateway service restart --interrupt` is the same launchd restart without the
maintenance window or the client-only inference guard: it runs while ChatGPT is open, remote chats are connected or
inference is busy, ends every running turn, and reports `restart: "interrupted"`. It is
the way out of a service that cannot find an idle moment while chats are refused
(`gateway rollout` says `blocked: release_skew`); a release that forwards never needs it.

`gateway service uninstall` explicitly stops all owned components
and moves the plan and LaunchAgent to Trash. Provider credentials remain. A job
launchd has already dropped (`launchctl bootout` reporting `3: No such process`)
can be absent while its process still drains. Legacy standalone installation
requires both job removal and process exit before replacement or rollback; see
[service installation recovery](service-install-recovery.md).

## Shutdown drain

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

## Tunnel and native registration

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

## Remove an owned tunnel

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

## Consolidate at the next login

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

## Rollback recovery

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

## Repair disabled jobs and SSH forwards

Explicit tunnel installation and desktop registration enable their managed
LaunchAgent before loading it. This repairs a disabled registration without
restarting an already loaded job. New tunnel jobs limit the initial SSH connection
to one ten-second attempt; launchd or the unified supervisor retries after failure.
Existing active tunnel arguments stay unchanged until a maintenance update.
Adopted Claude reverse forwards record an owned child/start identity and its
verified remote sshd listener, start stamp and TCP peer. A reconnect can clear
only that exact former listener after the original client has exited. Missing
proof, changed settings, foreign owners and unreadable state preserve the port.
Controller adoption records already-running forwards without interrupting them.
This recovery uses one bounded SSH probe at connection startup, no extra daemon,
and currently records direct IPv4 SSH connections on port 22. Unsupported routes
remain conservative. Generic same-user port cleanup stays disabled for Claude.
The unified supervisor also adds these defaults when it starts a newly owned SSH
child from an older plan. Explicit command-line timeout and attempt values,
forwarding endpoints, and SSH profile paths remain unchanged. It does not rewrite
the stored plan or replace a running tunnel to add defaults.
Network loss can interrupt forwarding, but a loaded KeepAlive job keeps retrying.
An unloaded job needs registration again; its plist alone does not start a process
in the current login session.
