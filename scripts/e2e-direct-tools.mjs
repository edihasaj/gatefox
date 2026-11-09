// Proves gateway SDKs expose direct tools and can edit and commit in a private fixture. A hostless SDK must
// turn every carried row direct; an SDK whose verified receipt pins a Code Mode host carries native modes, so
// the fixture gives it explicit direct native rows and proves they win over the caller's Code Mode settings.
// It uses the real packaged SDK, AppServerBackends, AppServerRouter and DesktopCatalog with a
// local mock provider. It sends no provider request outside this process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  package: { type: "string" }, code: { type: "string" }, root: { type: "string" }, openai: { type: "boolean" },
} });
for (const key of ["package", "root"]) assert.ok(values[key], `Pass --${key}`);

const pkg = resolve(values.package);
const code = resolve(values.code ?? new URL("..", import.meta.url).pathname);
const root = resolve(values.root);
await mkdir(root, { recursive: true, mode: 0o700 });
const fixture = await mkdtemp(join(root, "fixture-"));
const native = join(fixture, "native");
const home = join(fixture, "home");
const state = join(fixture, "state");
const work = join(fixture, "work");
for (const path of [native, home, state, work]) await mkdir(path, { recursive: true, mode: 0o700 });

// This is the complete inherited environment of fixture processes. It carries no account
// credentials, gateway configuration, or provider token from the developer's shell.
const allowedEnvironment = new Set(["TMPDIR", "LANG", "LC_ALL"]);
for (const key of Object.keys(process.env)) if (!allowedEnvironment.has(key)) delete process.env[key];
process.env.PATH = "/usr/bin:/bin";
process.env.HOME = home;
process.env.ZDOTDIR = home;
process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
process.env.GATEWAY_TELEMETRY = "off";
process.env.GATEWAY_ERROR_REPORTS = "off";

const load = name => import(pathToFileURL(join(code, "dist", `${name}.js`)));
const [{ AppServerBackends }, { AppServerRouter }, { DesktopCatalog }, { modelCatalog }, { startGateway },
  { writePrivateJson }, { gatewaySdkRuntime }, { executableRunsCodeMode }, { responsesInputToMessages }, { AppServerConnection }] = await Promise.all([
  load("app-server-backends"), load("app-server-router"), load("desktop-catalog"), load("catalog"),
  load("server"), load("config"), load("gateway-sdk-runtime"), load("codex-native-rows"), load("protocol/request"), load("app-server-connection"),
]);

const runtime = await gatewaySdkRuntime(pkg);
assert.ok(runtime?.executorIdentity, "Use a verified installed gateway SDK");
const hosted = runtime.codeModeHost === true;
assert.equal(executableRunsCodeMode(runtime.executable), hosted, "A Code Mode host must sit beside the executable exactly when the verified receipt names one");

const proof = `DIRECT_${randomUUID()}`;
const expectedProvider = values.openai ? "openai" : "gatefox";
const aliases = [
  { alias: "fixture/direct-code", upstream: "gpt-6.1-sol", file: "code-mode.txt", commit: "fix: direct code tool proof", task: `CHILD_${randomUUID()}` },
  { alias: "fixture/direct-unset", upstream: "gpt-6-luna", file: "unset-mode.txt", commit: "fix: direct unset tool proof", task: `CHILD_${randomUUID()}` },
];
// The missing-host trap: these remain caller settings through launch and turn start.
// An explicit direct row must take precedence over both of them.
const callerConfig = {
  web_search: "disabled",
  analytics: { enabled: false },
  features: { code_mode_only: true, code_mode_host: true, multi_agent_v2: { enabled: true }, plugins: false, hooks: false },
};
const configPath = join(fixture, "gateway.json");
const config = {
  version: 1, port: 0, stateDirectory: state, timeoutMs: 30_000,
  ...(values.openai ? { chatIdentity: "openai" } : {}),
  providers: [{
    id: "fixture", type: "codex-subscription", credentialFile: join(fixture, "fixture-credential.json"),
    models: Object.fromEntries(aliases.map(entry => [entry.alias, entry.upstream])),
    modelMetadata: Object.fromEntries(aliases.map(entry => [entry.alias, {
      contextWindow: 100_000, reasoningEfforts: ["low"], defaultReasoningEffort: "low",
      multiAgentVersion: "v2", multiAgentReasoningEffort: "low",
    }])),
  }],
};
await writeFile(config.providers[0].credentialFile, JSON.stringify({ fixture: true }) + "\n", { mode: 0o600 });

