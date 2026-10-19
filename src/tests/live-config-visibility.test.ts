import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writePrivateJson, gatewayToken } from "../config.js";
import { daemonConfigStatus } from "../config-rejection.js";
import { summarizeTelemetry } from "../diagnostics.js";
import { inferenceFindings } from "../health-checks.js";
import { probeInference } from "../health.js";
import { LiveConfig } from "../live-config.js";
import { startGateway } from "../server.js";
import { configureTelemetry } from "../telemetry.js";
import type { Provider } from "../providers/provider.js";

const provider = (id: string, baseUrl: string, models: Record<string, string>) => ({ id, type: "responses-api", label: id, baseUrl, apiKeyEnv: "GATEWAY_LIVE_TEST_KEY", models });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-live-visible-")); const path = join(directory, "config.json");
  const source = { version: 1, port: 0, stateDirectory: ".state", providers: [provider("one", "https://one.example/v1", { alpha: "alpha-model" }), provider("two", "https://two.example/v1", { beta: "beta-model" })] };
  await writePrivateJson(path, source); const initial = await loadConfig(path); const live = new LiveConfig(path, initial);
  configureTelemetry(initial.stateDirectory, "test");
  return { directory, path, source, initial, live };
}
/** The edit the reviewer described: provider two is removed, and in the same file provider one's base URL is rebound. */
const removalAndRebind = (source: Awaited<ReturnType<typeof setup>>["source"]) => ({ ...source, providers: [provider("one", "https://moved.example/v1", { alpha: "alpha-model" })] });

test("a refused change is a warning that names its fixed reason, and it adds to a release lag instead of replacing it", () => {
  const answered = { state: "answered" as const, status: 200, release: "0.4.7", bodyStatus: "ok" };
  assert.deepEqual(inferenceFindings({ ...answered, configRejected: "rebind" }, "0.4.7"), [{ level: "warn", reason: "gateway.json change not applied (rebind); fix it or restart the service" }]);
  assert.deepEqual(inferenceFindings({ ...answered, configRejected: "restart_required", release: "0.4.6" }, "0.4.7"), [
    { level: "warn", reason: "gateway.json change not applied (restart_required); fix it or restart the service" }, { level: "warn", reason: "lagging inference@0.4.6" }]);
  assert.deepEqual(inferenceFindings(answered, "0.4.7"), []);
});

test("the health probe reads the server's own answer, so the warning stays while the file stays refused, and only a fixed word is believed", async () => {
  const { path, source, live } = await setup(); await live.current();
  const server = await startGateway(await loadConfig(path), config => ({ async *infer() { yield { type: "text", text: config.id }; } } as Provider), () => live.current(), { configRejection: () => live.rejection });
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await probeInference(port)).configRejected, undefined);
    await writePrivateJson(path, removalAndRebind(source));
    for (let probe = 0; probe < 3; probe++) { const answered = await probeInference(port); assert.deepEqual([answered.state, answered.status, answered.configRejected], ["answered", 200, "rebind"]); }
    assert.deepEqual(await daemonConfigStatus(port), { reachable: true, rejection: "rebind" });
    await writeFile(path, "invalid JSON"); assert.equal((await probeInference(port)).configRejected, "invalid");
    await writePrivateJson(path, { ...source, providers: [source.providers[0]] });
    const cleared = await probeInference(port); assert.equal(cleared.configRejected, undefined); assert.deepEqual(await daemonConfigStatus(port), { reachable: true });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  // A process answering with anything but a word of the fixed list is not believed.
  const hostile = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok", configRejected: "/Users/x/.config/secret" })); });
  await new Promise<void>(resolve => hostile.listen(0, "127.0.0.1", resolve));
  try {
    const hostilePort = (hostile.address() as { port: number }).port;
    assert.equal((await probeInference(hostilePort)).configRejected, undefined); assert.deepEqual(await daemonConfigStatus(hostilePort), { reachable: true });
  } finally { await new Promise<void>(resolve => hostile.close(() => resolve())); }
});

