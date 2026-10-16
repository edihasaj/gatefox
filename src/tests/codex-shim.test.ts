import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { combinedNativeCatalog } from "../native-catalog.js";
import { loadConfig } from "../config.js";
import { serveUnix } from "../unix-transport.js";
import { reuseSshSocket, type SshSocketReuse } from "../ssh-socket.js";
import { releaseState } from "../self-update.js";
import { codexShim, serveWithRecovery } from "../codex-shim.js";

import { shimFiles as files } from "./shim-fixture.js";

test("shim passes native non-server commands through without reading gateway credentials", { skip: process.platform === "win32" }, async () => {
  const { backend, cli } = await files();
  const result = await promisify(execFile)(process.execPath, [cli, "codex-shim", "--config", "/absent.json", "--codex", backend, "--", "--version"]);
  assert.equal(result.stdout.trim(), "native-codex-test-version");
});

test("shim preserves approval correlation while native IDs overlap with its RPC IDs", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const { backend, config, cli, env } = await files();
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume(); const lines = createInterface({ input: child.stdout }); const pending = new Map<number, (result: Record<string, unknown>) => void>();
  let approval = false; let completed = false; let id = 0; let approvalId: string | undefined; let resolvedId: string | undefined;
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "item/commandExecution/requestApproval") {
      assert.match(message.id, /^gateway-server-/); approval = true; approvalId = message.id;
      child.stdin.write(JSON.stringify({ id: message.id, result: { decision: "accept" } }) + "\n");
    } else if (message.method === "serverRequest/resolved") resolvedId = message.params.requestId;
    else if (message.method === "turn/completed") completed = true;
    else if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  const rpc = (method: string, params = {}) => new Promise<Record<string, unknown>>(resolve => {
    pending.set(++id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "test", version: "1" } });
    const models = (await rpc("model/list")).result as { data: Array<{ model: string }> };
    assert.deepEqual(models.data.map(model => model.model), ["native", "claude/model"]);
    const start = (await rpc("thread/start", { model: "claude/model", modelProvider: "openai" })).result as { modelProvider: string; thread: { id: string } };
    assert.equal(start.modelProvider, "subscription_gateway");
    await rpc("turn/start", { threadId: start.thread.id, model: "claude/model", input: [] });
    assert.ok(approval);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(completed); assert.equal(resolvedId, approvalId);
    const closed = once(child, "close"); child.stdin.end(); await closed;
    assert.equal(child.exitCode, 0);
  } finally { child.kill("SIGKILL"); lines.close(); }
});

test("shim exits when the native backend dies with a client request pending", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const { backend, config, cli, env } = await files();
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stdout.resume(); child.stderr.resume();
  const closed = once(child, "close"); child.stdin.write(JSON.stringify({ id: 1, method: "crash", params: {} }) + "\n");
  try { await closed; assert.equal(child.exitCode, 7); }
  finally { child.kill("SIGKILL"); }
});


test("combined catalog preserves public native capabilities and excludes cache identity", { skip: process.platform === "win32" }, async () => {
  const { backend, config, catalog } = await files();
  const source = JSON.parse(await readFile(catalog, "utf8"));
  const path = await combinedNativeCatalog(backend, ["app-server"], await loadConfig(config));
  const merged = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(merged.models[0], source.models[0]);
  assert.equal(merged.models[1].slug, "claude/model");
  assert.equal(merged.identity, undefined);
  source.models.push({ slug: "claude/model" }); await writeFile(catalog, JSON.stringify(source));
  await assert.rejects(combinedNativeCatalog(backend, ["app-server"], await loadConfig(config)), /collides with a native model ID/);
  await writeFile(catalog, JSON.stringify({ models: [{ slug: "other" }] }));
  await assert.rejects(combinedNativeCatalog(backend, ["app-server"], await loadConfig(config)), /does not match/);
});

test("shim bounds unterminated client frames without echoing their contents", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const { backend, config, cli, env } = await files();
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stdout.resume(); child.stdin.on("error", () => {}); let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk.toString(); });
  const closed = once(child, "close"); child.stdin.write('private-client-content-' + "x".repeat(16 * 1024 * 1024));
  try {
    await closed; assert.equal(child.exitCode, 2);
    assert.match(diagnostics, /frame exceeds 16 MiB/); assert.ok(!diagnostics.includes("private-client-content"));
  } finally { child.kill("SIGKILL"); }
});

