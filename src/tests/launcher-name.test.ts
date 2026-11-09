import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayCommand, preferredLauncher, isManagedLauncher } from "../command.js";
import { renameLauncherInPlist, renameLaunchers } from "../mac-launcher-rename.js";
import { installUnifiedService, type UnifiedInstallTools } from "../mac-service.js";
import { sameNativeRegistration } from "../mac-native.js";
import { servicePlist } from "../mac-service.js";
import { collectServicePlan } from "../mac-consolidate.js";
import { macDesktop } from "../mac-desktop.js";
import { uninstallGateway, type UninstallDeps } from "../uninstall.js";
import { validateServicePlan } from "../service-plan.js";
import { desktopFixture, inDesktopHome } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const label = "com.edihasaj.subscription-gateway";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An installed layout in a temp folder: `bin/gateway` and `bin/harness-gateway`, both executable. */
async function installed(names = ["gateway", "harness-gateway"]) {
  const root = await mkdtemp(join(tmpdir(), "gateway-launcher-")); const bin = join(root, "bin"); await mkdir(bin);
  for (const name of names) await writeFile(join(bin, name), "#!/bin/sh\n# Managed by subscription-gateway installer\n", { mode: 0o700 });
  return { root, bin };
}
async function withCommand<T>(command: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = { installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
  process.env.GATEWAY_INSTALLED = "1"; if (command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = command;
  try { return await run(); } finally {
    if (saved.installed === undefined) delete process.env.GATEWAY_INSTALLED; else process.env.GATEWAY_INSTALLED = saved.installed;
    if (saved.command === undefined) delete process.env.GATEWAY_COMMAND; else process.env.GATEWAY_COMMAND = saved.command;
  }
}

test("gatewayCommand names harness-gateway for either launcher, and leaves the older name where harness-gateway is absent", async () => {
  const both = await installed(); const only = await installed(["gateway"]);
  try {
    for (const name of ["gateway", "harness-gateway"]) {
      assert.deepEqual(await withCommand(join(both.bin, name), async () => gatewayCommand()), { command: join(both.bin, "harness-gateway"), args: [] }, name);
    }
    assert.deepEqual(await withCommand(join(only.bin, "gateway"), async () => gatewayCommand()), { command: join(only.bin, "gateway"), args: [] }, "a rollback layout keeps what it has");
    assert.equal(preferredLauncher("/x/bin/gateway", () => true), "/x/bin/gatefox");
    // A harness-gateway without the installer's marker, or one that is only a link, is not ours to name in a plist.
    await writeFile(join(only.bin, "harness-gateway"), "#!/bin/sh\necho foreign\n", { mode: 0o700 });
    assert.deepEqual(await withCommand(join(only.bin, "gateway"), async () => gatewayCommand()), { command: join(only.bin, "gateway"), args: [] }, "no marker: keep gateway");
    assert.equal(isManagedLauncher(join(only.bin, "harness-gateway")), false);
    await rm(join(only.bin, "harness-gateway")); await symlink("gateway", join(only.bin, "harness-gateway"));
    assert.equal(isManagedLauncher(join(only.bin, "harness-gateway")), false, "a link is not a managed launcher file");
    assert.equal(isManagedLauncher(join(only.bin, "gateway")), true);
    assert.equal(preferredLauncher("/x/bin/gateway", () => false), "/x/bin/gateway");
    assert.equal(preferredLauncher("/x/bin/other", () => true), "/x/bin/other", "only the older launcher name is mapped");
  } finally { await rm(both.root, { recursive: true, force: true }); await rm(only.root, { recursive: true, force: true }); }
});

test("the service plist and plans written from the older command name harness-gateway", mac, async () => {
  const layout = await installed(); const state = join(layout.root, "state"); const config = join(layout.root, "config.json");
  await mkdir(state);
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "test", type: "claude-subscription", models: { test: "test" } }] }));
  const directory = join(layout.root, "agents"); await mkdir(directory);
  const harness = join(layout.bin, "harness-gateway"); const legacy = join(layout.bin, "gateway");
  try {
    await withCommand(legacy, async () => {
      const command = gatewayCommand();
      const plist = servicePlist(process.execPath, "/unused/cli.js", config, join(state, "service.log"), "/usr/bin:/bin", command.command);
      assert.ok(plist.includes(`<key>ProgramArguments</key><array><string>${harness}</string><string>serve</string>`));
      assert.equal(plist.includes(`<string>${legacy}</string>`), false);
      // Collection reads old plists that name either launcher and plans the unified service under harness-gateway.
      for (const name of [legacy, harness]) {
        await rm(directory, { recursive: true, force: true }); await mkdir(directory);
        await writeFile(join(directory, label + ".plist"), servicePlist(process.execPath, "/unused/cli.js", config, join(state, "service.log"), "/usr/bin:/bin", name));
        await writeFile(join(directory, label + ".desktop.plist"), `<?xml version="1.0"?><!-- Managed by subscription-gateway --><plist version="1.0"><dict><key>Label</key><string>${label}.desktop</string><key>ProgramArguments</key><array><string>${xml(name)}</string><string>desktop</string><string>register</string><string>--config</string><string>${xml(config)}</string><string>--app</string><string>/Applications/ChatGPT.app</string></array></dict></plist>\n`);
        const { plan, jobs } = await collectServicePlan(config, directory);
        assert.equal(jobs.length, 2, name);
        assert.deepEqual(plan.components.map(component => [component.kind, component.command]), [["desktop", harness], ["inference", harness]], name);
        assert.deepEqual(validateServicePlan(JSON.parse(JSON.stringify(plan))).components.length, 2, "and the plan validates");
      }
    });
  } finally { await rm(layout.root, { recursive: true, force: true }); }
});

