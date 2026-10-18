import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { associateAppRuntime, associateAppRuntimeTransaction, renderInstalledLauncher } from "../app-runtime.js";
import { InstallationAborted, withInstallationLock } from "../app-runtime-lock.js";

const marker = "# Managed by subscription-gateway installer";

class Fixture {
  root = ""; home = ""; install = ""; app = ""; state = ""; gateway = ""; subscription = "";
  async create(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), "gateway-app-runtime-")); this.home = join(this.root, "home"); this.install = join(this.home, ".local/share/subscription-gateway");
    this.app = join(this.root, "Harness Gateway.app"); this.state = join(this.root, "state"); this.gateway = join(this.home, ".local/bin/gateway"); this.subscription = join(this.home, ".local/bin/subscription-gateway");
    await mkdir(join(this.install, "releases/one/runtime/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(this.install, "releases/one/package/dist"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.home, ".local/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(this.app, "Contents/Resources/backend/runtime/bin"), { recursive: true, mode: 0o700 });
    await writeFile(join(this.install, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 }); await writeFile(join(this.install, "releases/one/package/dist/cli.js"), "fixture", { mode: 0o600 });
    await this.node(join(this.install, "releases/one/runtime/bin/node"), "release"); await this.node(join(this.app, "Contents/Resources/backend/runtime/bin/node"), "app");
    await symlink("releases/one", join(this.install, "current"));
    await this.legacy(this.gateway); await this.legacy(this.subscription);
    return this;
  }
  async node(path: string, name: string): Promise<void> {
    await writeFile(path, `#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' '${name}' \"$GATEWAY_COMMAND\" \"$1\" \"$2\" \"$PATH\"\n`, { mode: 0o700 }); await chmod(path, 0o700);
  }
  async legacy(path: string): Promise<void> {
    await writeFile(path, `#!/bin/sh\n${marker}\nGATEWAY_COMMAND='${path}' GATEWAY_INSTALLED=1 exec '${this.install}/current/runtime/bin/node' '${this.install}/current/package/dist/cli.js' \"$@\"\n`, { mode: 0o700 }); await chmod(path, 0o700);
  }
  options(apply = true) { return { home: this.home, appPath: this.app, stateDirectory: this.state, commandPath: this.gateway, apply }; }
  async dispose(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}
async function fixture(action: (value: Fixture) => Promise<void>): Promise<void> { const value = await new Fixture().create(); try { await action(value); } finally { await value.dispose(); } }
function run(command: string, argument: string): string { return execFileSync(command, [argument], { encoding: "utf8", env: { PATH: "/fixture-path" }, stdio: ["ignore", "pipe", "pipe"] }).trim(); }

test("cross-platform fixture uses release Node until app association, then preserves app identity through a release switch", () => fixture(async f => {
  const literal = `space ' quote \" dollar $HOME`;
  const before = run(f.gateway, literal).split("|"); assert.equal(before[0], "release"); assert.equal(before[1], f.gateway); assert.equal(before[3], literal);
  const installed = await realpath(f.install);
  const originalGateway = await readFile(f.gateway); const originalSubscription = await readFile(f.subscription);
  assert.equal(await associateAppRuntime(f.options()), true);
  const linked = await lstat(join(f.install, "app-runtime")); assert.equal(linked.isSymbolicLink(), true);
  const after = run(f.gateway, literal).split("|"); assert.equal(after[0], "app"); assert.equal(after[1], join(installed, "..", "..", "bin", "gateway")); assert.equal(after[3], literal); assert.match(after[4]!, new RegExp(`^${join(installed, "app-runtime/bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  assert.match(await readFile(f.subscription, "utf8"), /app-runtime/);
  await mkdir(join(f.install, "releases/two/runtime/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(f.install, "releases/two/package/dist"), { recursive: true, mode: 0o700 });
  await f.node(join(f.install, "releases/two/runtime/bin/node"), "new-release"); await writeFile(join(f.install, "releases/two/package/dist/cli.js"), "fixture", { mode: 0o600 }); await unlink(join(f.install, "current")); await symlink("releases/two", join(f.install, "current"));
  assert.equal(run(f.gateway, literal).split("|")[0], "app", "the registry link must not fall back to changing release Node");
  const backups = await readdir(join(f.state, "service-backups")); assert.equal(backups.length, 2); const backedUp = await Promise.all(backups.map(name => readFile(join(f.state, "service-backups", name)))); assert.ok(backedUp.some(bytes => bytes.equals(originalGateway))); assert.ok(backedUp.some(bytes => bytes.equals(originalSubscription)));
  assert.equal(await associateAppRuntime(f.options()), false, "a completed association is idempotent"); assert.equal((await readdir(join(f.state, "service-backups"))).length, 2);
}));

test("preview validates the same inputs without creating a registry link, state, or wrappers", () => fixture(async f => {
  const before = await readFile(f.gateway); await writeFile(join(f.install, ".gateway-installation"), "subscription-gateway", { mode: 0o600 }); assert.equal(await associateAppRuntime(f.options(false)), true); assert.deepEqual(await readFile(f.gateway), before);
  await assert.rejects(lstat(join(f.install, "app-runtime"))); await assert.rejects(lstat(f.state));
}));

test("both current managed launchers keep the shared harness command identity", () => fixture(async f => {
  const harness = join(f.home, ".local/bin/harness-gateway");
  await f.legacy(harness);
  assert.equal(await associateAppRuntime(f.options()), true);
  assert.deepEqual(await readFile(f.gateway), await readFile(harness));
  assert.equal(run(f.gateway, "literal").split("|")[1], await realpath(harness));
  assert.equal(run(harness, "literal").split("|")[1], await realpath(harness));
}));

test("refuses a marked sibling from a foreign installation before changing this installation", () => fixture(async f => {
  const foreign = join(f.root, "foreign/share/subscription-gateway");
  const originalGateway = await readFile(f.gateway); const originalSibling = await readFile(f.subscription);
  await writeFile(f.subscription, renderInstalledLauncher(foreign, f.subscription), { mode: 0o700 });
  const foreignSibling = await readFile(f.subscription);
  await assert.rejects(associateAppRuntime(f.options()), /unsafe/);
  assert.deepEqual(await readFile(f.gateway), originalGateway);
  assert.deepEqual(await readFile(f.subscription), foreignSibling);
  assert.notDeepEqual(foreignSibling, originalSibling);
  await assert.rejects(lstat(join(f.install, "app-runtime")));
}));

test("rolls back each runtime publication without overwriting a competing wrapper", async () => {
  for (const failure of ["app-runtime", "gateway", "subscription-gateway"] as const) await fixture(async f => {
    const originals = new Map([[f.gateway, await readFile(f.gateway)], [f.subscription, await readFile(f.subscription)]]);
    const option = { ...f.options(), beforePublish: async (path: string) => {
      if (path.endsWith(failure)) {
        if (failure === "subscription-gateway") await writeFile(f.subscription, `#!/bin/sh\n${marker}\necho external\n`, { mode: 0o700 });
        throw new Error("fixture publication failure");
      }
    } };
    await assert.rejects(associateAppRuntime(option), /fixture publication failure/);
    await assert.rejects(lstat(join(f.install, "app-runtime")));
    assert.deepEqual(await readFile(f.gateway), originals.get(f.gateway));
    if (failure === "subscription-gateway") assert.match(await readFile(f.subscription, "utf8"), /echo external/);
    else assert.deepEqual(await readFile(f.subscription), originals.get(f.subscription));
  });
});

