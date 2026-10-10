import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writePrivateJson, gatewayToken } from "../config.js";
import { LiveConfig } from "../live-config.js";
import { startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-live-")); const path = join(directory, "config.json");
  const source = { version: 1, port: 0, stateDirectory: ".state", providers: [{ id: "one", type: "claude-subscription", label: "One", models: { old: "old-model" } }] };
  await writePrivateJson(path, source); const initial = await loadConfig(path); const live = new LiveConfig(path, initial);
  return { directory, path, source, initial, live };
}

test("live config reuses unchanged snapshots and loads atomic model replacements", async () => {
  const { path, source, live } = await setup(); const first = await live.current();
  assert.equal(await live.current(), first);
  source.providers[0].models = { old: "old-model", newer: "new-model" } as typeof source.providers[0]["models"];
  await writePrivateJson(path, source); const next = await live.current();
  assert.notEqual(next, first); assert.equal(next.providers[0].models.newer, "new-model");
  await writeFile(path, "invalid JSON"); await assert.rejects(live.current(), /invalid JSON/);
  await writePrivateJson(path, source); assert.equal((await live.current()).providers[0].models.newer, "new-model");
  await writePrivateJson(path, { ...source, stateDirectory: ".other" }); await assert.rejects(live.current(), /requires restarting/);
});

test("explicit port overrides retain their command-line precedence during live refresh", async () => {
  const { path, source, initial } = await setup(); const live = new LiveConfig(path, { ...initial, port: 4567 }, 4567);
  await writePrivateJson(path, { ...source, port: 7890 }); assert.equal((await live.current()).port, 4567);
});

test("daemon reloads catalogs while pinning in-flight inference to its original account route", async () => {
  const { path, source, initial, live } = await setup(); let release: () => void = () => {}; let started: () => void = () => {};
  const oldStarted = new Promise<void>(resolve => { started = resolve; }); const oldReleased = new Promise<void>(resolve => { release = resolve; });
  const server = await startGateway(initial, config => ({ async *infer(request) {
    if (request.model === "old-model") { started(); await oldReleased; }
    yield { type: "text", text: `${config.id}/${request.model}` };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } } as Provider), () => live.current());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(initial.stateDirectory);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const pending = fetch(url + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "old", input: "hello" }) });
    await oldStarted;
    await writePrivateJson(path, { ...source, providers: [{ id: "two", type: "claude-subscription", label: "Two", models: { newer: "new-model" } }] });
    const catalog = await (await fetch(url + "/v1/model-catalog", { headers })).json() as { models: Array<{ slug: string }> };
    assert.deepEqual(catalog.models.map(model => model.slug), ["newer"]);
    const updated = await (await fetch(url + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "newer", input: "hello" }) })).json() as { output_text: string };
    assert.equal(updated.output_text, "two/new-model");
    release(); assert.equal(((await (await pending).json()) as { output_text: string }).output_text, "one/old-model");
    await writeFile(path, "bad config");
    assert.equal((await fetch(url + "/v1/models", { headers })).status, 503);
    assert.equal((await fetch(url + "/v1/models")).status, 401);
    assert.equal((await fetch(url + "/health")).status, 503);
    await writePrivateJson(path, source); assert.equal((await fetch(url + "/health")).status, 200);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("live reload cannot silently rebind an existing alias to another model or account", async () => {
  const { path, source, live } = await setup(); await live.current();
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], models: { old: "different-model" } }] });
  await assert.rejects(live.current(), /cannot be rebound live/);
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], id: "another-account" }] });
  await assert.rejects(live.current(), /cannot be rebound live/);
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], label: "Updated label" }] });
  assert.equal((await live.current()).providers[0].label, "Updated label");
});
