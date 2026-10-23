import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autoLatestLabel, autoLatestPlist, autoLatestScheduleStatus, syncAutoLatestSchedule, type AutoLatestScheduleTools } from "../model-auto-latest/schedule.js";
import { shortFolder } from "./short-folder.js";

const launcherText = "#!/bin/sh\n# Managed by subscription-gateway installer\nexec true\n";

/** A fake machine: its own home, its own /tmp, and a launchctl that only remembers labels. Nothing reaches the real launchd. */
async function machine(options: { launcher?: boolean; probe?: boolean; failBootstrap?: boolean; platform?: NodeJS.Platform } = {}) {
  const folder = await shortFolder("al-sched-");
  const root = await realpath(folder.directory);
  const home = join(root, "home"); const tmpRoot = join(root, "tmp");
  await mkdir(join(home, ".local", "bin"), { recursive: true, mode: 0o700 }); await mkdir(tmpRoot, { mode: 0o700 });
  await chmod(home, 0o700); await chmod(join(home, ".local"), 0o700); await chmod(join(home, ".local", "bin"), 0o700);
  if (options.launcher !== false) await writeFile(join(home, ".local", "bin", "harness-gateway"), launcherText, { mode: 0o700 });
  const loaded = new Set<string>(); const calls: string[][] = [];
  const tools: AutoLatestScheduleTools = {
    platform: options.platform ?? "darwin", uid: process.getuid!(), home, tmpRoot,
    launchctl: async args => {
      calls.push(args);
      const label = args[args.length - 1]!.split("/").pop()!.replace(/\.plist$/, "");
      if (args[0] === "print") { if (!loaded.has(label)) throw Object.assign(new Error("x"), { code: 113, stderr: "Could not find service" }); return "state = waiting"; }
      if (args[0] === "bootout") { if (!loaded.delete(label)) throw Object.assign(new Error("x"), { stderr: "3: No such process" }); return ""; }
      if (args[0] === "bootstrap") { if (options.failBootstrap) throw Object.assign(new Error("x"), { stderr: "5: Input/output error" }); loaded.add(label); return ""; }
      return "";
    },
    probe: async () => options.probe !== false,
    stateDirectory: async () => join(home, "state"),
    sleep: async () => undefined,
  };
  const config = join(home, "gateway.json"); await writeFile(config, "{}");
  return { tools, home, config, loaded, calls, remove: folder.remove, plist: (label: string) => join(home, "Library", "LaunchAgents", `${label}.plist`) };
}

test("enabling installs a private plist and loads only the owned job", async t => {
  const m = await machine(); t.after(m.remove);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true });
  const label = autoLatestLabel(await realpath(m.config));
  assert.match(label, /^com\.edihasaj\.harness-gateway\.models-[0-9a-f]{16}$/);
  assert.deepEqual([...m.loaded], [label]);
  const text = await readFile(m.plist(label), "utf8");
  assert.equal((await stat(m.plist(label))).mode & 0o777, 0o600);
  assert.match(text, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(text, /<key>LowPriorityIO<\/key><true\/>/);
  assert.match(text, /<string>auto-latest<\/string><string>check<\/string>/);
  assert.equal(text.includes("subscription-gateway.plist"), false);
  assert.deepEqual(m.calls.filter(call => call[0] !== "print").map(call => call[0]), ["enable", "bootstrap"]);
  assert.equal(m.calls.some(call => call.join(" ").includes("com.edihasaj.subscription-gateway")), false, "the inference service was touched");
  assert.equal((await stat(join(m.home, "state", "model-auto-latest"))).mode & 0o077, 0);
  assert.equal((await stat(join(m.tools.tmpRoot, `harness-gateway-model-refresh-${m.tools.uid}`))).mode & 0o077, 0);
});

test("enabling again changes nothing, and a changed definition replaces only that job", async t => {
  const m = await machine(); t.after(m.remove);
  await syncAutoLatestSchedule(m.config, true, m.tools);
  m.calls.length = 0;
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true });
  assert.deepEqual(m.calls.map(call => call[0]), ["print"]);
  await writeFile(join(m.home, ".local", "bin", "gateway"), launcherText, { mode: 0o700 });
  const label = autoLatestLabel(await realpath(m.config));
  await writeFile(m.plist(label), (await readFile(m.plist(label), "utf8")).replace("300", "600")); // drifted by hand
  m.calls.length = 0;
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true });
  assert.deepEqual(m.calls.filter(call => call[0] !== "print").map(call => call[0]), ["bootout", "enable", "bootstrap"]);
});

