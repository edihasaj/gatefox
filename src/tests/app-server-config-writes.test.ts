import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseKeyPath } from "../app-server-config-writes-key-path.js";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
type Call = { method: string; params: ObjectValue };

/**
 * Everything the adapter does with a Codex configuration write. The gateway keeps only its own
 * default selections and display settings in a private file; each other key reaches the native
 * engine exactly as ChatGPT would send it without the gateway. The guard that stays is identity:
 * a native file must never remember a gateway model or the gateway provider, because those rows
 * only exist while this adapter runs.
 */
const gateway = "subscription_gateway";
const alias = "claude/model";
const nativeFile = "/Users/dev/.codex/config.toml";
/** What the native engine answers for a write it applied itself; the adapter hands this back untouched. */
const nativeAnswer: ObjectValue = { status: "ok", version: "9", filePath: nativeFile, overriddenMetadata: null };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-config-writes-"));
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { [alias]: "model" }, modelMetadata: { [alias]: { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "medium", "high"] } } },
  ] };
  const calls: Call[] = [];
  let refuseNative = false;
  // The engine can answer the first native write slowly, or refuse a counted number of them, so a
  // test can watch what the adapter does while a write is still in flight.
  let slowFirstNativeWriteMs = 0;
  let nativeRefusals = 0;
  const refused = () => Object.assign(new Error("native refused"), { code: -32600 });
  const nativeWrite = (method: string) => method === "config/batchWrite" || method === "config/value/write";
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (nativeWrite(method)) {
      if (slowFirstNativeWriteMs) { const delay = slowFirstNativeWriteMs; slowFirstNativeWriteMs = 0; await new Promise(done => setTimeout(done, delay)); }
      if (nativeRefusals) { nativeRefusals--; throw refused(); }
      if (refuseNative) throw refused();
    }
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (nativeWrite(method)) return nativeAnswer;
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  const preferencesPath = join(directory, "desktop-preferences.json");
  const saved = async (): Promise<ObjectValue | undefined> => {
    try { return JSON.parse(await readFile(preferencesPath, "utf8")) as ObjectValue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  /** The forwarded calls only, so a private write that stayed home cannot hide a mistake. */
  const forwarded = () => calls.filter(call => nativeWrite(call.method));
  return {
    directory, config, calls, router, backend, preferencesPath, saved, forwarded,
    failNative: (value: boolean) => { refuseNative = value; },
    slowFirstNativeWrite: (ms: number) => { slowFirstNativeWriteMs = ms; },
    refuseNextNativeWrites: (count: number) => { nativeRefusals = count; },
  };
}

/** A refusal names its rule and nothing else: no key, no value, no path from the caller's request. */
const leaks = (message: string, values: unknown[]) =>
  values.some(value => typeof value === "string" && value.length > 1 && message.includes(value));

/** A chain of `levels` nested containers whose leaf is a benign string; the written value is level 1. */
const nest = (levels: number): unknown => levels <= 0 ? "benign" : { n: nest(levels - 1) };

// The SDK ships no parse_key_path unit tests, so these cover every branch of the ported parser.
test("a key path parses into the segments the engine applies", () => {
  assert.deepEqual(parseKeyPath("model"), ["model"]);
  assert.deepEqual(parseKeyPath("features.guardianv2.review_model"), ["features", "guardianv2", "review_model"]);
  assert.deepEqual(parseKeyPath("sample@catalog"), ["sample@catalog"], "bare segments stay permissive");
  assert.deepEqual(parseKeyPath("a b.c"), ["a b", "c"]);
  assert.deepEqual(parseKeyPath('model_providers."subscription_gateway".base_url'), ["model_providers", "subscription_gateway", "base_url"]);
  assert.deepEqual(parseKeyPath('a."b.c".d'), ["a", "b.c", "d"], "a quoted segment carries the separator literally");
  assert.deepEqual(parseKeyPath('"a b"'), ["a b"]);
  assert.deepEqual(parseKeyPath('a."b\\.c"'), ["a", "b.c"], "a quoted backslash escapes the separator");
  assert.deepEqual(parseKeyPath('a."b\\"c"'), ["a", 'b"c'], "a quoted backslash escapes the quote");
  assert.deepEqual(parseKeyPath('a."b\\\\c"'), ["a", "b\\c"], "a quoted backslash escapes itself");
  assert.deepEqual(parseKeyPath('a."x"y'), ["a", "xy"], "text may follow a closing quote");
  assert.deepEqual(parseKeyPath("\uFEFF"), ["\uFEFF"], "the engine trims Unicode whitespace, and a byte-order mark is not whitespace");
});

test("only the Unicode whitespace a path cannot hold is empty to the engine", () => {
  // JavaScript's trim() also strips the byte-order mark, which the engine keeps as a segment.
  for (const blank of [" ", "\u0085", "\u00a0", "\u2028", "\t \n"]) {
    assert.equal(parseKeyPath(blank), undefined, `expected ${JSON.stringify(blank)} to carry no segment`);
  }
  assert.deepEqual(parseKeyPath("\uFEFF\u0085"), ["\uFEFF\u0085"], "a mark beside whitespace is still a name");
});

test("a key path the engine would reject is refused fail-closed", () => {
  for (const bad of ["", " ", "\t\n", ".", "a..b", ".a", "a.", 'a"b', '"a', '"', '""', '"\\', 'a."b\\', 'a\\"b', 'a."x""y"']) {
    assert.equal(parseKeyPath(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  for (const notAPath of [undefined, null, 42, ["model"], {}]) assert.equal(parseKeyPath(notAPath), undefined);
});

test("a bundled plugin's native config write reaches the engine unchanged", async () => {
  const f = await fixture();
  const params = { edits: [{ keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl", args: [], env: { A: "1" }, startup_timeout_sec: 120 }, mergeStrategy: "upsert" }], reloadUserConfig: true };
  const sent = structuredClone(params);
  assert.equal(await f.router.request("config/batchWrite", params), nativeAnswer);
  assert.deepEqual(f.calls, [{ method: "config/batchWrite", params: sent }]);
  assert.equal(await f.saved(), undefined, "a native write saves no gateway preference");
});

test("a native value write keeps its version guard and file target", async () => {
  const f = await fixture();
  const params = { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "upsert", expectedVersion: 7, filePath: "/project/.codex/config.toml" };
  const sent = structuredClone(params);
  assert.equal(await f.router.request("config/value/write", params), nativeAnswer);
  assert.deepEqual(f.calls, [{ method: "config/value/write", params: sent }]);
  assert.equal(await f.saved(), undefined);
});

/** The `mcp_servers.x.enabled` edit ChatGPT sends when a server is switched on or off. */
const mcpEnabled = (value: boolean): ObjectValue => ({ keyPath: "mcp_servers.x.enabled", value, mergeStrategy: "upsert" });

test("config writes reach the native engine in the order they were sent", async () => {
  const f = await fixture();
  f.slowFirstNativeWrite(50);
  // A mixed batch whose native part is still in flight, then a write with no gateway default in it.
  const mixed = f.router.request("config/batchWrite", { edits: [{ keyPath: "model", value: alias, mergeStrategy: "upsert" }, mcpEnabled(false)] });
  const nativeOnly = f.router.request("config/batchWrite", { edits: [mcpEnabled(true)] });
  const mixedResult = await mixed;
  const nativeResult = await nativeOnly;
  assert.deepEqual(f.forwarded().map(call => (call.params.edits as ObjectValue[])[0]!.value), [false, true],
    "the queued write cannot overtake the native part of the batch that was sent first");
  assert.equal(mixedResult, nativeAnswer);
  assert.equal(nativeResult, nativeAnswer, "both callers get the answer for the write they sent");
  assert.equal((await f.saved())?.model, alias);
});

test("a batch with no gateway default reaches the engine unchanged", async () => {
  const f = await fixture();
  assert.equal(await f.router.request("config/batchWrite", { edits: [] }), nativeAnswer, "an empty batch is the caller's, not a refusal");
  assert.equal(await f.router.request("config/batchWrite", {}), nativeAnswer);
  assert.equal(await f.router.request("config/batchWrite", { edits: "off" }), nativeAnswer);
  assert.deepEqual(f.calls, [
    { method: "config/batchWrite", params: { edits: [] } },
    { method: "config/batchWrite", params: {} },
    { method: "config/batchWrite", params: { edits: "off" } },
  ]);
  assert.equal(await f.saved(), undefined, "a batch with nothing to save saves nothing");
});

test("a native write the engine refuses does not block the writes behind it", async () => {
  const f = await fixture();
  f.refuseNextNativeWrites(1);
  const refused = f.router.request("config/batchWrite", { edits: [mcpEnabled(true)] });
  const following = f.router.request("config/batchWrite", { edits: [{ keyPath: "model", value: alias, mergeStrategy: "upsert" }, mcpEnabled(false)] });
  await assert.rejects(refused, { message: "native refused" });
  assert.equal(await following, nativeAnswer, "the queue keeps going after a write that failed");
  assert.equal((await f.saved())?.model, alias);
});

test("a gateway model cannot be saved into a native profile", async () => {
  const f = await fixture();
  const profileModel = "Gateway defaults cannot be saved into a native Codex profile";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work.model", value: alias, mergeStrategy: "upsert" }),
    error => (error as Error).message === profileModel && (error as { code: number }).code === -32600 && !leaks((error as Error).message, ["profiles.work.model", alias]));
  await assert.rejects(f.router.request("config/batchWrite", { edits: [
    { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
    { keyPath: "profiles.work.model", value: "codex/model", mergeStrategy: "upsert" },
  ] }), { message: profileModel });
  assert.deepEqual(f.calls, [], "the whole request is refused before anything is forwarded");
  assert.equal(await f.saved(), undefined);
});

test("the gateway provider cannot be saved as a native provider", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "model_provider", value: gateway, mergeStrategy: "replace" }), { message: identity });
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work.model_provider", value: gateway, mergeStrategy: "upsert" }), { message: identity });
  assert.deepEqual(f.calls, []);
  assert.equal(await f.saved(), undefined);
});

test("the gateway's own provider row cannot be written into native config", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  await assert.rejects(f.router.request("config/value/write", { keyPath: `model_providers.${gateway}.base_url`, value: "http://127.0.0.1:3457/v1", mergeStrategy: "upsert" }),
    error => (error as Error).message === identity && !leaks((error as Error).message, [`model_providers.${gateway}.base_url`, "http://127.0.0.1:3457/v1"]));
  await assert.rejects(f.router.request("config/value/write", { keyPath: `model_providers.${gateway}`, value: { name: "Gateway" }, mergeStrategy: "replace" }), { message: identity });
  await assert.rejects(f.router.request("config/batchWrite", { edits: [{ keyPath: "model_providers", value: { [gateway]: {} }, mergeStrategy: "replace" }] }), { message: identity });
  assert.deepEqual(f.calls, []);
  assert.equal(await f.saved(), undefined);
});

test("gateway identity hidden inside a native value is refused", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work", value: { model: alias }, mergeStrategy: "replace" }),
    error => (error as Error).message === identity && !leaks((error as Error).message, [alias]));
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles", value: { w: { model_provider: gateway } }, mergeStrategy: "replace" }), { message: identity });
  await assert.rejects(f.router.request("config/batchWrite", { edits: [
    { keyPath: "mcp_servers.tool", value: { env: { LIST: [{ model_provider: gateway }] } }, mergeStrategy: "upsert" },
  ] }), { message: identity });
  let deep: ObjectValue = { model: alias };
  for (let level = 0; level < 80; level++) deep = { n: deep };
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.deep", value: deep, mergeStrategy: "replace" }), { message: identity });
  assert.deepEqual(f.calls, []);
  assert.equal(await f.saved(), undefined);
});

