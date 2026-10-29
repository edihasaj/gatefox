---
summary: 'Readiness evidence for an installed gateway release.'
read_when:
  - Installing or publishing a gateway release
  - Investigating a stale desktop executor, missing tool runner, or failed chat resume
---

# Rollout readiness

Run `gateway rollout` after each machine installs the published archive. It is a
read-only gate: it does not restart the service, acquire a gateway generation,
or reconnect a desktop client.

```
gateway rollout
gateway rollout --json
gateway rollout --verify
```

`ready` means all of the following agree on one installed release:

1. Each relevant loaded gateway process has a known immutable release and it
   matches the installed release.
2. The service status belongs to the currently running service PID, has a fresh
   frozen `runningRelease`, and its running plan components are current.
3. The local inference health endpoint answers HTTP 200 with the installed
   `X-Gateway-Release` header. A successful body alone is insufficient.
4. The execution host belongs to that service PID and OS start stamp, attests
   its immutable release source, active catalog fingerprint, verified SDK, and
   direct-tool compatibility.
5. The host's fresh canary proves a completed turn with a direct tool edit and
   Git commit. Its proof must name the same host, SDK, source, and active
   catalog fingerprint.

A pending Claude consolidation cannot earn `ready`, even when the old service's
canary passes. A normal pending receipt waits until every legacy Claude job is
unloaded; an idle socket snapshot does not make an automatic cutover safe. A
receipt explicitly staged with `gateway service claude-desktop --on-restart --force`
may interrupt its exact owned jobs and must be treated as a maintenance-window
cutover, not normal automatic migration. The gate checks the staged receipt before
and after verification. Once adopted, each Claude component must have its own running PID, matching OS
start and expected executable. Its deliberately pinned private JavaScript is not
relabeled as the main installed release; its authenticated endpoints require
separate post-migration checks.

The normal command accepts only a host-controlled cached canary report that is
less than five minutes old and still matches the live status. `--verify` runs a
new isolated serving-host canary. It uses a local mock provider and a temporary
repository; it does not use an account, send provider inference, replay chats,
or write user gateway state.

| State | Exit | Meaning |
| --- | ---: | --- |
| `ready` | 0 | All required live evidence agrees. |
| `pending` | 1 | A process, service, host, or proof has not adopted the release yet. Recheck after idle adoption. |
| `blocked` | 1 | The host explicitly reports active work, so a canary was not claimed. |
| `failed` | 2 | Inference or the direct-tool canary failed. Investigate before publishing or declaring the machine ready. |

The command reports only fixed reason codes, counts, versions, capabilities and
PIDs. It does not print command lines, paths, request bodies, tool arguments,
configuration values, or probe-child output.

A pending native-sharing intent keeps the rollout pending even when its gateway
tool canary passes. After combined adoption, the host must also hold the actual
native-home lease; advertising the native capability alone is insufficient.
The current canary requires gateway sharing. A native-only service uses its
service status and the shared-native fixture instead of this combined gate.

A live supervisor controller reports `runtime.controllerRelease` independently
from its root's `runningRelease`. Controller adoption does not change the
bootstrap process version or attest the retained host and relay. Those components
remain pending in this gate until their own evidence agrees with the installed
release; a controller swap must never be relabeled as full rollout readiness.
