import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shimFiles } from "./shim-fixture.js";
import { rpcRejection, rpcRejections } from "../rpc-rejection.js";
import { summarizeTelemetry } from "../diagnostics.js";

type Message = Record<string, unknown>;

// The signed SDK's own answers (0.162.0-alpha.17.2), reproduced so the adapter is held to
// forwarding the desktop's requests and the engine's replies unchanged.
const sdkHandlers = `
 else if(m.method==='process/spawn'){const p=m.params;
   if(typeof p.cwd!=='string'||!p.cwd.startsWith('/'))send({id:m.id,error:{code:-32600,message:'Invalid request: AbsolutePathBuf deserialized without a base path'}});
   else{send({id:m.id,result:{}});send({method:'process/outputDelta',params:{processHandle:p.processHandle,stream:'stdout',deltaBase64:Buffer.from(home).toString('base64'),capReached:false}});
     send({method:'process/exited',params:{processHandle:p.processHandle,exitCode:0,stdout:'',stdoutCapReached:false,stderr:'',stderrCapReached:false}});}}
 else if(m.method==='process/kill')send({id:m.id,error:{code:-32600,message:'no active process for process handle '+JSON.stringify(m.params.processHandle)}});
 else if(m.method==='thread/fork'){const p=m.params;
   const overrides=['model','modelProvider','serviceTier','cwd','approvalPolicy','sandbox','permissions','baseInstructions','developerInstructions'].some(k=>p[k]!==undefined&&p[k]!==null)||Object.keys(p.config||{}).length>0;
   if(p.experimentalPredictionMode&&overrides){send({id:m.id,error:{code:-32600,message:'\`experimentalPredictionMode\` cannot be combined with configuration overrides'}});return;}
   const parent=threads.get(p.threadId);if(!parent){send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+p.threadId}});return;}
   const thread={id:process.pid+'-'+(++serial),modelProvider:parent.modelProvider,model:parent.model,ephemeral:!!p.ephemeral};threads.set(thread.id,thread);
   send({id:m.id,result:{serviceTier:null,thread,modelProvider:thread.modelProvider,model:thread.model,engineHome:home}});}
 else if(m.method==='thread/delete')send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+m.params.threadId}});`;