test("a quoted gateway provider row cannot bypass the guard", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  await assert.rejects(f.router.request("config/value/write", { keyPath: `model_providers."${gateway}".base_url`, value: "http://127.0.0.1:3457/v1", mergeStrategy: "upsert" }),
    error => (error as Error).message === identity && !leaks((error as Error).message, [gateway]));
  assert.deepEqual(f.calls, [], "the quoted spelling reaches the same segments and is refused the same way");
  assert.equal(await f.saved(), undefined);
});

test("a gateway model under any model-bearing native key is refused", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  const profileModel = "Gateway defaults cannot be saved into a native Codex profile";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "review_model", value: alias, mergeStrategy: "upsert" }), { message: identity });
  await assert.rejects(f.router.request("config/value/write", { keyPath: "features.guardianv2.review_model", value: alias, mergeStrategy: "upsert" }), { message: identity });
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work.review_model", value: alias, mergeStrategy: "upsert" }), { message: identity });
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work", value: { review_model: alias }, mergeStrategy: "replace" }),
    error => (error as Error).message === identity && !leaks((error as Error).message, [alias]));
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work.model", value: alias, mergeStrategy: "upsert" }), { message: profileModel });
  assert.deepEqual(f.calls, []);
  // A native review model is the caller's own choice and reaches the engine unchanged.
  const native = { keyPath: "features.guardianv2.review_model", value: "native", mergeStrategy: "upsert" };
  const sent = structuredClone(native);
  assert.equal(await f.router.request("config/value/write", native), nativeAnswer);
  assert.deepEqual(f.calls, [{ method: "config/value/write", params: sent }]);
  assert.equal(await f.saved(), undefined);
});

