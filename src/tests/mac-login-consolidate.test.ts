import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, lstat, chmod, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageLoginConsolidation, activatePendingLoginConsolidation, activateLoginConsolidation, readPendingLoginConsolidation, pendingLoginConsolidationPath, recoveredLoginConsolidationPath, type LoginConsolidationDependencies } from "../mac-login-consolidate.js";
import { serviceLabel, servicePlanPath, readServicePlan, type ServicePlan, type ServiceComponent } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { bootIdentity, setBootIdentityForTests } from "../boot-identity.js";
import { runServiceDaemon } from "../service-daemon.js";

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function fixture(launcher = "Installed Gateway") {
  const root = await mkdtemp(join(tmpdir(), "gateway login paths ")); const directory = join(root, "Launch Agents");
  const state = join(root, "State Directory"); const trash = join(state, "service-login-retired"); const discarded = join(root, "Simulated OS Trash");
  for (const path of [directory, state, trash, discarded]) await mkdir(path, { mode: 0o700 });
  const config = join(root, "Gateway Config.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: state, providers: [{ id: "claude", type: "claude-subscription", models: { claude: "model" } }] });
  const gateway = join(root, launcher); const native = join(root, "gateway-native-relay");
  for (const command of [gateway, native]) await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const definitions: Array<{ label: string; kind: ServiceComponent["kind"]; args: string[] }> = [
    { label: serviceLabel, kind: "inference", args: [gateway, "serve", "--config", config] },
    { label: serviceLabel + ".desktop", kind: "desktop", args: [gateway, "desktop", "register", "--config", config, "--app", join(root, "ChatGPT App.app")] },
    { label: serviceLabel + ".native", kind: "native", args: [native, "--daemon", "--gateway", gateway, "--gateway-config", config, "--codex", process.execPath, "--native-home", join(root, "Native Home"), "--relay-home", join(root, "Relay Home")] },
    { label: serviceLabel + ".tunnel.main", kind: "tunnel", args: ["/usr/bin/ssh", "-N", "-L", "127.0.0.1:3459:127.0.0.1:3457", "existing-host"] },
  ];
  const plan: ServicePlan = { version: 1, config, components: definitions.map(definition => ({
    id: definition.kind === "tunnel" ? "tunnel-main" : definition.kind, kind: definition.kind,
    command: definition.args[0], args: definition.kind === "desktop" ? ["desktop-restore", "--config", config, "--app", definition.args.at(-1)!] : definition.args.slice(1), log: join(state, definition.kind + ".log"),
  })) };
  const registrations = new Map<string, { Label: string; Program?: string; ProgramArguments: string[] }>();
  const originals = new Map<string, string>();
  for (const definition of definitions) {
    const path = join(directory, definition.label + ".plist");
    const text = `<?xml version="1.0"?><!-- Managed by subscription-gateway --><plist version="1.0"><dict><key>Label</key><string>${definition.label}</string><key>ProgramArguments</key><array>${definition.args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array></dict></plist>\n`;
    await writeFile(path, text, { mode: 0o600 }); originals.set(path, text); registrations.set(path, { Label: definition.label, ProgramArguments: definition.args });
  }
  const loaded = new Map(definitions.map(definition => [definition.label, { loaded: true, pid: process.pid } as { loaded: boolean; pid?: number }]));
  const calls: string[] = [];
  const deps: LoginConsolidationDependencies = {
    directory, trash, label: serviceLabel, command: { command: gateway, args: [] }, move: rename,
    discard: async path => { calls.push("discard " + path); await rename(path, join(discarded, path.split("/").at(-1)!)); },
    status: async label => { calls.push("print " + label); return loaded.get(label) || { loaded: false }; },
    listLabels: async () => { calls.push("list"); return [...loaded].filter(([, value]) => value.loaded).map(([label]) => label); },
    disabled: async label => { calls.push("print-disabled " + label); return false; },
    // launchctl bootstrap, injected: the job named by the plist is loaded from then on.
    bootstrap: async path => { calls.push("bootstrap " + path); loaded.set(path.split("/").at(-1)!.replace(/\.plist$/, ""), { loaded: true, pid: 4242 }); },
    inspect: async path => registrations.get(path)!,
    collect: async () => ({ plan, jobs: await Promise.all(definitions.map(async definition => {
      const path = join(directory, definition.label + ".plist"); const component = plan.components.find(component => component.kind === definition.kind)!;
      return { path, label: definition.label, text: await readFile(path, "utf8"), loaded: loaded.get(definition.label)!.loaded, kind: definition.kind, component };
    })) }),
  };
  const unloadLegacy = () => { for (const [label, value] of loaded) if (label !== serviceLabel) value.loaded = false; };
  return { root, directory, state, trash, discarded, config, plan, deps, loaded, calls, originals, registrations, unloadLegacy };
}

test("next-login staging keeps live PIDs, preserves responsibilities and paths with spaces, and repeats identically", async () => {
  const f = await fixture(); const before = structuredClone([...f.loaded]);
  const result = await stageLoginConsolidation(f.config, f.deps); assert.equal(result.staged, true);
  assert.equal(await readServicePlan(f.state), undefined); assert.deepEqual([...f.loaded], before); process.kill(process.pid, 0);
  assert.deepEqual(await readdir(f.directory), [serviceLabel + ".plist"]);
  assert.ok(f.calls.every(call => /^(?:print |print-disabled |discard |list$)/.test(call)), "staging exposes no launchd mutation operation");
  assert.deepEqual(await readdir(f.trash), []); assert.equal((await readdir(f.discarded)).length, 4);
  const pending = await readPendingLoginConsolidation(f.state); assert.ok(pending); assert.equal(pending.phase, "ready"); assert.deepEqual(pending.plan, f.plan);
  assert.equal((await lstat(pendingLoginConsolidationPath(f.state))).mode & 0o777, 0o600);
  assert.equal((await lstat(pending.backup)).mode & 0o777, 0o700);
  for (const [path, original] of f.originals) assert.equal(await readFile(join(pending.backup, path.split("/").at(-1)!), "utf8"), original);
  const primary = join(f.directory, serviceLabel + ".plist"); const primaryBytes = await readFile(primary);
  assert.ok(primaryBytes.toString().includes(`<string>daemon</string><string>--config</string><string>${f.config}</string>`));
  const receipt = await readFile(pendingLoginConsolidationPath(f.state));
  assert.deepEqual(await stageLoginConsolidation(f.config, f.deps), result);
  assert.deepEqual(await readFile(primary), primaryBytes); assert.deepEqual(await readFile(pendingLoginConsolidationPath(f.state)), receipt);
});

test("promotion waits for every old label to unload, including PID-less jobs, then publishes exactly once", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps);
  f.loaded.set(serviceLabel + ".desktop", { loaded: true });
  await assert.rejects(activatePendingLoginConsolidation(f.config, f.deps), /remains loaded/);
  assert.equal(await readServicePlan(f.state), undefined);
  f.unloadLegacy(); assert.deepEqual(await activatePendingLoginConsolidation(f.config, f.deps), f.plan);
  assert.deepEqual(await readServicePlan(f.state), f.plan); assert.equal(await readPendingLoginConsolidation(f.state), undefined);
  const canonical = await readFile(servicePlanPath(f.state));
  assert.deepEqual(await activatePendingLoginConsolidation(f.config, f.deps), f.plan);
  assert.deepEqual(await readFile(servicePlanPath(f.state)), canonical);
});

