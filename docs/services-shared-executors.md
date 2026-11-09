---
summary: "Shared gateway executors, native-home ownership and hosted model maintenance."
read_when:
  - Changing shared chat and native execution
---

# Shared chat and native execution

Return to the [managed service overview](services.md).

## Shared chat executors

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
rule instead (see [Moving to a new release](services-releases.md#moving-to-a-new-release)).

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

## Shared native session ownership

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
The 1.8.5 auth-helper rename/deadline change also has a bounded compatibility
variant: both aliases must be verified identical managed executables for the same
installation before the earlier metadata is offered to the retained host.
Endpoints, credential args, permissions and cwd remain strict. Compatibility is
bounded to eight ownership requests, never inference requests.
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