test("clearing a gateway provider row stays possible", async () => {
  const f = await fixture();
  const row = { keyPath: `model_providers.${gateway}`, value: null, mergeStrategy: "replace", filePath: nativeFile };
  const field = { keyPath: `model_providers.${gateway}.base_url`, value: null, mergeStrategy: "replace" };
  const sent = structuredClone([row, field]);
  assert.equal(await f.router.request("config/value/write", row), nativeAnswer, "a null clears the whole row, as natively");
  assert.equal(await f.router.request("config/value/write", field), nativeAnswer, "a null clears one field, as natively");
  assert.deepEqual(f.calls, [{ method: "config/value/write", params: sent[0] }, { method: "config/value/write", params: sent[1] }]);
  assert.equal(await f.saved(), undefined);
});

test("the gateway catalog cannot be saved into native Codex configuration", async () => {
  const f = await fixture();
  const catalog = "The gateway catalog cannot be saved into native Codex configuration";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "model_catalog_json", value: f.router.catalogPath, mergeStrategy: "upsert" }),
    error => (error as Error).message === catalog && !leaks((error as Error).message, [f.router.catalogPath, f.directory]));
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work.model_catalog_json", value: join(f.directory, "anything.json"), mergeStrategy: "upsert" }),
    { message: catalog }, "any file inside the gateway state directory is gateway state");
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work", value: { model_catalog_json: f.router.catalogPath }, mergeStrategy: "replace" }),
    { message: catalog }, "the same path inside a written value is refused");
  assert.deepEqual(f.calls, []);
  const elsewhere = { keyPath: "model_catalog_json", value: "/elsewhere/catalog.json", mergeStrategy: "upsert" };
  const sent = structuredClone(elsewhere);
  assert.equal(await f.router.request("config/value/write", elsewhere), nativeAnswer, "the caller's own catalog file stays native");
  assert.deepEqual(f.calls, [{ method: "config/value/write", params: sent }]);
});

