import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeDesktopAdapterLabel,
  claudeDesktopAdapterMarker,
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

test("install only writes and loads its own marked LaunchAgent", async () => {
  const f = await fixture();
  const commands: Array<{ file: string; args: string[] }> = [];
  const result = await installClaudeDesktopService(f.config, {
    platform: "darwin", home: f.home, uid: 501, command: () => ({ command: "/opt/gateway", args: [] }), portAvailable: async () => true,
    exec: async (file, args) => {
      commands.push({ file, args });
      if (args[0] === "print") throw new Error("not loaded");
      return { stdout: "" };
    },
  });
  assert.deepEqual(result, { service: claudeDesktopAdapterLabel, installed: true, port: 3467 });
  const plist = await readFile(f.plist, "utf8");
  assert.ok(plist.includes(claudeDesktopAdapterMarker));
  assert.match(plist, /<string>claude-desktop<\/string><string>serve<\/string><string>--config<\/string>/);
  assert.deepEqual(commands.map(call => call.args[0]), ["print", "enable", "bootstrap"]);
});

test("install refuses loaded, occupied, and foreign targets without replacing them", async () => {
  const f = await fixture();
  const loaded = async (_file: string, args: string[]) => {
    if (args[0] === "print") return { stdout: " pid = 99\n" };
    throw new Error("must not change a loaded job");
  };
  await assert.rejects(installClaudeDesktopService(f.config, { platform: "darwin", home: f.home, uid: 501, exec: loaded, portAvailable: async () => true }), /already loaded/);
  await assert.rejects(installClaudeDesktopService(f.config, {
    platform: "darwin", home: f.home, uid: 501, exec: async () => { throw new Error("not loaded"); }, portAvailable: async () => false,
  }), /port 3467 is already occupied/);
  await writeFile(f.plist, "<plist>somebody else</plist>", { mode: 0o600 });
  await assert.rejects(installClaudeDesktopService(f.config, {
    platform: "darwin", home: f.home, uid: 501, exec: async () => { throw new Error("not loaded"); }, portAvailable: async () => true,
  }), /unmanaged LaunchAgent/);
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
});
