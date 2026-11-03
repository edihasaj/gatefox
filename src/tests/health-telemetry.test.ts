import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseHealthEvent, readHealthTelemetry, summarizeHealthEvents, telemetryFileNames, unavailableCode, watchedFields, type HealthEvent } from "../health-telemetry.js";

const at = Date.parse("2026-10-16T09:00:00.000Z");
const stamp = (msOffset: number) => new Date(at + msOffset).toISOString();
const minutes = (count: number) => count * 60_000;
/** A parsed event row directly, without the file round trip. */
const row = (extra: Record<string, unknown> & { event: string }, msOffset = 0): HealthEvent =>
  ({ ...extra, at: at + msOffset }) as unknown as HealthEvent;

test("a telemetry line keeps only the watched fields", () => {
  const parsed = parseHealthEvent(JSON.stringify({ at: stamp(0), event: "rpc_error", method: "turn/start", code: unavailableCode,
    path: "/secret/home", argv: ["--token", "hunter2"], message: "upstream said no" }));
  assert.deepEqual(parsed, { event: "rpc_error", method: "turn/start", code: unavailableCode, at });
  assert.equal(JSON.stringify(parsed).includes("hunter2"), false);
  assert.equal(JSON.stringify(parsed).includes("upstream said no"), false);
  // The judgement reads the fixed `rejection` vocabulary, never a free-text `reason`.
  assert.ok(watchedFields.includes("rejection"));
  assert.equal(watchedFields.includes("reason" as never), false);
  const shaped = parseHealthEvent(JSON.stringify({ at: stamp(0), event: "rpc_error", method: "thread/start", code: unavailableCode, errorClass: "RouteUnavailable", rejection: "other", reason: "a whole sentence about why" }));
  assert.deepEqual(shaped, { event: "rpc_error", at, method: "thread/start", code: unavailableCode, errorClass: "RouteUnavailable", rejection: "other" });
});

test("malformed, foreign, and torn lines read as nothing", () => {
  assert.equal(parseHealthEvent(""), undefined);
  assert.equal(parseHealthEvent("not json"), undefined);
  assert.equal(parseHealthEvent('{"at":"2026-10-16T09:00:00Z"}'), undefined);
  assert.equal(parseHealthEvent('{"at":"2026-10-16T09:00:00Z","event":"Evil! Event"}'), undefined);
  assert.equal(parseHealthEvent('{"event":"rpc_error"}'), undefined);
  assert.equal(parseHealthEvent('{"at":"nope","event":"rpc_error"}'), undefined);
  assert.equal(parseHealthEvent("[1,2,3]"), undefined);
  assert.equal(parseHealthEvent('"a string"'), undefined);
});

test("long field values are cut and numbers survive", () => {
  const parsed = parseHealthEvent(JSON.stringify({ at: stamp(0), event: "component_exit", kind: "n".repeat(300), pid: 402 }));
  assert.equal(parsed?.kind?.length, 128);
  assert.equal(parsed?.event, "component_exit");
});

test("counts cover hosts, exits, refusals, retries, and sharing", () => {
  const signals = summarizeHealthEvents([
    row({ event: "execution_host_failed" }), row({ event: "execution_host_failed" }),
    row({ event: "component_exit", kind: "native" }), row({ event: "component_exit", kind: "native" }), row({ event: "component_exit" }),
    row({ event: "rpc_error", method: "turn/start", code: unavailableCode, errorClass: "RouteUnavailable", rejection: "adapter_routing" }),
    row({ event: "rpc_error", method: "thread/resume", code: -32603, errorClass: "AdapterRefused", rejection: "other" }),
    row({ event: "rpc_error", method: "other/method", code: unavailableCode, errorClass: "RouteUnavailable", rejection: "adapter_routing" }),
    row({ event: "rpc_error", method: "thread/start", code: -32600, errorClass: "BadRequest", rejection: "invalid_params" }),
    row({ event: "gateway_features_trimmed", site: "startup" }),
    row({ event: "gateway_features_trimmed", site: "retry" }),
    row({ event: "native_sharing_unavailable" }), row({ event: "native_sharing_unavailable" }), row({ event: "native_sharing_fallback" }),
  ]);
  assert.equal(signals.hostFailures, 2);
  assert.deepEqual(signals.exits, { native: 2, unknown: 1 });
  assert.equal(signals.nativeExited, true);
  assert.deepEqual(signals.rpcErrors, { "turn/start": 1, "thread/resume": 1 });
  assert.equal(signals.refusals, 2);
  assert.equal(signals.featureRetries, 1);
  assert.deepEqual(signals.nativeSharing, ["native_sharing_unavailable", "native_sharing_fallback"]);
});

