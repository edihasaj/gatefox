import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { mutateConfig } from "../app-management/storage.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-")); const path = join(root, "gateway.json");
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models"); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-one", display_name: "Fixture One" }, { id: "fixture-two" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { path, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const dependencies = { lookupCli: async () => true };

test("prepares, discovers, and commits a loopback API connection without exposing its key", async () => {
  const f = await fixture();
  try {
    const prepared = await handleManagement({ operation: "prepare", configPath: f.path, provider: { label: "Fixture", type: "responses-api", baseUrl: f.baseUrl, apiKey: "test-secret-value" } }, dependencies);
    assert.equal(prepared.ok, true); if (!prepared.ok) return;
    const draftId = prepared.result.draft!.id;
    const discovered = await handleManagement({ operation: "discover", configPath: f.path, draftId }, dependencies);
    assert.equal(discovered.ok, true); if (!discovered.ok) return;
    assert.deepEqual(discovered.result.models?.map(model => model.id), ["fixture-one", "fixture-two"]);
    const committed = await handleManagement({ operation: "commit", configPath: f.path, draftId, selectedModels: ["fixture-one"] }, dependencies);
    assert.equal(committed.ok, true); if (!committed.ok) return;
    assert.equal(committed.result.providers?.[0].models[0].id, "fixture-one");
    assert.equal(JSON.stringify(committed).includes("test-secret-value"), false);
    const saved = await readFile(f.path, "utf8"); assert.equal(saved.includes("test-secret-value"), false);
    const credential = JSON.parse(saved).providers[0].credentialFile as string; assert.equal((await stat(credential)).mode & 0o077, 0);
  } finally { await f.close(); }
});

test("preserves unknown settings, aliases, and digest on a no-op model save", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify({ version: 1, port: 3457, stateDirectory: join(dirname(f.path), "state"), unknownRoot: { keep: true }, providers: [{ id: "fixture", label: "Old", type: "responses-api", baseUrl: f.baseUrl, credentialFile: join(dirname(f.path), "state", "fixture-key"), models: { "fixture/kept": "fixture-one" }, modelMetadata: { "fixture/kept": { displayName: "Kept" } }, unknownProvider: true }] }));
    const initial = await handleManagement({ operation: "inspect", configPath: f.path }, dependencies); assert.equal(initial.ok, true); if (!initial.ok) return;
    const saved = await handleManagement({ operation: "models", configPath: f.path, providerId: "fixture", revision: initial.result.revision, selectedModels: ["fixture-one"] }, dependencies);
    assert.equal(saved.ok, true); if (!saved.ok) return;
    assert.equal(saved.result.changed, false); assert.equal(saved.result.revision, initial.result.revision);
    const raw = JSON.parse(await readFile(f.path, "utf8")); assert.equal(raw.unknownRoot.keep, true); assert.equal(raw.providers[0].unknownProvider, true); assert.equal(raw.providers[0].models["fixture/kept"], "fixture-one");
  } finally { await f.close(); }
});

test("retains every alias and metadata for a selected upstream model", async () => {
  const f = await fixture();
  try {
    const state = join(dirname(f.path), "state"); await mkdir(state, { recursive: true }); const credential = join(state, "key"); await writeFile(credential, "key\n", { mode: 0o600 });
    await writeFile(f.path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "fixture", type: "responses-api", baseUrl: f.baseUrl, credentialFile: credential,
      models: { "fixture/a": "fixture-one", "fixture/b": "fixture-one" }, modelMetadata: { "fixture/a": { displayName: "A" }, "fixture/b": { displayName: "B" } } }] }), { mode: 0o600 });
    const inspected = await handleManagement({ operation: "inspect", configPath: f.path }, dependencies); assert.equal(inspected.ok, true); if (!inspected.ok) return;
    const saved = await handleManagement({ operation: "models", configPath: f.path, providerId: "fixture", revision: inspected.result.revision, selectedModels: ["fixture-one"] }, dependencies);
    assert.equal(saved.ok, true); assert.equal(saved.ok && saved.result.changed, false);
    const provider = JSON.parse(await readFile(f.path, "utf8")).providers[0];
    assert.deepEqual(provider.models, { "fixture/a": "fixture-one", "fixture/b": "fixture-one" });
    assert.deepEqual(provider.modelMetadata, { "fixture/a": { displayName: "A" }, "fixture/b": { displayName: "B" } });
  } finally { await f.close(); }
});