test("a refused change shows in the diagnostics problems", () => {
  const summary = summarizeTelemetry([{ at: new Date().toISOString(), host: "mac", component: "server", pid: 1, event: "config_rejected", reason: "rebind" }], new Date(Date.now() - 60000)) as { recentProblems: Array<Record<string, unknown>> };
  assert.deepEqual(summary.recentProblems.map(row => [row.event, row.reason]), [["config_rejected", "rebind"]]);
});

test("a valid file that is refused still takes away the aliases it no longer has, and they stay away through a later bad file", async () => {
  const { path, source, live } = await setup(); const good = await live.current();
  await writePrivateJson(path, removalAndRebind(source));
  const served = await live.current(); assert.equal(live.rejection, "rebind");
  assert.deepEqual(served.providers.map(entry => [entry.id, entry.baseUrl, Object.keys(entry.models)]), [["one", "https://one.example/v1", ["alpha"]]], "removed provider stops; rebound one keeps its old binding");
  assert.equal(await live.current(), served, "the same object between calls, so routes are not rebuilt per request");
  assert.equal(good.providers.length, 2);
  await writeFile(path, "invalid JSON"); assert.deepEqual((await live.current()).providers.map(entry => entry.id), ["one"], "an unreadable follow-up edit does not bring it back");
  await writePrivateJson(path, { ...source, providers: [source.providers[0]] });
  assert.deepEqual((await live.current()).providers.map(entry => [entry.id, entry.baseUrl]), [["one", "https://one.example/v1"]]); assert.equal(live.rejection, undefined);
});

test("removing one alias of a provider while rebinding another stops only the removed alias, with its metadata", async () => {
  const { path, source, live } = await setup();
  const first = { ...provider("one", "https://one.example/v1", { alpha: "alpha-model", extra: "extra-model" }), modelMetadata: { alpha: { displayName: "Alpha" }, extra: { displayName: "Extra" } } };
  await writePrivateJson(path, { ...source, providers: [first, source.providers[1]] }); await live.current();
  await writePrivateJson(path, { ...source, providers: [{ ...first, models: { alpha: "other-model" }, modelMetadata: { alpha: { displayName: "Alpha" } } }, source.providers[1]] });
  const served = await live.current(); assert.equal(live.rejection, "rebind");
  assert.deepEqual(served.providers[0].models, { alpha: "alpha-model" }); assert.deepEqual(Object.keys(served.providers[0].modelMetadata ?? {}), ["alpha"]);
  assert.deepEqual(served.providers.map(entry => entry.id), ["one", "two"]);
});

test("through the server a refused removal stops serving the removed model and keeps the rebound one on its old route", async () => {
  const { path, source, initial, live } = await setup(); await live.current();
  const served: string[] = [];
  const server = await startGateway(initial, config => ({ async *infer(request) {
    served.push(`${config.id}/${request.model}/${config.baseUrl}`); yield { type: "text", text: config.id };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } } as Provider), () => live.current(), { configRejection: () => live.rejection });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(initial.stateDirectory);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const ask = (model: string) => fetch(url + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model, input: "hello" }) });
  try {
    assert.equal((await ask("beta")).status, 200);
    await writePrivateJson(path, removalAndRebind(source));
    assert.notEqual((await ask("beta")).status, 200, "the removed provider no longer serves");
    assert.equal((await ask("alpha")).status, 200);
    const models = await (await fetch(url + "/v1/models", { headers })).json() as { data: Array<{ id: string }> };
    assert.deepEqual(models.data.map(model => model.id), ["alpha"]);
    assert.deepEqual(served, ["two/beta-model/https://two.example/v1", "one/alpha-model/https://one.example/v1"]);
    assert.equal(((await (await fetch(url + "/health")).json()) as { configRejected?: string }).configRejected, "rebind");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
