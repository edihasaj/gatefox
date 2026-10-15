// Waits for a process group to be empty, for the test runner (scripts/run-tests.mjs).

/**
 * Settles with true once no process is left in the process group led by `leader`, or with false after `ms`. A process that was sent
 * SIGKILL is gone when the kernel has torn it down, which is after the signal was sent; the sockets it listened on close only then.
 */
export async function groupGone(leader, ms) {
  const end = Date.now() + ms;
  for (;;) {
    // A group that cannot be looked at (it is gone, or no longer ours) has nothing left to wait for.
    try { process.kill(-leader, 0); } catch { return true; }
    if (Date.now() >= end) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
