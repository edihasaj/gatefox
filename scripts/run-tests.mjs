#!/usr/bin/env node
// Runs the compiled test suite in its own process group under a private temp folder and a private home folder, so that the real
// ones are left as they were and a broken test fails the run instead of hanging it. The execution-host tests keep their host
// folders, receipts and socket links under the home folder (`$HOME/.local/state/gw-exec`), so HOME points at `<folder>/home`
// for the whole suite and nothing of theirs reaches the real one. (The fixed `/tmp/codex-daemon-<uid>` socket rendezvous the pinned SDK
// uses for the sockets themselves is kept out by the tests: each file that starts a host points it at a folder of its own, see
// src/tests/isolated-execution-roots.ts. Should a stopped run still leave a socket there, the runner removes each one that the run's
// folder links to and that no process listens on, after asking again for a few seconds in case its owner is still being torn down.
// GATEWAY_TEST_SDK_ROOT names another folder for that cleanup; only the runner's own tests set it, so they never touch the real one.)
//
// Several tests start gateways and fixture Copilot CLIs. Their startup sweep and their folders live under
// `<TMPDIR>/harness-gateway-copilot-<uid>`, and a test that wrote there would delete a running gateway's leftovers or leave
// a marker that makes an installed release skip its first scan. The runner creates one private folder, points TMPDIR at it
// for the whole suite, and removes it afterwards, whatever the outcome. Arguments name test files (default: every
// `dist/tests/*.test.js`); GATEWAY_TEST_TMPDIR tells the isolation test what the suite was given.
//
// Two limits keep a regression from hanging the run: every test that sets no timeout of its own fails after
// GATEWAY_TEST_TIMEOUT_MS (default 120000), and a test file's process exits once its tests have ended, so a fixture server or CLI
// handle left open cannot hold it. The suite runs in its own process group, and a signal to the runner is passed to the whole
// group (and escalated to SIGKILL after a grace); the runner waits for the group to leave, so that the test processes finish their
// exit handlers, and then exits with 128 plus the signal, with no test process left behind.
// Each test process also exits on the signal instead of dying of it (scripts/test-preload.mjs), so the Copilot CLIs it started,
// which run in groups of their own, are stopped with it; the fixture CLIs leave when their parent does as well.
//
// A run that left a test's receipt in the user's real `~/.local/state/gw-native` or `gw-exec` fails, naming each file and
// removing none (scripts/real-state-guard.mjs); test processes themselves refuse those roots (src/test-root-guard.ts).
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { groupGone } from "./group-gone.mjs";
import { isStale, ownSocket, sdkSocketName } from "./stale-sockets.mjs";
import { watchRealState } from "./real-state-guard.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsFolder = join(root, "dist", "tests");
const requested = process.argv.slice(2);
const fail = message => { process.stderr.write(`${message}\n`); process.exit(2); };
let files;
try { files = requested.length ? requested : readdirSync(testsFolder).filter(name => name.endsWith(".test.js")).sort().map(name => join(testsFolder, name)); }
catch (error) { if (error?.code === "ENOENT") fail("No compiled tests found; run npm run build first."); throw error; }
if (!files.length) fail("No compiled tests found; run npm run build first.");

