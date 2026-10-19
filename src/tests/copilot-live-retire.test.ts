import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatewayToken, validateConfig, type GatewayConfig } from "../config.js";
import { createGatewayHandler, startGateway } from "../server.js";
import { CopilotSubscription, retireUnconfiguredCopilotScopes } from "../providers/copilot.js";
import type { Provider } from "../providers/provider.js";
import { adapter, alive, harness, live, providerId, registeredScopes, sleep, turn, until, user, type Harness } from "./copilot-live-harness.js";

// A provider that a configuration no longer serves must not keep a live session, which holds a CLI process and the
// conversation log: whether the configuration is reloaded while the session is still starting, or an in-place upgrade
// adopts a session the new release's configuration does not serve.
const provider = () => ({ id: providerId, type: "copilot-subscription", models: { alias: "fixture" } });
const other = { id: "other", type: "claude-subscription", models: { other: "x" } };
const config = (h: Harness, providers: unknown[]): GatewayConfig => validateConfig({ version: 1, port: 0, stateDirectory: join(h.directory, "state"), providers });
const factory = (p: { type: string }) => p.type === "copilot-subscription" ? new CopilotSubscription(p as ConstructorParameters<typeof CopilotSubscription>[0]) : {} as Provider;

test("a provider removed while its live session is still starting loses that session when the request it started ends", { timeout: 30000 }, async () => {
  // The CLI answers session.create only when the test lets it, so the attach is in progress for exactly as long as the test needs.
  const h = await harness(); const gate = join(h.directory, "create-gate"); process.env.GATEWAY_COPILOT_LIVE_CREATE_GATE = gate;
  let next = config(h, [provider(), other]);
  const server = await startGateway(next, factory, async () => next, { onFailure: () => {}, copilotTempBase: h.scratch });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${await gatewayToken(join(h.directory, "state"))}`, "Content-Type": "application/json", "thread-id": "thread-1" };
    const answered = fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hello", stream: true }) }).then(response => response.text());
    // The CLI has started and is slow to create its session: the attach is in progress, and no session is registered yet.
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "create")));
    assert.equal(live().sessions().length, 0, "the session is not registered yet");
    next = config(h, [other]); await fetch(`${url}/health`); await writeFile(gate, "x");
    assert.match(await answered, /answer/, "the request that was already running is still answered");
    const [pid] = await h.pids();
    assert.ok(await until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0), "the session is gone once its request has ended, though its provider was removed while it started");
    assert.deepEqual((await h.sessions()).filter(entry => entry.outcome === "closed").map(entry => entry.missReason), ["provider_removed"]);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await h.restore(); }
});

test("a gateway generation that starts with a configuration which no longer serves a session's provider retires it", { timeout: 30000 }, async () => {
  const h = await harness();
  const first = config(h, [provider(), other]);
  const server = await startGateway(first, factory, undefined, { onFailure: () => {}, copilotTempBase: h.scratch });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${await gatewayToken(join(h.directory, "state"))}`, "Content-Type": "application/json", "thread-id": "thread-1" };
    await (await fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hello", stream: true }) })).text();
    assert.equal(live().sessions().length, 1); const [pid] = await h.pids();
    // An upgrade whose configuration still serves the provider keeps the session it adopts.
    await createGatewayHandler(config(h, [provider(), other]), factory, undefined, { copilotTempBase: h.scratch });
    await sleep(300); assert.equal(live().sessions().length, 1); assert.ok(alive(pid), "the session lives on");
    // One whose configuration does not serve it ends it, though it was never reloaded.
    await createGatewayHandler(config(h, [other]), factory, undefined, { copilotTempBase: h.scratch });
    assert.ok(await until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0), "the adopted session of a removed provider is closed");
    assert.deepEqual((await h.sessions()).filter(entry => entry.outcome === "closed").map(entry => entry.missReason), ["provider_removed"]);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await h.restore(); }
});

// A session that is reseeded in place gets a new process for the same thread. The one it replaces ends while the new one is
// being placed, and its end must not take the thread's provider scope with it: without a scope no reload retires the session.
const outcomesOf = async (h: Harness) => (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));

test("a session reseeded in place is still retired by a reload that no longer serves its provider", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    await turn(provider, [user("hello")]);
    // Unrelated input: the history does not extend what the session holds, so the thread starts over in a new process.
    await turn(provider, [user("something else entirely")]);
    assert.ok((await outcomesOf(h)).some(outcome => outcome.startsWith("reseeded")), (await outcomesOf(h)).join(","));
    assert.equal(live().sessions().length, 1); const pid = (await h.pids()).at(-1)!;
    assert.deepEqual([...registeredScopes().values()], [`${providerId}\0`], "the reseeded session has its provider scope");
    retireUnconfiguredCopilotScopes([]);
    assert.ok(await until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0), "the reseeded session was retired");
    assert.ok((await outcomesOf(h)).includes("closed:provider_removed"), (await outcomesOf(h)).join(","));
  } finally { await h.restore(); }
});

test("a reload that arrives while a reseeded session is still starting retires it when its request ends", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    await turn(provider, [user("hello")]);
    process.env.GATEWAY_COPILOT_LIVE_SLOW_CREATE = "800";
    const answered = turn(provider, [user("something else entirely")]);
    // The old session is gone and the new process has not answered session.create: the attach is starting it.
    assert.ok(await until(async () => (await h.log()).filter(entry => entry.op === "create").length === 2));
    assert.equal(live().sessions().length, 0, "the new session is not registered yet");
    retireUnconfiguredCopilotScopes([]);
    assert.match((await answered).text, /^answer/, "the request that was already running is still answered");
    const pid = (await h.pids()).at(-1)!;
    assert.ok(await until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0), "its session is gone once the request ended");
    assert.ok((await outcomesOf(h)).includes("closed:provider_removed"), (await outcomesOf(h)).join(","));
  } finally { await h.restore(); }
});

test("an attach that falls back to the one-shot path leaves no provider scope behind", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    // One slot, and a running session is never evicted: the second thread cannot get one.
    const provider = adapter({ mode: "live", max: 1 }); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller, context: { threadId: "busy" } }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    assert.match((await turn(provider, [user("hello")], { context: { threadId: "other" } })).text, /^answer/, "the second thread is served one-shot");
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "capacity"), "it fell back for want of a slot");
    assert.equal(registeredScopes().size, 1, "only the session that exists has a scope");
    controller.abort(); await running;
  } finally { await h.restore(); }
});
