import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { cp, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { combinedNativeCatalog } from "../native-catalog.js";
import { loadConfig } from "../config.js";
import { serveUnix } from "../unix-transport.js";
import { reuseSshSocket, type SshSocketReuse } from "../ssh-socket.js";
import { shortFolder } from "./short-folder.js";
import { releaseState } from "../self-update.js";
import { codexShim, serveWithRecovery } from "../codex-shim.js";
import { isAppServerSession } from "../codex-invocation.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";

import { shimFiles as files } from "./shim-fixture.js";

test("shim passes native non-server commands through without reading gateway credentials", { skip: process.platform === "win32" }, async () => {
  const { backend, cli } = await files();
  const result = await promisify(execFile)(process.execPath, [cli, "codex-shim", "--config", "/absent.json", "--codex", backend, "--", "--version"]);
  assert.equal(result.stdout.trim(), "native-codex-test-version");
});

test("shim runs app-server diagnostics on the original CLI before gateway setup", { skip: process.platform === "win32" }, async () => {
  const f = await files({ serve: false });
  const original = join(f.directory, "one-shot-original"); const missingConfig = join(f.directory, "missing-gateway.json");
  const missingState = join(f.directory, "state-must-not-exist");
  await writeFile(original, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(47);\n", { mode: 0o700 });
  try {
    for (const args of [
      ["-c", '{"literal":"app-server --print-not-a-command"}', "app-server", "--startup-sign-out", "--startup-client-info", '{"name":"ChatGPT"}', "--cloud-skills-snapshot=--print-not-a-diagnostic", "--print-startup-config"],
      ["app-server", "--startup-client-info={\"name\":\"ChatGPT\"}", "--cloud-skills-snapshot", "--print-not-a-diagnostic", "--strict-config", "--stdio", "--analytics-default-enabled", "--remote-control", "--managed-daemon", "--print-startup-config"],
      ["app-server", "--config=features.example=true", "generate-ts"],
      ["app-server", "generate-internal-json-schema"],
      ["app-server", "future-tooling-command"],
    ]) {
      let failure: { code?: number; stdout?: string; stderr?: string } | undefined;
      try { await promisify(execFile)(process.execPath, [f.cli, "codex-shim", "--config", missingConfig, "--codex", original, "--", ...args], { env: { ...f.env, CODEX_HOME: missingState } }); }
      catch (error) { failure = error as typeof failure; }
      assert.equal(failure?.code, 47, args.join(" "));
      assert.equal(failure?.stdout, JSON.stringify(args) + "\n", "the original CLI receives the exact one-shot argv once");
      assert.equal(failure?.stderr, "");
    }
    await assert.rejects(lstat(missingConfig), { code: "ENOENT" });
    await assert.rejects(lstat(missingState), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("app-server routing reserves only explicit one-shots", () => {
  for (const args of [
    ["app-server", "--listen", "stdio://"],
    ["-c", '{"literal":"app-server --print-startup-config"}', "app-server", "--listen", "stdio://"],
    ["app-server", "--config", '{"literal":"--print-startup-config"}', "--listen", "stdio://"],
    ["app-server", "--startup-client-info", "--print-not-a-diagnostic", "--cloud-skills-snapshot", "--print-not-a-diagnostic", "--listen", "stdio://"],
    ["app-server", "--stdio", "--strict-config", "--analytics-default-enabled"],
    ["app-server", "--", "--print-startup-config"],
    ["app-server", "--future-session-option", "--print-startup-config"],
  ]) assert.equal(isAppServerSession(args), true, args.join(" "));
  for (const args of [
    ["app-server", "--startup-sign-out", "--startup-client-info", '{"name":"ChatGPT"}', "--print-startup-config"],
    ["app-server", "--startup-client-info={\"name\":\"ChatGPT\"}", "--cloud-skills-snapshot=--print-not-a-diagnostic", "--print-startup-config"],
    ["app-server", "--print-future-diagnostic"],
    ["app-server", "--help"],
    ["app-server", "--version"],
    ["app-server", "proxy"],
    ["app-server", "generate-ts"],
    ["app-server", "generate-json-schema"],
    ["app-server", "generate-internal-json-schema"],
    ["app-server", "--config=features.example=true", "generate-ts"],
    ["app-server", "future-tooling-command"],
    ["app-server", "daemon"],
  ]) assert.equal(isAppServerSession(args), false, args.join(" "));
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
    assert.equal(start.modelProvider, "gatefox");
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
  // A cache that lacks an engine model no longer stops startup; the gateway rows still follow the cache rows.
  await writeFile(catalog, JSON.stringify({ identity: "excluded-native-cache-identity", models: [{ slug: "other" }] }));
  const partial = JSON.parse(await readFile(await combinedNativeCatalog(backend, ["app-server"], await loadConfig(config)), "utf8"));
  assert.deepEqual(partial.models.map((model: { slug: string }) => model.slug), ["other", "claude/model"]);
  assert.equal(partial.identity, undefined);
  await writeFile(catalog, JSON.stringify({ models: [{ slug: "a" }, { slug: "a" }] }));
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

/** One release directory of this checkout's dist, without touching `current`. */
async function addRelease(directory: string, version: string) {
  // The layout must hold a real copy: releaseState() resolves symlinks, so a linked dist
  // could never report a release directory.
  const release = join(directory, "releases", version); const pkg = join(release, "package");
  await mkdir(pkg, { recursive: true });
  await cp(fileURLToPath(new URL("../", import.meta.url)), join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@edihasaj/harness-gateway", version, type: "module" }));
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(pkg, "node_modules"));
  return { release, cli: join(pkg, "dist", "cli.js") };
}

/** Point `current` at an added release the way an install switch does: a pending symlink, then a rename. */
async function setCurrentRelease(directory: string, version: string) {
  const pending = join(directory, "current.pending");
  await symlink(join(directory, "releases", version), pending);
  await rename(pending, join(directory, "current"));
}

/**
 * This checkout's dist laid out as installed release `version`, so a bootstrap run from it is the
 * installed release. `install(next)` adds a second release and repoints `current` at it, which is
 * how a later release becomes installed while this process keeps running.
 */
async function installedRelease(version: string) {
  const folder = await shortFolder("gw-rel-");
  const added = await addRelease(folder.directory, version);
  await setCurrentRelease(folder.directory, version);
  return {
    cli: added.cli, directory: folder.directory, remove: folder.remove,
    install: async (next: string) => { const other = await addRelease(folder.directory, next); await setCurrentRelease(folder.directory, next); return other; },
  };
}

/** Replacement events the given state directory recorded so far. */
async function replacementEvents(stateDirectory: string, withinMs = 3000, event = "ssh_listener_replaced") {
  let events: Record<string, any>[] = [];
  for (let i = 0; i < Math.max(1, withinMs / 20); i++) {
    const dir = join(stateDirectory, "telemetry");
    const lines = await Promise.all((await readdir(dir).catch(() => [] as string[])).map(name => readFile(join(dir, name), "utf8").catch(() => "")));
    events = lines.join("").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
      .filter((e): e is Record<string, any> => e?.event === event);
    if (events.length) break;
    await delay(20);
  }
  return events;
}

test("installing a release does not repeatedly close idle sessions inside the same Unix listener", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await files(); const control = await shortFolder("gw-upgrade-"); const release = await installedRelease("0.4.1");
  const path = join(control.directory, "app-server-control/app-server-control.sock");
  const child = spawn(process.execPath, [release.cli, "codex-shim", "--ssh", "--ssh-home", control.directory, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"],
    { env: { ...f.env, GATEWAY_UPGRADE_CHECK_MS: "30", GATEWAY_SESSION_IDLE_MS: "0" }, stdio: "ignore" });
  const exited = once(child, "close"); let connection: SocketAppServerConnection | undefined;
  try {
    for (let i = 0; i < 500 && !await lstat(path).then(() => true, () => false); i++) await delay(10);
    connection = new SocketAppServerConnection(path, async () => {});
    await connection.request("initialize", { clientInfo: { name: "upgrade_fixture", version: "1" } });
    connection.send({ method: "initialized" });
    const before = await connection.request("engine/info", {});
    await release.install("0.4.2");
    await delay(500); // More than two independent upgrade ticks while the session is idle.
    assert.equal(connection.closed, false, "a reconnect would return to exactly the same old loaded listener");
    assert.equal(child.exitCode, null);
    assert.equal((await connection.request("engine/info", {})).pid, before.pid, "the original native executor is retained");
    assert.deepEqual(await replacementEvents(f.value.stateDirectory, 50, "self_upgrade"), []);
  } finally {
    await connection?.stop(); child.kill("SIGTERM"); await exited; await release.remove(); await control.remove(); f.close();
  }
});

test("an idle stdio adapter still exits once so its parent can start the installed release", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const f = await files(); const release = await installedRelease("0.4.1");
  const child = spawn(process.execPath, [release.cli, "codex-shim", "--config", f.config, "--codex", f.backend, "--", "app-server"],
    { env: { ...f.env, GATEWAY_UPGRADE_CHECK_MS: "30", GATEWAY_SESSION_IDLE_MS: "0" }, stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(child, "close"); const lines = createInterface({ input: child.stdout });
  try {
    const initialized = new Promise<void>(resolve => lines.on("line", line => { if (JSON.parse(line).id === 7) resolve(); }));
    child.stdin.write(JSON.stringify({ id: 7, method: "initialize", params: { clientInfo: { name: "stdio_upgrade_fixture", version: "1" } } }) + "\n");
    await initialized; await release.install("0.4.2"); await exited;
    assert.equal(child.exitCode, 0);
    const events = await replacementEvents(f.value.stateDirectory, 100, "self_upgrade");
    assert.equal(events.length, 1); assert.equal(events[0].component, "adapter");
  } finally { lines.close(); child.kill("SIGTERM"); await exited; await release.remove(); f.close(); }
});

test("an SSH bootstrap logs a replaced listener exactly once, only after telemetry is configured", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await files(); const control = await shortFolder("gw-ssh-log-");
  const path = join(control.directory, "app-server-control/app-server-control.sock");
  const listener = await staleListener(path, "0.4.0");
  const release = await installedRelease("0.4.2");
  const args = [release.cli, "codex-shim", "--ssh", "--ssh-home", control.directory, "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"];
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
  } finally { child.kill("SIGTERM"); await exited; await listener.stop().catch(() => {}); await release.remove(); await control.remove(); f.close(); }
});

test("a bootstrap whose preparation fails leaves the old listener serving", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await files(); const control = await shortFolder("gw-ssh-kept-");
  const path = join(control.directory, "app-server-control/app-server-control.sock");
  const listener = await staleListener(path, "0.4.0");
  const release = await installedRelease("0.4.2");
  // The reuse decision runs before the config is read; this config then fails the fixed-port
  // preparation after telemetry is set up but before anything binds or unlinks.
  const config = join(control.directory, "no-port.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 0, stateDirectory: f.value.stateDirectory, providers: f.value.providers }));
  const args = [release.cli, "codex-shim", "--ssh", "--ssh-home", control.directory, "--config", config, "--codex", f.backend, "--", "app-server", "--listen", "unix://"];
  const before = await lstat(path, { bigint: true });
  const child = spawn(process.execPath, args, { env: f.env, stdio: "ignore" });
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 2, "preparation failed, so this bootstrap never reached the bind");
    const kept = await lstat(path, { bigint: true });
    assert.equal(kept.isSocket(), true); assert.equal(String(kept.ino), String(before.ino)); assert.equal(String(kept.dev), String(before.dev), "the old listener still owns the public alias");
    const reuse = await reuseSshSocket(path, { running: "0.4.2", installed: "0.4.2" });
    assert.equal(reuse.reused, false); assert.equal(reuse.replace?.from, "0.4.0"); assert.equal(reuse.replace?.to, "0.4.2", "the live old listener is still there to replace");
    assert.deepEqual(await replacementEvents(f.value.stateDirectory, 500), [], "a bootstrap that replaced nothing logs nothing");
  } finally { child.kill("SIGTERM"); await listener.stop(); await release.remove(); await control.remove(); f.close(); }
});

test("listener startup reuses a raced listener and binds once more only after recovery", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const folder = await shortFolder("gw-recover-"); const path = join(folder.directory, "rpc.sock");
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
    assert.equal(report?.reused, true); assert.equal(report?.replace, undefined, "nothing was replaced, so nothing is logged again");
  } finally { controller.abort(); await serving; await folder.remove(); }
});

test("a custom --listen unix listener survives an install switch", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await files(); const control = await shortFolder("gw-listen-");
  const path = join(control.directory, "rpc.sock");
  const release = await installedRelease("0.9.0");
  // A fast upgrade check, so a listener that did follow the install would retire inside this window.
  const child = spawn(process.execPath,
    [release.cli, "codex-shim", "--config", f.config, "--codex", f.backend, "--", "app-server", "--listen", "unix://" + path],
    { env: { ...f.env, GATEWAY_UPGRADE_CHECK_MS: "100" }, stdio: "ignore" });
  const exited = once(child, "close");
  try {
    for (let i = 0; i < 500 && !await lstat(path).then(() => true, () => false); i++) await delay(20);
    assert.equal(await lstat(path).then(() => true, () => false), true, "the listener bound the path the caller chose");
    await release.install("0.9.1");
    await delay(1500);
    // Only the SSH socket has a bootstrap on the installed release to hand it over; a caller's own
    // listener keeps running, because retiring it would take the endpoint away with nothing behind it.
    assert.equal(child.exitCode, null, "the listener is not retired by an install it was never part of");
    assert.equal(await lstat(path).then(() => true, () => false), true, "the socket stays on the path it was given");
    assert.deepEqual(await replacementEvents(f.value.stateDirectory, 500, "self_upgrade"), [], "no self upgrade is claimed for a listener that moved to nothing");
  } finally { child.kill("SIGTERM"); await exited; await release.remove(); await control.remove(); f.close(); }
});