const evidence = {
  checkedAt: new Date().toISOString(),
  realGatewaySdk: true,
  hostlessSdk: !hosted,
  paidInferenceRequests: 0,
  expectedProvider,
  nativeRows: Object.create(null),
  chats: [],
  configReadVerified: false,
  nativeConfigUnchanged: false,
  nativeAuthAbsent: false,
  completedChildTurns: 0,
  passed: false,
};
const toolsFor = request => {
  const declared = [...(request.tools ?? []), ...(request.input ?? []).filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])];
  return declared.flatMap(tool => tool.type === "namespace"
    ? tool.tools.map(child => ({ name: child.name, namespace: tool.name === "functions" ? undefined : tool.name }))
    : [{ name: tool.name ?? tool.function?.name, namespace: undefined }]);
};
const functionCall = (name, id, args) => ({
  type: "tool",
  call: {
    type: "function", id,
    responseTool: { type: "function", name },
    function: { name, arguments: JSON.stringify(args) },
  },
});
const callFor = (tool, id, args) => ({
  type: "tool",
  call: {
    type: "function", id,
    responseTool: { type: "function", name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) },
    function: { name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name, arguments: JSON.stringify(args) },
  },
});
const until = async (check, label, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`${label} timed out`);
};
const emittedExecutorCatalog = async () => {
  const names = (await readdir(state)).filter(name => /^desktop-catalog-[a-f0-9]{64}\.json$/.test(name));
  assert.equal(names.length, 1, "The selected gateway generation must write exactly one immutable catalog");
  return JSON.parse(await readFile(join(state, names[0]), "utf8"));
};
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const commandFor = entry => [
  `printf '%s\\n' ${quote(proof)} > ${quote(entry.file)}`,
  `git add ${quote(entry.file)}`,
  `git commit -m ${quote(entry.commit)}`,
  "git status --porcelain",
  "printf 'DIRECT_TOOL_EXIT=0\\n'",
].join(" && ");
const disabled = value => value === undefined || value === null || value === false || value === "disabled"
  || !!value && typeof value === "object" && !Array.isArray(value) && value.enabled === false;
const empty = value => value === undefined || value === null || value === false || Array.isArray(value) && value.length === 0
  || !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
const verifySafeConfig = result => {
  const effective = result?.config;
  assert.ok(effective && typeof effective === "object" && !Array.isArray(effective));
  for (const key of ["hooks", "external_features"]) assert.ok(disabled(effective[key]), `Canary config unexpectedly enables ${key}`);
  for (const key of ["plugins", "memory", "mcp", "mcp_servers"]) assert.ok(disabled(effective[key]) || empty(effective[key]), `Canary config unexpectedly enables ${key}`);
  assert.ok(disabled(effective.web_search), "Canary web access must be disabled");
  assert.ok(disabled(effective.analytics), "Canary analytics must be disabled");
};

