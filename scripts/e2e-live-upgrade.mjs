// Exercises one real Unix desktop-adapter connection through an old host's replacement.
// It deliberately moves only its private old package after it has loaded, proving the old
// adapter recovers its verified SDK from the new managed current release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { groupGone } from "./group-gone.mjs";

const { values } = parseArgs({ options: { previous: { type: "string" }, package: { type: "string" }, code: { type: "string" }, root: { type: "string" } } });
for (const key of ["previous", "package", "root"]) assert.ok(values[key], `Pass --${key}`);
const previousSource = resolve(values.previous), candidateSource = resolve(values.package);
const code = resolve(values.code ?? candidateSource), root = resolve(values.root);
const packageVersion = async path => JSON.parse(await readFile(join(path, "package.json"), "utf8")).version;
const [previousVersion, candidateVersion] = await Promise.all([packageVersion(previousSource), packageVersion(candidateSource)]);
assert.equal(previousVersion, "0.6.0", "This regression starts from the released 0.6.0 package");
assert.match(candidateVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/, "Use a canonical candidate release");
assert.notEqual(candidateVersion, previousVersion, "The candidate must be a different immutable release");
assert.notEqual(resolve(previousSource), resolve(candidateSource), "Use distinct immutable package inputs");

const runId = randomUUID();
// macOS limits Unix socket addresses to 103 bytes. Keep all active fixture state
// under a short private path; --root receives the compact, sanitized evidence only.
const fixture = await mkdtemp("/tmp/gwu-");
const evidencePath = join(root, `live-upgrade-${runId}.json`);
const managed = join(fixture, "managed"), releases = join(managed, "releases");
const oldPackage = join(releases, previousVersion, "package");
const newPackage = join(releases, candidateVersion, "package");
const faultPackage = join(fixture, "faulted-old-package");
const home = join(fixture, "home"), native = join(fixture, "native"), state = join(fixture, "state"), work = join(fixture, "work");
for (const path of [root, releases, home, native, state, work]) await mkdir(path, { recursive: true, mode: 0o700 });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
await cp(previousSource, oldPackage, { recursive: true, preserveTimestamps: true });
await cp(candidateSource, newPackage, { recursive: true, preserveTimestamps: true });
await writeFile(join(managed, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 });
for (const version of [previousVersion, candidateVersion]) await writeFile(join(releases, version, ".gateway-release"), `${version}\n`, { mode: 0o600 });
// Match the installer: relative release targets remain inside the same physical
// installation when macOS exposes /tmp through its /private/tmp alias.
await symlink(join("releases", previousVersion), join(managed, "current"));
// The installed adapter invokes this stable launcher for provider auth. It follows
// current across the fixture upgrade, just like the normal installer launcher.
const gatewayLauncher = join(managed, "harness-gateway");
await writeFile(gatewayLauncher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(managed, "current", "package", "dist", "cli.js"))} "$@"\n`, { mode: 0o700 });

// Only fixture children see this environment. Its configuration and chat storage are new,
// and it deliberately omits account credentials and any developer gateway setup.
const childEnv = {
  PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
  TERM: process.env.TERM, USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: process.env.SHELL,
  HOME: home, CODEX_HOME: native, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
  GATEWAY_TELEMETRY: "off", GATEWAY_ERROR_REPORTS: "off", GATEWAY_INSTALLED: "1", GATEWAY_COMMAND: gatewayLauncher,
};
process.env.HOME = home; process.env.CODEX_HOME = native;
process.env.GATEWAY_TELEMETRY = "off"; process.env.GATEWAY_ERROR_REPORTS = "off";
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "HARNESS_GATEWAY_EXECUTOR", "GATEFOX_EXECUTOR"]) delete process.env[key];

const candidate = name => import(pathToFileURL(join(code, "dist", `${name}.js`)).href);
const old = name => import(pathToFileURL(join(oldPackage, "dist", `${name}.js`)).href);
const [{ startGateway }, { modelCatalog }, { writePrivateJson }, { SocketAppServerConnection },
  { executionHostHome }, { gatewaySdkRuntime: candidateRuntime }, { gatewaySdkRuntime: oldRuntime },
  { responsesInputToMessages }] = await Promise.all([
  candidate("server"), candidate("catalog"), candidate("config"), candidate("socket-app-server-connection"),
  candidate("execution-host"), candidate("gateway-sdk-runtime"), old("gateway-sdk-runtime"), candidate("protocol/request"),
]);
const oldSdk = await oldRuntime(oldPackage), newSdk = await candidateRuntime(newPackage);
assert.ok(oldSdk?.executorIdentity && newSdk?.executorIdentity, "Both private immutable packages must verify their gateway SDKs");

const until = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(40); }
  throw new Error(`${label} timed out`);
};
const quote = shellQuote;
const groups = new Set();
async function stopGroup(entry) {
  if (!entry || entry.stopping) return entry?.stopping;
  entry.stopping = (async () => {
    try { process.kill(-entry.child.pid, "SIGTERM"); } catch {}
    if (!await Promise.race([entry.exited.then(() => true), delay(10_000).then(() => false)])) try { process.kill(-entry.child.pid, "SIGKILL"); } catch {}
    await entry.exited; groups.delete(entry);
    if (!await groupGone(entry.child.pid, 5_000)) {
      try { process.kill(-entry.child.pid, "SIGKILL"); } catch {}
      assert.ok(await groupGone(entry.child.pid, 5_000), "A fixture process group did not stop");
    }
  })();
  return entry.stopping;
}
function group(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const entry = { child, exited: new Promise(resolve => child.once("close", resolve)), stopping: undefined };
  groups.add(entry); return entry;
}
const evidence = {
  checkedAt: new Date().toISOString(), previousVersion, candidateVersion, paidInferenceRequests: 0, mockProviderRequests: 0,
  unixFrontend: false, oldHostCommandCommitted: false, busyGuardRefused: false,
  oldPackageFaulted: false, recoveredRuntimeFromCurrent: false, sameChatResumed: false, socketPathFits: false,
  firstCommandNotReplayed: false, childCommittedAfterUpgrade: false, hostReplaced: false,
  nativeAuthenticationCopied: false, passed: false,
};
let gateway, adapter, oldHost, newHost, frontend, control, runtimeProbe;
let phase = "setup";
const firstMarker = `FIRST_${randomUUID()}`, childMarker = `CHILD_${randomUUID()}`;
const firstCall = `first_${randomUUID()}`, childCall = `child_${randomUUID()}`, spawnCall = `spawn_${randomUUID()}`;
const holdMarker = `HOLD_${randomUUID()}`, resumedMarker = `RESUMED_${randomUUID()}`;
let releaseHeld; const held = new Promise(resolve => { releaseHeld = resolve; }); let holdStarted = false; let firstToolDispatches = 0;
const toolsFor = request => {
  const declared = [...(request.tools ?? []), ...(request.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])];
  return declared.flatMap(tool => tool.type === "namespace" ? tool.tools.map(child => ({ name: child.name, namespace: tool.name === "functions" ? undefined : tool.name }))
    : [{ name: tool.name ?? tool.function?.name, namespace: undefined }]);
};
const callFor = (tool, id, args) => ({ type: "tool", call: { type: "function", id,
  responseTool: { type: "function", name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) },
  function: { name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name, arguments: JSON.stringify(args) } } });
const outputFor = (request, id) => (request.input ?? []).some(item => item?.type === "function_call_output" && item.call_id === id);
const command = (file, marker, subject, attempt) => [
  ...(attempt ? [`printf '%s\\n' ${quote(attempt)} >> .first-attempts`] : []),
  `printf '%s\\n' ${quote(marker)} > ${quote(file)}`, `git add ${quote(file)}${attempt ? " .first-attempts" : ""}`,
  `git commit -m ${quote(subject)}`, "git status --porcelain",
].join(" && ");

const configPath = join(fixture, "gateway.json");
assert.ok(Buffer.byteLength(join(executionHostHome(configPath, native), "host.sock")) <= 103, "Fixture host socket path must fit Unix limits");
evidence.socketPathFits = true;
const alias = "fixture/live-upgrade", upstream = "gpt-6.1-sol";
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 30_000, providers: [{
  id: "fixture", type: "codex-subscription", credentialFile: join(fixture, "fixture-credential.json"),
  models: { [alias]: upstream }, modelMetadata: { [alias]: { contextWindow: 100_000, reasoningEfforts: ["low"], defaultReasoningEffort: "low", multiAgentVersion: "v2", multiAgentReasoningEffort: "low" } },
}] };
await writeFile(config.providers[0].credentialFile, "{\"fixture\":true}\n", { mode: 0o600 });

function hostRunner(hostCode, runtimeCode, runtimePackage) {
  return `const [hostUrl,configUrl,runtimeUrl,runtimePackage,configPath,nativeHome,codex]=process.argv.slice(1);
