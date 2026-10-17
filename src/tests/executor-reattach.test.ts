import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChatLoads, ReattachError, Reattacher, setHostDownWindowForTests } from "../executor-reattach.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { Message } from "../app-server-connection.js";

/** These tests hold no sockets: they check the load replay and the re-attach bookkeeping in this process only. */

test("a replayed resume omits what the SDK restores and strips the config keys that would block that restore", () => {
  const loads = new ChatLoads();
  loads.remember("chat", { threadId: "chat", model: "claude/a", modelProvider: "openai", serviceTier: "priority", cwd: "/work",
    runtimeWorkspaceRoots: ["/work"], approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only",
    permissions: { id: "p" }, config: { model: "claude/a", model_provider: "openai", model_reasoning_effort: "low", approval_policy: "never",
      approvals_reviewer: "user", sandbox_mode: "read-only", default_permissions: "p", model_catalog_json: "/c.json", web_search: "disabled" },
    baseInstructions: "b", developerInstructions: "d", personality: "friendly", input: [{ type: "text", text: "turn content never replays" }] } as Message);
  const resume = loads.resumeParams("chat");
  assert.deepEqual(Object.keys(resume).sort(), ["baseInstructions", "config", "cwd", "developerInstructions", "excludeTurns", "personality",
    "runtimeWorkspaceRoots", "serviceTier", "threadId"], "no model, provider, approvals, sandbox or permissions replay");
  assert.deepEqual(resume.config, { model_catalog_json: "/c.json", web_search: "disabled" }, "the config keeps only keys that gate nothing");
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.serviceTier, "priority");
});

test("an unknown chat re-attaches with its saved settings alone", () => {
  assert.deepEqual(new ChatLoads().resumeParams("sub-agent"), { threadId: "sub-agent", excludeTurns: true });
});

test("the load store holds 512 chats and evicts the oldest first", () => {
  const loads = new ChatLoads();
  for (let index = 0; index <= 513; index++) loads.remember(`chat-${index}`, { threadId: `chat-${index}`, cwd: `/w/${index}` } as Message);
  assert.deepEqual(loads.resumeParams("chat-0"), { threadId: "chat-0", excludeTurns: true }, "the evicted chat re-attaches from its saved settings");
  assert.deepEqual(loads.resumeParams("chat-1"), { threadId: "chat-1", excludeTurns: true });
  assert.deepEqual(loads.resumeParams("chat-2"), { threadId: "chat-2", cwd: "/w/2", excludeTurns: true }, "the kept set starts at chat-2");
  assert.deepEqual(loads.resumeParams("chat-513"), { threadId: "chat-513", cwd: "/w/513", excludeTurns: true });
});

test("a chat a connection never loaded keeps its saved settings, and remembering replaces its old parameters", () => {
  const loads = new ChatLoads();
  loads.remember("chat", { cwd: "/first", model: "claude/old" } as Message);
  loads.remember("chat", { cwd: "/second" } as Message);
  assert.deepEqual(loads.resumeParams("chat"), { threadId: "chat", cwd: "/second", excludeTurns: true });
  loads.forget("chat");
  assert.deepEqual(loads.resumeParams("chat"), { threadId: "chat", excludeTurns: true });
});

test("requests that find a running re-attach share it, and one flight records once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-reattach-unit-"));
  configureTelemetry(directory, "test");
  try {
    const reattacher = new Reattacher();
    let attempts = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const flight = async () => { attempts++; await gate; };
    const first = reattacher.join("chat", "engine_closed", flight);
    const second = reattacher.join("chat", "engine_closed", flight);
    release();
    await Promise.all([first, second]);
    assert.equal(attempts, 1, "the chat was resumed once, and the flight is claimed before anything is awaited");
    await flushTelemetry();
    assert.deepEqual((await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "executor_reattached")
      .map(event => [event.reason, event.requests]), [["engine_closed", 2]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed host lookup makes later attempts fail fast for its window, and records once per window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-reattach-unit-"));
  configureTelemetry(directory, "test");
  setHostDownWindowForTests(400);
  try {
    const reattacher = new Reattacher();
    let attempts = 0;
    const down = async () => { attempts++; throw new ReattachError("host_unavailable"); };
    await assert.rejects(reattacher.join("a", "engine_closed", down), ReattachError);
    const at = Date.now();
    await assert.rejects(reattacher.join("b", "engine_closed", down), ReattachError);
    assert.ok(Date.now() - at < 250, "inside the window an attempt neither kicks the host nor waits it out");
    assert.equal(attempts, 1, "the refused attempt never reached the host lookup");
    await delay(420);
    await assert.rejects(reattacher.join("c", "engine_closed", down), ReattachError);
    assert.equal(attempts, 2, "after the window a new attempt looks for the host again");
    await flushTelemetry();
    const events = (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "executor_reattach_failed");
    assert.deepEqual(events.map(event => [event.reason, event.requests]), [["host_unavailable", 1], ["host_unavailable", 1]],
      "one host_unavailable record per window, whatever the number of refused requests");
  } finally { setHostDownWindowForTests(); await rm(directory, { recursive: true, force: true }); }
});

test("flights that were already running when the host lookup failed record host_unavailable once between them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-reattach-unit-"));
  configureTelemetry(directory, "test");
  setHostDownWindowForTests(400);
  try {
    const reattacher = new Reattacher();
    const down = async () => { await delay(20); throw new ReattachError("host_unavailable"); };
    await Promise.all(["a", "b", "c"].map(id => assert.rejects(reattacher.join(id, "engine_closed", down), ReattachError)));
    await flushTelemetry();
    const events = (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "executor_reattach_failed");
    assert.equal(events.length, 1, "three chats that waited on the same dead host log it once, not three times");
  } finally { setHostDownWindowForTests(); await rm(directory, { recursive: true, force: true }); }
});

test("an executor that refuses the resume records resume_failed and opens no fail-fast window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-reattach-unit-"));
  configureTelemetry(directory, "test");
  setHostDownWindowForTests(400);
  try {
    const reattacher = new Reattacher();
    let attempts = 0;
    await assert.rejects(reattacher.join("a", "engine_closed", async () => { throw new ReattachError("resume_failed"); }), ReattachError);
    await assert.rejects(reattacher.join("b", "engine_closed", async () => { attempts++; throw new ReattachError("resume_failed"); }), ReattachError);
    assert.equal(attempts, 1, "a refused resume is the chat's own problem: the next request reaches the host right away");
    await flushTelemetry();
    const events = (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "executor_reattach_failed");
    assert.deepEqual(events.map(event => event.reason), ["resume_failed", "resume_failed"]);
  } finally { setHostDownWindowForTests(); await rm(directory, { recursive: true, force: true }); }
});
