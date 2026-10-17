import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writePrivateJson, gatewayToken } from "../config.js";
import { LiveConfig } from "../live-config.js";
import { startGateway } from "../server.js";
import { startServeRuntime } from "../serve-runtime.js";
import { configureTelemetry, flushTelemetry, readTelemetry, type TelemetryEvent } from "../telemetry.js";
import type { Provider } from "../providers/provider.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-live-")); const path = join(directory, "config.json");
  const source = { version: 1, port: 0, stateDirectory: ".state", providers: [{ id: "one", type: "claude-subscription", label: "One", models: { old: "old-model" } }] };
  await writePrivateJson(path, source); const initial = await loadConfig(path); const live = new LiveConfig(path, initial);
  configureTelemetry(initial.stateDirectory, "test"); const since = Date.now() - 1000;
  /** The `config_rejected` events this test recorded, in order. */
  const rejections = async (): Promise<TelemetryEvent[]> => { await flushTelemetry(); return (await readTelemetry(initial.stateDirectory, since)).filter(event => event.event === "config_rejected"); };
  return { directory, path, source, initial, live, rejections };
}

test("live config reuses unchanged snapshots and loads atomic model replacements", async () => {
  const { path, source, live } = await setup(); const first = await live.current();
  assert.equal(await live.current(), first);
  source.providers[0].models = { old: "old-model", newer: "new-model" } as typeof source.providers[0]["models"];
  await writePrivateJson(path, source); const next = await live.current();
  assert.notEqual(next, first); assert.equal(next.providers[0].models.newer, "new-model");
  await writeFile(path, "invalid JSON"); assert.equal(await live.current(), next);
  await writePrivateJson(path, source); assert.equal((await live.current()).providers[0].models.newer, "new-model");
  await writePrivateJson(path, { ...source, stateDirectory: ".other" }); assert.equal((await live.current()).stateDirectory, first.stateDirectory);
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
    // The last good configuration keeps serving; only an unauthenticated call is refused, as ever.
    assert.equal((await fetch(url + "/v1/models", { headers })).status, 200);
    assert.equal((await fetch(url + "/v1/models")).status, 401);
    assert.equal((await fetch(url + "/health")).status, 200);
    await writePrivateJson(path, source); assert.equal((await fetch(url + "/health")).status, 200);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("live reload cannot silently rebind an existing alias to another model or account, and keeps the last good config", async () => {
  const { path, source, live, initial, rejections } = await setup(); const first = await live.current();
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], models: { old: "different-model" } }] });
  assert.equal(await live.current(), first); assert.equal(live.rejection, "rebind");
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], id: "another-account" }] });
  assert.equal(await live.current(), first);
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], label: "Updated label" }] });
  assert.equal((await live.current()).providers[0].label, "Updated label"); assert.equal(live.rejection, undefined);
  assert.equal(first.stateDirectory, initial.stateDirectory);
  assert.deepEqual((await rejections()).map(event => event.reason), ["rebind", "rebind"]);
});

test("retiring and restoring an alias cannot change its account identity within one daemon lifetime", async () => {
  const { path, source, live } = await setup(); await live.current();
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], models: { newer: "new-model" } }] }); const retired = await live.current();
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], id: "another-account" }] });
  assert.equal(await live.current(), retired); assert.equal(live.rejection, "rebind");
  await writePrivateJson(path, source); assert.equal((await live.current()).providers[0].id, "one"); assert.equal(live.rejection, undefined);
});

test("a refused file is recorded once per stamp with a fixed reason and nothing from the file, and a later valid file clears it", async () => {
  const { directory, path, source, live, rejections } = await setup(); const good = await live.current();
  const secret = join(directory, "private-credential-path");
  // Each refusal class, the same file asked about many times: one record per stamp, and it carries the reason alone.
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], models: { old: "different-model" } }], note: secret });
  for (let request = 0; request < 5; request++) assert.equal(await live.current(), good);
  await writeFile(path, `{ "broken": "${secret}`); for (let request = 0; request < 3; request++) assert.equal(await live.current(), good);
  await writePrivateJson(path, { ...source, port: 1234 }); assert.equal(await live.current(), good); assert.equal(live.rejection, "restart_required");
  await writePrivateJson(path, { ...source, providers: [] }); assert.equal(await live.current(), good); assert.equal(live.rejection, "invalid");
  await writePrivateJson(path, source); await chmod(path, 0o000); assert.equal(await live.current(), good); assert.equal(live.rejection, "unreadable"); assert.equal(await live.current(), good);
  // Mending the permissions keeps the file's stamp, yet it is read again and, being valid, adopted.
  await chmod(path, 0o600); const mended = await live.current(); assert.deepEqual(mended.providers, good.providers); assert.equal(live.rejection, undefined);
  await rm(path); assert.equal(await live.current(), mended); assert.equal(live.rejection, "unreadable"); assert.equal(await live.current(), mended);
  const events = await rejections();
  assert.deepEqual(events.map(event => event.reason), ["rebind", "invalid", "restart_required", "invalid", "unreadable", "unreadable"]);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).filter(key => !["at", "host", "component", "pid", "event"].includes(key)), ["reason"]);
    assert.ok(!JSON.stringify(event).includes(secret) && !JSON.stringify(event).includes(directory));
  }
  // A later valid, allowed file is adopted as before, and the rejection clears.
  await writePrivateJson(path, { ...source, providers: [{ ...source.providers[0], label: "Fixed" }] });
  const adopted = await live.current(); assert.equal(adopted.providers[0].label, "Fixed"); assert.equal(live.rejection, undefined);
  assert.equal((await rejections()).length, events.length);
});

