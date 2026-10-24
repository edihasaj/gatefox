import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autoLatestLabel, autoLatestScheduleStatus, getAutoLatestScheduleStatus, syncAutoLatestSchedule, trimScheduleLog, type AutoLatestScheduleTools } from "../model-auto-latest/schedule.js";
import { shortFolder } from "./short-folder.js";

async function machine(platform: NodeJS.Platform = "darwin") {
  const folder = await shortFolder("al-one-"); const root = await realpath(folder.directory);
  const home = join(root, "home"), directory = join(home, "Library/LaunchAgents"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = join(home, "gateway.json"); await writeFile(config, "{}", { mode: 0o600 });
  const label = autoLatestLabel(config), target = `gui/${process.getuid!()}/${label}`, path = join(directory, `${label}.plist`);
  const loaded = new Set<string>(), calls: string[][] = []; let running = true;
  const tools: AutoLatestScheduleTools = { platform, uid: process.getuid!(), home, tmpRoot: root, stateDirectory: async () => join(home, "state"), probe: async () => { throw Error("must not probe launcher"); }, sleep: async () => {},
    launchctl: async args => { calls.push(args); if (args[0] === "print") { if (!loaded.has(args[1]!)) throw Object.assign(Error("missing"), { code: 113 }); return "loaded"; }
      if (args[0] === "bootout") { loaded.delete(args[1]!); return ""; } throw Error("must never enable/bootstrap another job"); },
    runtimeStatus: async () => running ? { scheduled: true } : { scheduled: false, reason: "service_unavailable" } };
  const legacy = async (content?: string) => { await writeFile(path, content ?? `<!-- Managed by harness-gateway auto-latest -->\n<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/h/gateway</string><string>auto-latest</string><string>check</string><string>--config</string><string>${config}</string></array>`, { mode: 0o600 }); loaded.add(target); };
  return { tools, home, config, path, target, directory, loaded, calls, legacy, stopRuntime: () => { running = false; }, remove: folder.remove };
}

test("turning on and off creates no job or plist and observes only the existing service", async t => {
  const m = await machine(); t.after(m.remove);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true });
  assert.deepEqual(await syncAutoLatestSchedule(m.config, false, m.tools), { scheduled: false });
  assert.deepEqual(await readdir(m.directory), []); assert.deepEqual(m.calls, []);
  m.stopRuntime(); assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: false, reason: "service_unavailable" });
});

test("migration unloads and removes only the owned 0.8.7 metadata job, preserving the app job", async t => {
  const m = await machine(); t.after(m.remove); await m.legacy();
  const app = join(m.directory, "com.edihasaj.subscription-gateway.plist"); await writeFile(app, "signed app fixture");
  const original = await readFile(m.config);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true });
  assert.deepEqual(await readFile(m.config), original); assert.equal(await readFile(app, "utf8"), "signed app fixture");
  assert.deepEqual(await readdir(m.directory), ["com.edihasaj.subscription-gateway.plist"]);
  assert.deepEqual(m.calls.filter(c => c[0] !== "print"), [["bootout", m.target]]);
  assert.equal(m.loaded.size, 0);
});

test("turning off also retires the old job and never changes the parent registration", async t => {
  const m = await machine(); t.after(m.remove); await m.legacy();
  assert.deepEqual(await syncAutoLatestSchedule(m.config, false, m.tools), { scheduled: false });
  assert.deepEqual(await readdir(m.directory), []); assert.equal(m.calls.some(c => c.join().includes("subscription-gateway")), false);
});

test("foreign, writable, mismatched and symlinked legacy jobs are refused, never stopped or deleted", async t => {
  for (const kind of ["foreign", "writable", "wrong-config", "symlink", "fifo"]) {
    const m = await machine(); t.after(m.remove);
    if (kind === "fifo") execFileSync("mkfifo", [m.path]);
    else if (kind === "symlink") { const other = join(m.home, "other"); await writeFile(other, "do not change"); await symlink(other, m.path); }
    else { await m.legacy(kind === "foreign" ? "not ours" : kind === "wrong-config" ? "<!-- Managed by harness-gateway auto-latest --><string>other.json</string>" : undefined); if (kind === "writable") await chmod(m.path, 0o666); }
    assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: false, reason: "foreign_job" }, kind);
    assert.deepEqual(m.calls, [], kind); assert.ok(await stat(m.path).catch(() => undefined));
  }
});

test("a failed unload preserves the owned plist and never claims the replacement timer is running", async t => {
  const m = await machine(); t.after(m.remove); await m.legacy();
  const tools = { ...m.tools, launchctl: async (args: string[]) => { if (args[0] === "bootout") throw Error("not stopped"); return "still loaded"; } };
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, tools), { scheduled: false, reason: "launchctl_failed" });
  assert.ok(await stat(m.path));
});

test("read-only status never asks launchctl or creates filesystem entries, and reports the shared owner", async t => {
  const m = await machine(); t.after(m.remove);
  assert.deepEqual(await getAutoLatestScheduleStatus(m.config, m.tools), { scheduled: true });
  assert.deepEqual(await autoLatestScheduleStatus(m.config, m.tools), { supported: true, mode: "app-service", scheduled: true });
  assert.deepEqual(m.calls, []); assert.deepEqual(await readdir(m.directory), []);
  m.stopRuntime(); assert.equal((await getAutoLatestScheduleStatus(m.config, m.tools)).scheduled, false);
});

test("migration preserves a foreign replacement written while launchctl drains the old job", async t => {
  const m = await machine(); t.after(m.remove); await m.legacy();
  const tools = { ...m.tools, launchctl: async (args: string[]) => {
    if (args[0] === "bootout") {
      const replacement = `${m.path}.replacement`; await writeFile(replacement, "foreign replacement", { mode: 0o600 }); await rename(replacement, m.path);
    }
    return m.tools.launchctl(args);
  } };
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, tools), { scheduled: false, reason: "foreign_job" });
  assert.equal(await readFile(m.path, "utf8"), "foreign replacement");
});

test("non-macOS uses the existing process timer without launchd", async t => {
  const m = await machine("linux"); t.after(m.remove);
  assert.deepEqual(await syncAutoLatestSchedule(m.config, true, m.tools), { scheduled: true }); assert.deepEqual(m.calls, []);
});

test("legacy log trimming refuses links and FIFOs", async t => {
  const m = await machine(); t.after(m.remove); const state = join(m.home, "state"); const logs = join(state, "model-auto-latest"); await mkdir(logs, { recursive: true });
  const victim = join(m.home, "victim"); await writeFile(victim, "untouched"); await symlink(victim, join(logs, "schedule.log"));
  await trimScheduleLog(state, 1); assert.equal(await readFile(victim, "utf8"), "untouched");
});