test("disabling boots out and removes only this configuration's job", async t => {
  const m = await machine(); t.after(m.remove);
  const other = join(m.home, "other.json"); await writeFile(other, "{}");
  await syncAutoLatestSchedule(m.config, true, m.tools); await syncAutoLatestSchedule(other, true, m.tools);
  assert.equal(m.loaded.size, 2);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, false, m.tools), { scheduled: false });
  assert.deepEqual([...m.loaded], [autoLatestLabel(await realpath(other))]);
  assert.equal((await readdir(join(m.home, "Library", "LaunchAgents"))).length, 1);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, false, m.tools), { scheduled: false }, "disabling twice is fine");
});

test("an unavailable job reports a fixed reason and the real state", async t => {
  const none = await machine({ launcher: false }); t.after(none.remove);
  assert.deepEqual(await syncAutoLatestSchedule(none.config, true, none.tools), { scheduled: false, reason: "launcher_unavailable" });
  const old = await machine({ probe: false }); t.after(old.remove);
  assert.deepEqual(await syncAutoLatestSchedule(old.config, true, old.tools), { scheduled: false, reason: "command_unavailable" });
  assert.equal(old.calls.some(call => call[0] === "bootstrap"), false);
  const broken = await machine({ failBootstrap: true }); t.after(broken.remove);
  assert.deepEqual(await syncAutoLatestSchedule(broken.config, true, broken.tools), { scheduled: false, reason: "launchctl_failed" });
  assert.deepEqual(await readdir(join(broken.home, "Library", "LaunchAgents")), [], "a job launchd does not have left a file behind");
  const other = await machine({ platform: "linux" }); t.after(other.remove);
  assert.deepEqual(await syncAutoLatestSchedule(other.config, true, other.tools), { scheduled: false, reason: "unsupported" });
  assert.equal(other.calls.length, 0);
});

test("a failed repair keeps reporting a job that is still loaded", async t => {
  const m = await machine(); t.after(m.remove);
  await syncAutoLatestSchedule(m.config, true, m.tools);
  await writeFile(join(m.home, ".local", "bin", "harness-gateway"), "#!/bin/sh\nexec true\n", { mode: 0o700 }); // no longer ours
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true, reason: "launcher_unavailable" });
});

test("launchers that are not the installer's own are refused", async t => {
  for (const [name, prepare] of [
    ["link", async (path: string) => { await writeFile(`${path}.real`, launcherText, { mode: 0o700 }); await symlink(`${path}.real`, path); }],
    ["writable", async (path: string) => { await writeFile(path, launcherText, { mode: 0o700 }); await chmod(path, 0o777); }],
    ["not executable", async (path: string) => { await writeFile(path, launcherText, { mode: 0o600 }); }],
    ["no marker", async (path: string) => { await writeFile(path, "#!/bin/sh\nexec true\n", { mode: 0o700 }); }],
    ["no header", async (path: string) => { await writeFile(path, "# Managed by subscription-gateway installer\n", { mode: 0o700 }); }],
  ] as const) {
    const m = await machine({ launcher: false }); t.after(m.remove);
    await prepare(join(m.home, ".local", "bin", "harness-gateway"));
    assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: false, reason: "launcher_unavailable" }, name);
  }
});

test("a plist we did not write, or a linked one, is never replaced or removed", async t => {
  const m = await machine(); t.after(m.remove);
  const label = autoLatestLabel(await realpath(m.config));
  await mkdir(join(m.home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(m.plist(label), "<plist>someone else</plist>");
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: false, reason: "foreign_job" });
  assert.deepEqual(await syncAutoLatestSchedule(m.config, false, m.tools), { scheduled: false, reason: "foreign_job" });
  assert.equal(await readFile(m.plist(label), "utf8"), "<plist>someone else</plist>");
  assert.equal(m.calls.some(call => call[0] === "bootout" || call[0] === "bootstrap"), false);
  const linked = await machine(); t.after(linked.remove);
  const linkedLabel = autoLatestLabel(await realpath(linked.config));
  await mkdir(join(linked.home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(join(linked.home, "target.plist"), "x"); await symlink(join(linked.home, "target.plist"), linked.plist(linkedLabel));
  assert.deepEqual(await syncAutoLatestSchedule(linked.config, true, linked.tools), { scheduled: false, reason: "foreign_job" });
});

test("a state folder or home another user can write is unsafe", async t => {
  const m = await machine(); t.after(m.remove);
  await mkdir(join(m.home, "state"), { mode: 0o700 }); await chmod(join(m.home, "state"), 0o777);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: false, reason: "unsafe_path" });
  const bin = await machine(); t.after(bin.remove);
  await chmod(join(bin.home, ".local", "bin"), 0o777);
  assert.deepEqual(await syncAutoLatestSchedule(bin.config, true, bin.tools), { scheduled: false, reason: "launcher_unavailable" });
});