test("promotion refuses manual starts, unknown launchctl ownership, and changed future registration", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps); f.unloadLegacy();
  f.loaded.set(serviceLabel, { loaded: true, pid: process.pid + 10000 });
  await assert.rejects(activatePendingLoginConsolidation(f.config, f.deps), /primary launchd process/);
  f.loaded.set(serviceLabel, { loaded: true });
  await assert.rejects(activatePendingLoginConsolidation(f.config, f.deps), /primary launchd process/);
  f.loaded.set(serviceLabel, { loaded: true, pid: process.pid });
  await assert.rejects(activatePendingLoginConsolidation(f.config, { ...f.deps, status: async () => { throw new Error("launchctl permission failure"); } }), /permission failure/);
  const primary = join(f.directory, serviceLabel + ".plist"); await writeFile(primary, "changed managed registration", { mode: 0o600 });
  await assert.rejects(stageLoginConsolidation(f.config, f.deps), /LaunchAgent changed/);
  await assert.rejects(activatePendingLoginConsolidation(f.config, f.deps), /LaunchAgent changed/);
  assert.equal(await readServicePlan(f.state), undefined);
});

test("recreated retired paths and newly added owned labels block re-stage and promotion", async () => {
  for (const suffix of ["desktop", "tunnel.new"]) {
    const f = await fixture(); await stageLoginConsolidation(f.config, f.deps); f.unloadLegacy();
    await writeFile(join(f.directory, `${serviceLabel}.${suffix}.plist`), "unmanaged replacement", { mode: 0o600 });
    await assert.rejects(stageLoginConsolidation(f.config, f.deps), /recreated|appeared/);
    await assert.rejects(activatePendingLoginConsolidation(f.config, f.deps), /recreated|appeared/);
    assert.equal(await readServicePlan(f.state), undefined);
  }
});

