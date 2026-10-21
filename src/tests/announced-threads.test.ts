import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureTelemetry, flushTelemetry } from "../telemetry.js";
import { TurnTelemetry } from "../turn-telemetry.js";
import { AnnouncedThreads, describeChat } from "../announced-threads.js";
import { legacyGatewayProvider } from "../chat-identity.js";
import type { Message } from "../app-server-connection.js";

const started = (id: string, model: unknown, modelProvider?: unknown, source?: unknown): Message =>
  ({ method: "thread/started", params: { thread: { id, ...(model === undefined ? {} : { model }), ...(modelProvider === undefined ? {} : { modelProvider }), ...(source === undefined ? {} : { source }) } } });
const spawned = (id: string, model: string): Message => started(id, model, legacyGatewayProvider, { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } });

test("an announced gateway sub-agent reports its engine, model and saved identity", () => {
  const announced = new AnnouncedThreads();
  announced.observe(spawned("sub-agent", "gpt-5.6-terra"), "gateway");
  assert.deepEqual(announced.describe("sub-agent"), { provider: "gateway", model: "gpt-5.6-terra", identity: "legacy" });
  // The native identity is reported as such, and a native chat reports none.
  announced.observe(started("native-identity-chat", "gpt-5.6-terra", "openai"), "gateway");
  assert.deepEqual(announced.describe("native-identity-chat"), { provider: "gateway", model: "gpt-5.6-terra", identity: "openai" });
  announced.observe(started("native-chat", "gpt-5.1-codex"), "native");
  assert.deepEqual(announced.describe("native-chat"), { provider: "native", model: "gpt-5.1-codex" });
  assert.ok(!("identity" in announced.describe("native-chat")));
  assert.deepEqual(announced.describe("unannounced"), {});
});

test("applied settings report a known chat's model, never describing or refreshing one", () => {
  const announced = new AnnouncedThreads();
  announced.observe(spawned("sub-agent", "gpt-5.6-terra"), "gateway");
  announced.observe({ method: "thread/settings/updated", params: { threadId: "sub-agent", threadSettings: { model: "gpt-5.1" } } }, "gateway");
  assert.deepEqual(announced.describe("sub-agent"), { provider: "gateway", model: "gpt-5.1", identity: "legacy" });
  announced.observe({ method: "thread/settings/updated", params: { threadId: "other", threadSettings: { model: "gpt-5.1" } } }, "gateway");
  assert.deepEqual(announced.describe("other"), {});
  // Only a re-announcement refreshes recency, so a chat that merely reported settings still ages out on schedule.
  const bounded = new AnnouncedThreads(2);
  for (const id of ["a", "b"]) bounded.observe(spawned(id, "gpt-5.6-terra"), "gateway");
  bounded.observe({ method: "thread/settings/updated", params: { threadId: "a", threadSettings: { model: "gpt-5.1" } } }, "gateway");
  bounded.observe(spawned("c", "gpt-5.6-terra"), "gateway");
  assert.deepEqual(bounded.describe("a"), {}, "the settings report did not move a to the newest");
  assert.equal(bounded.describe("b").model, "gpt-5.6-terra");
});

test("a closed chat is forgotten", () => {
  const announced = new AnnouncedThreads();
  announced.observe(spawned("sub-agent", "gpt-5.6-terra"), "gateway");
  announced.observe({ method: "thread/closed", params: { threadId: "sub-agent" } }, "gateway");
  assert.deepEqual(announced.describe("sub-agent"), {});
});

test("announced metadata is bounded, and an announcement refreshes recency", () => {
  const announced = new AnnouncedThreads(2);
  for (const id of ["a", "b"]) announced.observe(spawned(id, "gpt-5.6-terra"), "gateway");
  announced.observe(spawned("c", "gpt-5.6-terra"), "gateway");
  assert.deepEqual(announced.describe("a"), {}, "the chat announced longest ago is gone");
  assert.ok(Object.keys(announced.describe("b")).length && Object.keys(announced.describe("c")).length);
  announced.observe(spawned("b", "gpt-5.6-terra"), "gateway");
  announced.observe(spawned("d", "gpt-5.6-terra"), "gateway");
  assert.deepEqual(announced.describe("c"), {}, "re-announcing b left c as the oldest");
  assert.ok(Object.keys(announced.describe("b")).length && Object.keys(announced.describe("d")).length);
});