test("a value nested past the searched 65 levels is refused", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  const shallow = { keyPath: "profiles.work", value: nest(65), mergeStrategy: "replace" };
  const sent = structuredClone(shallow);
  assert.equal(await f.router.request("config/value/write", shallow), nativeAnswer, "65 levels are searched, and a benign value inside them is forwarded");
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work", value: nest(66), mergeStrategy: "replace" }), { message: identity });
  assert.deepEqual(f.calls, [{ method: "config/value/write", params: sent }], "only the searched-depth write reached the engine");
});

test("a mixed batch forwards null and native edits unchanged and in order", async () => {
  const f = await fixture();
  const plugin = { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" };
  const sent = structuredClone(plugin);
  await f.router.request("config/batchWrite", { edits: [{ keyPath: "model", value: alias, mergeStrategy: "upsert" }, null, plugin] });
  assert.deepEqual(f.forwarded(), [{ method: "config/batchWrite", params: { edits: [null, sent] } }],
    "the native part keeps the caller's own entries, including one the adapter cannot read");
  assert.equal((await f.saved())?.model, alias);
});

test("a native write cannot target the gateway preference file", async () => {
  const f = await fixture();
  const target = "Native configuration changes cannot target the gateway preference file";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "sandbox_mode", value: "read-only", filePath: f.preferencesPath }),
    error => (error as Error).message === target && !leaks((error as Error).message, [f.preferencesPath, "sandbox_mode"]));
  await assert.rejects(f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: alias, mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
  ], filePath: f.preferencesPath }), { message: target });
  assert.deepEqual(f.calls, []);
  assert.equal(await f.saved(), undefined, "a refused mixed batch saves its private part nowhere");
});

