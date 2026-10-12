import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, lstat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageLoginConsolidation, activatePendingLoginConsolidation, readPendingLoginConsolidation, pendingLoginConsolidationPath, type LoginConsolidationDependencies } from "../mac-login-consolidate.js";
import { serviceLabel, servicePlanPath, readServicePlan, type ServicePlan, type ServiceComponent } from "../service-plan.js";
import { writePrivateJson } from "../config.js";

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway login paths ")); const directory = join(root, "Launch Agents");
  const state = join(root, "State Directory"); const trash = join(state, "service-login-retired"); const discarded = join(root, "Simulated OS Trash");
  for (const path of [directory, state, trash, discarded]) await mkdir(path, { mode: 0o700 });
  const config = join(root, "Gateway Config.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: state, providers: [{ id: "claude", type: "claude-subscription", models: { claude: "model" } }] });
  const gateway = join(root, "Installed Gateway"); const native = join(root, "gateway-native-relay");
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
