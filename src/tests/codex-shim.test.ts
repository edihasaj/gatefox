import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { combinedNativeCatalog } from "../native-catalog.js";
import { loadConfig } from "../config.js";

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-shim-"));
  const backend = join(directory, "codex");
  const catalog = join(directory, "models.json");
  await writeFile(catalog, JSON.stringify({ identity: "excluded-native-cache-identity", models: [{ slug: "native", priority: 1, context_window: 800000, apply_patch_tool_type: "freeform", model_messages: { instructions_template: "original native instructions" } }] }));
  await writeFile(backend, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
if(process.argv.includes('--version')) {console.log('native-codex-test-version');process.exit(0);}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let pending;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method&&pending){if(m.id!==pending.id||m.result.decision!=='accept')process.exit(9);send({method:'serverRequest/resolved',params:{threadId:'chat',requestId:pending.id}});send({id:pending.id,result:{turn:{id:'turn'}}});send({method:'turn/completed',params:{threadId:'chat',turn:{id:'turn',status:'completed'}}});pending=null;return;}
 if(m.id===undefined)return;
 if(m.method==='model/list')send({id:m.id,result:{data:[{id:'native',model:'native',displayName:'Native'}],nextCursor:null}});
 else if(m.method==='config/read')send({id:m.id,result:{config:{model_catalog_json:${JSON.stringify(catalog)}}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'chat'},modelProvider:m.params.modelProvider||'openai',model:m.params.model}});
 else if(m.method==='turn/start'){pending=m;send({id:m.id,method:'item/commandExecution/requestApproval',params:{threadId:'chat',turnId:'turn',itemId:'command'}});}
 else if(m.method==='crash')process.exit(7);
 else send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const config = join(directory, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: ".state", providers: [{ id: "claude", type: "claude-subscription", models: { "claude/model": "model" } }] }), { mode: 0o600 });
  return { backend, config, catalog, cli: fileURLToPath(new URL("../cli.js", import.meta.url)) };
}

test("shim passes native non-server commands through without reading gateway credentials", { skip: process.platform === "win32" }, async () => {
  const { backend, cli } = await files();
  const result = await promisify(execFile)(process.execPath, [cli, "codex-shim", "--config", "/absent.json", "--codex", backend, "--", "--version"]);
  assert.equal(result.stdout.trim(), "native-codex-test-version");
});

test("shim preserves approval correlation while native IDs overlap with its RPC IDs", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const { backend, config, cli } = await files();
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
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
    const start = (await rpc("thread/start", { model: "claude/model", modelProvider: "openai" })).result as { modelProvider: string };
    assert.equal(start.modelProvider, "subscription_gateway");
    await rpc("turn/start", { threadId: "chat", model: "claude/model", input: [] });
    assert.ok(approval);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(completed); assert.equal(resolvedId, approvalId);
    const closed = once(child, "close"); child.stdin.end(); await closed;
    assert.equal(child.exitCode, 0);
  } finally { child.kill("SIGKILL"); lines.close(); }
});

test("shim exits when the native backend dies with a client request pending", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const { backend, config, cli } = await files();
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
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
  const { backend, config, cli } = await files();
  const child = spawn(process.execPath, [cli, "codex-shim", "--config", config, "--codex", backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume(); child.stdin.on("error", () => {}); let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk.toString(); });
  const closed = once(child, "close"); child.stdin.write('private-client-content-' + "x".repeat(16 * 1024 * 1024));
  try {
    await closed; assert.equal(child.exitCode, 2);
    assert.match(diagnostics, /frame exceeds 16 MiB/); assert.ok(!diagnostics.includes("private-client-content"));
  } finally { child.kill("SIGKILL"); }
});
