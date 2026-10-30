import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyCodexHookCorrections, normalizeCodexFeatureArgs, normalizeCodexFeatureConfig, normalizeCodexFeatureRequest, rewrittenCodexHookScopes, scopedCodexFeatureBase } from "../codex-feature-compat.js";
import { gatewayEngineHome } from "../gateway-engine-home.js";
import { shimFiles } from "./shim-fixture.js";

test("feature compatibility removes only ignored keys and preserves hooks, code mode and Guardian settings", () => {
  const features = { codex_hooks: false, code_mode_tool_description_first: true, code_mode: { enabled: true, future: ["unchanged"] }, guardianv2: { enabled: true, thread_context: false, review_model: "unchanged" }, "guardianv2.thread_context": true, unrelated: false };
  const config = { features, model_reasoning_effort: "ultra", developer_instructions: "code_mode_tool_description_first is a literal here" };
  const before = JSON.stringify(config); const result = normalizeCodexFeatureConfig(config);
  assert.deepEqual(result, { features: { hooks: false, code_mode: { enabled: true, future: ["unchanged"] }, guardianv2: { enabled: true, review_model: "unchanged" }, unrelated: false }, model_reasoning_effort: "ultra", developer_instructions: config.developer_instructions });
  assert.equal(JSON.stringify(config), before);
});

test("canonical hooks take precedence across nested/dotted config and profile feature maps", () => {
  const config = {
    "features.codex_hooks": true, features: { hooks: false, codex_hooks: true },
    "features.code_mode_tool_description_first": true, "features.guardianv2.thread_context": false,
    "features.guardianv2": { enabled: false, thread_context: true, future: 3 },
    "profiles.work.features.hooks": false,
    profiles: { work: { features: { codex_hooks: true, code_mode: false, guardianv2: { thread_context: true, enabled: true } } }, other: { "features.codex_hooks": false, "features.code_mode_tool_description_first": true, "features.guardianv2.thread_context": true } },
  };
  assert.deepEqual(normalizeCodexFeatureConfig(config), {
    features: { hooks: false }, "features.guardianv2": { enabled: false, future: 3 }, "profiles.work.features.hooks": false,
    profiles: { work: { features: { code_mode: false, guardianv2: { enabled: true } } }, other: { "features.hooks": false } },
  });
});

test("RPC normalization is limited to the SDK config and enablement fields", () => {
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const params = { threadId: "thread", config: { "features.codex_hooks": false, "features.code_mode_tool_description_first": true, model_reasoning_effort: "max" }, future: { code_mode_tool_description_first: true } };
    assert.deepEqual(normalizeCodexFeatureRequest(method, params), { ...params, config: { "features.hooks": false, model_reasoning_effort: "max" } });
    assert.equal(params.config["features.codex_hooks"], false);
  }
  assert.deepEqual(normalizeCodexFeatureRequest("experimentalFeature/enablement/set", { enablement: { codex_hooks: false, hooks: true, code_mode_tool_description_first: true, "guardianv2.thread_context": false, guardianv2: true, code_mode: true, memories: false } }), { enablement: { hooks: true, guardianv2: true, code_mode: true, memories: false } });
  const params = { config: { "features.code_mode_tool_description_first": true }, input: [{ text: "codex_hooks" }] };
  for (const method of ["initialize", "turn/start", "config/value/write", "thread/settings/update"]) assert.equal(normalizeCodexFeatureRequest(method, params), params);
});

test("quoted profile names retain canonical hooks across flat and structured overrides", () => {
  const config = { profiles: { "work.profile": { features: { codex_hooks: false, code_mode: true } } }, 'profiles."work.profile".features.hooks': true };
  assert.deepEqual(normalizeCodexFeatureConfig(config), { profiles: { "work.profile": { features: { code_mode: true } } }, 'profiles."work.profile".features.hooks': true });
  assert.deepEqual(normalizeCodexFeatureArgs(["-c", 'profiles."work.profile".features={codex_hooks=false,code_mode=true}', "-c", "profiles.'work.profile'.features.hooks=true"]), ["-c", 'profiles."work.profile".features={ code_mode=true }', "-c", "profiles.'work.profile'.features.hooks=true"]);
});

