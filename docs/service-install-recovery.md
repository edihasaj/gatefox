---
summary: 'Bounded teardown checks before replacing or restoring a legacy standalone service.'
read_when:
  - Changing legacy macOS service installation or rollback
  - Investigating a bootstrap failure while a previous service is still exiting
---

# Legacy service installation recovery

A successful `launchctl bootout`, or a job disappearing from `launchctl print`,
does not by itself establish that the original process has exited. The legacy
standalone installer must confirm both before enabling and bootstrapping either
the replacement definition or the original definition during rollback.

The installer captures the original process identity before asking it to stop.
Its bounded teardown check distinguishes the original process from a later
process that reuses the PID. Unknown process state, permission failures, and
ambiguous launchd failures block reload. The check never force-kills a process
or unloads an intervening replacement job.

The wait uses the service stop budget (currently 13 seconds) with a monotonic
elapsed-time deadline. Each operating-system inspection also has its own timeout.
The installer checks process identity again after disabling the job and before
sending the idle-exit signal.

If teardown cannot be confirmed within the deadline, the installer retains the
original definition for recovery and reports the incomplete rollback. It must
not claim that the old service is running merely because its plist was restored.
Before replacing the plist, it saves its original bytes in a unique private file
under `<stateDirectory>/service-backups/`. Successful replacement or rollback
removes that backup; incomplete recovery leaves it available for inspection.

This path applies to legacy standalone service replacement. A machine with a
unified service plan uses the existing unified installer, which preserves a
running service. Normal `gateway service restart` keeps its idle guard.

Regression tests inject launchctl responses, process identities, and a virtual
clock. They cover a removed job whose process is still draining, confirmed exit,
PID reuse, timeouts, inspection failures, and rollback ordering without restarting
any live service.
