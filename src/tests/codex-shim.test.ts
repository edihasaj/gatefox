import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { writeFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { combinedNativeCatalog } from "../native-catalog.js";
import { loadConfig } from "../config.js";

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