test("explicit canonical base hooks retain precedence over contrary legacy CLI and RPC overrides", () => {
  for (const enabled of [false, true]) {
    const base = { features: { hooks: enabled, code_mode: true } };
    const incoming = { features: { codex_hooks: !enabled, guardianv2: { enabled: true, thread_context: false } } };
    assert.deepEqual(normalizeCodexFeatureConfig(incoming, base), { features: { guardianv2: { enabled: true } } });
    assert.deepEqual(normalizeCodexFeatureArgs(["app-server", "-c", `features.codex_hooks=${!enabled}`, enabled ? "--disable" : "--enable", "codex_hooks"], base), ["app-server"]);
    assert.deepEqual(normalizeCodexFeatureConfig({ "features.hooks": !enabled, "features.codex_hooks": enabled }, base), { "features.hooks": !enabled });
    assert.deepEqual(normalizeCodexFeatureArgs(["-c", `features.hooks=${!enabled}`, "--enable", "codex_hooks"], base), ["-c", `features.hooks=${!enabled}`]);
    assert.deepEqual(normalizeCodexFeatureConfig({ "profiles.work.features.codex_hooks": !enabled }, { profiles: { work: { features: { hooks: enabled } } } }), {});
  }
});

test("SDK-scoped lower canonical hooks survive a synthetic CLI rewrite and honor explicit client choices", () => {
  const args = ["app-server", "-c", "features.codex_hooks=true"];
  const rewritten = rewrittenCodexHookScopes(args, {}); assert.deepEqual([...rewritten], ["features"]);
  assert.equal(rewrittenCodexHookScopes(args, { features: { hooks: false } }).size, 0);
  const response = { config: { features: { hooks: true, code_mode: true } }, layers: [
    { name: { type: "sessionFlags" }, config: { features: { hooks: true } } },
    { name: { type: "project" }, config: { features: { hooks: false } } },
    { name: { type: "user" }, config: { features: { hooks: true } } },
  ] };
  const scoped = scopedCodexFeatureBase(response, rewritten);
  assert.deepEqual(scoped, { base: { "features.hooks": false }, corrections: { "features.hooks": false } });
  const normalized = normalizeCodexFeatureConfig({ features: { codex_hooks: true, code_mode: true } }, scoped.base);
  assert.deepEqual(applyCodexHookCorrections(normalized, scoped.corrections), { features: { code_mode: true }, "features.hooks": false });
  assert.deepEqual(applyCodexHookCorrections({ features: { hooks: true } }, scoped.corrections), { features: { hooks: true } });
  assert.throws(() => scopedCodexFeatureBase({ config: { features: { hooks: true } } }, rewritten), error => (error as Error & { code: number }).code === -32001);
  assert.throws(() => scopedCodexFeatureBase({}, new Set()), error => (error as Error & { code: number }).code === -32001);
});

test("CLI compatibility preserves unrelated arguments and normalizes scalar override and enablement forms", () => {
  const input = ["app-server", "-c", "features.code_mode_tool_description_first=true", "--config=features.guardianv2.thread_context=false", "--disable", "codex_hooks", "--enable=code_mode", "--enable=guardianv2.thread_context", "-c", "features.guardianv2.enabled=true", "--listen", "stdio://"];
  assert.deepEqual(normalizeCodexFeatureArgs(input), ["app-server", "--disable", "hooks", "--enable=code_mode", "-c", "features.guardianv2.enabled=true", "--listen", "stdio://"]);
  assert.equal(input[2], "features.code_mode_tool_description_first=true");
  assert.deepEqual(normalizeCodexFeatureArgs(["--enable=codex_hooks", "--disable", "hooks", "-c", "features.codex_hooks=true"]), ["--disable", "hooks"]);
  assert.deepEqual(normalizeCodexFeatureArgs(["--enable=code_mode,guardianv2.thread_context"]), ["--enable=code_mode,guardianv2.thread_context"]);
  assert.deepEqual(normalizeCodexFeatureArgs(["-c", "profiles.work.features.codex_hooks=false", "-c", "profiles.work.features.guardianv2.thread_context=true", "app-server"]), ["-c", "profiles.work.features.hooks=false", "app-server"]);
});

