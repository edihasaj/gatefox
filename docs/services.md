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

The same ownership rule includes the Claude Desktop integration. Its separate
configuration and loopback listeners do not justify separate startup jobs.
Legacy `com.edihasaj.claude-*` adapters, private inference and SSH forwards must
be counted in a gateway audit, even though their labels do not say `gateway`.
Node executables and SSH processes remain children of the one signed app-owned
root, not additional LaunchAgents. See [Claude Desktop](claude-desktop.md#apply-and-run)
for the read-only preview and next-start migration. Never disable a generic
`node` Login Items row without identifying its registrations: it can contain
the live Claude bridge or unrelated applications.

Claude consolidation has a stricter admission rule than a socket-idle restart:
the pinned private runtime has no atomic request-drain protocol. A normal staged
receipt adopts only when every legacy Claude job is unloaded, including SSH
tunnels. It does not substitute an idle connection snapshot for that guarantee.
An operator who has approved a maintenance interruption can stage exactly one
receipt with `gateway service claude-desktop --on-restart --force`; that receipt
may retire only its still-matching owned jobs and can interrupt Claude work.

Once any Claude component is configured, automatic primary-service restarts and
upgrade activation remain pending even when no socket is currently busy. The
pinned runtimes have no atomic admission gate, so a new request could otherwise
arrive after an idle check. An explicit operator restart remains available for an
authorized maintenance window: `gateway service restart --force` (see below); a
plain `gateway service restart` refuses and names that reason. Adopted Claude SSH forwards retain their
processes across wake; their existing keepalives and confirmed-exit retries
recover connections instead of a forced wake restart or broad remote cleanup.
Restaging without `--force` removes that authorization. This never forces busy
Codex work to restart.

The TCP-only Claude activity probe tolerates one specific unrelated diagnostic:
`lsof` cannot stat a CoreDevice `devicefs` mount under
`/Users/<account>/Library/Developer/CoreDevice/DeviceFS` and falls back to the
mount table's device number. It requires that complete three-line diagnostic;
partial, changed, or additional diagnostics still refuse the probe. Darwin
[`lsof` reads mount metadata](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/dialects/darwin/libproc/dmnt.c#L143)
separately from its
[`libproc` socket inspection](https://github.com/apple-oss-distributions/lsof/blob/7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255/lsof/dialects/darwin/libproc/dsock.c#L482),
so this filesystem warning does not hide established TCP connections. Socket
output, timeouts, unexpected exits, and unknown or reused process identities
remain refusals. This exception does not enable automatic restarts with Claude
components configured.

## Choose a task

| Task | Guide |
| --- | --- |
| Background-item ownership and consolidation | [Service ownership](services-consolidation.md) |
| Shared chat executors and native-home ownership | [Shared execution](services-shared-executors.md) |
| Updates, retained components and release skew | [Release adoption](services-releases.md) |

## Live supervisor controller updates

Read [live supervisor controller updates](services-releases.md#live-supervisor-controller-updates) in the focused guide.

## The name macOS shows

Read [the name macos shows](services-consolidation.md#the-name-macos-shows) in the focused guide.

## Shared chat executors

Read [shared chat executors](services-shared-executors.md#shared-chat-executors) in the focused guide.

## Moving to a new release

Read [moving to a new release](services-releases.md#moving-to-a-new-release) in the focused guide.

## The host waits while an app is attached

Read [the host waits while an app is attached](services-releases.md#the-host-waits-while-an-app-is-attached) in the focused guide.

## Desktop adapters wait for the app's next launch

Read [desktop adapters wait for the app's next launch](services-releases.md#desktop-adapters-wait-for-the-apps-next-launch) in the focused guide.

## Release skew: a newer adapter beside an older host

Read [release skew: a newer adapter beside an older host](services-releases.md#release-skew-a-newer-adapter-beside-an-older-host) in the focused guide.

## Per-chat rollout: newer adapters run on the installed release's SDK

Read [per-chat rollout: newer adapters run on the installed release's sdk](services-releases.md#per-chat-rollout-newer-adapters-run-on-the-installed-releases-sdk) in the focused guide.

## An app update while the service runs

Read [an app update while the service runs](services-releases.md#an-app-update-while-the-service-runs) in the focused guide.

## Masked execution failures

Read [masked execution failures](services-releases.md#masked-execution-failures) in the focused guide.

## Shared native session ownership

Read [shared native session ownership](services-shared-executors.md#shared-native-session-ownership) in the focused guide.

## Automatic model selection maintenance

Read [automatic model selection maintenance](services-releases.md#automatic-model-selection-maintenance) in the focused guide.
