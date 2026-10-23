---
summary: 'Automatic recovery of managed SSH and executor sockets after a Mac reboots.'
read_when:
  - Investigating SSH connection refusals or socket ownership failures after a reboot
  - Changing recovery of managed SSH listeners or executor socket identities
---

# Recovery after a reboot

macOS can assign a different device number to the same filesystem after a reboot.
An old socket can retain its inode while its saved ownership receipt names another
device. Its serving process is gone, and the SDK's physical socket under `/tmp`
may have disappeared too.

Managed SSH bootstraps and executor recovery recognize this previous boot state
automatically. They validate private managed paths, prove that no listener serves
them, and recheck the observed socket identity before removing stale entries.
New SSH records carry the boot and writer identity. Legacy records use the
existing boot-time heuristic, with a one-minute margin and old socket timestamps.
A device mismatch from the current boot still refuses recovery. A live listener,
uncertain probe, or foreign ownership remains protected.

The next SSH connection recreates its listener. The unified service retries a
failed execution host automatically; an adapter can request an earlier retry.
Each machine uses its own configuration and native home. Recovery does not copy
credentials, change registrations, or replay an inference turn.

Sleep and network reconnection retain the existing transport retry behavior;
see [travel recovery](travel-recovery.md). Recreating sockets does not inject a
gateway adapter into a ChatGPT process that started before desktop registration
was restored. Its next normal launch uses the registered adapter. Active apps
and conversations are never stopped to force adoption.

Check `gateway service status`, `gateway health`, and
`gateway rollout --verify --json` after an update. File installation alone does
not prove that every open app has adopted the new release;
[rollout readiness](rollout.md) reports that separately.