test("CLI structured JSON and inline TOML retain code-mode and Guardian values", () => {
  const json = { codex_hooks: false, code_mode_tool_description_first: true, code_mode: { enabled: true }, guardianv2: { enabled: false, thread_context: true } };
  assert.deepEqual(normalizeCodexFeatureArgs(["-c", "features=" + JSON.stringify(json), "--config=features.hooks=true"]), ["-c", 'features={"code_mode":{"enabled":true},"guardianv2":{"enabled":false}}', "--config=features.hooks=true"]);
  const table = 'features = { code_mode = { enabled = true, names = ["a,b", "thread_context"] }, codex_hooks = false, guardianv2 = { enabled = true, thread_context = false, note = "commas, and braces } remain" } }';
  assert.deepEqual(normalizeCodexFeatureArgs(["-c", table]), ["-c", 'features={ code_mode = { enabled = true, names = ["a,b", "thread_context"] }, hooks = false, guardianv2 = { enabled = true, note = "commas, and braces } remain" } }']);
  assert.deepEqual(normalizeCodexFeatureArgs(["--config=features.guardianv2={enabled = false, thread_context = true, extra = 'keep, = }'}"]), ["--config=features.guardianv2={ enabled = false, extra = 'keep, = }' }"]);
  assert.deepEqual(normalizeCodexFeatureArgs(["-c", "developer_instructions='features.codex_hooks=false, thread_context=true'"]), ["-c", "developer_instructions='features.codex_hooks=false, thread_context=true'"]);
});

test("private snapshots normalize feature aliases without writing the native configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "feature-compat-home-")); const native = join(root, "native"); await mkdir(native, { mode: 0o700 });
  const original = "# original native configuration\n"; await writeFile(join(native, "config.toml"), original, { mode: 0o600 });
  try {
    const home = await gatewayEngineHome(join(root, "state"), { features: { codex_hooks: false, code_mode_tool_description_first: true, code_mode: { enabled: true }, guardianv2: { enabled: true, thread_context: false } }, profiles: { work: { features: { codex_hooks: true, guardianv2: { enabled: false, thread_context: true } } } } }, { nativeHome: native });
    const snapshot = await readFile(join(home, "config.toml"), "utf8");
    assert.equal(snapshot.includes("codex_hooks"), false); assert.equal(snapshot.includes("code_mode_tool_description_first"), false); assert.equal(snapshot.includes("thread_context"), false);
    assert.match(snapshot, /hooks = false/); assert.match(snapshot, /hooks = true/); assert.match(snapshot, /code_mode = \{ enabled = true \}/);
    assert.equal(await readFile(join(native, "config.toml"), "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual shim forwards normalized config and enablement while preserving its native account", { timeout: 10000 }, async () => {
  const f = await shimFiles();
  let source = await readFile(f.backend, "utf8");
  source = source.replace("model:m.params.model,ephemeral:", "model:m.params.model,cwd:m.params.cwd||process.cwd(),ephemeral:")
    .replaceAll("model:thread.model}});", "model:thread.model,observedConfig:m.params.config}});")
    .replace("if(m.method==='model/list')", "if(m.method==='experimentalFeature/enablement/set')send({id:m.id,result:{enablement:m.params.enablement}});\n else if(m.method==='model/list')");
  await writeFile(f.backend, source, { mode: 0o700 });
  const child = spawn(process.execPath, [f.cli, "codex-shim", "--config", f.config, "--codex", f.backend, "--", "app-server", "-c", "features.code_mode_tool_description_first=true", "--listen", "stdio://"], { env: f.env, stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(child, "close"); const lines = createInterface({ input: child.stdout }); let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  lines.on("line", line => { const message = JSON.parse(line); const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); });
  const rpc = (method: string, params = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error("Compatibility fixture timed out")); }, 5000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  try {
    await rpc("initialize", { clientInfo: { name: "feature-compat-test", version: "1" } });
    const config = { features: { code_mode_tool_description_first: true, codex_hooks: false, code_mode: true, guardianv2: { enabled: false, thread_context: true } }, model_reasoning_effort: "max" };
    const started = await rpc("thread/start", { model: "native", config });
    assert.equal(started.modelProvider, "openai"); assert.deepEqual(started.observedConfig, { features: { hooks: false, code_mode: true, guardianv2: { enabled: false } }, model_reasoning_effort: "max" });
    const resumed = await rpc("thread/resume", { threadId: started.thread.id, config });
    assert.deepEqual(resumed.observedConfig, started.observedConfig);
    assert.deepEqual((await rpc("experimentalFeature/enablement/set", { enablement: { code_mode_tool_description_first: true, codex_hooks: false, memories: true } })).enablement, { hooks: false, memories: true });
    assert.equal((await rpc("account/read")).account.email, "primary-test-account");
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { child.stdin.end(); await exited; lines.close(); for (const value of pending.values()) clearTimeout(value.timer); f.close(); }
});