test("staging rollback restores exact originals after a partial Trash failure without touching live PIDs", async () => {
  const f = await fixture(); const before = structuredClone([...f.loaded]); let moves = 0;
  await assert.rejects(stageLoginConsolidation(f.config, { ...f.deps, move: async (source, target) => { if (++moves === 2) throw new Error("injected Trash failure"); await rename(source, target); } }), /injected Trash failure/);
  for (const [path, original] of f.originals) assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal(await readServicePlan(f.state), undefined); assert.deepEqual([...f.loaded], before);
  assert.equal((await stageLoginConsolidation(f.config, f.deps)).staged, true);
});

test("OS Trash errors before or after disposal restore backups without direct Trash access", async () => {
  for (const afterDisposal of [false, true]) {
    const f = await fixture(); const before = structuredClone([...f.loaded]); let discards = 0;
    await assert.rejects(stageLoginConsolidation(f.config, { ...f.deps, discard: async path => {
      if (++discards === 2) { if (afterDisposal) await f.deps.discard(path); throw new Error("OS Trash EPERM"); }
      await f.deps.discard(path);
    } }), /OS Trash EPERM/);
    for (const [path, original] of f.originals) assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual([...f.loaded], before); assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal(await readServicePlan(f.state), undefined);
    assert.equal((await stageLoginConsolidation(f.config, f.deps)).staged, true);
  }
});

test("an OS Trash success that leaves the file in quarantine refuses staging and restores originals", async () => {
  const f = await fixture();
  await assert.rejects(stageLoginConsolidation(f.config, { ...f.deps, discard: async () => {} }), /did not move.*Trash/);
  for (const [path, original] of f.originals) assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal(await readServicePlan(f.state), undefined);
});

test("persistent OS Trash failure cannot prevent restoring an already-published future primary", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps);
  const pending = await readPendingLoginConsolidation(f.state); assert.ok(pending); pending.phase = "preparing";
  await writePrivateJson(pendingLoginConsolidationPath(f.state), pending);
  let discards = 0;
  await assert.rejects(stageLoginConsolidation(f.config, { ...f.deps, discard: async () => { discards++; throw new Error("persistent OS Trash EPERM"); } }), /persistent OS Trash EPERM/);
  assert.ok(discards >= 2, "recovery restores the old primary before re-stage encounters the same cleanup failure");
  for (const [path, original] of f.originals) assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal(await readServicePlan(f.state), undefined);
  assert.ok((await readdir(f.trash)).length >= 2, "verified future and failed retirement stay safely outside LaunchAgents");
});

test("rollback preserves a concurrently changed source and leaves a private recovery receipt", async () => {
  const f = await fixture(); const native = join(f.directory, serviceLabel + ".native.plist"); let moves = 0;
  await assert.rejects(stageLoginConsolidation(f.config, { ...f.deps, move: async (source, target) => {
    if (++moves === 2) { await writeFile(native, "external change", { mode: 0o600 }); throw new Error("injected concurrent change"); }
    await rename(source, target);
  } }), /changed during rollback/);
  assert.equal(await readFile(native, "utf8"), "external change"); assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing");
  assert.equal(await readServicePlan(f.state), undefined);
});