let gateway;
let backend;
let phase = "setup";
const events = [];
const completed = new Set();
const childFinished = new Set();
let active;
try {
  await exec("git", ["init", "--quiet"], { cwd: work });
  await exec("git", ["config", "user.name", "Gateway fixture"], { cwd: work });
  await exec("git", ["config", "user.email", "gateway-fixture@example.invalid"], { cwd: work });
  await exec("git", ["config", "commit.gpgSign", "false"], { cwd: work });

  gateway = await startGateway(config, () => ({
    async *infer(request) {
      const tools = toolsFor(request);
      const names = new Set(tools.map(tool => tool.name));
      const messages = responsesInputToMessages(request.input);
      const childText = [...messages].reverse().find(message => message.role === "user" && typeof message.content === "string")?.content;
      const entry = aliases.find(candidate => childText?.includes(candidate.task)) ?? active?.entry;
      assert.ok(entry, "The SDK request must belong to the active fixture");
      assert.equal(request.model, entry.upstream, "The carried native child keeps its bare model");
      if (!childText?.includes(entry.task)) {
        const spawn = tools.find(tool => tool.name === "spawn_agent");
        assert.ok(spawn, "The gateway parent must expose its real sub-agent tool");
        if (!active.spawned) {
          active.spawned = true;
          yield callFor(spawn, `spawn_${entry.file}`, {
            task_name: `direct_${entry.file.replace(/\W/g, "_")}`,
            message: `Run the assigned direct-tool fixture command ${entry.task} and return.`,
            model: entry.upstream, reasoning_effort: "low", fork_turns: "none",
          });
        } else {
          const deadline = Date.now() + 15_000;
          while (!childFinished.has(entry.alias) && Date.now() < deadline) await delay(10);
          assert.ok(childFinished.has(entry.alias), "The direct child must save its completed command turn before its parent completes");
          yield { type: "text", text: "PARENT_FIXTURE_COMPLETE" };
        }
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        return;
      }
      const command = tools.find(tool => tool.name === "exec_command");
      assert.ok(command, "The direct row must expose exec_command directly");
      assert.equal(names.has("exec"), false, "The fixture must not fall back to the missing Code Mode host");
      assert.equal(names.has("wait"), false, "The fixture must not fall back to the missing Code Mode host");
      assert.equal(names.has("spawn_agent"), false, "The carried native child must use its native catalog row");
      const callId = `direct_${entry.file}`;
      const output = (request.input ?? []).find(item => item?.type === "function_call_output" && item.call_id === callId);
      if (!output) {
        yield callFor(command, callId, { cmd: commandFor(entry), login: false });
      } else {
        // This is the actual continuation after the SDK dispatched the command. Filesystem and
        // Git assertions below prove that it was not merely a model-generated claim.
        assert.ok(output.output !== undefined, "The command result must return to the provider");
        assert.match(JSON.stringify(output.output), /DIRECT_TOOL_EXIT=0/, "The direct command must complete successfully");
        yield { type: "text", text: "DIRECT_TOOL_COMPLETE" };
        yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        completed.add(entry.alias);
        return;
      }
      yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    },
  }));
  config.port = gateway.address().port;
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, "service-plan.json"), {
    version: 1, config: configPath, sharedExecutors: false,
    components: [{ id: "native", kind: "native", command: runtime.executable, args: ["--codex", runtime.executable, "--native-home", native], log: join(state, "native.log") }],
  });

  const published = modelCatalog(config).models;
  const base = published[0];
  // A hosted SDK keeps native tool modes, so its fixture rows are explicitly direct; a hostless SDK must rewrite them.
  const nativeCode = { ...base, slug: aliases[0].upstream, tool_mode: hosted ? "direct" : "code_mode_only", upstream_slug: undefined };
  const nativeUnset = { ...base, slug: aliases[1].upstream, upstream_slug: undefined };
  delete nativeCode.multi_agent_version; delete nativeCode.multi_agent_reasoning_effort;
  if (hosted) nativeUnset.tool_mode = "direct"; else delete nativeUnset.tool_mode;
  delete nativeUnset.multi_agent_version; delete nativeUnset.multi_agent_reasoning_effort;
  const nativeConfig = [
    `model = ${JSON.stringify(aliases[0].upstream)}`,
    `model_catalog_json = ${JSON.stringify(join(native, "models.json"))}`,
    'web_search = "disabled"',
    "[features]",
    "remote_control = false",
    "plugins = false",
    "hooks = false",
    "[analytics]",
    "enabled = false",
    "",
  ].join("\n");
  await writePrivateJson(join(native, "models.json"), { models: [nativeCode, nativeUnset] });
  await writeFile(join(native, "config.toml"), nativeConfig, { mode: 0o600 });
  const catalogPath = join(state, "desktop-catalog.json");
  const catalog = new DesktopCatalog(config, [nativeCode, nativeUnset], catalogPath);
  // Inspect the exact private home the canary will use before it creates a
  // thread. A separate SDK connection leaves the router and its chat state alone.
  const configConnection = new AppServerConnection(runtime.executable, ["app-server", "--listen", "stdio://"], async message => {
    if (message.id !== undefined) configConnection.send({ id: message.id, error: { code: -32601, message: "Probe has no server methods" } });
  }, () => {}, { ...process.env, HOME: home, CODEX_HOME: native, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" }, "gateway");
  try {
    await configConnection.request("initialize", { clientInfo: { name: "gateway_execution_probe", version: "1" }, capabilities: { experimentalApi: true } });
    configConnection.send({ method: "initialized", params: {} });
    verifySafeConfig(await configConnection.request("config/read", { includeLayers: false }));
    evidence.configReadVerified = true;
  } finally { configConnection.stop(); await configConnection.exited; }
  const overrides = {
    name: "Direct tools fixture", base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: "responses",
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 30_000,
    "auth.command": process.execPath, "auth.args": [join(code, "dist/cli.js"), "token", "--config", configPath],
  };
  backend = await AppServerBackends.create(runtime.executable, ["app-server", "--listen", "stdio://"], config, callerConfig, overrides, catalog,
    async message => { events.push(message); }, () => {}, configPath);
  backend.resolveRuntime = async () => runtime;
  const router = new AppServerRouter(config, (method, params, hint) => backend.request(method, params, hint),
    catalogPath, catalog, native, backend.identity);
  await router.initialize();
  await router.request("initialize", { clientInfo: { name: "gateway_direct_tools_e2e", version: "1" }, capabilities: { experimentalApi: true } });
  backend.notify({ method: "initialized", params: {} });
  // gateway() resolves the actual packaged executable and changes the catalog from code_mode_only
  // (or absent) to direct before it launches the SDK.
  phase = "direct-chats";
  for (const entry of aliases) {
    active = { entry, spawned: false };
    const started = await router.request("thread/start", {
      // This fixture uses full access with a deterministic command and temporary cwd so
      // the direct command can prove a local Git commit. Production permissions stay untouched.
      model: entry.alias, cwd: work, approvalPolicy: "never", sandbox: "danger-full-access",
      config: callerConfig,
    });
    assert.equal(started.thread.modelProvider, expectedProvider, "The selected provider remains saved");
    const emitted = (await emittedExecutorCatalog()).models;
    for (const nativeModel of aliases) {
      const nativeRow = emitted.find(row => row.slug === nativeModel.upstream);
      assert.equal(nativeRow?.tool_mode, "direct", "Every carried native row must use direct tools");
      evidence.nativeRows[nativeModel.upstream] = nativeRow?.tool_mode;
    }
    const parentTurn = await router.request("turn/start", {
      threadId: started.thread.id, model: entry.alias,
      input: [{ type: "text", text: "Use the direct command tool to complete this fixture." }],
      config: callerConfig,
    });
    const child = await until(async () => {
      const loaded = await router.request("thread/loaded/list", {});
      for (const id of loaded.data) {
        if (id === started.thread.id) continue;
        try {
          const { thread } = await router.request("thread/read", { threadId: id, includeTurns: false });
          if ((thread.parentThreadId ?? thread.source?.subAgent?.thread_spawn?.parent_thread_id) === started.thread.id) return thread;
        } catch { /* A just-created child can expose its id before its rollout has a header. */ }
      }
    }, `${entry.alias} child`);
    const saved = await until(async () => {
      try {
        const value = await router.request("thread/read", { threadId: child.id, includeTurns: true });
        const turns = value.thread?.turns;
        return Array.isArray(turns) && turns.at(-1)?.status === "completed"
          && turns.flatMap(turn => turn.items).some(item => item.type === "commandExecution") ? value : false;
      } catch { return false; }
    }, `${entry.alias} saved child terminal`);
    assert.equal(saved.thread.modelProvider, expectedProvider, "The saved provider must not change");
    assert.equal(saved.thread.model, entry.upstream, "The child retains its bare native model");
    const childTurns = saved.thread.turns;
    assert.equal(childTurns.at(-1)?.status, "completed", "The child must save a completed terminal turn");
    assert.ok(childTurns.flatMap(turn => turn.items).some(item => item.type === "commandExecution"), "The child history records the real command");
    await until(() => completed.has(entry.alias), `${entry.alias} command continuation`);
    childFinished.add(entry.alias);
    const parentDone = await until(() => events.find(event => event.method === "turn/completed" && event.params?.turn?.id === parentTurn.turn.id), `${entry.alias} parent completion`);
    assert.equal(parentDone.params.turn.status, "completed", "The parent must not fail after spawning its child");
    evidence.chats.push({ alias: entry.alias, bareModel: saved.thread.model, provider: saved.thread.modelProvider, commandContinuationObserved: completed.has(entry.alias) });
  }

  assert.equal(completed.size, aliases.length, "Every real command must return through function_call_output");
  for (const entry of aliases) assert.equal((await readFile(join(work, entry.file), "utf8")), `${proof}\n`, "The direct command must write the exact fixture bytes");
  const log = (await exec("git", ["log", "--format=%s", "-2"], { cwd: work })).stdout.trim().split("\n");
  assert.deepEqual(new Set(log), new Set(aliases.map(entry => entry.commit)), "The direct commands must create conventional local commits");
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: work })).stdout, "", "The fixture repository must be clean after both commits");
  assert.equal(await readFile(join(native, "config.toml"), "utf8"), nativeConfig, "The native configuration must stay unchanged");
  await assert.rejects(readFile(join(native, "auth.json"), "utf8"), { code: "ENOENT" }, "The fixture must not copy native authentication");
  evidence.nativeConfigUnchanged = true;
  evidence.nativeAuthAbsent = true;
  evidence.completedChildTurns = aliases.length;
  evidence.passed = true;
} catch (error) {
  evidence.phase = phase;
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await backend?.stop();
  if (gateway) await new Promise(resolve => gateway.close(resolve));
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  if (!process.exitCode) await rm(fixture, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: evidence.passed, phase: evidence.phase ?? "complete", paidInferenceRequests: 0 }));
}
