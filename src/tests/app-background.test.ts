import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { appResourceAncestorAllowed, canonicalPath, handleAppBackground, parseAppBackgroundArgs, runBoundedCommand, verifySignature, type AppBackgroundDependencies } from "../app-background.js";
import { renderInstalledLauncher } from "../app-runtime.js";
import { InstallationAborted } from "../app-runtime-lock.js";
import type { ConfigSnapshot } from "../app-management/storage.js";
import { serviceLabel, serviceMarker } from "../service-plan.js";

const decode = async (bytes: Buffer) => {
  const text = bytes.toString("utf8").replace(`${serviceMarker}\n`, ""); const match = text.match(/<plist>([\s\S]*)<\/plist>/);
  return JSON.parse(match ? match[1]! : text) as Record<string, unknown>;
};
const encode = async (value: Record<string, unknown>) => Buffer.from(`<?xml version="1.0"?><plist>${JSON.stringify(value)}</plist>`);
const directory = (mode: number, uid = 0, link = false) => ({ mode, uid, isDirectory: () => true, isSymbolicLink: () => link });

class Fixture {
  root = ""; home = ""; app = ""; helper = ""; config = ""; state = ""; launcher = ""; plist = ""; install = "";
  async create(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), "gateway-app-background-")); this.home = join(this.root, "home"); this.app = join(this.root, "Harness Gateway.app");
    this.helper = join(this.app, "Contents/MacOS/GatewayService"); this.config = join(this.root, "gateway.json"); this.state = join(this.root, "state");
    this.launcher = join(this.home, ".local/bin/gateway"); this.plist = join(this.home, `Library/LaunchAgents/${serviceLabel}.plist`); this.install = join(this.home, ".local/share/subscription-gateway");
    await mkdir(join(this.home, ".local/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(this.home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.app, "Contents/MacOS"), { recursive: true, mode: 0o700 }); await mkdir(join(this.app, "Contents/Resources/backend/runtime/bin"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.install, "releases/one/runtime/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(this.install, "releases/one/package/dist"), { recursive: true, mode: 0o700 });
    await writeFile(join(this.install, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 }); await writeFile(join(this.install, "releases/one/package/dist/cli.js"), "fixture", { mode: 0o600 });
    await writeFile(join(this.install, "releases/one/runtime/bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await writeFile(join(this.app, "Contents/Resources/backend/runtime/bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink("releases/one", join(this.install, "current"));
    const harness = join(this.home, ".local/bin/harness-gateway"); await writeFile(this.launcher, renderInstalledLauncher(this.install, harness), { mode: 0o700 }); await writeFile(harness, renderInstalledLauncher(this.install, harness), { mode: 0o700 }); await chmod(this.launcher, 0o700); await chmod(harness, 0o700);
    await writeFile(this.helper, "fixture", { mode: 0o700 }); await writeFile(join(this.app, "Contents/Info.plist"), JSON.stringify({ CFBundleIdentifier: "com.edihasaj.harness-gateway.app" }), { mode: 0o600 });
    return this;
  }
  snapshot(revision = "one"): ConfigSnapshot { return { raw: {}, config: { stateDirectory: this.state } as ConfigSnapshot["config"], revision }; }
  plistValue(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { Label: serviceLabel, ProgramArguments: [this.launcher, "daemon", "--config", this.config, "--keep-flag"], EnvironmentVariables: { PATH: "/fixture/bin", UNRELATED: "kept" }, StandardOutPath: "/fixture/log", RunAtLoad: true, ...extra };
  }
  async writePlist(value = this.plistValue()): Promise<void> { await writeFile(this.plist, `${serviceMarker}\n${JSON.stringify(value)}`, { mode: 0o600 }); }
  async remove(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await new Fixture().create(); const previous = process.env.HOME; process.env.HOME = fixture.home;
  try { await action(fixture); } finally { process.env.HOME = previous; await fixture.remove(); }
}
function dependencies(fixture: Fixture, overrides: Partial<AppBackgroundDependencies> = {}): AppBackgroundDependencies {
  return { readSnapshot: async () => fixture.snapshot(), decodePlist: decode, encodePlist: encode, verifySignature: async () => true, registerApp: async () => {}, associateRuntime: async () => false, ...overrides };
}
async function run(fixture: Fixture, apply = false, overrides: Partial<AppBackgroundDependencies> = {}) {
  return handleAppBackground({ configPath: fixture.config, apply, appPath: fixture.app }, dependencies(fixture, overrides));
}

test("keeps an ordinary Linux /tmp directory literal during canonicalization", async () => {
  const inspected: string[] = [];
  const path = await canonicalPath("/tmp/gateway-fixture", { lstat: async value => { inspected.push(value); return directory(0o1777); }, readlink: async () => { throw new Error("unused"); } });
  assert.equal(path, "/tmp/gateway-fixture"); assert.deepEqual(inspected, ["/tmp"]);
});

test("allows only the exact standard /Applications root:admin writable ancestor for app resources", () => {
  const standard = directory(0o775);
  assert.equal(appResourceAncestorAllowed("/Applications", standard), true);
  assert.equal(appResourceAncestorAllowed("/opt/Applications", standard), false);
  assert.equal(appResourceAncestorAllowed("/Applications", directory(0o775, 501)), false);
  assert.equal(appResourceAncestorAllowed("/Applications", directory(0o775, 0, true)), false);
});

test("preserves every unrelated plist field and writes only the signed-app association", () => withFixture(async fixture => {
  await fixture.writePlist(); const before = await decode(await readFile(fixture.plist)); const response = await run(fixture, true);
  assert.deepEqual(response, { ok: true, result: { status: "associated", changed: true, appliesAt: "next_service_start" } });
  const after = await decode(await readFile(fixture.plist)); const helper = fixture.helper;
  assert.deepEqual(after, { ...before, Program: helper, AssociatedBundleIdentifiers: "com.edihasaj.harness-gateway.app" });
  assert.ok((await readFile(fixture.plist, "utf8")).includes(serviceMarker));
}));

test("an applied association is idempotent and does not create another backup", () => withFixture(async fixture => {
  await fixture.writePlist(); let registrations = 0;
  assert.equal((await run(fixture, true, { registerApp: async () => { registrations++; } })).ok, true);
  const backups = join(fixture.state, "service-backups"); assert.equal((await readdir(backups)).length, 1);
  assert.deepEqual(await run(fixture, true, { registerApp: async () => { registrations++; } }), { ok: true, result: { status: "already_associated", changed: false, appliesAt: "next_service_start" } });
  assert.equal((await readdir(backups)).length, 1); assert.equal(registrations, 2, "apply retries app registration after an earlier association");
}));

test("repairs the runtime of an already attributed service under the same registration lock", () => withFixture(async fixture => {
  await fixture.writePlist({ ...fixture.plistValue(), Program: fixture.helper, AssociatedBundleIdentifiers: "com.edihasaj.harness-gateway.app" });
  let received: unknown;
  const response = await run(fixture, true, { associateRuntime: async options => { received = options; return true; } });
  assert.deepEqual(response, { ok: true, result: { status: "associated", changed: true, appliesAt: "next_service_start" } });
  assert.deepEqual(received, { home: fixture.home, appPath: fixture.app, stateDirectory: fixture.state, commandPath: fixture.launcher });
}));

test("runtime refusal preserves the original service registration", () => withFixture(async fixture => {
  await fixture.writePlist();
  const original = await readFile(fixture.plist);
  const response = await run(fixture, true, { associateRuntime: async () => { throw new Error("unsafe"); } });
  assert.deepEqual(response, { ok: false, error: { code: "unsafe_installation", message: "The installed gateway service is not safe to update." } });
  assert.deepEqual(await readFile(fixture.plist), original);
  await assert.rejects(readdir(join(fixture.state, "service-backups")), { code: "ENOENT" });
}));

test("registers before mutation and leaves the plist intact when registration fails", () => withFixture(async fixture => {
  await fixture.writePlist(); const original = await readFile(fixture.plist);
  const response = await run(fixture, true, { registerApp: async () => { assert.deepEqual(await readFile(fixture.plist), original); throw new Error("fixture"); } });
  assert.equal(response.ok, false); assert.deepEqual(await readFile(fixture.plist), original);
}));

test("refuses a configuration that changes while waiting for the registration lock", () => withFixture(async fixture => {
  await fixture.writePlist(); let calls = 0;
  const response = await run(fixture, true, { readSnapshot: async () => fixture.snapshot(calls++ ? "two" : "one") });
  assert.deepEqual(response, { ok: false, error: { code: "configuration_changed", message: "The gateway configuration changed; refresh and try again." } });
}));

test("refuses unsafe links and writable LaunchAgent files without revealing paths", () => withFixture(async fixture => {
  await fixture.writePlist(); await chmod(fixture.plist, 0o666);
  const writable = await run(fixture, true); assert.equal(writable.ok, false); if (!writable.ok) assert.ok(!writable.error.message.includes(fixture.root));
  await chmod(fixture.plist, 0o600); await rm(fixture.plist); await symlink(join(fixture.root, "elsewhere"), fixture.plist);
  const linked = await run(fixture); assert.deepEqual(linked, { ok: false, error: { code: "unsafe_installation", message: "The installed gateway service is not safe to update." } });
}));

test("refuses a symlinked state directory before the lock or backup can escape", () => withFixture(async fixture => {
  await fixture.writePlist(); const outside = join(fixture.root, "outside"); await mkdir(outside, { mode: 0o700 }); await symlink(outside, fixture.state);
  const response = await run(fixture, true); assert.equal(response.ok, false); assert.deepEqual(await readdir(outside), []);
}));

test("refuses unmanaged and conflicting LaunchAgent keys", () => withFixture(async fixture => {
  await fixture.writePlist({ ...fixture.plistValue(), Program: "/unrelated/program" });
  assert.equal((await run(fixture)).ok, false);
  await fixture.writePlist({ ...fixture.plistValue(), AssociatedBundleIdentifiers: ["com.edihasaj.harness-gateway.app", "another.app"] });
  assert.equal((await run(fixture)).ok, false);
  await writeFile(fixture.plist, JSON.stringify(fixture.plistValue())); assert.equal((await run(fixture)).ok, false);
}));

test("normalizes the one permitted legacy associated-bundle array", () => withFixture(async fixture => {
  await fixture.writePlist({ ...fixture.plistValue(), AssociatedBundleIdentifiers: ["com.edihasaj.harness-gateway.app"] });
  assert.equal((await run(fixture, true)).ok, true);
  assert.equal((await decode(await readFile(fixture.plist))).AssociatedBundleIdentifiers, "com.edihasaj.harness-gateway.app");
}));

test("reports unsigned and pending states without changing the LaunchAgent", () => withFixture(async fixture => {
  await fixture.writePlist(); const original = await readFile(fixture.plist);
  assert.deepEqual(await run(fixture, true, { verifySignature: async () => false }), { ok: true, result: { status: "unsigned", changed: false, appliesAt: "next_service_start" } });
  await mkdir(fixture.state, { recursive: true, mode: 0o700 }); await writeFile(join(fixture.state, "service-login-pending.json"), "{}", { mode: 0o600 });
  assert.deepEqual(await run(fixture, true), { ok: true, result: { status: "pending", changed: false, appliesAt: "next_service_start" } });
  assert.deepEqual(await readFile(fixture.plist), original);
}));

test("detects a concurrent replacement immediately before its atomic rename", () => withFixture(async fixture => {
  await fixture.writePlist(); const replacement = `${serviceMarker}\n${JSON.stringify(fixture.plistValue({ KeepAlive: false }))}`;
  const response = await run(fixture, true, { encodePlist: async value => { await writeFile(fixture.plist, replacement, { mode: 0o600 }); return encode(value); } });
  assert.deepEqual(response, { ok: false, error: { code: "configuration_changed", message: "The gateway configuration changed; refresh and try again." } });
  assert.deepEqual(await readFile(fixture.plist, "utf8"), replacement);
}));

test("validates the strict command-line surface and previews without writes", () => withFixture(async fixture => {
  await fixture.writePlist({ ...fixture.plistValue(), ProgramArguments: [fixture.launcher, "serve", "--config", fixture.config] });
  const before = await readFile(fixture.plist); assert.deepEqual(await run(fixture), { ok: true, result: { status: "preview", changed: false, appliesAt: "next_service_start", wouldChange: true } }); assert.deepEqual(await readFile(fixture.plist), before); assert.deepEqual(await readdir(fixture.root), ["Harness Gateway.app", "home"]);
  assert.deepEqual(parseAppBackgroundArgs(["--config", fixture.config, "--apply"]), { configPath: fixture.config, apply: true }); assert.equal(parseAppBackgroundArgs(["--apply", "--config", fixture.config]), undefined);
}));

test("preview reports wouldChange from the first validated association", () => withFixture(async fixture => {
  await fixture.writePlist({ ...fixture.plistValue(), Program: fixture.helper, AssociatedBundleIdentifiers: "com.edihasaj.harness-gateway.app" });
  assert.deepEqual(await run(fixture), { ok: true, result: { status: "preview", changed: false, appliesAt: "next_service_start", wouldChange: false } });
}));

test("publishes only completed private backups when later serialization fails", () => withFixture(async fixture => {
  await fixture.writePlist(); const original = await readFile(fixture.plist);
  const response = await run(fixture, true, { encodePlist: async () => { throw new Error("fixture"); } }); assert.equal(response.ok, false);
  const backups = join(fixture.state, "service-backups"); const names = await readdir(backups); assert.equal(names.length, 1); assert.deepEqual(await readFile(join(backups, names[0]!)), original);
}));

test("a real runtime association rolls back when plist serialization fails", () => withFixture(async fixture => {
  await fixture.writePlist(); const gateway = await readFile(fixture.launcher); const harness = await readFile(join(fixture.home, ".local/bin/harness-gateway"));
  const response = await run(fixture, true, { associateRuntime: undefined, encodePlist: async () => { throw new Error("fixture"); } });
  assert.equal(response.ok, false); await assert.rejects(lstat(join(fixture.install, "app-runtime")));
  assert.deepEqual(await readFile(fixture.launcher), gateway); assert.deepEqual(await readFile(join(fixture.home, ".local/bin/harness-gateway")), harness);
}));

test("a post-rename plist validation failure restores the original plist and runtime publications", () => withFixture(async fixture => {
  await fixture.writePlist(); const plist = await readFile(fixture.plist); const gateway = await readFile(fixture.launcher); const harness = await readFile(join(fixture.home, ".local/bin/harness-gateway")); let renamed = false;
  const response = await run(fixture, true, { associateRuntime: undefined, beforeReplace: async () => { renamed = true; }, decodePlist: async bytes => {
    if (renamed) throw new Error("post-rename decode"); return decode(bytes);
  } });
  assert.equal(response.ok, false); assert.deepEqual(await readFile(fixture.plist), plist); assert.deepEqual(await readFile(fixture.launcher), gateway); assert.deepEqual(await readFile(join(fixture.home, ".local/bin/harness-gateway")), harness);
  await assert.rejects(lstat(join(fixture.install, "app-runtime")));
}));

test("SIGTERM immediately after an owned plist receipt restores the plist and runtime publications", () => withFixture(async fixture => {
  await fixture.writePlist(); const plist = await readFile(fixture.plist); const gateway = await readFile(fixture.launcher); const harness = await readFile(join(fixture.home, ".local/bin/harness-gateway"));
  await assert.rejects(run(fixture, true, { associateRuntime: undefined, afterReplace: async () => {
    throw new InstallationAborted("SIGTERM");
  } }), (error: unknown) => (error as { signal?: string }).signal === "SIGTERM");
  assert.deepEqual(await readFile(fixture.plist), plist); assert.deepEqual(await readFile(fixture.launcher), gateway); assert.deepEqual(await readFile(join(fixture.home, ".local/bin/harness-gateway")), harness);
  await assert.rejects(lstat(join(fixture.install, "app-runtime")));
}));

test("a concurrent plist replacement is preserved with the runtime dependencies it may reference", () => withFixture(async fixture => {
  await fixture.writePlist(); let renamed = false; let replaced = false; const external = `${serviceMarker}\n${JSON.stringify(fixture.plistValue({ KeepAlive: false, Program: fixture.helper, AssociatedBundleIdentifiers: "com.edihasaj.harness-gateway.app" }))}`;
  const response = await run(fixture, true, { associateRuntime: undefined, beforeReplace: async () => { renamed = true; }, decodePlist: async bytes => {
    if (renamed && !replaced) { replaced = true; await writeFile(fixture.plist, external, { mode: 0o600 }); throw new Error("concurrent plist"); }
    return decode(bytes);
  } });
  assert.equal(response.ok, false); assert.equal(await readFile(fixture.plist, "utf8"), external);
  assert.equal((await lstat(join(fixture.install, "app-runtime"))).isSymbolicLink(), true);
  assert.match(await readFile(fixture.launcher, "utf8"), /app-runtime/);
}));

test("previews, applies, and repeats a signed-runtime association under a quoted custom prefix", () => withFixture(async fixture => {
  const prefix = join(fixture.root, "custom prefix ' quote"); const install = join(prefix, "share/subscription-gateway"); const launcher = join(prefix, "bin/gateway"); const harness = join(prefix, "bin/harness-gateway");
  await mkdir(join(install, "releases/one/runtime/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(install, "releases/one/package/dist"), { recursive: true, mode: 0o700 }); await mkdir(join(prefix, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(join(install, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 }); await writeFile(join(install, "releases/one/package/dist/cli.js"), "fixture", { mode: 0o600 }); await writeFile(join(install, "releases/one/runtime/bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await symlink("releases/one", join(install, "current"));
  await writeFile(launcher, renderInstalledLauncher(install, harness), { mode: 0o700 }); await writeFile(harness, renderInstalledLauncher(install, harness), { mode: 0o700 });
  fixture.install = install; fixture.launcher = launcher;
  await fixture.writePlist();
  assert.deepEqual(await run(fixture, false, { associateRuntime: undefined }), { ok: true, result: { status: "preview", changed: false, appliesAt: "next_service_start", wouldChange: true } });
  const applied = await run(fixture, true, { associateRuntime: undefined }); assert.equal(applied.ok, true); if (applied.ok) assert.equal(applied.result.status, "associated");
  const repeated = await run(fixture, true, { associateRuntime: undefined }); assert.equal(repeated.ok, true); if (repeated.ok) assert.equal(repeated.result.status, "already_associated");
  assert.deepEqual(await readFile(launcher), await readFile(harness)); assert.match(await readFile(launcher, "utf8"), /GATEWAY_COMMAND=/);
}));

test("requires matching stable Developer ID identities for app, launcher, and Node", { skip: process.platform !== "darwin" }, async () => {
  const calls: string[][] = []; const runner = async (_command: string, args: string[]) => {
    calls.push(args); return args.includes("-d") ? { code: 0, stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" } : { code: 0, stdout: "", stderr: "" };
  };
  assert.equal(await verifySignature("/fixture/App.app", "/fixture/App.app/Contents/MacOS/GatewayService", runner), true);
  assert.ok(calls[0]!.some(value => value.includes("anchor apple generic") && value.includes("100.6.1.13")));
  assert.ok(calls.at(-1)!.some(value => value.includes("anchor apple generic") && value.includes("subject.OU") && value.includes("ABCDE12345")));
  assert.equal(calls.at(-1)!.at(-1), "/fixture/App.app/Contents/Resources/backend/runtime/bin/node");
  assert.ok(calls.at(-1)!.some(value => value.includes('identifier "com.edihasaj.harness-gateway.node"')));
  assert.equal(await verifySignature("/fixture/App.app", "/fixture/helper", async (_command, args) =>
    args.at(-1)?.endsWith("/runtime/bin/node") ? { code: 1, stdout: "", stderr: "" } : runner(_command, args)), false);
  assert.equal(await verifySignature("/fixture/App.app", "/fixture/helper", async () => ({ code: 0, stdout: "", stderr: "TeamIdentifier=not-a-team\n" })), false);
});

test("terminates a non-cooperating subprocess within five seconds plus cleanup", async () => {
  const began = Date.now(); const outcome = await runBoundedCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
  assert.equal(outcome.code, 1); assert.ok(Date.now() - began < 5_750);
});

test("uses real plutil parsing and serialization on Darwin", { skip: process.platform !== "darwin" }, () => withFixture(async fixture => {
  const plist = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">${serviceMarker}<plist version="1.0"><dict><key>Label</key><string>${serviceLabel}</string><key>ProgramArguments</key><array><string>${fixture.launcher}</string><string>daemon</string><string>--config</string><string>${fixture.config}</string></array><key>KeepAlive</key><true/></dict></plist>`;
  const info = `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.edihasaj.harness-gateway.app</string></dict></plist>`;
  await writeFile(fixture.plist, plist, { mode: 0o600 }); await writeFile(join(fixture.app, "Contents/Info.plist"), info, { mode: 0o600 });
  const response = await run(fixture, true, { readSnapshot: async () => fixture.snapshot(), verifySignature: async () => true, decodePlist: undefined, encodePlist: undefined }); assert.equal(response.ok, true);
  assert.ok((await readFile(fixture.plist, "utf8")).includes("<key>KeepAlive</key>"));
}));

test("an app renamed to GateFox.app takes over a plist naming the Harness Gateway.app beside it, and no other app", () => withFixture(async fixture => {
  const associated = { Program: fixture.helper, AssociatedBundleIdentifiers: "com.edihasaj.harness-gateway.app" };
  await fixture.writePlist({ ...fixture.plistValue(), ...associated });
  const gatefox = join(fixture.root, "GateFox.app"); await rename(fixture.app, gatefox);
  const renamed = (appPath: string) => handleAppBackground({ configPath: fixture.config, apply: true, appPath }, dependencies(fixture));
  assert.deepEqual(await renamed(gatefox), { ok: true, result: { status: "associated", changed: true, appliesAt: "next_service_start" } });
  assert.equal((await decode(await readFile(fixture.plist))).Program, join(gatefox, "Contents/MacOS/GatewayService"));
  await fixture.writePlist({ ...fixture.plistValue(), ...associated });
  const elsewhere = join(fixture.root, "elsewhere", "GateFox.app"); await mkdir(join(fixture.root, "elsewhere")); await rename(gatefox, elsewhere);
  assert.equal((await renamed(elsewhere)).ok, false, "a plist naming an app in another folder is refused");
}));