test("status reports what launchd really has", async t => {
  const m = await machine(); t.after(m.remove);
  const label = autoLatestLabel(await realpath(m.config));
  assert.deepEqual(await autoLatestScheduleStatus(m.config, m.tools), { supported: true, label, installed: false, loaded: false });
  await syncAutoLatestSchedule(m.config, true, m.tools);
  assert.deepEqual(await autoLatestScheduleStatus(m.config, m.tools), { supported: true, label, installed: true, loaded: true });
  m.loaded.clear();
  assert.deepEqual(await autoLatestScheduleStatus(m.config, m.tools), { supported: true, label, installed: true, loaded: false });
  const linux = { ...m.tools, platform: "linux" as const };
  assert.deepEqual(await autoLatestScheduleStatus(m.config, linux), { supported: false, label, installed: false, reason: "unsupported" });
});

test("the plist escapes paths and carries no credentials", () => {
  const text = autoLatestPlist({ label: "com.edihasaj.harness-gateway.models-0123456789abcdef", launcher: "/h/a&b/gateway", config: "/h/<c>\"'.json", home: "/h", tmp: "/tmp/t", workingDirectory: "/h/s", log: "/h/s/l.log" });
  assert.match(text, /a&amp;b/); assert.match(text, /&lt;c&gt;&quot;&apos;\.json/);
  assert.equal(text.includes("TOKEN") || text.includes("KEY"), false);
  const keys = [...text.matchAll(/<key>([A-Za-z_]+)<\/key><string>/g)].map(match => match[1]);
  assert.deepEqual(keys.filter(key => ["HOME", "PATH", "TMPDIR"].includes(key)), ["HOME", "PATH", "TMPDIR"]);
});

test("a FIFO or link in place of the launcher, plist or log is never opened blocking or followed", async t => {
  const { execFileSync } = await import("node:child_process");
  const { trimScheduleLog, autoLatestLogPath } = await import("../model-auto-latest/schedule.js");
  const fifo = await machine({ launcher: false }); t.after(fifo.remove);
  execFileSync("/usr/bin/mkfifo", [join(fifo.home, ".local", "bin", "harness-gateway")]);
  assert.deepEqual(await syncAutoLatestSchedule(fifo.config, true, fifo.tools), { scheduled: false, reason: "launcher_unavailable" });
  const plist = await machine(); t.after(plist.remove);
  const label = autoLatestLabel(await realpath(plist.config));
  await mkdir(join(plist.home, "Library", "LaunchAgents"), { recursive: true });
  execFileSync("/usr/bin/mkfifo", [plist.plist(label)]);
  assert.deepEqual(await syncAutoLatestSchedule(plist.config, true, plist.tools), { scheduled: false, reason: "foreign_job" });
  assert.deepEqual(await syncAutoLatestSchedule(plist.config, false, plist.tools), { scheduled: false, reason: "foreign_job" });
  const log = await machine(); t.after(log.remove);
  const state = join(log.home, "state"); await mkdir(join(state, "model-auto-latest"), { recursive: true });
  execFileSync("/usr/bin/mkfifo", [autoLatestLogPath(state)]);
  await trimScheduleLog(state, 10); // returns instead of waiting for a reader
});

test("trimming the log truncates only the user's own regular file and never follows a link", async t => {
  const { trimScheduleLog, autoLatestLogPath } = await import("../model-auto-latest/schedule.js");
  const m = await machine(); t.after(m.remove);
  const state = join(m.home, "state"); await mkdir(join(state, "model-auto-latest"), { recursive: true });
  const target = join(m.home, "precious.txt"); await writeFile(target, "x".repeat(2000));
  await symlink(target, autoLatestLogPath(state));
  await trimScheduleLog(state, 100);
  assert.equal((await stat(target)).size, 2000, "a linked log cut another file");
  const real = await machine(); t.after(real.remove);
  const rs = join(real.home, "state"); await mkdir(join(rs, "model-auto-latest"), { recursive: true });
  await writeFile(autoLatestLogPath(rs), "x".repeat(2000));
  await trimScheduleLog(rs, 5000); assert.equal((await stat(autoLatestLogPath(rs))).size, 2000);
  await trimScheduleLog(rs, 100); assert.equal((await stat(autoLatestLogPath(rs))).size, 0);
  await trimScheduleLog(join(real.home, "missing"), 100); // no log is fine
});