const {startExecutionHost}=await import(hostUrl); const {loadConfig}=await import(configUrl);
const runtime=runtimeUrl ? await import(runtimeUrl) : undefined; let host; let closing;
const close=()=>closing??=(async()=>{await host?.close().catch(()=>{});process.exit(0);})();
for(const signal of ["SIGTERM","SIGINT","SIGHUP"])process.on(signal,()=>void close());
try { const config=await loadConfig(configPath); host=await startExecutionHost({config,configPath,nativeHome,codex,
  ...(runtime ? {gatewayRuntime:()=>runtime.gatewaySdkRuntime(runtimePackage)} : {})}); }
catch { process.stdout.write("HOST_FAILED\\n"); process.exit(1); }
process.stdin.setEncoding("utf8"); let buffered="";
process.stdin.on("data",async data=>{buffered+=data;for(;;){const newline=buffered.indexOf("\\n");if(newline<0)return;
 const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);if(line==="quiet")process.stdout.write("QUIET "+JSON.stringify(await host.prepareQuietStop?.(0))+"\\n");}});
process.stdout.write("HOST_READY\\n");`;
}
async function startHost({ hostCode, runtimeCode, runtimePackage }) {
  const runner = group(process.execPath, ["--input-type=module", "-e", hostRunner(hostCode, runtimeCode, runtimePackage),
    pathToFileURL(join(hostCode, "execution-host.js")).href, pathToFileURL(join(hostCode, "config.js")).href,
    runtimeCode ? pathToFileURL(join(runtimeCode, "gateway-sdk-runtime.js")).href : "", runtimePackage ?? "",
    configPath, native, oldSdk.executable], { env: childEnv });
  const lines = createInterface({ input: runner.child.stdout }); const messages = [];
  lines.on("line", line => messages.push(line));
  const ready = await until(() => messages.find(line => line === "HOST_READY" || line === "HOST_FAILED"), "execution host startup");
  assert.equal(ready, "HOST_READY", "The execution host must start from its declared package code");
  const connection = new SocketAppServerConnection(join(executionHostHome(configPath, native), "host.sock"), async () => {});
  await connection.ready; runner.control = connection; runner.messages = messages; runner.lines = lines;
  return runner;
}
async function startOldRuntimeProbe() {
  const runner = group(process.execPath, ["--input-type=module", "-e", `const runtime=await import(process.argv[1]);
