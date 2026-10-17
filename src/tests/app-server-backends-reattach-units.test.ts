import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import type { Message } from "../app-server-connection.js";
import type { NativeRpcConnection } from "../shared-native-connection.js";
import type { GatewayConfig } from "../config.js";
import { ReattachError, setHostDownWindowForTests } from "../executor-reattach.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

/**
 * The socket-free half of the re-attach tests. The behaviour these three rules need is bookkeeping inside this process, so
 * they are checked with a fake host lookup and a stubbed native connection: no host, no executor process, no socket. The
 * host and executor itself is the subject of `app-server-backends-reattach.test.ts`.
 */
/**
 * An adapter whose host lookups are fakes: no host, no executor process, no socket, nothing but this process. It checks the
 * rules the re-attach path depends on that no executor can be watched from: one discovery per dead host connection, a
 * flight claimed before anything is awaited, and an unload that never wakes a host.
 */
type HostStub = { closed: boolean; close?: () => void };
interface UnitAdapter {
  pool: () => Promise<HostStub | undefined>;
  reattach: (threadId: string, engine: unknown) => Promise<void>;
  poolClient?: HostStub;
  poolPending?: Promise<HostStub | undefined>;
  reattacher: { flights: Map<string, unknown>; hostDownUntil: number };
  gateway: () => Promise<unknown>;
  owner: (threadId: string) => Promise<unknown>;
  bindings: Map<string, unknown>;
  loads: { remember(threadId: string, params: Message): void; resumeParams(threadId: string): Message };
  ephemeralThreads: { has(threadId: string): boolean };
}
async function unitAdapter() {
  const directory = await mkdtemp(join(tmpdir(), "gw-reattach-unit-"));
  const configPath = join(directory, "gateway.json");
  const stateDirectory = join(directory, "state");
  configureTelemetry(stateDirectory, "test");
  const snapshot = () => ({ revision: "1".repeat(64), models: [] as Message[] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  const native: NativeRpcConnection = { closed: false, exited: Promise.resolve({ code: 0, signal: null }), drained: Promise.resolve(), request: async () => ({}), send: () => {}, stop: () => {} };
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory, providers: [], clientOnly: true };
  const backends = new AppServerBackends("/fixture/codex", ["app-server"], config, {}, {}, catalog, async () => {}, () => {}, configPath, () => native);
  return { directory, stateDirectory, backends, internals: backends as unknown as UnitAdapter };
}
const unitTelemetry = async (directory: string, name: string) => {
  await flushTelemetry();
  return (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === name);
};

test("chats whose host connection died together wake exactly one discovery", async () => {
  const { directory, stateDirectory, backends, internals } = await unitAdapter();
  const discoverAll = ExecutionHostClient.discover;
  let discovers = 0;
  const stale: HostStub = { closed: true }; const live: HostStub = { closed: false };
  ExecutionHostClient.discover = async () => { discovers++; return (discovers === 1 ? stale : live) as unknown as ExecutionHostClient; };
  try {
    await internals.pool(); // The connection from before the restart: it is settled, and it is closed.
    assert.equal(discovers, 1);
    const clients = await Promise.all([internals.pool(), internals.pool(), internals.pool()]);
    assert.equal(discovers, 2, "one discovery for the dead connection, not one per waiting chat");
    assert.deepEqual(clients, [live, live, live], "every caller got the connection the one discovery found");
    assert.equal(internals.poolClient, live);
  } finally {
    ExecutionHostClient.discover = discoverAll; await backends.stop(); await rm(directory, { recursive: true, force: true });
  }
});

test("a re-attach claims its flight before it awaits a host lookup", async () => {
  const { directory, stateDirectory, backends, internals } = await unitAdapter();
  let resumes = 0;
  const host: HostStub = { closed: false };
  const engine = { connection: { closed: false }, threads: new Set<string>(), active: new Map<string, string>(), requests: 0, shared: true };
  const closedEngine = { connection: { closed: true }, threads: new Set<string>(), active: new Map<string, string>(), requests: 0, shared: true };
  internals.owner = async () => engine;
  backends.request = async (method: string) => { if (method === "thread/resume") { resumes++; await delay(20); } return {}; };
  internals.poolClient = host;
  internals.poolPending = new Promise<HostStub>(resolveHost => setTimeout(() => resolveHost(host), 200)); // A lookup this adapter is still waiting on.
  try {
    const first = internals.reattach("chat", closedEngine);
    assert.equal(internals.reattacher.flights.has("chat"), true, "the flight is claimed with nothing awaited");
    const second = internals.reattach("chat", closedEngine);
    await Promise.all([first, second]);
    assert.equal(resumes, 1, "the second request joined the running flight instead of resuming the chat again");
    assert.deepEqual((await unitTelemetry(stateDirectory, "executor_reattached")).map(event => [event.reason, event.requests]),
      [["generation_retired", 2]], "the reason is read from the state this connection holds, and both requests share the record");
  } finally { await backends.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("unsubscribing a chat whose executor is gone is answered here, without waking a host", async () => {
  const { directory, backends, internals } = await unitAdapter();
  const discoverAll = ExecutionHostClient.discover;
  let discovers = 0; let forwards = 0;
  ExecutionHostClient.discover = async () => { discovers++; return undefined; };
  const engine = { connection: { closed: true, request: async () => { forwards++; return {}; } }, threads: new Set(["chat"]), active: new Map(), requests: 0, shared: true };
  internals.bindings.set("chat", engine);
  internals.loads.remember("chat", { cwd: "/work" });
  try {
    assert.deepEqual(await backends.request("thread/unsubscribe", { threadId: "chat" }), { status: "notLoaded" });
    assert.equal(discovers, 0, "unloading a chat asks nothing of a host");
    assert.equal(forwards, 0, "nothing was resumed to be unloaded");
    assert.equal(internals.bindings.has("chat"), false, "the chat's records are cleared");
    assert.equal(engine.threads.has("chat"), false);
    assert.deepEqual(internals.loads.resumeParams("chat"), { threadId: "chat", excludeTurns: true });
  } finally {
    ExecutionHostClient.discover = discoverAll; await backends.stop(); await rm(directory, { recursive: true, force: true });
  }
});

test("stopping while a caller waits in pool() leaves no host connection open, even if the host is reachable right after the abort", async () => {
  const { directory, backends, internals } = await unitAdapter();
  const discoverAll = ExecutionHostClient.discover;
  const opened: HostStub[] = [];
  let discovers = 0;
  ExecutionHostClient.discover = async (...ask: Parameters<typeof ExecutionHostClient.discover>) => {
    discovers++;
    if (discovers === 1) { // The host is down: the first lookup fails when stop() aborts it.
      await new Promise<void>(resolveWait => ask[5]!.addEventListener("abort", () => resolveWait()));
      throw Object.assign(new Error("Shared gateway executor host is unavailable"), { code: -32001 });
    }
    // The host is reachable by the time anyone looks again.
    const client: HostStub = { closed: false, close() { this.closed = true; } }; opened.push(client);
    return client as unknown as ExecutionHostClient;
  };
  (backends as unknown as { sharedGateway: boolean }).sharedGateway = true;
  try {
    const first = internals.pool().then(() => undefined, (error: Error & { code?: number }) => error);
    const second = internals.pool().then(() => undefined, (error: Error & { code?: number }) => error); // Follows the first lookup.
    await delay(10); assert.equal(discovers, 1);
    await backends.stop();
    const errors = await Promise.all([first, second]);
    assert.equal(opened.filter(client => !client.closed).length, 0, "no host connection is left open after the stop");
    assert.equal(discovers, 1, "the caller that woke after the stop started no lookup of its own");
    assert.deepEqual(errors.map(error => error?.code), [-32001, -32001], "both callers got the coded error");
    // A lookup that finishes only after the stop is closed, too.
    let late: HostStub | undefined;
    (backends as unknown as { closing: boolean }).closing = false; internals.poolPending = undefined;
    ExecutionHostClient.discover = async () => { await delay(20); late = { closed: false, close() { this.closed = true; } }; return late as unknown as ExecutionHostClient; };
    const lookup = internals.pool().then(() => undefined, (error: Error & { code?: number }) => error);
    (backends as unknown as { closing: boolean }).closing = true;
    assert.equal((await lookup)?.code, -32001);
    assert.equal(late?.closed, true, "a client obtained after the stop is closed");
  } finally {
    ExecutionHostClient.discover = discoverAll; await rm(directory, { recursive: true, force: true });
  }
});

test("only a failed host lookup arms the fail-fast window; a gateway() refusal is the chat's own failure", async () => {
  const { directory, stateDirectory, backends, internals } = await unitAdapter();
  const discoverAll = ExecutionHostClient.discover;
  setHostDownWindowForTests(5_000);
  const closedEngine = { connection: { closed: true }, threads: new Set<string>(), active: new Map<string, string>(), requests: 0, shared: true };
  let gateways = 0;
  const reason = (error: unknown) => (error as ReattachError).reason;
  try {
    internals.owner = async () => undefined;
    internals.gateway = async () => { gateways++; throw Object.assign(new Error("The gateway executor changed while this desktop connection was open"), { code: -32001 }); };
    const first = await internals.reattach("a", closedEngine).catch(error => error);
    const second = await internals.reattach("b", closedEngine).catch(error => error);
    assert.deepEqual([reason(first), reason(second)], ["resume_failed", "resume_failed"], "a refused gateway() is not a host problem, whatever its code");
    assert.equal(gateways, 2, "the second chat reached gateway() again: no window was armed");
    assert.equal(internals.reattacher.hostDownUntil, 0);
    assert.deepEqual((await unitTelemetry(stateDirectory, "executor_reattach_failed")).map(event => event.reason), ["resume_failed", "resume_failed"]);
    // A failed host lookup, through the real pool(), is still host_unavailable and arms the window.
    delete (internals as { owner?: unknown }).owner;
    ExecutionHostClient.discover = async () => { throw Object.assign(new Error("Shared gateway executor host is unavailable"), { code: -32001 }); };
    (backends as unknown as { sharedGateway: boolean }).sharedGateway = true;
    const down = await internals.reattach("c", closedEngine).catch(error => error);
    assert.equal(reason(down), "host_unavailable");
    assert.ok(internals.reattacher.hostDownUntil > Date.now(), "a failed host lookup arms the window");
    assert.equal(reason(await internals.reattach("d", closedEngine).catch(error => error)), "host_unavailable", "and the next attempt is refused inside it");
    assert.equal(gateways, 2);
  } finally {
    ExecutionHostClient.discover = discoverAll; setHostDownWindowForTests(); await backends.stop(); await rm(directory, { recursive: true, force: true });
  }
});