test("folders are made without following links, and a link is never chmod'ed or written through", async t => {
  const { ownedPrivateFolder } = await import("../model-auto-latest/schedule-safety.js");
  const m = await machine(); t.after(m.remove);
  const outside = join(m.home, "outside"); await mkdir(outside, { mode: 0o755 }); await chmod(outside, 0o755);
  // The job folder itself is a link to a folder elsewhere.
  const state = join(m.home, "state"); await mkdir(state, { mode: 0o700 });
  await symlink(outside, join(state, "model-auto-latest"));
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: false, reason: "unsafe_path" });
  assert.equal((await stat(outside)).mode & 0o777, 0o755, "a linked folder was chmod'ed");
  assert.deepEqual(await readdir(outside), [], "something was written through a link");
  await assert.rejects(ownedPrivateFolder(join(state, "model-auto-latest"), m.tools.uid));
  // A link in the job's tmp location.
  const tmpLink = join(m.tools.tmpRoot, `harness-gateway-model-refresh-${m.tools.uid}`);
  await symlink(outside, tmpLink);
  const other = join(m.home, "state2"); await mkdir(other, { mode: 0o700 });
  const second = { ...m.tools, stateDirectory: async () => other };
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, second), { scheduled: false, reason: "unsafe_path" });
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  // A dangling link.
  const dangling = await machine(); t.after(dangling.remove);
  await mkdir(join(dangling.home, "Library"), { mode: 0o700 });
  await symlink(join(dangling.home, "nowhere"), join(dangling.home, "Library", "LaunchAgents"));
  assert.deepEqual(await syncAutoLatestSchedule(dangling.config, true, dangling.tools), { scheduled: false, reason: "unsafe_path" });
  assert.equal(await stat(join(dangling.home, "nowhere")).catch(() => "absent"), "absent");
});

test("a looser job folder of ours is tightened to 700", async t => {
  const { ownedPrivateFolder } = await import("../model-auto-latest/schedule-safety.js");
  const m = await machine(); t.after(m.remove);
  const folder = join(m.home, "state", "model-auto-latest"); await mkdir(folder, { recursive: true, mode: 0o750 }); await chmod(folder, 0o750);
  await ownedPrivateFolder(folder, m.tools.uid);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
});

test("the read-only status matches an owned plist with a loaded job and changes nothing", async t => {
  const { getAutoLatestScheduleStatus } = await import("../model-auto-latest/schedule.js");
  const m = await machine(); t.after(m.remove);
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, m.tools), { scheduled: false });
  assert.equal(m.calls.length, 0, "no plist means no launchctl call");
  await syncAutoLatestSchedule(m.config, true, m.tools);
  m.calls.length = 0;
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, m.tools), { scheduled: true });
  assert.deepEqual(m.calls, [["print", `gui/${m.tools.uid}/${autoLatestLabel(await realpath(m.config))}`]]);
  m.loaded.clear();
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, m.tools), { scheduled: false, reason: "not_loaded" });
  const broken = { ...m.tools, launchctl: async () => { throw Object.assign(new Error("x"), { killed: true }); } };
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, broken), { scheduled: false, reason: "launchctl_failed" });
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, { ...m.tools, platform: "linux" }), { scheduled: false, reason: "unsupported" });
  const label = autoLatestLabel(await realpath(m.config));
  await writeFile(m.plist(label), "<plist>someone else</plist>");
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, m.tools), { scheduled: false, reason: "foreign_job" });
});

test("a marked plist that others can write, or that is oversized, is foreign and left alone", async t => {
  const { getAutoLatestScheduleStatus } = await import("../model-auto-latest/schedule.js");
  for (const [name, prepare] of [
    ["group writable", async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o620); }],
    ["world writable", async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o602); }],
    ["oversized", async (path: string, text: string) => { await writeFile(path, text + "x".repeat(70000), { mode: 0o600 }); }],
  ] as const) {
    const m = await machine(); t.after(m.remove);
    await syncAutoLatestSchedule(m.config, true, m.tools);
    const label = autoLatestLabel(await realpath(m.config));
    const original = await readFile(m.plist(label), "utf8");
    await prepare(m.plist(label), original);
    const before = await readFile(m.plist(label), "utf8");
    m.calls.length = 0;
    assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true, reason: "foreign_job" }, name);
    assert.deepEqual(await syncAutoLatestSchedule(m.config, false, m.tools), { scheduled: false, reason: "foreign_job" }, name);
    assert.deepEqual(await getAutoLatestScheduleStatus(m.config, m.tools), { scheduled: false, reason: "foreign_job" }, name);
    assert.equal(await readFile(m.plist(label), "utf8"), before, `${name}: the file changed`);
    assert.equal(m.calls.some(call => call[0] === "bootout" || call[0] === "bootstrap" || call[0] === "enable"), false, name);
  }
});
