import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeDesktopAdapterLabel,
  claudeDesktopServicePlist,
  claudeDesktopServiceStatus,
  installClaudeDesktopService,
} from "../claude-desktop-service.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-claude-desktop-service-"));
  const home = join(root, "home");
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  const config = join(root, "adapter-config.json");
  await writeFile(config, JSON.stringify({ listenPort: 3467, tokenFile: join(root, "secret-token") }), { mode: 0o600 });
  return { root, home, config, plist: join(home, "Library/LaunchAgents", `${claudeDesktopAdapterLabel}.plist`) };
}

test("the dedicated plist uses the current gateway command and no shared service label", () => {
  const plist = claudeDesktopServicePlist({ command: "/opt/gateway", args: ["--runtime"] }, "/private/tmp/adapter.json", "/private/tmp/home");
  assert.match(plist, new RegExp(claudeDesktopAdapterLabel));
  assert.match(plist, /<string>\/opt\/gateway<\/string><string>--runtime<\/string><string>claude-desktop<\/string><string>serve<\/string>/);
  assert.throws(() => claudeDesktopServicePlist({ command: "/opt/gateway", args: [] }, "/private/tmp/adapter.json", "/private/tmp/home", "com.edihasaj.subscription-gateway"), /reserved/);
});

test("install never creates a separate startup job or calls launchctl", async () => {
  const f = await fixture();
  const commands: Array<{ file: string; args: string[] }> = [];
  await assert.rejects(installClaudeDesktopService(f.config, {
    platform: "darwin", home: f.home, uid: 501, command: () => ({ command: "/opt/gateway", args: [] }), portAvailable: async () => true,
    exec: async (file, args) => {
      commands.push({ file, args });
      if (args[0] === "print") throw new Error("not loaded");
      return { stdout: "" };
    },
  }), /Separate Claude Desktop LaunchAgents are no longer supported/);
  assert.deepEqual(await readdir(join(f.home, "Library/LaunchAgents")), []);
  assert.deepEqual(commands, []);
});

test("retired install preserves loaded and foreign targets without probing or replacing them", async () => {
  const f = await fixture();
  const loaded = async (_file: string, args: string[]) => {
    if (args[0] === "print") return { stdout: " pid = 99\n" };
    throw new Error("must not change a loaded job");
  };
  await assert.rejects(installClaudeDesktopService(f.config, { platform: "darwin", home: f.home, uid: 501, exec: loaded, portAvailable: async () => true }), /no longer supported/);
  await assert.rejects(installClaudeDesktopService(f.config, {
    platform: "darwin", home: f.home, uid: 501, exec: async () => { throw new Error("not loaded"); }, portAvailable: async () => false,
  }), /no longer supported/);
  await writeFile(f.plist, "<plist>somebody else</plist>", { mode: 0o600 });
  await assert.rejects(installClaudeDesktopService(f.config, {
    platform: "darwin", home: f.home, uid: 501, exec: async () => { throw new Error("not loaded"); }, portAvailable: async () => true,
  }), /no longer supported/);
  assert.equal(await readFile(f.plist, "utf8"), "<plist>somebody else</plist>");
});

test("status reports only the adapter service and listener state", async () => {
  const f = await fixture();
  const result = await claudeDesktopServiceStatus(f.config, {
    platform: "darwin", home: f.home, uid: 501,
    exec: async (_file, args) => args[0] === "print" ? { stdout: " pid = 42\n" } : { stdout: "" },
  });
  assert.equal(result.service, claudeDesktopAdapterLabel);
  assert.equal(result.loaded, true);
  assert.equal(result.pid, 42);
  assert.equal((result.listener as { port: number; listening: boolean }).port, 3467);
  assert.equal(typeof (result.listener as { port: number; listening: boolean }).listening, "boolean");
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(result.retirementRequired, true);
});

test("status reports a fresh app-owned adapter and never claims a stale child is running", async () => {
  const f = await fixture();
  const primary = join(f.home, "Library/Application Support/Subscription Gateway");
  const state = join(primary, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(primary, "gateway.json"), JSON.stringify({ version: 1, port: 3457, stateDirectory: state, clientOnly: true, providers: [] }), { mode: 0o600 });
  await writeFile(join(state, "service-plan.json"), JSON.stringify({ version: 1, config: join(primary, "gateway.json"), components: [{ id: "claude-adapter", kind: "claude-adapter", command: "/signed/node", args: ["/private/cli.js", "claude-desktop", "serve", "--config", f.config], log: join(state, "adapter.log") }] }), { mode: 0o600 });
  const statusPath = join(state, "service-status.json");
  const snapshot = { pid: 42, updatedAt: new Date().toISOString(), components: [{ id: "claude-adapter", kind: "claude-adapter", state: "running", pid: 43 }] };
  await writeFile(statusPath, JSON.stringify(snapshot), { mode: 0o600 });
  const deps = { platform: "darwin" as const, home: f.home, uid: 501, exec: async (_file: string, args: string[]) => {
    if (args[1] === "gui/501/com.edihasaj.subscription-gateway") return { stdout: " pid = 42\n" };
    throw new Error("legacy job absent");
  } };
  const fresh = await claudeDesktopServiceStatus(f.config, deps);
  assert.equal(fresh.service, "com.edihasaj.subscription-gateway");
  assert.equal(fresh.mode, "app-service"); assert.equal(fresh.pid, 43); assert.equal(fresh.state, "running"); assert.equal(fresh.legacyLoaded, false);
  await writeFile(statusPath, JSON.stringify({ ...snapshot, pid: 99 }), { mode: 0o600 });
  const stale = await claudeDesktopServiceStatus(f.config, deps);
  assert.equal(stale.state, "unknown"); assert.equal(stale.pid, undefined);
  for (const malformed of [null, [], { ...snapshot, components: "not a component list" }, { ...snapshot, components: [null] }]) {
    await writeFile(statusPath, JSON.stringify(malformed), { mode: 0o600 });
    const unknown = await claudeDesktopServiceStatus(f.config, deps);
    assert.equal(unknown.state, "unknown"); assert.equal(unknown.pid, undefined);
  }
});