test("a native model and provider choice stay native", async () => {
  const f = await fixture();
  const model = { keyPath: "profiles.work.model", value: "native", mergeStrategy: "upsert" };
  const provider = { keyPath: "model_provider", value: "openai", mergeStrategy: "upsert" };
  assert.equal(await f.router.request("config/value/write", model), nativeAnswer);
  assert.equal(await f.router.request("config/value/write", provider), nativeAnswer);
  assert.deepEqual(f.calls.map(call => call.params), [structuredClone(model), structuredClone(provider)]);
  assert.equal(await f.saved(), undefined);
});

test("a mixed batch forwards the native edit then saves the gateway default", async () => {
  const f = await fixture();
  const plugin = { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl", args: [] }, mergeStrategy: "upsert" };
  const sent = structuredClone(plugin);
  const result = await f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: alias, mergeStrategy: "upsert" },
    plugin,
  ], reloadUserConfig: true });
  assert.deepEqual(f.forwarded(), [{ method: "config/batchWrite", params: { edits: [sent], reloadUserConfig: true } }]);
  assert.equal(result, nativeAnswer, "the native engine answers the mixed batch");
  assert.equal((await f.saved())?.model, alias);
  // Several native edits in one batch keep the order the caller sent them in.
  const approval = { keyPath: "approval_policy", value: "on-request", mergeStrategy: "upsert" };
  await f.router.request("config/batchWrite", { edits: [
    approval,
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    plugin,
  ] });
  assert.deepEqual((f.forwarded().at(-1)!.params.edits as ObjectValue[]).map(edit => edit.keyPath), ["approval_policy", "mcp_servers.node_repl"]);
  assert.equal((await f.saved())?.model_reasoning_effort, "high");
});

test("a mixed batch whose native write fails saves nothing", async () => {
  const f = await fixture();
  await f.router.request("config/batchWrite", { edits: [{ keyPath: "model", value: alias, mergeStrategy: "upsert" }] });
  const before = await f.saved();
  f.failNative(true);
  await assert.rejects(f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "codex/model", mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
  ] }), error => (error as Error).message === "native refused" && (error as { code: number }).code === -32600);
  assert.deepEqual(await f.saved(), before, "the saved default keeps the model its last successful write chose");
});