test("a replacement raced into retirement or primary publication survives without being overwritten", async () => {
  for (const race of ["retirement", "primary"]) {
    const f = await fixture(); const target = join(f.directory, serviceLabel + (race === "retirement" ? ".native" : "") + ".plist");
    await assert.rejects(stageLoginConsolidation(f.config, { ...f.deps, move: async (source, destination) => {
      if (source === target && race === "retirement") await writeFile(source, "external replacement", { mode: 0o600 });
      await rename(source, destination);
      if (source === target && race === "primary") await writeFile(source, "external replacement", { mode: 0o600 });
    } }));
    assert.equal(await readFile(target, "utf8"), "external replacement");
    for (const name of await readdir(f.discarded)) assert.notEqual(await readFile(join(f.discarded, name), "utf8"), "external replacement", "unknown replacements never reach OS Trash");
    assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing"); assert.equal(await readServicePlan(f.state), undefined);
  }
});

test("interrupted preparation and an abandoned private lock recover before restaging", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps);
  const pending = await readPendingLoginConsolidation(f.state); assert.ok(pending); pending.phase = "preparing";
  await writePrivateJson(pendingLoginConsolidationPath(f.state), pending);
  await writeFile(join(f.state, "service-login.lock"), "2147483647", { mode: 0o600 });
  assert.equal((await stageLoginConsolidation(f.config, f.deps)).staged, true);
  assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "ready");
  assert.equal(await readServicePlan(f.state), undefined);
});

test("promotion resumes a crash after canonical publication without changing the existing plan", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps); f.unloadLegacy();
  await writePrivateJson(servicePlanPath(f.state), f.plan); const bytes = await readFile(servicePlanPath(f.state));
  assert.deepEqual(await activatePendingLoginConsolidation(f.config, f.deps), f.plan);
  assert.deepEqual(await readFile(servicePlanPath(f.state)), bytes); assert.equal(await readPendingLoginConsolidation(f.state), undefined);
});

test("existing unified plans refuse duplicate jobs and mismatched installations, otherwise remain untouched", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps); f.unloadLegacy(); await activatePendingLoginConsolidation(f.config, f.deps);
  const bytes = await readFile(servicePlanPath(f.state));
  assert.equal((await stageLoginConsolidation(f.config, f.deps)).alreadyConsolidated, true); assert.deepEqual(await readFile(servicePlanPath(f.state)), bytes);
  f.loaded.set(serviceLabel + ".native", { loaded: true });
  await assert.rejects(stageLoginConsolidation(f.config, f.deps), /Separate gateway login jobs/); f.unloadLegacy();
  const secondConfig = join(f.root, "Second Config.json"); await writeFile(secondConfig, await readFile(f.config), { mode: 0o600 });
  await assert.rejects(stageLoginConsolidation(secondConfig, f.deps), /another configuration/);
});

test("unsafe source ownership, symlinks, ambiguous native arguments, disabled jobs, and missing binaries refuse before changes", async () => {
  for (const fault of ["unmanaged", "program", "symlink", "public", "directory", "native-flags", "native-check", "native-enable", "desktop-app", "disabled", "missing-binary", "directory-binary", "oversized-plan"]) {
    const f = await fixture(); const native = join(f.directory, serviceLabel + ".native.plist");
    if (fault === "unmanaged") await writeFile(native, "unmanaged source", { mode: 0o600 });
    if (fault === "program") f.registrations.get(native)!.Program = "/unexpected/program";
    if (fault === "symlink") { await rename(native, native + ".original"); await symlink(native + ".original", native); }
    if (fault === "public") await chmod(native, 0o666);
    if (fault === "directory") await chmod(f.directory, 0o777);
    if (fault === "native-flags") f.registrations.get(native)!.ProgramArguments.push("--native-home", join(f.root, "Other Native Home"));
    if (fault === "native-check") f.registrations.get(native)!.ProgramArguments.push("--check");
    if (fault === "native-enable") f.registrations.get(native)!.ProgramArguments.push("--enable");
    if (fault === "desktop-app") f.registrations.get(join(f.directory, serviceLabel + ".desktop.plist"))!.ProgramArguments.push("--app", join(f.root, "Other App.app"));
    const deps = { ...f.deps, ...(fault === "disabled" ? { disabled: async (label: string) => label.endsWith(".native") } : {}) };
    if (fault === "missing-binary") f.plan.components.find(component => component.kind === "native")!.command = join(f.root, "absent-native-relay");
    if (fault === "directory-binary") f.plan.components.find(component => component.kind === "native")!.command = f.directory;
    if (fault === "oversized-plan") f.plan.components.find(component => component.kind === "tunnel")!.args.push("a".repeat(66000));
    await assert.rejects(stageLoginConsolidation(f.config, deps));
    assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal(await readServicePlan(f.state), undefined);
    assert.equal(await readFile(join(f.directory, serviceLabel + ".plist"), "utf8"), f.originals.get(join(f.directory, serviceLabel + ".plist")));
  }
});