/** A listener started before this bootstrap, its lease recording `release`. */
async function staleListener(path: string, release: string) {
  const controller = new AbortController();
  const serving = serveUnix(path, controller.signal, async () => {}, release);
  serving.catch(() => {});
  for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
  if (!await lstat(path).then(() => true, () => false)) { controller.abort(); await serving.finally(() => {}); throw new Error("Listener socket never appeared"); }
  return { stop: async () => { controller.abort(); await serving.finally(() => {}); } };
}

/** Replacement events the given state directory recorded so far. */
async function replacementEvents(stateDirectory: string, withinMs = 3000) {
  let events: Record<string, any>[] = [];
  for (let i = 0; i < Math.max(1, withinMs / 20); i++) {
    const dir = join(stateDirectory, "telemetry");
    const lines = await Promise.all((await readdir(dir).catch(() => [] as string[])).map(name => readFile(join(dir, name), "utf8").catch(() => "")));
    events = lines.join("").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
      .filter((e): e is Record<string, any> => e?.event === "ssh_listener_replaced");
    if (events.length) break;
    await delay(20);
  }
  return events;
}

test("an SSH bootstrap logs a replaced listener exactly once, only after telemetry is configured", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  // The fake install layout must hold a real copy: releaseState() resolves symlinks, so a
  // linked dist could never report a release directory.
  const f = await files(); const control = await mkdtemp("/tmp/gw-ssh-log-");
  const path = join(control, "app-server-control/app-server-control.sock");
  const listener = await staleListener(path, "0.4.0");
  const root = await mkdtemp("/tmp/gw-rel-"); const release = join(root, "releases", "0.4.2"); const pkg = join(release, "package");
  await mkdir(pkg, { recursive: true });
  await cp(fileURLToPath(new URL("../", import.meta.url)), join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@edihasaj/harness-gateway", version: "0.4.2", type: "module" }));
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(pkg, "node_modules"));
  await symlink(release, join(root, "current"));
  const args = [join(pkg, "dist", "cli.js"), "codex-shim", "--ssh", "--ssh-home", control, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"];
  const child = spawn(process.execPath, args, { env: f.env, stdio: "ignore" }); const exited = once(child, "close");
  try {
    const events = await replacementEvents(f.value.stateDirectory, 15000);
    assert.equal(events.length, 1, "the replacement is recorded exactly once");
    const [event] = events;
    assert.equal(event.from, "0.4.0"); assert.equal(event.to, "0.4.2"); assert.equal(event.component, "adapter");
    assert.deepEqual(Object.keys(event).filter(key => !["at", "host", "component", "pid"].includes(key)).sort(), ["event", "from", "to"], "no paths or extra fields");
    for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(20);
    assert.equal((await reuseSshSocket(path, { running: "0.4.2", installed: "0.4.2" })).reused, true, "the bootstrap became the live listener");
    assert.equal(child.exitCode, null);
    await delay(1500); await listener.stop();
    assert.equal((await replacementEvents(f.value.stateDirectory, 500)).length, 1, "the current listener is reused, not replaced again");
  } finally { child.kill("SIGTERM"); await exited; await listener.stop().catch(() => {}); f.close(); }
});

test("listener startup reuses a raced listener and binds once more only after recovery", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const dir = await mkdtemp("/tmp/gw-recover-"); const path = join(dir, "rpc.sock");
  let attempts = 0;
  await serveWithRecovery(path, true, async () => {
    attempts++; if (attempts === 1) throw new Error("Unix socket path is occupied; the existing listener was not replaced");
  });
  assert.equal(attempts, 2, "a bootstrap that only recovered a dead socket binds once more");

  attempts = 0;
  await assert.rejects(serveWithRecovery(path, false, async () => { attempts++; throw new Error("occupied"); }), /occupied/);
  assert.equal(attempts, 1, "outside SSH mode the original error still fails fast");

  attempts = 0;
  await assert.rejects(serveWithRecovery(path, true, async () => { attempts++; throw new Error("occupied"); }), /occupied/);
  assert.equal(attempts, 2, "a second bind failure surfaces instead of looping");

  const controller = new AbortController();
  const serving = serveUnix(path, controller.signal, async () => {}, releaseState()?.running ?? "0.4.2");
  try {
    for (let i = 0; i < 200 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
    attempts = 0; let report: SshSocketReuse | undefined;
    await serveWithRecovery(path, true, async () => { attempts++; throw new Error("occupied"); }, reuse => { report = reuse; });
    assert.equal(attempts, 1, "a live current listener from the race is kept without another bind");
    assert.equal(report?.reused, true); assert.equal(report?.replaced, undefined, "nothing was replaced, so nothing is logged again");
  } finally { controller.abort(); await serving; }
});