process.stdout.write("READY\\n"); process.stdin.setEncoding("utf8");
process.stdin.on("data",async value=>{if(value.trim()!=="check")return;try{const found=await runtime.gatewaySdkRuntime();
process.stdout.write(JSON.stringify({ok:!!found,executable:found?.executable})+"\\n");}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error instanceof Error?error.message:"other"})+"\\n");}});`,
    pathToFileURL(join(oldPackage, "dist", "gateway-sdk-runtime.js")).href], { env: childEnv });
  runner.messages = []; const lines = createInterface({ input: runner.child.stdout });
  lines.on("line", line => runner.messages.push(line)); runner.lines = lines;
  await until(() => runner.messages.find(line => line === "READY"), "old runtime probe startup");
  return runner;
}
const hostStatus = async host => host.control.request("execution/status", {});
async function quiet(host) {
  host.child.stdin.write("quiet\n");
  return until(() => host.messages.find(line => line.startsWith("QUIET ")), "quiet-stop guard").then(line => JSON.parse(line.slice(6)));
}
async function closeFrontend() { frontend?.stop(); await frontend?.exited; frontend = undefined; }
async function closeGateway() { if (gateway) await new Promise(resolve => gateway.close(resolve)); gateway = undefined; }
async function cleanup() {
  await closeFrontend().catch(() => {});
  for (const entry of [...groups]) await stopGroup(entry).catch(() => {});
  control?.stop(); await control?.exited.catch(() => {});
  await closeGateway().catch(() => {});
}
const finish = async code => { await cleanup(); process.exit(code); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { void finish(128); });

try {
  phase = "gateway";
  gateway = await startGateway(config, () => ({
    async *infer(request) {
      evidence.mockProviderRequests++;
      const messages = responsesInputToMessages(request.input);
      const user = [...messages].reverse().find(message => message.role === "user" && typeof message.content === "string")?.content;
      const tools = toolsFor(request);
      const direct = tools.find(tool => tool.name === "exec_command");
      if (user?.includes(firstMarker)) {
        assert.ok(direct, "The old released host must expose direct exec_command");
        if (!outputFor(request, firstCall)) {
          firstToolDispatches++;
          yield callFor(direct, firstCall, { cmd: command("before.txt", firstMarker, "test: before upgrade", firstMarker), login: false });
        }
        else yield { type: "text", text: "FIRST_COMPLETE" };
      } else if (user?.includes(holdMarker)) {
        holdStarted = true; await held; yield { type: "text", text: "HOLD_COMPLETE" };
      } else if (user?.includes(childMarker)) {
        assert.ok(direct, "The resumed child must expose direct exec_command");
        if (!outputFor(request, childCall)) yield callFor(direct, childCall, { cmd: command("after.txt", childMarker, "test: after upgrade child"), login: false });
        else yield { type: "text", text: "CHILD_COMPLETE" };
      } else if (user?.includes(resumedMarker)) {
        const spawn = tools.find(tool => tool.name === "spawn_agent");
        assert.ok(spawn, "The resumed parent must expose spawn_agent");
        if (!outputFor(request, spawnCall)) yield callFor(spawn, spawnCall, {
          task_name: "live_upgrade_child", message: `Run the child fixture ${childMarker} and return.`, model: upstream, reasoning_effort: "low", fork_turns: "none",
        }); else yield { type: "text", text: "RESUMED_COMPLETE" };
      } else throw new Error("Unexpected mock-provider fixture request");
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    },
  }));
  config.port = gateway.address().port; await writePrivateJson(configPath, config);
  const base = modelCatalog(config).models[0];
  const nativeRow = { ...base, slug: upstream, tool_mode: "direct", upstream_slug: undefined };
  delete nativeRow.multi_agent_version; delete nativeRow.multi_agent_reasoning_effort;
  await writePrivateJson(join(native, "models.json"), { models: [nativeRow] });
  await writeFile(join(native, "config.toml"), `model = ${JSON.stringify(upstream)}\nmodel_catalog_json = ${JSON.stringify(join(native, "models.json"))}\nweb_search = "disabled"\n[features]\nremote_control = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  await writePrivateJson(join(state, "service-plan.json"), { version: 1, config: configPath, sharedExecutors: true,
    components: [{ id: "native", kind: "native", command: oldSdk.executable, args: ["--codex", oldSdk.executable, "--native-home", native], log: join(state, "native.log") }] });

  phase = "old-host-and-unix-adapter";
  runtimeProbe = await startOldRuntimeProbe();
  oldHost = await startHost({ hostCode: join(oldPackage, "dist") });
  const socket = join(fixture, "adapter.sock");
  adapter = group(process.execPath, [join(oldPackage, "dist", "cli.js"), "codex-shim", "--config", configPath, "--codex", oldSdk.executable,
    "--", "app-server", "--listen", `unix://${socket}`], { env: childEnv, cwd: work });
  await until(() => lstat(socket).then(info => info.isSocket(), () => false), "Unix adapter listener");
  const events = [];
  frontend = new SocketAppServerConnection(socket, async message => { events.push(message); });
  await frontend.ready;
  await frontend.request("initialize", { clientInfo: { name: "gateway_live_upgrade_e2e", version: "1" }, capabilities: { experimentalApi: true } });
  frontend.send({ method: "initialized" }); evidence.unixFrontend = true;
  const waitTurn = async (turn, offset) => until(() => events.slice(offset).find(event => event.method === "turn/completed" && event.params?.turn?.id === turn.turn.id), "turn completion");
  const callerSettings = { approvalPolicy: "never", sandbox: "danger-full-access", config: { model_reasoning_effort: "low" } };
  const started = await frontend.request("thread/start", { model: alias, cwd: work, ...callerSettings });
  const threadId = started.thread.id;
  const savedStart = (await frontend.request("thread/read", { threadId, includeTurns: false })).thread;
  const threadPermissions = thread => Object.fromEntries(["approvalPolicy", "sandbox", "sandboxPolicy", "permissions"].filter(key => Object.hasOwn(thread, key)).map(key => [key, thread[key]]));
  const initialIdentity = { model: started.thread.model, provider: started.thread.modelProvider, cwd: await realpath(started.thread.cwd), permissions: threadPermissions(savedStart) };
  await new Promise((resolve, reject) => { const child = spawn("git", ["init", "--quiet"], { cwd: work }); child.once("close", code => code === 0 ? resolve() : reject(new Error("git init failed"))); });
  for (const [key, value] of [["user.name", "Gateway fixture"], ["user.email", "gateway-fixture@example.invalid"], ["commit.gpgSign", "false"]])
    await new Promise((resolve, reject) => { const child = spawn("git", ["config", key, value], { cwd: work }); child.once("close", code => code === 0 ? resolve() : reject(new Error("git configuration failed"))); });

  phase = "old-command";
  let offset = events.length; let turn = await frontend.request("turn/start", { threadId, model: alias, input: [{ type: "text", text: firstMarker }] });
  assert.equal((await waitTurn(turn, offset)).params.turn.status, "completed");
  assert.equal(await readFile(join(work, "before.txt"), "utf8"), `${firstMarker}\n`); evidence.oldHostCommandCommitted = true;
  assert.equal(await readFile(join(work, ".first-attempts"), "utf8"), `${firstMarker}\n`, "The initial tool may run once before replacement");
  const oldStatus = await hostStatus(oldHost); const oldPid = oldStatus.pid;

  phase = "busy-guard";
  offset = events.length; turn = await frontend.request("turn/start", { threadId, model: alias, input: [{ type: "text", text: holdMarker }] });
  await until(() => holdStarted, "held provider turn");
  const guard = await quiet(oldHost); assert.deepEqual(guard, { wait: "running" }, "A busy turn must refuse the quiet-stop guard");
  evidence.busyGuardRefused = true; releaseHeld();
  assert.equal((await waitTurn(turn, offset)).params.turn.status, "completed");

  phase = "replace-host";
  oldHost.control.stop(); await oldHost.control.exited; await stopGroup(oldHost);
  await unlink(join(managed, "current")); await symlink(join("releases", candidateVersion), join(managed, "current"));
  await rename(oldPackage, faultPackage); evidence.oldPackageFaulted = true;
  // This is the production recovery path: the old adapter's already-loaded runtime module
  // resolves its absent original package through managed/current and verifies the candidate.
  const recovered = await oldRuntime(oldPackage);
  assert.ok(recovered?.executable);
  assert.equal(await realpath(recovered.executable), await realpath(join(newPackage, "gateway-sdk", "gateway-codex")));
  runtimeProbe.child.stdin.write("check\n");
  const probe = JSON.parse(await until(() => runtimeProbe.messages.find(line => line.startsWith("{")), "old runtime recovery probe"));
  assert.equal(probe.ok, true, "A persisted old runtime must recover through managed/current");
  assert.equal(await realpath(probe.executable), await realpath(join(newPackage, "gateway-sdk", "gateway-codex")));
  evidence.recoveredRuntimeFromCurrent = true;
  newHost = await startHost({ hostCode: join(code, "dist"), runtimeCode: join(code, "dist"), runtimePackage: newPackage });
  control = newHost.control;

  phase = "same-chat-resume-and-child";
  let lastResumeError;
  const resumed = await until(async () => {
    try { return await frontend.request("thread/resume", { threadId, model: alias, cwd: work, ...callerSettings }); }
    catch (error) { lastResumeError = error; return false; }
  }, "same frontend chat resume", 30_000).catch(() => {
    const code = typeof lastResumeError?.code === "number" ? lastResumeError.code : "unknown";
    const message = lastResumeError instanceof Error ? lastResumeError.message.slice(0, 240) : "unknown";
    throw new Error(`same frontend chat resume failed (RPC code ${code}): ${message}`);
  });
  assert.equal(resumed.thread.id, threadId);
  const savedResume = (await frontend.request("thread/read", { threadId, includeTurns: false })).thread;
  assert.deepEqual({ model: resumed.thread.model, provider: resumed.thread.modelProvider, cwd: await realpath(resumed.thread.cwd), permissions: threadPermissions(savedResume) }, initialIdentity,
    "The saved model, provider, workspace and caller permissions must survive replacement");
  evidence.sameChatResumed = true;
  offset = events.length; turn = await frontend.request("turn/start", { threadId, model: alias, input: [{ type: "text", text: resumedMarker }] });
  const resumedTurn = await waitTurn(turn, offset);
  if (resumedTurn.params.turn.status !== "completed") {
    const kind = resumedTurn.params.turn.error?.codexErrorInfo;
    const message = String(resumedTurn.params.turn.error?.message ?? "").slice(0, 240);
    throw new Error(`Resumed parent turn ${resumedTurn.params.turn.status}; fixed kind ${typeof kind === "string" ? kind : "unknown"}: ${message}`);
  }
  await until(async () => (await readFile(join(work, "after.txt"), "utf8").catch(() => "")) === `${childMarker}\n`, "resumed child command");
  const childThread = await until(async () => {
    const loaded = await frontend.request("thread/loaded/list", {});
    for (const id of loaded.data.filter(id => id !== threadId)) {
      const read = await frontend.request("thread/read", { threadId: id, includeTurns: true }).catch(() => undefined);
      const thread = read?.thread;
      if ((thread?.parentThreadId ?? thread?.source?.subAgent?.thread_spawn?.parent_thread_id) === threadId
        && thread.turns?.at(-1)?.status === "completed"
        && thread.turns.flatMap(turn => turn.items).some(item => item.type === "commandExecution")) return thread;
    }
    return false;
  }, "resumed child history");
  assert.equal(childThread.turns.at(-1)?.status, "completed", "The child turn must complete before its commit is accepted");
  assert.ok(childThread.turns.flatMap(turn => turn.items).some(item => item.type === "commandExecution"), "The child history must retain its actual command result");
  const history = (await new Promise((resolve, reject) => { const child = spawn("git", ["log", "--format=%s"], { cwd: work, stdio: ["ignore", "pipe", "ignore"] }); let out = ""; child.stdout.on("data", chunk => { out += chunk; }); child.once("close", code => code === 0 ? resolve(out.trim().split("\n")) : reject(new Error("git log failed"))); }));
  assert.deepEqual(history, ["test: after upgrade child", "test: before upgrade"], "The old side effect must remain exactly once");
  assert.equal(firstToolDispatches, 1, "The mock provider must dispatch the original command exactly once");
  assert.equal(await readFile(join(work, ".first-attempts"), "utf8"), `${firstMarker}\n`, "A resumed chat must not replay its original tool command");
  evidence.firstCommandNotReplayed = true; evidence.childCommittedAfterUpgrade = true;
  const newStatus = await hostStatus(newHost);
  assert.notEqual(newStatus.pid, oldPid, "Replacement must be a new execution-host process");
  evidence.hostReplaced = true;
  await assert.rejects(readFile(join(native, "auth.json"), "utf8"), { code: "ENOENT" });
  evidence.nativeAuthenticationCopied = false;
  evidence.passed = true;
} catch (error) {
  evidence.phase = phase; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  await cleanup();
  const result = JSON.stringify(evidence, null, 2) + "\n";
  await writeFile(join(fixture, "result.json"), result, { mode: 0o600 });
  await writeFile(evidencePath, result, { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, phase: evidence.phase ?? "complete", evidence: evidencePath }));
  await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