/** A staging process that is gone: a pid that exited, stamped with a start no live process can have. */
async function deadStager(): Promise<{ pid: number; startedAtMs: number }> {
  const child = spawn("/usr/bin/true"); await once(child, "exit");
  return { pid: child.pid!, startedAtMs: 1 };
}
async function interrupted(f: Awaited<ReturnType<typeof fixture>>, stager: unknown): Promise<void> {
  await stageLoginConsolidation(f.config, f.deps);
  const pending = await readPendingLoginConsolidation(f.state); assert.ok(pending);
  // What a crash between publishing the future primary and marking the staging ready leaves behind.
  await writePrivateJson(pendingLoginConsolidationPath(f.state), { ...pending, phase: "preparing", stager });
}

test("staging records the process that stages, so a marker it leaves can be told apart from one in progress", async () => {
  const f = await fixture(); await stageLoginConsolidation(f.config, f.deps);
  assert.equal((await readPendingLoginConsolidation(f.state))?.stager?.pid, process.pid);
  await writePrivateJson(pendingLoginConsolidationPath(f.state), { ...await readPendingLoginConsolidation(f.state), stager: { pid: "1" } });
  await assert.rejects(readPendingLoginConsolidation(f.state), /Invalid pending/);
});

/** The records an interrupted staging left in its backup, by kind (`login-activated`, `login-recovered`). */
async function records(f: Awaited<ReturnType<typeof fixture>>, kind: string): Promise<string[]> {
  const backups = (await readdir(join(f.state, "service-backups"))).map(name => join(f.state, "service-backups", name));
  return (await Promise.all(backups.map(path => readdir(path)))).flat().filter(name => new RegExp(`^${kind}\\.[0-9a-f]+\\.json$`).test(name));
}
const events = async (f: Awaited<ReturnType<typeof fixture>>, name: string) => { await flushTelemetry(); return (await readTelemetry(f.state, Date.now() - 60_000)).filter(event => event.event === name); };
const bootstraps = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(call => call.startsWith("bootstrap ")).map(call => call.slice(10).split("/").at(-1)).sort();

test("a staging interrupted after its last file write is finished at the daemon's start and runs its plan", async () => {
  for (const stager of [await deadStager(), undefined]) {
    const f = await fixture(); configureTelemetry(f.state, "test");
    await interrupted(f, stager); f.unloadLegacy(); // A fresh login: the retired jobs have no plist left to load from.
    const primary = await readFile(join(f.directory, serviceLabel + ".plist"));
    assert.deepEqual(await activateLoginConsolidation(f.config, f.deps), { plan: f.plan, restored: false });
    assert.deepEqual(await readServicePlan(f.state), f.plan); assert.equal(await readPendingLoginConsolidation(f.state), undefined);
    assert.deepEqual(await readFile(join(f.directory, serviceLabel + ".plist")), primary, "the staged daemon stays the login job");
    assert.deepEqual(await readdir(f.directory), [serviceLabel + ".plist"], "no original was put back");
    assert.equal((await records(f, "login-activated")).length, 1); assert.deepEqual(await records(f, "login-recovered"), []);
    assert.deepEqual(bootstraps(f), [], "nothing was loaded");
    assert.deepEqual((await events(f, "login_consolidation_completed")).map(event => event.jobs), [4]);
    assert.deepEqual(await events(f, "login_consolidation_restored"), []);
    // The next launchd restart runs the same plan.
    assert.deepEqual(await activateLoginConsolidation(f.config, f.deps), { plan: f.plan, restored: false });
  }
});