const timeout = Number(process.env.GATEWAY_TEST_TIMEOUT_MS) > 0 ? Math.round(Number(process.env.GATEWAY_TEST_TIMEOUT_MS)) : 120000;
// The path is short on purpose: tests put Unix sockets deep under this folder, and a socket path cannot exceed 104 bytes on
// macOS, where the user's temp folder alone is 48. So on Unix the folder lives in /tmp, not in the user's temp folder.
const folder = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "gwt-"));
// The home folder is private (0700) and inside it, so the execution-host folders the tests make go with the run's folder.
const home = join(folder, "home"); mkdirSync(home, { mode: 0o700 });
const codexHome = join(home, ".codex"); mkdirSync(codexHome, { mode: 0o700 });
const remove = () => { try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Best effort; it is one folder under the temp folder. */ } };
const grouped = process.platform !== "win32";
// The user's own state folders, taken before the run: a receipt a test left there fails the run (see real-state-guard.mjs).
const realStateLeaks = watchRealState(homedir());
// How long a stopped suite may take to end before its group gets SIGKILL.
const killGrace = Number(process.env.GATEWAY_TEST_KILL_GRACE_MS) > 0 ? Number(process.env.GATEWAY_TEST_KILL_GRACE_MS) : 10000;
const preload = pathToFileURL(join(root, "scripts", "test-preload.mjs")).href;
const child = spawn(process.execPath, ["--import", preload, "--test", "--test-force-exit", `--test-timeout=${timeout}`, ...files], { cwd: root, stdio: "inherit", detached: grouped,
  env: { ...process.env, TMPDIR: folder, TEMP: folder, TMP: folder, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, GATEWAY_TEST_TMPDIR: folder } });
/** Signals the suite's whole process group (the child leads it), or just the child where there are no groups. */
const send = signal => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already gone. */ } };
let stopped;
// A stopped runner stops the whole suite and still removes its folder.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
  stopped ??= signal; send(signal);
  setTimeout(() => send("SIGKILL"), killGrace).unref();
});
child.once("error", error => { process.stderr.write(`Could not start the test run: ${error.message}\n`); remove(); process.exit(2); });
/**
 * The pinned SDK puts the socket of an execution host in a fixed folder, `/tmp/codex-daemon-<uid>`, and the run's folder holds a
 * symlink to it. A run that was stopped leaves the socket file behind. Each one the run's folder links to is removed when nothing
 * listens on it (the same rule as src/execution-host-storage.ts removeOwnedSocket); a socket something still serves, and every
 * file the run did not link to, is left alone.
 */
async function removeStaleSockets() {
  if (process.platform === "win32" || !process.getuid) return;
  let rendezvous; try { rendezvous = process.env.GATEWAY_TEST_SDK_ROOT ? realpathSync(process.env.GATEWAY_TEST_SDK_ROOT) : join(realpathSync("/tmp"), `codex-daemon-${process.getuid()}`); } catch { return; }
  const targets = new Set();
  const walk = path => {
    let entries; try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) {
        try { const target = resolve(dirname(full), readlinkSync(full)); if (dirname(target) === rendezvous && sdkSocketName(basename(target))) targets.add(target); } catch { /* Not readable: not ours. */ }
      }
    }
  };
  walk(folder);
  // All at once: a socket that is still served is asked for a few seconds, and they should not add up.
  await Promise.all([...targets].map(async target => {
    try { const info = lstatSync(target); if (!ownSocket(info, process.getuid())) return; } catch { return; }
    if (await isStale(target)) { try { unlinkSync(target); } catch { /* Best effort. */ } }
  }));
}
child.once("exit", async (code, signal) => {
  // The leader leaves as soon as it is signalled, while the test processes in its group are still running their exit handlers, which
  // stop the Copilot CLIs they started (those run in groups of their own). A run that was stopped gives them the time to finish, up to
  // the kill grace, which also sends SIGKILL to the group when it ends.
  if (stopped && grouped && child.pid) await groupGone(child.pid, killGrace);
  // Whatever is left running in the group goes with the run.
  send("SIGKILL");
  // Nothing of the run is left running when its folder goes, and a socket is looked at only after its owner is gone. (A killed process
  // leaves its group before the kernel has closed its sockets, so removeStaleSockets also asks a socket again before it believes it.)
  if (grouped && child.pid) await groupGone(child.pid, 10000);
  await removeStaleSockets().catch(() => {}); remove();
  const name = stopped ?? signal;
  const leaks = realStateLeaks();
  if (leaks.length) process.stderr.write(`The run left test receipts in the real gateway state; nothing was removed:\n${leaks.map(path => `  ${path}\n`).join("")}`);
  process.exit(name ? 128 + (constants.signals[name] ?? 15) : leaks.length && !code ? 1 : code ?? 1);
});