test("remote process and thread methods reach the owning engine as the desktop sent them", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const files = await shimFiles();
  let source = await readFile(files.backend, "utf8");
  const crash = " else if(m.method==='crash')process.exit(7);";
  const unknown = "catch{send({id:m.id,error:{code:-32000,message:'Thread not found'}});}";
  assert.ok(source.includes(crash) && source.includes(unknown));
  // An unknown chat reads as "thread not loaded", as the SDK answers it.
  source = source.replace(crash, sdkHandlers + "\n" + crash).replace(unknown, "catch{send({id:m.id,error:{code:-32600,message:'thread not loaded: '+m.params.threadId}});}");
  await writeFile(files.backend, source, { mode: 0o700 });
  // A native row that offers the effort saved for the chat, as the installed catalog does.
  const catalog = JSON.parse(await readFile(files.catalog, "utf8"));
  catalog.models[0].supported_reasoning_levels = [{ effort: "low" }, { effort: "high" }];
  await writeFile(files.catalog, JSON.stringify(catalog));

  const child = spawn(process.execPath, [files.cli, "codex-shim", "--config", files.config, "--codex", files.backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: files.env });
  child.stderr.resume();
  const notes: Message[] = []; const pending = new Map<number, (message: Message) => void>(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line) as Message;
    if (typeof message.id === "number") pending.get(message.id)?.(message);
    else if (String(message.method).startsWith("process/")) notes.push(message);
  });
  const rpc = (method: string, params: Message = {}) => new Promise<Message>(resolve => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  const result = (message: Message) => { assert.equal(message.error, undefined, JSON.stringify(message.error)); return message.result as Message; };
  try {
    await rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "26.1007.71326" }, capabilities: { experimentalApi: true } });
    // A gateway chat is bound first: process calls carry no chat and still belong to the native engine.
    const gateway = (result(await rpc("thread/start", { model: "claude/model" })).thread as Message).id as string;

    // The desktop's git probe for a projectless remote composer (worker.js git root lookup).
    const git = { command: ["git", "-c", "safe.bareRepository=explicit", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      streamStdoutStderr: true, streamStdin: true, timeoutMs: 59990, env: { LC_MESSAGES: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } };
    const projectless = await rpc("process/spawn", { ...git, cwd: "~", processHandle: "process:4d0b6a1e-7c55-4a3e-9d61-2f1c7b8e9a01" });
    assert.deepEqual(projectless.error, { code: -32600, message: "Invalid request: AbsolutePathBuf deserialized without a base path" });
    const handle = "process:0f6c2d7e-8b14-4b39-a1f0-6c2e9d3b5a72";
    assert.deepEqual(result(await rpc("process/spawn", { ...git, cwd: files.directory, processHandle: handle })), {});
    for (let tries = 0; tries < 100 && !notes.some(note => note.method === "process/exited"); tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(notes.map(note => note.method), ["process/outputDelta", "process/exited"]);
    assert.equal(Buffer.from(String((notes[0].params as Message).deltaBase64), "base64").toString(), files.nativeHome, "the native engine ran the process");
    // The desktop kills a process whose exit it has not seen yet; the SDK has already reaped it.
    assert.deepEqual((await rpc("process/kill", { processHandle: handle })).error, { code: -32600, message: `no active process for process handle "${handle}"` });

    // Composer predictions: resume, then fork in prediction mode. The native chat has a saved effort.
    const native = (result(await rpc("thread/start", { model: "native", config: { model_reasoning_effort: "high" } })).thread as Message).id as string;
    result(await rpc("thread/resume", { threadId: native }));
    const prediction = { experimentalPredictionMode: true, ephemeral: true, excludeTurns: true, threadSource: "composer_predictions" };
    assert.equal(result(await rpc("thread/fork", { threadId: native, ...prediction })).engineHome, files.nativeHome);
    const forked = result(await rpc("thread/fork", { threadId: gateway, ...prediction }));
    assert.equal(forked.modelProvider, "subscription_gateway");
    assert.notEqual(forked.engineHome, files.nativeHome, "the gateway chat's own executor forked it");

    // Deleting a prewarmed chat that never wrote a rollout returns the SDK's answer, which the desktop recognizes.
    const missing = "01a13f34-c570-70b2-8c0d-8a631c6aab5d";
    assert.deepEqual((await rpc("thread/delete", { threadId: missing })).error, { code: -32600, message: `no rollout found for thread id ${missing}` });
    const closed = once(child, "close"); child.stdin.end(); await closed;
  } finally { child.kill("SIGKILL"); lines.close(); files.close(); }

  const directory = join(files.value.stateDirectory, "telemetry"); const events: Message[] = [];
  for (const name of await readdir(directory)) for (const line of (await readFile(join(directory, name), "utf8")).split("\n")) if (line) events.push(JSON.parse(line));
  const errors = events.filter(event => event.event === "rpc_error").map(event => [event.method, event.code, event.rejection]);
  assert.deepEqual(errors, [["process/spawn", -32600, "relative_path"], ["process/kill", -32600, "no_active_process"], ["thread/delete", -32600, "rollout_not_found"]]);
});