test("an interrupted staging that fails its checks is rolled back, and every restored job but the primary one is loaded at once", async () => {
  for (const failing of [false, true]) {
    const f = await fixture(); configureTelemetry(f.state, "test");
    await interrupted(f, await deadStager()); f.unloadLegacy();
    // A gateway job that appeared after staging: promoting now could run it next to the unified service.
    const added = join(f.directory, serviceLabel + ".tunnel.new.plist"); await writeFile(added, "added after staging", { mode: 0o600 });
    const deps = failing ? { ...f.deps, bootstrap: async (path: string) => { if (path.endsWith(".native.plist")) throw new Error("injected bootstrap failure"); await f.deps.bootstrap(path); } } : f.deps;
    assert.deepEqual(await activateLoginConsolidation(f.config, deps), { plan: undefined, restored: true });
    for (const [path, original] of f.originals) assert.equal(await readFile(path, "utf8"), original, "every original comes back byte for byte");
    assert.equal(await readFile(added, "utf8"), "added after staging", "a job the staging never owned is left alone");
    assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal(await readServicePlan(f.state), undefined);
    assert.equal((await records(f, "login-recovered")).length, 1, "the record is kept in the backup");
    assert.equal((await stat(recoveredLoginConsolidationPath(f.state))).mode & 0o777, 0o600, "and the private rollback mark is in the state folder");
    const expected = [".desktop", ".native", ".tunnel.main"].map(suffix => serviceLabel + suffix + ".plist");
    assert.deepEqual(bootstraps(f), failing ? expected.filter(name => !name.endsWith(".native.plist")) : expected, "the primary label is this daemon's, so it is not loaded");
    assert.deepEqual((await events(f, "login_consolidation_restored")).map(event => [event.jobs, event.started, event.failed]), [[4, failing ? 2 : 3, failing ? 1 : 0]]);
    assert.deepEqual(await events(f, "login_consolidation_completed"), []);
  }
});

test("an interrupted staging whose old jobs still run waits for the next attempt instead of rolling back, and then runs its plan", async () => {
  for (const stager of [await deadStager(), undefined]) {
    const f = await fixture(); configureTelemetry(f.state, "test");
    await interrupted(f, stager); // Every retired job is still loaded, so the staged plan cannot take over yet.
    const primary = await readFile(join(f.directory, serviceLabel + ".plist"));
    await assert.rejects(activateLoginConsolidation(f.config, f.deps), /remains loaded; consolidation waits/);
    assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing", "the staging is kept for the next attempt");
    assert.deepEqual(await readFile(join(f.directory, serviceLabel + ".plist")), primary, "nothing was rolled back");
    assert.deepEqual(await readdir(f.directory), [serviceLabel + ".plist"]);
    assert.deepEqual(bootstraps(f), []); assert.deepEqual(await events(f, "login_consolidation_restored"), []);
    await assert.rejects(stat(recoveredLoginConsolidationPath(f.state)), { code: "ENOENT" });
    // A start that is not the primary launchd process only waits too.
    f.unloadLegacy(); f.loaded.set(serviceLabel, { loaded: true, pid: process.pid + 10000 });
    await assert.rejects(activateLoginConsolidation(f.config, f.deps), /primary launchd process/);
    assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing");
    // The next launchd start, once the old jobs are gone, finishes the staging.
    f.loaded.set(serviceLabel, { loaded: true, pid: process.pid });
    assert.deepEqual(await activateLoginConsolidation(f.config, f.deps), { plan: f.plan, restored: false });
    assert.deepEqual((await events(f, "login_consolidation_completed")).map(event => event.jobs), [4]);
  }
});