test("the desktop login agent is written with harness-gateway as its program", mac, async () => {
  const f = await desktopFixture("launcher-name");
  await inDesktopHome(f, async () => {
    const harness = join(f.root, "harness-gateway"); await writeFile(harness, "#!/bin/sh\n# Managed by subscription-gateway installer\nexit 0\n", { mode: 0o700 });
    await writeFile(f.gateway, "#!/bin/sh\n# Managed by subscription-gateway installer\nexit 0\n", { mode: 0o700 });
    // The fixture's installed command is the older name; the plist still names the sibling harness-gateway.
    await macDesktop("register", f.config, f.app, false, f.exec);
    const text = await readFile(join(f.home, "Library/LaunchAgents", label + ".desktop.plist"), "utf8");
    assert.ok(text.includes(`<key>ProgramArguments</key><array><string>${harness}</string><string>desktop</string><string>register</string>`), text);
    assert.equal(text.includes(`<string>${f.gateway}</string>`), false, "never the older name");
  });
});

/** The installer's layout under a temp HOME, with the launchers as the 0.4.6 installer leaves them or as an older one did. */
async function uninstallLayout(shape: "current" | "linked" | "foreign-alias") {
  const home = await mkdtemp(join(tmpdir(), "gateway-uninstall-launchers-")); const bin = join(home, "bin");
  await mkdir(bin); await mkdir(join(home, "Library/LaunchAgents"), { recursive: true }); await mkdir(join(home, "share/subscription-gateway"), { recursive: true });
  await writeFile(join(home, "share/subscription-gateway/.gateway-installation"), "subscription-gateway\n");
  const managed = "#!/bin/sh\n# Managed by subscription-gateway installer\n";
  await writeFile(join(bin, "gateway"), managed, { mode: 0o700 });
  if (shape === "current") await writeFile(join(bin, "harness-gateway"), managed, { mode: 0o700 });
  if (shape === "linked") await symlink("gateway", join(bin, "harness-gateway"));
  if (shape === "foreign-alias") await writeFile(join(bin, "harness-gateway"), "#!/bin/sh\necho mine\n", { mode: 0o755 });
  return { home, bin };
}
const noop = async () => ({});
const noDeps: UninstallDeps = { macService: noop, macNative: noop, macDesktop: noop, planDesktopUnregister: noop, macSsh: noop, macTunnel: noop, withdrawNativeProvider: async () => "absent" } as unknown as UninstallDeps;