test("reserves edited and retired aliases without rebinding a selected new model", async () => {
  const f = await fixture();
  try {
    const state = join(dirname(f.path), "state"); await mkdir(state, { recursive: true }); const credential = join(state, "key"); await writeFile(credential, "key\n", { mode: 0o600 });
    await writeFile(f.path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "p", type: "responses-api", baseUrl: f.baseUrl, credentialFile: credential, models: { "p/new": "old" } }] }), { mode: 0o600 });
    const first = await handleManagement({ operation: "inspect", configPath: f.path }, dependencies); assert.equal(first.ok, true); if (!first.ok) return;
    const both = await handleManagement({ operation: "models", configPath: f.path, providerId: "p", revision: first.result.revision, selectedModels: ["new", "old"], manualModels: ["new"] }, dependencies);
    assert.equal(both.ok, true); if (!both.ok) return;
    let provider = JSON.parse(await readFile(f.path, "utf8")).providers[0]; assert.deepEqual(provider.models, { "p/new": "old", "p/new-2": "new" });
    const retired = await handleManagement({ operation: "models", configPath: f.path, providerId: "p", revision: both.result.revision, selectedModels: ["new"], manualModels: ["new"] }); assert.equal(retired.ok, true); if (!retired.ok) return;
    const resumed = await handleManagement({ operation: "models", configPath: f.path, providerId: "p", revision: retired.result.revision, selectedModels: ["old", "new"], manualModels: ["old", "new"] }); assert.equal(resumed.ok, true);
    provider = JSON.parse(await readFile(f.path, "utf8")).providers[0]; assert.deepEqual(provider.models, { "p/new-2": "new", "p/new": "old" });
  } finally { await f.close(); }
});

test("new API connections persist a private state credential and select a usable loopback port", async () => {
  const f = await fixture();
  try {
    const prepared = await handleManagement({ operation: "prepare", configPath: f.path, provider: { label: "Fixture", type: "responses-api", baseUrl: f.baseUrl, apiKey: "first-key" } }, dependencies); assert.equal(prepared.ok, true); if (!prepared.ok) return;
    const discovered = await handleManagement({ operation: "discover", configPath: f.path, draftId: prepared.result.draft!.id }, dependencies); assert.equal(discovered.ok, true); if (!discovered.ok) return;
    const committed = await handleManagement({ operation: "commit", configPath: f.path, draftId: prepared.result.draft!.id, selectedModels: ["fixture-one"] }, dependencies); assert.equal(committed.ok, true); if (!committed.ok) return;
    const raw = JSON.parse(await readFile(f.path, "utf8")); const credential = raw.providers[0].credentialFile as string;
    assert.match(credential, /state\/connections\//); assert.equal((await stat(credential)).mode & 0o077, 0); assert.ok(raw.port > 0);
    const reconnected = await handleManagement({ operation: "authenticate", configPath: f.path, providerId: raw.providers[0].id, revision: committed.result.revision, provider: { apiKey: "second-key" } }, dependencies);
    assert.equal(reconnected.ok, true); assert.equal((await readFile(credential, "utf8")).trim(), "second-key");
  } finally { await f.close(); }
});

test("manual discovery IDs do not overwrite discovered metadata at commit", async () => {
  const f = await fixture();
  try {
    const discoveredModel = { model: "fixture-one", metadata: { displayName: "Fresh Fixture", contextWindow: 123_456 } };
    const prepared = await handleManagement({ operation: "prepare", configPath: f.path, provider: { label: "Fixture", type: "responses-api", baseUrl: f.baseUrl, apiKey: "first-key" } }, dependencies); assert.equal(prepared.ok, true); if (!prepared.ok) return;
    const discovered = await handleManagement({ operation: "discover", configPath: f.path, draftId: prepared.result.draft!.id, manualModels: ["fixture-one"] }, { ...dependencies, discoverModels: async () => [discoveredModel] });
    assert.equal(discovered.ok, true); if (!discovered.ok) return;
    const committed = await handleManagement({ operation: "commit", configPath: f.path, draftId: prepared.result.draft!.id, selectedModels: ["fixture-one"] }, dependencies); assert.equal(committed.ok, true);
    const provider = JSON.parse(await readFile(f.path, "utf8")).providers[0]; const alias = Object.keys(provider.models).find(key => provider.models[key] === "fixture-one");
    assert.deepEqual(provider.modelMetadata[alias!], discoveredModel.metadata);
  } finally { await f.close(); }
});

test("a pre-aborted prepare writes no private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-cancel-")); const path = join(root, "gateway.json"); const control = new AbortController(); control.abort();
  const result = await handleManagement({ operation: "prepare", configPath: path, provider: { label: "Fixture", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", apiKey: "first-key" } }, { signal: control.signal });
  assert.deepEqual(result, { ok: false, error: { code: "cancelled", message: "The management operation was cancelled." } });
  assert.deepEqual(await readdir(root), []);
});

test("pre-aborted rename and key replacement leave their original bytes unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-cancel-")); const path = join(root, "gateway.json"); const state = join(root, "state"); const credential = join(state, "api-key");
  await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700); await writeFile(credential, "first-key\n", { mode: 0o600 });
  await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "fixture", label: "Original", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", credentialFile: credential, models: { fixture: "model" } }] }), { mode: 0o600 });
  const inspected = await handleManagement({ operation: "inspect", configPath: path }); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  const bytes = await readFile(path); const key = await readFile(credential); const control = new AbortController(); control.abort();
  const renamed = await handleManagement({ operation: "rename", configPath: path, providerId: "fixture", revision: inspected.result.revision, label: "Changed" }, { signal: control.signal });
  const replaced = await handleManagement({ operation: "authenticate", configPath: path, providerId: "fixture", revision: inspected.result.revision, provider: { apiKey: "second-key" } }, { signal: control.signal });
  assert.equal(renamed.ok, false); assert.equal(replaced.ok, false); if (!renamed.ok) assert.equal(renamed.error.code, "cancelled"); if (!replaced.ok) assert.equal(replaced.error.code, "cancelled");
  assert.deepEqual(await readFile(path), bytes); assert.deepEqual(await readFile(credential), key);
});