test("only all four session methods count as refusals", () => {
  for (const method of ["thread/start", "thread/resume", "thread/fork", "turn/start"]) {
    assert.equal(summarizeHealthEvents([row({ event: "rpc_error", method, code: unavailableCode })]).rpcErrors[method], 1);
  }
  assert.equal(summarizeHealthEvents([row({ event: "rpc_error", method: "turn/completed", rejection: "other" })]).rpcErrors["turn/completed"], undefined);
  // A rejection outside the fixed vocabulary is not a session-stopping refusal, and free text never is.
  assert.deepEqual(summarizeHealthEvents([row({ event: "rpc_error", method: "turn/start", rejection: "timeout" })]).rpcErrors, {});
  assert.deepEqual(summarizeHealthEvents([row({ event: "rpc_error", method: "turn/start", reason: "other" as never })]).rpcErrors, {});
  // The two ways a session refusal is recognised, counted together.
  assert.equal(summarizeHealthEvents([
    row({ event: "rpc_error", method: "turn/start", code: unavailableCode }),
    row({ event: "rpc_error", method: "thread/fork", code: -32002, rejection: "other" }),
  ]).refusals, 2);
});

test("a retry followed by a refusal is the config failure worth naming", () => {
  const events = [row({ event: "gateway_features_trimmed", site: "retry" }, minutes(2)), row({ event: "rpc_error", method: "turn/start", code: unavailableCode }, minutes(3))];
  const now = at + minutes(4);
  assert.equal(summarizeHealthEvents(events, { now }).retriedThenRefused, 1);
  // The same refusal after the service came back is no longer ongoing, so it is no longer the config failure either.
  assert.equal(summarizeHealthEvents(events, { now: at + minutes(20) }).retriedThenRefused, 0);
  assert.equal(summarizeHealthEvents(events, { now, markers: [at + minutes(3.5)] }).retriedThenRefused, 0);
  // A refusal that came first is unrelated to the retry, whatever order the file lists them in.
  const before = [row({ event: "gateway_features_trimmed", site: "retry" }, minutes(5)), row({ event: "rpc_error", method: "turn/start", code: unavailableCode }, minutes(3))];
  assert.equal(summarizeHealthEvents(before, { now }).retriedThenRefused, 0);
  assert.equal(summarizeHealthEvents(before.reverse(), { now }).retriedThenRefused, 0);
  assert.equal(summarizeHealthEvents([row({ event: "gateway_features_trimmed", site: "retry" })], { now }).retriedThenRefused, 0);
});

test("the window's files are named by UTC day, today and the one before", () => {
  assert.deepEqual(telemetryFileNames(Date.parse("2026-10-16T13:00:00Z")), ["events-2026-10-16.jsonl"]);
  // Fifteen minutes back crosses midnight UTC, so both files are read.
  assert.deepEqual(telemetryFileNames(Date.parse("2026-10-16T00:05:00Z")), ["events-2026-10-16.jsonl", "events-2026-10-15.jsonl"]);
});

test("the reader takes both files and drops lines outside the window", async () => {
  // Just past UTC midnight, so the 15-minute window reaches into yesterday's file.
  const nowMs = Date.parse("2026-10-16T00:05:00Z");
  const wanted = join("/state", "telemetry");
  const today = "events-2026-10-16.jsonl";
  const yesterday = "events-2026-10-15.jsonl";
  const line = (msOffset: number) => JSON.stringify({ event: "execution_host_failed", at: new Date(nowMs + msOffset).toISOString() });
  const files: Record<string, string> = {
    [join(wanted, today)]: [line(-minutes(2)), "torn{", "", line(-minutes(600))].join("\n"),
    [join(wanted, yesterday)]: [line(-minutes(10)), "garbage"].join("\n"),
  };
  const read: string[] = [];
  const rows = await readHealthTelemetry("/state", { now: () => nowMs, readFile: async path => { read.push(path); return files[path] ?? ""; } });
  assert.deepEqual(read.sort(), [join(wanted, today), join(wanted, yesterday)].sort());
  assert.equal(rows.length, 2);
  assert.deepEqual(summarizeHealthEvents(rows).hostFailures, 2);
});

test("unreadable telemetry is quiet, not a failure", async () => {
  const rows = await readHealthTelemetry("/state", { now: () => at, readFile: async () => "" });
  assert.deepEqual(rows, []);
});

test("newer-adapter refusals fail health until a real service move answers them", () => {
  const now = Date.now();
  const refused = { event: "release_skew_refused", direction: "adapter_newer", count: 16, at: now - 60_000 } as HealthEvent;
  assert.equal(summarizeHealthEvents([refused], { now }).skewRefusals, 16);
  assert.equal(summarizeHealthEvents([refused, { event: "self_upgrade", component: "service", mode: "live", at: now - 30_000 } as HealthEvent], { now }).skewRefusals, 16);
  assert.equal(summarizeHealthEvents([refused, { event: "self_upgrade", component: "service", mode: "skew", at: now - 30_000 } as HealthEvent], { now }).skewRefusals, 0);
  const parsed = parseHealthEvent(JSON.stringify({ at: new Date(now).toISOString(), event: "release_skew_refused", direction: "adapter_newer", count: 3 }));
  assert.deepEqual([parsed?.direction, parsed?.count], ["adapter_newer", 3]);
});