test("malformed announcements are ignored without throwing", () => {
  const announced = new AnnouncedThreads();
  assert.doesNotThrow(() => {
    announced.observe({}, "gateway");
    announced.observe({ method: 7 }, "gateway");
    announced.observe({ method: "thread/started" }, "gateway");
    announced.observe({ method: "thread/started", params: { thread: { id: "", model: "gpt-5.6-terra" } } }, "gateway");
    announced.observe({ method: "thread/started", params: { thread: "not an object" } }, "gateway");
    announced.observe(started("no-engine", "gpt-5.6-terra"));
    announced.observe(started("numbered-model", 5), "gateway");
    announced.observe(started("empty-model", ""), "gateway");
    announced.observe({ method: "thread/settings/updated" }, "gateway");
    announced.observe({ method: "thread/settings/updated", params: { threadId: "empty-model", threadSettings: { model: 5 } } }, "gateway");
    announced.observe({ method: "thread/closed" }, "gateway");
  });
  // A start the adapter saw without an engine label still announced a chat, so its model is kept without a provider.
  assert.deepEqual(announced.describe("no-engine"), { model: "gpt-5.6-terra" });
  assert.ok(!("provider" in announced.describe("no-engine")) && !("identity" in announced.describe("no-engine")));
  assert.deepEqual(announced.describe("numbered-model"), { provider: "gateway" }, "a model that is not text is left out");
  assert.deepEqual(announced.describe("empty-model"), { provider: "gateway" });
});

test("a route always wins over announced metadata", () => {
  const announced = new AnnouncedThreads();
  announced.observe(spawned("sub-agent", "gpt-5.6-terra"), "gateway");
  assert.deepEqual(describeChat({ provider: "native", model: "gpt-5.1-codex" }, announced, "sub-agent"), { provider: "native", model: "gpt-5.1-codex" });
  assert.deepEqual(describeChat({}, announced, "sub-agent"), { provider: "gateway", model: "gpt-5.6-terra", identity: "legacy" });
  assert.deepEqual(describeChat(undefined, announced, "sub-agent"), { provider: "gateway", model: "gpt-5.6-terra", identity: "legacy" });
  assert.deepEqual(describeChat(undefined, announced, "unannounced"), {});
});

test("a described copy cannot change what was announced", () => {
  const announced = new AnnouncedThreads();
  announced.observe(spawned("sub-agent", "gpt-5.6-terra"), "gateway");
  const copy = announced.describe("sub-agent");
  copy.model = "other"; copy.provider = "native"; delete copy.identity;
  assert.deepEqual(announced.describe("sub-agent"), { provider: "gateway", model: "gpt-5.6-terra", identity: "legacy" });
});

test("an announced chat's turns log its engine and model instead of unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-announced-"));
  try {
    configureTelemetry(directory, "adapter");
    const announced = new AnnouncedThreads();
    const turns = new TurnTelemetry(threadId => describeChat({}, announced, threadId));
    announced.observe(spawned("sub-agent", "gpt-5.6-terra"), "gateway");
    turns.observe({ method: "turn/started", params: { threadId: "sub-agent", turn: { id: "t1" } } });
    turns.observe({ method: "item/completed", params: { threadId: "sub-agent", turnId: "t1", item: { type: "agentMessage" } } });
    turns.observe({ method: "turn/completed", params: { threadId: "sub-agent", turn: { id: "t1", status: "completed" } } });
    turns.close();
    await flushTelemetry();
    const files = await readdir(join(directory, "telemetry")); assert.equal(files.length, 1);
    const events = (await readFile(join(directory, "telemetry", files[0]), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(events.map(event => event.event), ["turn_started", "turn_completed"]);
    for (const event of events) assert.deepEqual([event.provider, event.model, event.identity], ["gateway", "gpt-5.6-terra", "legacy"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
