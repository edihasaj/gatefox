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