test("uninstall moves both launchers to the Trash whichever one ran it, and leaves a foreign harness-gateway alone", mac, async () => {
  for (const [shape, running] of [["current", "harness-gateway"], ["current", "gateway"], ["linked", "gateway"], ["foreign-alias", "gateway"]] as const) {
    const l = await uninstallLayout(shape); const saved = { HOME: process.env.HOME, installed: process.env.GATEWAY_INSTALLED, command: process.env.GATEWAY_COMMAND };
    process.env.HOME = l.home; process.env.GATEWAY_INSTALLED = "1"; process.env.GATEWAY_COMMAND = join(l.bin, running);
    try {
      await uninstallGateway(join(l.home, "gateway.json"), noDeps);
      const trashed = await readdir(join(l.home, ".Trash"));
      const left = await readdir(l.bin);
      if (shape === "foreign-alias") {
        assert.deepEqual(left, ["harness-gateway"], shape + ": the foreign file stays");
        assert.equal(await readFile(join(l.bin, "harness-gateway"), "utf8"), "#!/bin/sh\necho mine\n");
        assert.equal(trashed.some(name => name.startsWith("harness-gateway.")), false);
      } else {
        assert.deepEqual(left, [], `${shape}/${running}: no launcher is left`);
        for (const name of ["gateway", "harness-gateway"]) assert.equal(trashed.some(entry => entry.startsWith(name + ".")), true, `${shape}/${running}: ${name} is in the Trash`);
      }
    } finally {
      for (const [key, value] of [["HOME", saved.HOME], ["GATEWAY_INSTALLED", saved.installed], ["GATEWAY_COMMAND", saved.command]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(l.home, { recursive: true, force: true });
    }
  }
});

const unifiedPlist = (program: string, config: string, extra = "") => servicePlist(process.execPath, "/unused/cli.js", config, "/tmp/service.log", "/usr/bin:/bin", program, "daemon") + extra;

test("an already-unified service plist is rewritten in place to harness-gateway, changing nothing else", async () => {
  const l = await installed(); const file = join(l.root, `${label}.plist`); const config = "/Users/x/Library/Application Support/gw & co/config.json";
  const legacy = join(l.bin, "gateway"); const harness = join(l.bin, "harness-gateway");
  try {
    const original = unifiedPlist(legacy, config); await writeFile(file, original, { mode: 0o600 });
    assert.equal(await renameLauncherInPlist(file), true);
    const text = await readFile(file, "utf8");
    assert.equal(text, original.replace(`<string>${legacy}</string>`, `<string>${harness}</string>`), "only the program changed (label, arguments, KeepAlive and the rest are as they were)");
    assert.ok(text.includes(`<key>Label</key><string>${label}</string>`));
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(l.root)).filter(name => name.includes("rename") || name.includes("tmp")), [], "no temporary file is left");
    assert.equal(await renameLauncherInPlist(file), false, "a second run changes nothing");
    assert.equal(await renameLauncherInPlist(join(l.root, "missing.plist")), false, "and a missing file is not an error");
  } finally { await rm(l.root, { recursive: true, force: true }); }
});

