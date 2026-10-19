#!/usr/bin/env node
// The cleanup of an end-to-end check that was SIGKILLed (scripts/e2e-shared-execution.mjs), which cannot run its own. The check
// starts it first, detached in a process group of its own, as: node e2e-reaper.mjs PARENT_PID FAKE_HOME SDK_ROOT.
//
// While the check runs, the reaper notes, twice a second, the process groups the check lists in `<FAKE_HOME>/.groups` and the SDK
// sockets its links point at: every link under FAKE_HOME whose target is a socket name in SDK_ROOT, the pinned SDK's fixed folder.
// It keeps what it saw, because a host the check left removes FAKE_HOME by itself. A group is only ever signalled while it is seen
// alive: a `-<pid>` line, which the check writes once a group it listed has emptied, or a probe the group does not answer, marks it
// gone for good, so that a pid the system later hands to another process is never killed by mistake. A SIGTERM (the check ended
// normally) ends the reaper with nothing done. When the check's process is gone instead, it SIGKILLs every noted group that is not
// gone, waits for each to empty, removes each noted socket that a connect is refused at (scripts/stale-sockets.mjs) and its `.lock`
// file once the socket is gone, and removes FAKE_HOME. A socket something still serves, a file that is not this user's socket,
// a group that ended or was announced gone, and anything it never noted stay.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { groupGone } from "./group-gone.mjs";
import { isStale, ownSocket, sdkSocketName } from "./stale-sockets.mjs";

const [parentText, fakeHome, sdkRootText] = process.argv.slice(2);
const parent = Number(parentText);
if (!Number.isSafeInteger(parent) || parent < 2 || !fakeHome || !sdkRootText) process.exit(2);
const uid = process.getuid?.();
let sdkRoot; try { sdkRoot = realpathSync(sdkRootText); } catch { sdkRoot = resolve(sdkRootText); }
const groups = new Set(); const targets = new Set(); const gone = new Set();

/** Notes the listed groups and every link's SDK target under the fake home; what is unreadable is simply not noted. */
function note() {
  // A `-<pid>` line is the check's own notice that a group it listed has emptied; a plain one only lists a group it still has.
  try {
    for (const line of readFileSync(join(fakeHome, ".groups"), "utf8").split("\n")) {
      const text = line.trim(); const announced = text.startsWith("-"); const pid = Number(announced ? text.slice(1) : text);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      if (announced) gone.add(pid); else if (!gone.has(pid)) groups.add(pid);
    }
  } catch { /* Not written yet, or gone. */ }
  // A group that does not answer a probe of its own is empty already, and its pid is another process's by the next look: gone, forever.
  for (const leader of groups) if (!gone.has(leader)) { try { process.kill(-leader, 0); } catch { gone.add(leader); } }
  const walk = (path, depth) => {
    if (depth > 12) return;
    let entries; try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isSymbolicLink()) {
        try {
          const target = resolve(dirname(full), readlinkSync(full)); let folder = dirname(target);
          try { folder = realpathSync(folder); } catch { /* Judged as written. */ }
          if (folder === sdkRoot && sdkSocketName(basename(target))) targets.add(join(folder, basename(target)));
        } catch { /* Not ours to judge. */ }
      }
    }
  };
  walk(fakeHome, 0);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } };

async function reap() {
  note();
  const leaders = [...groups].filter(leader => !gone.has(leader));
  for (const leader of leaders) { try { process.kill(-leader, "SIGKILL"); } catch { /* Already gone. */ } }
  await Promise.all(leaders.map(leader => groupGone(leader, 10000)));
  await Promise.all([...targets].map(async target => {
    let info; try { info = lstatSync(target); } catch { info = undefined; }
    if (info) { if (!ownSocket(info, uid) || !await isStale(target)) return; try { unlinkSync(target); } catch { return; } }
    // The SDK keeps an empty `<socket>.lock` beside each socket and removes it only when it stops cleanly.
    try { const lock = lstatSync(target + ".lock"); if (lock.isFile() && lock.uid === uid && lock.size === 0) unlinkSync(target + ".lock"); } catch { /* None. */ }
  }));
  try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Best effort. */ }
  process.exit(0);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
const timer = setInterval(() => {
  if (alive(parent) && process.ppid === parent) { note(); return; }
  clearInterval(timer); void reap();
}, 500);
note();
