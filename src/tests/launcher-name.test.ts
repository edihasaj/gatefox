import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayCommand, preferredLauncher } from "../command.js";
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
    assert.equal(preferredLauncher("/x/bin/gateway", () => true), "/x/bin/harness-gateway");
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
    const harness = join(f.root, "harness-gateway"); await writeFile(harness, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
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
const noDeps: UninstallDeps = { macService: noop, macNative: noop, macDesktop: noop, planDesktopUnregister: noop, macSsh: noop, macTunnel: noop } as unknown as UninstallDeps;

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