test("the launcher rename refuses what is not ours: foreign plist, foreign launcher, missing or unmarked harness-gateway, links", async () => {
  const l = await installed(); const config = "/c.json"; const legacy = join(l.bin, "gateway");
  const check = async (name: string, text: string) => { const file = join(l.root, name + ".plist"); await writeFile(file, text); assert.equal(await renameLauncherInPlist(file), false, name); assert.equal(await readFile(file, "utf8"), text, name + ": untouched"); return file; };
  try {
    await check("foreign-plist", unifiedPlist(legacy, config).replace("<!-- Managed by subscription-gateway -->", ""));
    await check("other-program", unifiedPlist(join(l.bin, "elsewhere"), config));
    await check("node-program", unifiedPlist("/usr/bin/node", config));
    await writeFile(legacy, "#!/bin/sh\necho foreign\n", { mode: 0o700 });
    await check("foreign-launcher", unifiedPlist(legacy, config));
    await writeFile(legacy, "#!/bin/sh\n# Managed by subscription-gateway installer\n", { mode: 0o700 });
    await writeFile(join(l.bin, "harness-gateway"), "#!/bin/sh\necho foreign\n", { mode: 0o700 });
    await check("unmarked-harness", unifiedPlist(legacy, config));
    await rm(join(l.bin, "harness-gateway"));
    await check("no-harness", unifiedPlist(legacy, config));
    await writeFile(join(l.bin, "harness-gateway"), "#!/bin/sh\n# Managed by subscription-gateway installer\n", { mode: 0o700 });
    const real = join(l.root, "real.plist"); await writeFile(real, unifiedPlist(legacy, config)); const link = join(l.root, "link.plist"); await symlink(real, link);
    assert.equal(await renameLauncherInPlist(link), false, "a link is never followed"); assert.equal(await readFile(real, "utf8"), unifiedPlist(legacy, config));
  } finally { await rm(l.root, { recursive: true, force: true }); }
});

/** launchd, recorded: a test never reaches the real session. */
function fakeLaunchd(installedState: { installed: boolean; pid?: number }) {
  const calls: string[] = [];
  const tools: UnifiedInstallTools = { status: async () => { calls.push("print"); return installedState; }, launchctl: async args => { calls.push(args.join(" ")); }, finish: async () => ({ service: label, mode: "supervised" }) };
  return { calls, tools };
}

test("gateway service install on a unified Mac renames the launcher without booting out or restarting anything", async () => {
  const l = await installed(); const file = join(l.root, `${label}.plist`); const desktop = join(l.root, `${label}.desktop.plist`); const config = "/c.json";
  const legacy = join(l.bin, "gateway"); const harness = join(l.bin, "harness-gateway");
  try {
    await writeFile(file, unifiedPlist(legacy, config), { mode: 0o600 });
    await writeFile(desktop, `<?xml version="1.0"?><!-- Managed by subscription-gateway --><plist version="1.0"><dict><key>Label</key><string>${label}.desktop</string><key>ProgramArguments</key><array><string>${legacy}</string><string>desktop</string><string>register</string></array></dict></plist>\n`);
    const running = fakeLaunchd({ installed: true, pid: 4242 });
    const result = await installUnifiedService({ service: file, desktop, target: `gui/501/${label}`, domain: "gui/501" }, running.tools);
    assert.deepEqual(running.calls, ["print"], "a running service gets no launchctl write at all: no bootout, kickstart or bootstrap");
    assert.deepEqual([result.programRewritten, result.desktopRewritten, result.appliesAt, result.mode], [true, true, "next login", "supervised"]);
    assert.ok((await readFile(file, "utf8")).includes(`<array><string>${harness}</string><string>daemon</string>`));
    assert.ok((await readFile(desktop, "utf8")).includes(`<array><string>${harness}</string><string>desktop</string>`));
    const again = await installUnifiedService({ service: file, desktop, target: `gui/501/${label}`, domain: "gui/501" }, fakeLaunchd({ installed: true, pid: 4242 }).tools);
    assert.deepEqual([again.programRewritten, again.desktopRewritten, "appliesAt" in again], [false, false, false], "a second install rewrites nothing and promises nothing");
  } finally { await rm(l.root, { recursive: true, force: true }); }
});