test("putting the applied file back clears a pending rejection, and a file refused again is reported again", async () => {
  const { path, directory, live, rejections } = await setup(); const good = await live.current();
  const saved = join(directory, "saved.json"); await rename(path, saved);
  await writeFile(path, "invalid JSON"); assert.equal(await live.current(), good); assert.equal(live.rejection, "invalid");
  await rename(saved, path); // The very file that serves: same inode, size and time.
  assert.equal(await live.current(), good); assert.equal(live.rejection, undefined);
  await writeFile(path, "invalid JSON again"); assert.equal(await live.current(), good); assert.equal(live.rejection, "invalid");
  assert.deepEqual((await rejections()).map(event => event.reason), ["invalid", "invalid"]);
});

// The production incident: an operator changed one provider's baseUrl, the live read threw on every request, and every model
// of every provider answered 503 "Gateway configuration is invalid" until the file was reverted.
test("changing one provider's baseUrl keeps every model serving on the last good config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-live-url-")); const path = join(directory, "config.json");
  const provider = (id: string, baseUrl: string, models: Record<string, string>) => ({ id, type: "responses-api", label: id, baseUrl, apiKeyEnv: "GATEWAY_LIVE_TEST_KEY", models });
  const source = { version: 1, port: 0, stateDirectory: ".state", providers: [provider("one", "https://one.example/v1", { alpha: "alpha-model" }), provider("two", "https://two.example/v1", { beta: "beta-model" })] };
  await writePrivateJson(path, source); const initial = await loadConfig(path); const live = new LiveConfig(path, initial);
  configureTelemetry(initial.stateDirectory, "test"); const since = Date.now() - 1000;
  const served: string[] = [];
  const server = await startGateway(initial, config => ({ async *infer(request) {
    served.push(`${config.id}/${request.model}/${config.baseUrl}`);
    yield { type: "text", text: `${config.id}/${request.model}` };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } } as Provider), () => live.current());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(initial.stateDirectory);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const ask = async (model: string) => fetch(url + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model, input: "hello" }) });
  try {
    await writePrivateJson(path, { ...source, providers: [provider("one", "https://moved.example/v1", { alpha: "alpha-model" }), source.providers[1]] });
    for (const model of ["alpha", "beta"]) { const response = await ask(model); assert.equal(response.status, 200); }
    assert.equal((await fetch(url + "/v1/models", { headers })).status, 200); assert.equal((await fetch(url + "/health")).status, 200);
    assert.deepEqual(served, ["one/alpha-model/https://one.example/v1", "two/beta-model/https://two.example/v1"], "both models kept their old routes");
    await flushTelemetry(); const events = (await readTelemetry(initial.stateDirectory, since)).filter(event => event.event === "config_rejected");
    assert.deepEqual(events.map(event => event.reason), ["rebind"], "reported once, however many requests were served");
    // An allowed change in the same file is then adopted, and the new alias is served.
    await writePrivateJson(path, { ...source, providers: [source.providers[0], provider("two", "https://two.example/v1", { beta: "beta-model", gamma: "gamma-model" })] });
    assert.equal((await ask("gamma")).status, 200); assert.equal(live.rejection, undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("the first load at startup is still fatal when the file is invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-live-first-")); const path = join(directory, "config.json");
  await writeFile(path, "invalid JSON", { mode: 0o600 });
  await assert.rejects(startServeRuntime(path), /unreadable or invalid JSON/);
  await writePrivateJson(path, { version: 1, port: 0, stateDirectory: ".state", providers: [{ id: "one", type: "no-such-provider", label: "One", models: { old: "old-model" } }] });
  await assert.rejects(startServeRuntime(path), /Unsupported provider type/);
});
