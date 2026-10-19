import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { associateAppRuntime, renderInstalledLauncher } from "../app-runtime.js";

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
  const source = await readFile(join(process.cwd(), "scripts/install.sh"), "utf8"); const script = source.match(/<<'JS'\n([\s\S]*?)\nJS/)?.[1]; assert.ok(script, "installer has its Node launcher generator");
  const root = "/tmp/root with ' quotes"; const output = join(tmpdir(), `gateway-launcher-${Date.now()}-${Math.random()}.new`); const command = output.slice(0, -4);
  try { execFileSync(process.execPath, ["--input-type=module", "-", root, output], { input: script }); assert.equal(await readFile(output, "utf8"), renderInstalledLauncher(root, command)); }
  finally { await rm(output, { force: true }); }
});