test("a prediction fork skips the legacy hooks correction its parent already received", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const files = await shimFiles();
  const crash = " else if(m.method==='crash')process.exit(7);";
  const read = "else if(m.method==='config/read')send({id:m.id,result:{config:";
  const source = await readFile(files.backend, "utf8");
  assert.ok(source.includes(read));
  await writeFile(files.backend, source.replace(crash, sdkHandlers + "\n" + crash)
    .replace(read, "else if(m.method==='config/read')send({id:m.id,result:{layers:[{name:{type:'user'},config:{features:{hooks:true}}}],config:"), { mode: 0o700 });
  // The retired hooks alias makes the adapter correct thread settings from the configuration layers.
  const child = spawn(process.execPath, [files.cli, "codex-shim", "--config", files.config, "--codex", files.backend, "--", "-c", "features.codex_hooks=true", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: files.env });
  child.stderr.resume();
  const pending = new Map<number, (message: Message) => void>(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { const message = JSON.parse(line) as Message; if (typeof message.id === "number") pending.get(message.id)?.(message); });
  const rpc = (method: string, params: Message = {}) => new Promise<Message>(resolve => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  try {
    await rpc("initialize", { clientInfo: { name: "Codex Desktop", version: "26.1007.71326" }, capabilities: { experimentalApi: true } });
    const native = ((await rpc("thread/start", { model: "native", cwd: files.directory })).result as { thread: { id: string } }).thread.id;
    const fork = await rpc("thread/fork", { threadId: native, experimentalPredictionMode: true, ephemeral: true, excludeTurns: true, threadSource: "composer_predictions" });
    assert.equal(fork.error, undefined, JSON.stringify(fork.error));
  } finally { child.kill("SIGKILL"); lines.close(); files.close(); }
});

test("rejection names come only from the fixed list", () => {
  const cases: Array<[string, unknown, string]> = [
    ["process/spawn", { code: -32600, message: "Invalid request: AbsolutePathBuf deserialized without a base path" }, "relative_path"],
    ["process/spawn", { code: -32603, message: "failed to spawn process: No such file or directory (os error 2)" }, "spawn_failed"],
    ["process/spawn", { code: -32600, message: "process/spawn requires experimentalApi capability" }, "experimental_api"],
    ["process/spawn", { code: -32600, message: "Invalid request: unknown variant `process/spawn`, expected one of `initialize`" }, "unknown_method"],
    ["process/kill", { code: -32600, message: 'process "process:1" is no longer running' }, "process_not_running"],
    ["thread/fork", { code: -32600, message: "`experimentalPredictionMode` cannot be combined with configuration overrides" }, "prediction_fork_overrides"],
    ["thread/fork", { code: -32600, message: "`experimentalPredictionMode` requires a loaded parent" }, "prediction_fork_parent"],
    ["thread/delete", { code: -32600, message: "thread is not persisted and cannot be deleted: 01a1" }, "thread_not_persisted"],
    ["process/spawn", { code: -32600, message: 'duplicate active process handle: "process:1"' }, "duplicate_process_handle"],
    ["thread/read", { code: -32600, message: "thread not loaded: 01a13f34-c570-70b2-8c0d-8a631c6aab5d" }, "thread_not_loaded"],
    ["turn/start", { code: -32001, message: "Codex app-server exited" }, "engine_closed"],
    ["turn/start", { code: -32001, message: "The gateway executor connection was lost; resume this chat to reconnect to its saved or running session." }, "engine_closed"],
    ["turn/start", { code: -32001, message: "Codex app-server request timed out" }, "engine_timeout"],
    ["thread/resume", { code: -32600, message: "Invalid request: missing field `threadId`" }, "invalid_params"],
    ["thread/read", { code: -32001, message: "private text /Users/someone/secret" }, "other"],
  ];
  for (const [method, error, expected] of cases) assert.equal(rpcRejection(method, Object.assign(new Error(String((error as Message).message)), error)), expected, expected);
  assert.equal(rpcRejection("thread/start", new Error("any"), true), "adapter_routing");
  for (const [method, error] of cases) assert.ok(rpcRejections.has(rpcRejection(method, error)));
  // Diagnostics group by the rejection when it says more than the error class.
  const event = (fields: Record<string, string | number>) => ({ at: new Date().toISOString(), host: "h", component: "adapter", pid: 1, event: "rpc_error", ...fields });
  const summary = summarizeTelemetry([event({ method: "process/kill", code: -32600, errorClass: "other", rejection: "no_active_process" }),
    event({ method: "thread/read", code: -32001, errorClass: "overloaded", rejection: "other" }), event({ method: "thread/fork", code: -32600, errorClass: "other" })], new Date(0));
  assert.deepEqual(summary.rpcErrors, { "process/kill -32600 no_active_process": 1, "thread/read -32001 overloaded": 1, "thread/fork -32600 other": 1 });
});