test("a rollback marks itself before it archives the staging, so a daemon stopped in between, or before it loaded the jobs, relaunches idle and loads them", async () => {
  for (const stop of ["before the archive", "before the loads"] as const) {
    const f = await fixture(); configureTelemetry(f.state, "test");
    await interrupted(f, await deadStager()); f.unloadLegacy();
    await writeFile(join(f.directory, serviceLabel + ".tunnel.new.plist"), "added after staging", { mode: 0o600 });
    const backup = (await readPendingLoginConsolidation(f.state))!.backup;
    if (stop === "before the archive") {
      // The archive's rename fails once the mark is written: the process ends there, with both files left.
      await chmod(backup, 0o500);
      try { await assert.rejects(activateLoginConsolidation(f.config, f.deps), { code: "EACCES" }); } finally { await chmod(backup, 0o700); }
      assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing", "the record was not archived");
    } else {
      // Every load fails as if the process had ended right after the archive.
      assert.deepEqual(await activateLoginConsolidation(f.config, { ...f.deps, bootstrap: async () => { throw new Error("stopped"); } }), { plan: undefined, restored: true });
      assert.equal(await readPendingLoginConsolidation(f.state), undefined, "the record was archived");
    }
    assert.ok(JSON.parse(await readFile(recoveredLoginConsolidationPath(f.state), "utf8")).removedLabels.length, "the mark names the restored jobs");
    assert.deepEqual(bootstraps(f), [], "no job was loaded");
    // The relaunch stays idle and loads every restored job but the primary one; a further relaunch loads nothing twice.
    assert.deepEqual(await activateLoginConsolidation(f.config, f.deps), { plan: undefined, restored: true });
    for (const [path, original] of f.originals) assert.equal(await readFile(path, "utf8"), original);
    assert.equal(await readPendingLoginConsolidation(f.state), undefined); assert.equal((await records(f, "login-recovered")).length, 1);
    const expected = [".desktop", ".native", ".tunnel.main"].map(suffix => serviceLabel + suffix + ".plist");
    assert.deepEqual(bootstraps(f), expected);
    assert.deepEqual(await activateLoginConsolidation(f.config, f.deps), { plan: undefined, restored: true });
    assert.deepEqual(bootstraps(f), expected);
  }
});

test("a daemon relaunched after a rollback stays idle without failing, in the same boot only, until a staging is promoted", async () => {
  const f = await fixture(); configureTelemetry(f.state, "test");
  await interrupted(f, await deadStager()); f.unloadLegacy();
  await writeFile(join(f.directory, serviceLabel + ".tunnel.new.plist"), "added after staging", { mode: 0o600 });
  const daemon = (standby: () => Promise<void>) => runServiceDaemon(f.config, { activate: path => activateLoginConsolidation(path, f.deps), run: async () => assert.fail("no plan to run"), standby, notice: () => {} });
  let waits = 0;
  await daemon(async () => { waits++; }); // The start that rolls back.
  for (let relaunch = 0; relaunch < 3; relaunch++) await daemon(async () => { waits++; }); // A crash, `kickstart -k`, SIGTERM: each relaunch stands by.
  assert.equal(waits, 4);
  const boot = await bootIdentity();
  try {
    // A mark from an earlier boot is not this daemon's: with no plan, the start fails as before.
    setBootIdentityForTests({ id: "0123456789abcdef-other-boot", bootedAtMs: boot.bootedAtMs });
    if (boot.id) await assert.rejects(daemon(async () => assert.fail("no standby in another boot")), /Unified service plan is missing/);
  } finally { setBootIdentityForTests(undefined); }
  // A later staging that is promoted clears the mark.
  await rename(join(f.directory, serviceLabel + ".tunnel.new.plist"), join(f.root, "set aside.plist"));
  f.loaded.set(serviceLabel, { loaded: true, pid: process.pid });
  assert.equal((await stageLoginConsolidation(f.config, f.deps)).staged, true); f.unloadLegacy();
  assert.deepEqual(await activateLoginConsolidation(f.config, f.deps), { plan: f.plan, restored: false });
  await assert.rejects(stat(recoveredLoginConsolidationPath(f.state)), { code: "ENOENT" });
});

