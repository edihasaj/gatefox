import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { catalogLimits, DesktopCatalog } from "../desktop-catalog.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { shimFiles } from "./shim-fixture.js";

const rows = { models: [{ slug: "claude/model", display_name: "Claude Model", supported_reasoning_levels: [] }] };
const unavailable = { code: -32001, message: /Gateway model discovery is unavailable/ };
const native = [{ slug: "native", priority: 1, node_repl_disabled: false, node_repl_auto_review_required: false }];

/** A host whose answers are scripted; "hang" never answers. */
async function host(run: (f: { catalog(): DesktopCatalog; answer(next: "ok" | "hang" | "error" | "invalid" | Array<"ok" | "hang">): void; requests(): number; down(): Promise<void>; stateDirectory: string }) => Promise<void>) {
  const files = await shimFiles({ serve: false }), limits = { ...catalogLimits };
  let mode: string | string[] = "ok", requests = 0; const open = new Set<ServerResponse>();
  const server = createServer((_req, res) => {
    requests++; const answer = Array.isArray(mode) ? mode.shift() ?? "ok" : mode;
    if (answer === "hang") { open.add(res); return; }
    if (answer === "error") { res.writeHead(500); res.end(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(answer === "invalid" ? "{" : JSON.stringify(rows));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  files.value.port = (server.address() as { port: number }).port;
  configureTelemetry(files.value.stateDirectory, "test");
  const down = async () => { for (const res of open) res.destroy(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
  Object.assign(catalogLimits, { firstMs: 150, retryMs: 2000 });
  try {
    await run({ catalog: () => new DesktopCatalog(files.value, native, join(files.directory, "combined.json")), answer: next => { mode = next; requests = 0; }, requests: () => requests, down, stateDirectory: files.value.stateDirectory });
  } finally { Object.assign(catalogLimits, limits); await down(); await flushTelemetry(); }
}
/** Validated rows read while nothing is slow, so a loaded test machine cannot time this read out. */
async function primed(f: { catalog(): DesktopCatalog }) {
  const firstMs = catalogLimits.firstMs; catalogLimits.firstMs = 10000;
  const catalog = f.catalog(); await catalog.refresh(true); catalogLimits.firstMs = firstMs; return catalog;
}
const slugs = (value: { models: Array<{ slug?: unknown }> }) => value.models.map(model => model.slug);

test("opening a chat uses the saved rows when the host is slow or down; a start stays strict", { timeout: 30000 }, () => host(async f => {
  const since = Date.now(), catalog = await primed(f);
  f.answer("hang");
  assert.deepEqual(slugs(await catalog.refresh(true, true)), ["claude/model"]);
  assert.equal(f.requests(), 1, "opening does not wait for the longer try");
  catalogLimits.retryMs = 150;
  await assert.rejects(catalog.refresh(true), unavailable);
  await f.down();
  assert.deepEqual(slugs(await catalog.refresh(true, true)), ["claude/model"]);
  await assert.rejects(catalog.refresh(true), unavailable);
  const restarted = f.catalog();
  assert.deepEqual(slugs(await restarted.refresh(true, true)), ["claude/model"], "a new adapter restores the validated rows");
  await flushTelemetry();
  const events = (await readTelemetry(f.stateDirectory, since)).filter(event => event.event === "catalog_read_failed").map(event => [event.reason, event.outcome]);
  assert.deepEqual(events, [["timeout", "saved"], ["timeout", "retrying"], ["timeout", "unavailable"], ["unreachable", "saved"], ["unreachable", "unavailable"], ["unreachable", "saved"]]);
}));

test("a start waits once more for a slow host and then proceeds", { timeout: 30000 }, () => host(async f => {
  const catalog = f.catalog(); catalogLimits.retryMs = 10000;
  f.answer(["hang", "ok"]);
  assert.deepEqual(slugs(await catalog.refresh(true)), ["claude/model"]);
  assert.equal(f.requests(), 2);
}));

test("opening still refuses without validated rows, and when the host answers with a refusal or invalid rows", { timeout: 30000 }, () => host(async f => {
  catalogLimits.retryMs = 150; f.answer("hang");
  await assert.rejects(f.catalog().refresh(true, true), unavailable, "configured aliases alone are not proof the host serves them");
  catalogLimits.firstMs = 10000; f.answer("ok");
  const catalog = await primed(f);
  for (const refused of ["error", "invalid"] as const) { f.answer(refused); await assert.rejects(catalog.refresh(true, true), unavailable); assert.equal(f.requests(), 1, "a refusal is not retried"); }
}));