test("uses the validated custom-prefix installation, including spaces and quotes", () => fixture(async f => {
  const prefix = join(f.root, "prefix with ' quote"); const install = join(prefix, "share/subscription-gateway"); const gateway = join(prefix, "bin/gateway"); const harness = join(prefix, "bin/harness-gateway");
  await mkdir(join(install, "releases/one/runtime/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(install, "releases/one/package/dist"), { recursive: true, mode: 0o700 });
  await writeFile(join(install, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 }); await writeFile(join(install, "releases/one/package/dist/cli.js"), "fixture", { mode: 0o600 }); await f.node(join(install, "releases/one/runtime/bin/node"), "release"); await symlink("releases/one", join(install, "current"));
  await mkdir(join(prefix, "bin"), { recursive: true, mode: 0o700 }); await writeFile(gateway, renderInstalledLauncher(install, harness), { mode: 0o700 }); await writeFile(harness, renderInstalledLauncher(install, harness), { mode: 0o700 });
  const options = { ...f.options(), commandPath: gateway };
  assert.equal(await associateAppRuntime({ ...options, apply: false }), true);
  await assert.rejects(lstat(join(install, "app-runtime")));
  assert.equal(await associateAppRuntime(options), true); assert.equal(await associateAppRuntime(options), false);
  assert.deepEqual(await readFile(gateway), await readFile(harness)); assert.equal(run(gateway, "quoted prefix").split("|")[1], await realpath(harness));
}));

test("keeps every runtime dependency when a newer published wrapper refuses rollback", () => fixture(async f => {
  const originalGateway = await readFile(f.gateway); const external = `#!/bin/sh\n${marker}\necho newer\n`;
  await assert.rejects(associateAppRuntimeTransaction(f.options(), async () => {
    await writeFile(f.subscription, external, { mode: 0o700 }); throw new Error("post-publication failure");
  }), (error: unknown) => (error as { code?: string }).code === "EROLLBACK");
  assert.deepEqual(await readFile(f.subscription, "utf8"), external);
  assert.notDeepEqual(await readFile(f.gateway), originalGateway, "the sibling dependency remains published too");
  assert.equal((await lstat(join(f.install, "app-runtime"))).isSymbolicLink(), true);
}));

test("SIGTERM aborts a live association, restores publications, and releases its lock", () => fixture(async f => {
  const originalGateway = await readFile(f.gateway); const originalSubscription = await readFile(f.subscription); const ready = join(f.root, "publisher-ready");
  const script = `
    import { associateAppRuntime } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/app-runtime.js")).href)};
    import { writeFile } from "node:fs/promises";
    const options=${JSON.stringify(f.options())}; const pause=${JSON.stringify(ready)};
    try {
      await associateAppRuntime({ ...options, afterPublish: async (path, guard) => {
        if (!path.endsWith("/gateway")) return;
        await writeFile(pause, "ready");
        for (;;) { await new Promise(resolve => setTimeout(resolve, 10)); guard.check(); }
      }});
    } catch (error) { process.exitCode = error && error.signal === "SIGTERM" ? 143 : 1; }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { detached: true, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(ready, "utf8").then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(ready, "utf8"), "ready"); process.kill(-child.pid!, "SIGTERM");
  const code = await new Promise<number | null>(resolve => child.once("close", resolve)); assert.equal(code, 143);
  assert.deepEqual(await readFile(f.gateway), originalGateway); assert.deepEqual(await readFile(f.subscription), originalSubscription);
  await assert.rejects(lstat(join(f.install, "app-runtime"))); await assert.rejects(lstat(join(f.install, ".gateway-installation-lock")));
}));

test("SIGTERM immediately after lock acquisition cleans up only the owned lock", () => fixture(async f => {
  await assert.rejects(withInstallationLock(f.install, async guard => {
    void guard; throw new InstallationAborted("SIGTERM");
  }), (error: unknown) => (error as { signal?: string }).signal === "SIGTERM");
  await assert.rejects(lstat(join(f.install, ".gateway-installation-lock")));
}));

test("refuses an active installer lock without replacing a launcher", () => fixture(async f => {
  const before = await readFile(f.gateway); await mkdir(join(f.install, ".gateway-installation-lock"), { mode: 0o700 });
  await assert.rejects(associateAppRuntime(f.options()), (error: unknown) => (error as { code?: string }).code === "ELOCKBUSY");
  assert.deepEqual(await readFile(f.gateway), before);
}));

test("a registered but later missing app runtime fails closed instead of selecting release Node", () => fixture(async f => {
  await associateAppRuntime(f.options()); await unlink(join(f.app, "Contents/Resources/backend/runtime/bin/node"));
  const result = (() => { try { run(f.gateway, "x"); return "ran"; } catch (error) { return (error as { status?: number }).status; } })(); assert.equal(result, 78);
}));

test("accepts a large app runtime executable without reading it, and rejects a writable one", () => fixture(async f => {
  const runtime = join(f.app, "Contents/Resources/backend/runtime/bin/node");
  await appendFile(runtime, Buffer.alloc(64 * 1024));
  assert.equal(await associateAppRuntime(f.options()), true);
  await chmod(runtime, 0o722);
  await assert.rejects(associateAppRuntime(f.options()), /unsafe/);
}));

test("refuses a FIFO wrapper without blocking", () => fixture(async f => {
  await unlink(f.gateway); execFileSync("mkfifo", [f.gateway]);
  const script = `import { associateAppRuntime } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/app-runtime.js")).href)};\nawait associateAppRuntime(${JSON.stringify(f.options())});`;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "--eval", script], { stdio: "ignore", timeout: 1_000 }),
    (error: unknown) => {
      const result = error as { status?: number | null; signal?: string | null };
      assert.equal(result.status, 1); assert.notEqual(result.signal, "SIGTERM"); return true;
    },
  );
}));

test("refuses unsafe installers, wrappers, ancestors, and an unrelated registry link", async () => {
  const cases: Array<(f: Fixture) => Promise<void>> = [
    async f => { await writeFile(join(f.install, ".gateway-installation"), "subscription-gateway\n\n", { mode: 0o600 }); },
    async f => { await chmod(f.gateway, 0o722); },
    async f => { await unlink(f.gateway); await symlink("subscription-gateway", f.gateway); },
    async f => { await rm(join(f.install, ".gateway-installation")); },
    async f => { await symlink(join(f.root, "outside"), join(f.install, "app-runtime")); },
    async f => { await rm(join(f.home, ".local/bin"), { recursive: true }); await symlink(join(f.root, "outside"), join(f.home, ".local/bin")); },
  ];
  for (const mutate of cases) await fixture(async f => { await mutate(f); await assert.rejects(associateAppRuntime(f.options()), /unsafe/); });
});

test("the installer inline generator exactly matches the runtime association renderer", async () => {
  const source = await readFile(join(process.cwd(), "scripts/install.sh"), "utf8");
  const script = [...source.matchAll(/<<'JS'\n([\s\S]*?)\nJS/g)].map(match => match[1]).find(value => value?.includes("const [root,launcher,...files]"));
  assert.ok(script, "installer has its Node launcher generator");
  const root = "/tmp/root with ' quotes";
  const output = join(tmpdir(), `gateway-launcher-${Date.now()}-${Math.random()}.new`);
  const compatibility = `${output}.compat`; const command = output.slice(0, -4);
  try {
    execFileSync(process.execPath, ["--input-type=module", "-", root, command, output, compatibility], { input: script });
    assert.equal(await readFile(output, "utf8"), renderInstalledLauncher(root, command));
    assert.deepEqual(await readFile(output), await readFile(compatibility));
  }
  finally { await rm(output, { force: true }); await rm(compatibility, { force: true }); }
});
