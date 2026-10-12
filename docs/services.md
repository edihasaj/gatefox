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