test("a mixed batch with an invalid private part never reaches the engine", async () => {
  const versioned = await fixture();
  await assert.rejects(versioned.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: alias, mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
  ], expectedVersion: 4 }), { message: /version guard/ });
  assert.deepEqual(versioned.calls, []);
  assert.equal(await versioned.saved(), undefined);

  const undeclared = await fixture();
  await assert.rejects(undeclared.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: alias, mergeStrategy: "upsert" },
    { keyPath: "service_tier", value: "priority", mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
  ] }), error => (error as Error).message.includes("does not offer that speed") && (error as { code: number }).code === -32002);
  assert.deepEqual(undeclared.calls, []);
  assert.equal(await undeclared.saved(), undefined);

  const targeted = await fixture();
  await assert.rejects(targeted.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: alias, mergeStrategy: "upsert" },
    { keyPath: "mcp_servers.node_repl", value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
  ], filePath: "/project/.codex/config.toml" }), { message: /custom config-file target/ });
  assert.deepEqual(targeted.calls, []);
});

test("a gateway default write never reaches the engine", async () => {
  const f = await fixture();
  const model = await f.router.request("config/value/write", { keyPath: "model", value: alias, mergeStrategy: "upsert" });
  await f.router.request("config/batchWrite", { edits: [
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
    { keyPath: "desktop.appearanceTheme", value: "dark", mergeStrategy: "replace" },
  ] });
  assert.deepEqual(f.calls, []);
  assert.equal(model.filePath, f.preferencesPath);
  assert.deepEqual(await f.saved(), { model: alias, model_reasoning_effort: "high", desktop: { appearanceTheme: "dark" } });
});

test("the native home is the only base a relative catalog path reads against", async () => {
  const f = await fixture();
  const catalog = "The gateway catalog cannot be saved into native Codex configuration";
  // The engine expands a lone `~`, and `~/rest`, against the home directory.
  const homeSpelling = "~/" + relative(homedir(), f.router.catalogPath);
  await assert.rejects(f.router.request("config/value/write", { keyPath: "model_catalog_json", value: homeSpelling, mergeStrategy: "upsert" }),
    error => (error as Error).message === catalog && !leaks((error as Error).message, [f.router.catalogPath, f.directory]));

  // A relative path is read below the native home, whatever the request's own filePath says: none,
  // a `~` spelling of the native config, and a symlink pointing at one all share that same base.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "gateway-native-base-")));
  const state = join(root, "state");
  const nativeHome = join(root, "native-home");
  await mkdir(state); await mkdir(nativeHome);
  const scoped = new AppServerRouter({ ...f.config, stateDirectory: state }, f.backend, undefined, undefined, nativeHome);
  const aliasConfig = join(root, "native-config-link.toml");
  await symlink(join(nativeHome, "config.toml"), aliasConfig);
  const climbing = relative(nativeHome, scoped.catalogPath); // ../state/codex-models.json
  assert.ok(climbing.startsWith("../"), `the catalog spelled below the native home: ${climbing}`);
  for (const filePath of [undefined, "~/.codex/config.toml", aliasConfig]) {
    const edit = { keyPath: "model_catalog_json", value: climbing, ...(filePath ? { filePath } : {}), mergeStrategy: "upsert" };
    await assert.rejects(scoped.request("config/value/write", structuredClone(edit)), { message: catalog },
      `the catalog reached from the native home is refused with filePath ${String(filePath)}`);
  }
  // A symlinked native home is that same home once the guard resolves it.
  const homeAlias = join(root, "native-home-link");
  await symlink(nativeHome, homeAlias);
  await assert.rejects(new AppServerRouter({ ...f.config, stateDirectory: state }, f.backend, undefined, undefined, homeAlias)
    .request("config/value/write", { keyPath: "model_catalog_json", value: climbing, mergeStrategy: "upsert" }),
    { message: catalog }, "a ../ spelling of the catalog is refused however the native home is spelled");
  assert.deepEqual(f.calls, [], "none of the refusals forwarded anything");

  // The caller's own files stay native: one beside the config the write targets, one the engine
  // expands onto the home directory, and two that only look like one: a backslash expands nowhere
  // outside Windows, and a tilde with no separator after it is just the first character of a name.
  for (const value of ["elsewhere.json", "~/elsewhere.json", "~.x/foo.json", "~\\elsewhere.json"]) {
    const edit = { keyPath: "model_catalog_json", value, filePath: nativeFile, mergeStrategy: "upsert" };
    const sent = structuredClone(edit);
    assert.equal(await scoped.request("config/value/write", edit), nativeAnswer, `${value} stays the caller's own file`);
    assert.deepEqual(f.calls.at(-1), { method: "config/value/write", params: sent }, `${value} is forwarded as it was sent`);
  }
});