test("a unified install still starts a stopped service as before, and a rewrite that failed does not stop it", async () => {
  const l = await installed(); const file = join(l.root, `${label}.plist`); const legacy = join(l.bin, "gateway");
  try {
    await writeFile(file, unifiedPlist(legacy, "/c.json"), { mode: 0o600 });
    const stopped = fakeLaunchd({ installed: false });
    const started = await installUnifiedService({ service: file, desktop: join(l.root, "none.plist"), target: `gui/501/${label}`, domain: "gui/501" }, stopped.tools);
    assert.deepEqual(stopped.calls, ["print", `enable gui/501/${label}`, `bootstrap gui/501 ${file}`]);
    assert.equal(started.appliesAt, "now", "loaded after the rewrite, so it applies at once");
    const idle = fakeLaunchd({ installed: true });
    await installUnifiedService({ service: file, desktop: join(l.root, "none.plist"), target: `gui/501/${label}`, domain: "gui/501" }, idle.tools);
    assert.deepEqual(idle.calls, ["print", `kickstart gui/501/${label}`], "loaded without a process: kickstart, as before");
    // A write that fails (a directory in the way of the temporary file) is reported and the service still starts.
    await writeFile(file, unifiedPlist(legacy, "/c.json"), { mode: 0o600 }); await mkdir(`${file}.${process.pid}.rename`);
    const blocked = fakeLaunchd({ installed: true, pid: 1 });
    const result = await installUnifiedService({ service: file, desktop: join(l.root, "none.plist"), target: `gui/501/${label}`, domain: "gui/501" }, blocked.tools);
    assert.deepEqual([result.programRewritten, result.launcherRenameFailed], [false, true]);
    assert.ok((await readFile(file, "utf8")).includes(`<string>${legacy}</string>`), "the plist is as it was");
    assert.deepEqual((await renameLaunchers(file, join(l.root, "none.plist"))).failed, true);
  } finally { await rm(l.root, { recursive: true, force: true }); }
});

test("a native relay started with the older launcher name is the same registration as the one written now", () => {
  const harness = "/h/.local/bin/harness-gateway"; const legacy = "/h/.local/bin/gateway";
  const written = (command: string) => `<array><string>/r/gateway-native-relay</string><string>--gateway</string><string>${command}</string><string>--daemon</string></array>`;
  assert.equal(sameNativeRegistration(written(harness), written(harness), harness), true);
  assert.equal(sameNativeRegistration(written(legacy), written(harness), harness), true, "the 0.4.5 relay is not 'another registration'");
  assert.equal(sameNativeRegistration(written("/h/.local/bin/other"), written(harness), harness), false);
  assert.equal(sameNativeRegistration(undefined, written(harness), harness), false);
  assert.equal(sameNativeRegistration(written(harness), written(legacy), legacy), false, "only the harness-gateway form is migrated from");
});


test("new installations name only the managed gatefox command in generated native auth rows", async () => {
  const layout = await installed(["gateway", "harness-gateway", "gatefox"]);
  try {
    for (const name of ["gateway", "harness-gateway", "gatefox"]) await withCommand(join(layout.bin, name), async () => {
      assert.equal(gatewayCommand().command, join(layout.bin, "gatefox"));
      const { nativeProviderRow } = await import("../native-provider-row.js");
      const row = nativeProviderRow(3457, join(layout.root, "gateway.json"));
      assert.equal(row.name, "GateFox"); assert.equal(row.auth.command, join(layout.bin, "gatefox"));
    });
    await writeFile(join(layout.bin, "gatefox"), "#!/bin/sh\necho not-managed\n", { mode: 0o700 });
    assert.equal(await withCommand(join(layout.bin, "gateway"), async () => gatewayCommand().command), join(layout.bin, "harness-gateway"));
  } finally { await rm(layout.root, { recursive: true, force: true }); }
});


test("native relay registrations accept migration from both historical sibling launchers to gatefox", () => {
  const base = "/h/.local/bin", gatefox = join(base, "gatefox");
  const written = (command: string) => `<array><string>/relay</string><string>--gateway</string><string>${command}</string><string>--native-home</string><string>/home</string></array>`;
  for (const name of ["gateway", "harness-gateway", "gatefox"]) assert.equal(sameNativeRegistration(written(join(base, name)), written(gatefox), gatefox), true, name);
  assert.equal(sameNativeRegistration(written("/elsewhere/gatefox"), written(gatefox), gatefox), false);
  assert.equal(sameNativeRegistration(written(join(base, "gateway")).replace("/home", "/foreign"), written(gatefox), gatefox), false);
});