test("a staging whose process is still alive keeps its marker and changes nothing", async () => {
  const f = await fixture();
  const live = spawn(process.execPath, ["-e", "const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 250)"], { stdio: "ignore" });
  try {
    await once(live, "spawn"); await interrupted(f, { pid: live.pid });
    const primary = join(f.directory, serviceLabel + ".plist"); const staged = await readFile(primary);
    await assert.rejects(activateLoginConsolidation(f.config, f.deps), /did not finish staging/);
    assert.deepEqual(await readFile(primary), staged); assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing");
  } finally { live.kill("SIGKILL"); }
});

test("a rollback that would overwrite a changed original refuses and keeps the marker", async () => {
  const f = await fixture(); await interrupted(f, await deadStager()); f.unloadLegacy();
  await writeFile(join(f.directory, serviceLabel + ".tunnel.new.plist"), "added after staging", { mode: 0o600 }); // A check that refuses.
  const backup = (await readPendingLoginConsolidation(f.state))!.backup;
  await writeFile(join(backup, serviceLabel + ".native.plist"), "tampered", { mode: 0o600 });
  await assert.rejects(activateLoginConsolidation(f.config, f.deps), /backup changed/);
  assert.equal((await readPendingLoginConsolidation(f.state))?.phase, "preparing");
});

/**
 * The desktop environment agent shares our label prefix but is not a service component. Staging and promotion must
 * neither fold it into the plan, nor retire it, nor count it as a separate gateway login job that blocks them.
 */
test("the desktop environment agent is neither consolidated, retired, nor mistaken for a separate login job", async () => {
  const f = await fixture(); const envLabel = serviceLabel + ".desktop-env"; const envPath = join(f.directory, envLabel + ".plist");
  const envText = `<?xml version="1.0"?><!-- Managed by subscription-gateway desktop-env --><plist version="1.0"><dict><key>Label</key><string>${envLabel}</string></dict></plist>\n`;
  await writeFile(envPath, envText, { mode: 0o600 });
  f.registrations.set(envPath, { Label: envLabel, ProgramArguments: [join(f.state, "harness-gateway-login-env")] });
  const keepEnvLoaded = () => f.loaded.set(envLabel, { loaded: true });
  keepEnvLoaded();

  await stageLoginConsolidation(f.config, f.deps);
  const pending = (await readPendingLoginConsolidation(f.state))!;
  assert.ok(!pending.removedLabels.includes(envLabel) && !pending.sources.some(source => source.label === envLabel), "it is not a retired source");
  assert.ok(!pending.plan.components.some(component => component.id.includes("env")), "it is not a plan component");
  assert.equal(await readFile(envPath, "utf8"), envText, "its plist is left exactly where and as it was");
  assert.deepEqual((await readdir(f.directory)).sort(), [envLabel + ".plist", serviceLabel + ".plist"].sort());

  f.unloadLegacy(); keepEnvLoaded();
  assert.deepEqual(await activatePendingLoginConsolidation(f.config, f.deps), f.plan, "a loaded agent does not hold promotion back");
  assert.equal(await readFile(envPath, "utf8"), envText, "promotion leaves it alone");
  assert.equal((await stageLoginConsolidation(f.config, f.deps)).alreadyConsolidated, true, "and a later stage is not blocked by it");
  assert.equal(f.loaded.get(envLabel)?.loaded, true, "it stays loaded");
});

test("login jobs naming gateway or harness-gateway are both accepted, and the staged service names harness-gateway", async () => {
  for (const launcher of ["gateway", "harness-gateway"]) {
    const f = await fixture(launcher); const harness = join(f.root, "harness-gateway");
    await writeFile(harness, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    f.deps.command = { command: harness, args: [] };
    assert.equal((await stageLoginConsolidation(f.config, f.deps)).staged, true, launcher + ": the old jobs are accepted");
    const primary = await readFile(join(f.directory, serviceLabel + ".plist"), "utf8");
    assert.ok(primary.includes(`<array><string>${harness}</string><string>daemon</string>`), launcher + ": the unified plist names harness-gateway");
    assert.equal(primary.includes(`<string>${join(f.root, "gateway")}</string>`), false, launcher + ": and never the older name");
    f.unloadLegacy();
    assert.deepEqual(await activatePendingLoginConsolidation(f.config, f.deps), f.plan, launcher + ": promotion verifies the staged registration");
  }
});