test("a gateway default spelled with quotes is refused rather than saved elsewhere", async () => {
  const f = await fixture();
  const spelling = "Gateway defaults must be written with their plain key";
  for (const keyPath of ['"model"', '"service_tier"', '"model_reasoning_effort"', '"model_reasoning_summary"', 'desktop."appearanceTheme"']) {
    await assert.rejects(f.router.request("config/value/write", { keyPath, value: "anything", mergeStrategy: "upsert" }),
      error => (error as Error).message === spelling && !leaks((error as Error).message, [keyPath]));
  }
  await assert.rejects(f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: alias, mergeStrategy: "upsert" },
    { keyPath: '"mcp_servers.node_repl"', value: { command: "/x/node_repl" }, mergeStrategy: "upsert" },
    { keyPath: '"model_reasoning_summary"', value: "auto", mergeStrategy: "upsert" },
  ] }), { message: spelling }, "a mixed batch with one quoted default saves nothing");
  assert.deepEqual(f.calls, [], "the whole request is refused before anything is forwarded");
  assert.equal(await f.saved(), undefined);
  // A quoted name that is not a gateway default is one native key the adapter has no claim on.
  const quoted = { keyPath: '"mcp_servers.node_repl"', value: { command: "/x/node_repl" }, mergeStrategy: "upsert" };
  const literal = { keyPath: 'mo\\del', value: alias, mergeStrategy: "upsert" };
  const desktop = { keyPath: '"desktop.appearanceTheme"', value: "dark", mergeStrategy: "upsert" };
  const sent = [quoted, literal, desktop].map(edit => structuredClone(edit));
  for (const edit of [quoted, literal, desktop]) assert.equal(await f.router.request("config/value/write", edit), nativeAnswer);
  assert.deepEqual(f.forwarded().map(call => call.params), sent, "a key the engine reads as one name it does not own stays native");
});

test("the gateway provider cannot be chosen as the native OSS provider", async () => {
  const f = await fixture();
  const identity = "Gateway models and the gateway provider cannot be saved into native Codex configuration";
  await assert.rejects(f.router.request("config/value/write", { keyPath: "oss_provider", value: gateway, mergeStrategy: "replace" }),
    error => (error as Error).message === identity && !leaks((error as Error).message, [gateway]));
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work.oss_provider", value: gateway, mergeStrategy: "upsert" }), { message: identity });
  await assert.rejects(f.router.request("config/value/write", { keyPath: "profiles.work", value: { oss_provider: gateway }, mergeStrategy: "replace" }), { message: identity });
  await assert.rejects(f.router.request("config/batchWrite", { edits: [{ keyPath: "mcp_servers.x", value: { env: { SET: { oss_provider: gateway } } }, mergeStrategy: "upsert" }] }), { message: identity });
  assert.deepEqual(f.calls, []);
  assert.equal(await f.saved(), undefined);
  // Another provider, and a cleared key, stay the caller's own.
  const other = { keyPath: "oss_provider", value: "ollama", mergeStrategy: "upsert" };
  const cleared = { keyPath: "oss_provider", value: null, mergeStrategy: "replace" };
  assert.equal(await f.router.request("config/value/write", other), nativeAnswer);
  assert.equal(await f.router.request("config/value/write", cleared), nativeAnswer);
  assert.deepEqual(f.forwarded().map(call => call.params), [structuredClone(other), structuredClone(cleared)]);
});

test("the whole-file native write stays refused", async () => {
  const f = await fixture();
  await assert.rejects(f.router.request("config/write", { filePath: nativeFile, toVersion: 1, values: { sandbox_mode: "read-only" } }), { message: /managed separately/ });
  assert.deepEqual(f.calls, []);
});