test("cancellation while waiting for the configuration lock prevents the later rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-cancel-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "fixture", label: "Original", type: "claude-subscription", models: { fixture: "model" } }] }), { mode: 0o600 });
  const inspected = await handleManagement({ operation: "inspect", configPath: path }, dependencies); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  let entered!: () => void; const acquired = new Promise<void>(resolve => { entered = resolve; }); let release!: () => void; const unlocked = new Promise<void>(resolve => { release = resolve; });
  const held = mutateConfig(path, inspected.result.revision, async current => { entered(); await unlocked; return current!.raw; }); await acquired;
  const original = await readFile(path); const control = new AbortController(); const pending = handleManagement({ operation: "rename", configPath: path, providerId: "fixture", revision: inspected.result.revision, label: "Changed" }, { signal: control.signal });
  await new Promise(resolve => setTimeout(resolve, 25)); control.abort(); release(); await held;
  const result = await pending; assert.deepEqual(result, { ok: false, error: { code: "cancelled", message: "The management operation was cancelled." } }); assert.deepEqual(await readFile(path), original);
});

test("a safe existing 0755 state root keeps new credentials reconnectable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-management-state-root-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { mode: 0o755 }); await chmod(state, 0o755);
  const prepared = await handleManagement({ operation: "prepare", configPath: path, provider: { label: "Fixture", type: "responses-api", baseUrl: "http://127.0.0.1:3457/v1", apiKey: "first-key" } }, dependencies); assert.equal(prepared.ok, true); if (!prepared.ok) return;
  const committed = await handleManagement({ operation: "commit", configPath: path, draftId: prepared.result.draft!.id, selectedModels: ["fixture-one"], manualModels: ["fixture-one"] }, dependencies); assert.equal(committed.ok, true); if (!committed.ok) return;
  const saved = JSON.parse(await readFile(path, "utf8")); const credential = saved.providers[0].credentialFile as string; const inspected = await handleManagement({ operation: "inspect", configPath: path }, dependencies); assert.equal(inspected.ok, true); if (!inspected.ok) return;
  assert.equal(inspected.result.providers?.[0]?.canReconnect, true); const replaced = await handleManagement({ operation: "authenticate", configPath: path, providerId: saved.providers[0].id, revision: inspected.result.revision, provider: { apiKey: "second-key" } }, dependencies);
  assert.equal(replaced.ok, true); assert.equal((await readFile(credential, "utf8")).trim(), "second-key"); assert.equal((await stat(state)).mode & 0o777, 0o755);
});
