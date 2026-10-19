import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { appResourceAncestorAllowed, canonicalPath, handleAppBackground, parseAppBackgroundArgs, runBoundedCommand, verifySignature, type AppBackgroundDependencies } from "../app-background.js";
import type { ConfigSnapshot } from "../app-management/storage.js";
import { serviceLabel, serviceMarker } from "../service-plan.js";

const decode = async (bytes: Buffer) => {
  const text = bytes.toString("utf8").replace(`${serviceMarker}\n`, ""); const match = text.match(/<plist>([\s\S]*)<\/plist>/);
  return JSON.parse(match ? match[1]! : text) as Record<string, unknown>;
};
const encode = async (value: Record<string, unknown>) => Buffer.from(`<?xml version="1.0"?><plist>${JSON.stringify(value)}</plist>`);
const directory = (mode: number, uid = 0, link = false) => ({ mode, uid, isDirectory: () => true, isSymbolicLink: () => link });

class Fixture {
  root = ""; home = ""; app = ""; helper = ""; config = ""; state = ""; launcher = ""; plist = "";
  async create(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), "gateway-app-background-")); this.home = join(this.root, "home"); this.app = join(this.root, "Harness Gateway.app");
    this.helper = join(this.app, "Contents/MacOS/GatewayService"); this.config = join(this.root, "gateway.json"); this.state = join(this.root, "state");
    this.launcher = join(this.home, ".local/bin/gateway"); this.plist = join(this.home, `Library/LaunchAgents/${serviceLabel}.plist`);
    await mkdir(join(this.home, ".local/bin"), { recursive: true, mode: 0o700 }); await mkdir(join(this.home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.app, "Contents/MacOS"), { recursive: true, mode: 0o700 }); await mkdir(join(this.app, "Contents/Resources"), { recursive: true, mode: 0o700 });
    await writeFile(this.launcher, `#!/bin/sh\n${"# Managed by subscription-gateway installer"}\n`, { mode: 0o700 }); await chmod(this.launcher, 0o700);
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
