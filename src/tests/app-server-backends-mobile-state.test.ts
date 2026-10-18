import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerBackends } from "../app-server-backends.js";
import type { Message } from "../app-server-connection.js";
import type { AppServerChatList } from "../app-server-chat-list.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { ExecutionHostClient } from "../execution-host-client.js";
import type { ExecutionRecord } from "../execution-host-engine.js";
import { setNativeRuntimeRootForTests, type NativeRuntimeStatus } from "../native-runtime-status.js";

const revision = "a".repeat(64);
const id = (tail: string) => `018f5d11-1234-7abc-8def-${tail}`;
const gateway = id("000000000002");
const native = id("000000000001");
const peer = id("000000000003");

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

type BackendInternals = {
  chatList: AppServerChatList;
  engines: Array<{ connection: unknown; revision: string; aliases: Set<string>; threads: Set<string>; active: Map<string, string>; requests: number }>;
  poolClient?: ExecutionHostClient;
  sharedGateway?: boolean;
  chatListSources(signal?: AbortSignal): Promise<unknown[]>;
  loadedList(native: Message, params: Message): Promise<Message>;
  nativeLoadedIds(): Promise<Set<string> | undefined>;
  forward(connection: unknown, message: Message): Promise<void>;
  nativeStatus?: NativeRuntimeStatus;
};

async function fixture(withConfig = false) {
  const root = await mkdtemp(join(tmpdir(), "gw-mobile-state-"));
  const stateDirectory = join(root, "state"); await mkdir(stateDirectory, { mode: 0o700 });
  const events: Message[] = [];
  const engine = { closed: false, ready: Promise.resolve(), drained: Promise.resolve(), exited: Promise.resolve({ code: null, signal: null }), request: async () => ({}), send() {}, stop() {} };
  const backend = new AppServerBackends("codex", ["app-server"], { version: 1, port: 3457, stateDirectory, providers: [] }, {}, {}, {} as DesktopCatalog,
    async message => { events.push(message); }, () => {}, withConfig ? join(root, "gateway.json") : undefined, () => engine) as unknown as BackendInternals & { stop(): Promise<void> };
  return { backend, engine, root, events, clean: async () => { await backend.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("supplemental native metadata never clears an observed running turn", async () => {
  const f = await fixture();
  setNativeRuntimeRootForTests(join(f.root, "runtime"));
  const backend = f.backend as unknown as BackendInternals & {
    request(method: string, params: Message): Promise<Message>;
    nativeTurns: { active: Map<string, unknown> };
  };
  f.engine.request = async (method?: string) => method === "thread/loaded/list"
    ? { data: [native], nextCursor: null }
    : method === "thread/read" ? { thread: { id: native, status: { type: "active", activeFlags: [] }, turns: [] } } : {};
  try {
    await backend.request("initialize", { clientInfo: { name: "native-state-fixture", version: "1" } });
    await backend.forward(f.engine, { method: "turn/started", params: {
      threadId: native, turn: { id: "running-native-turn", status: "inProgress" },
    } });
    assert.equal(backend.nativeTurns.active.has(native), true);
    const publisher = backend.nativeStatus as unknown as { runtimeRequest(method: string, params: Message): Promise<Message> };
    assert.ok(publisher);
    await publisher.runtimeRequest("runtime/list", {});
    assert.equal(backend.nativeTurns.active.has(native), true);
  } finally { await f.clean(); setNativeRuntimeRootForTests(); }
});

test("backend forwarding records a regular engine status before its old read returns", async () => {
  const f = await fixture(); const reading = deferred<Message>(); let reads = 0;
  const connection = {
    closed: false,
    async request(method: string): Promise<Message> {
      if (method === "thread/loaded/list") return { data: [gateway], nextCursor: null };
      reads++; return await reading.promise;
    },
    stop() { this.closed = true; },
  };
  f.backend.engines.push({ connection, revision, aliases: new Set(["gateway/model"]), threads: new Set(), active: new Map(), requests: 0 });
  try {
    const hydrated = f.backend.chatList.hydrate({ data: [{ id: gateway, status: { type: "notLoaded" } }], nextCursor: null });
    await eventually(() => reads === 1);
    await f.backend.forward(connection, { method: "thread/status/changed", params: { threadId: gateway, status: { type: "idle" } } });
    reading.resolve({ thread: { id: gateway, status: { type: "active", activeFlags: ["awaitingApproval"] } } });
    assert.deepEqual((await hydrated).data, [{ id: gateway, status: { type: "idle" } }]);
    assert.deepEqual(f.events, [{ method: "thread/status/changed", params: { threadId: gateway, status: { type: "idle" } } }]);
  } finally { await f.clean(); }
});

test("timed-out generation lists retain one borrowed raw control request", async () => {
  const f = await fixture(); const pending = deferred<ExecutionRecord[]>(); let requests = 0;
  f.backend.poolClient = { closed: false, generations: async () => { requests++; return await pending.promise; } } as unknown as ExecutionHostClient;
  try {
    const firstAbort = new AbortController(); const first = f.backend.chatListSources(firstAbort.signal);
    await eventually(() => requests === 1); firstAbort.abort(); await first;
    const secondAbort = new AbortController(); const second = f.backend.chatListSources(secondAbort.signal);
    await eventually(() => requests === 1); secondAbort.abort(); await second;
    assert.equal(requests, 1);
    pending.resolve([]);
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { await f.clean(); }
});

test("an aborted transient generation read closes only its owned client", async () => {
  const f = await fixture(true);
  const backend = f.backend as BackendInternals & { sharedGateway: boolean };
  backend.sharedGateway = true;
  const original = ExecutionHostClient.discover;
  let reject!: (error: Error) => void;
  const pending = new Promise<ExecutionRecord[]>((_resolve, no) => { reject = no; });
  let requests = 0;
  const client = {
    closed: false,
    generations() { requests++; return pending; },
    close() { this.closed = true; reject(new Error("closed")); },
  };
  ExecutionHostClient.discover = async () => client as unknown as ExecutionHostClient;
  try {
    const controller = new AbortController();
    const lookup = backend.chatListSources(controller.signal);
    await eventually(() => requests === 1);
    controller.abort();
    assert.equal(await lookup, undefined);
    assert.equal(client.closed, true);
  } finally { ExecutionHostClient.discover = original; await f.clean(); }
});

test("a shared-host generation failure leaves the native loaded page unchanged", async () => {
  const f = await fixture(); const internals = f.backend;
  const original = { data: ["native-sdk-page"], nextCursor: "native-sdk-cursor", extra: "unchanged" };
  internals.sharedGateway = true;
  internals.poolClient = { closed: false, generations: async () => { throw new Error("host generations rejected"); } } as unknown as ExecutionHostClient;
  (internals as unknown as { nativeLoadedIds: () => Promise<Set<string>> }).nativeLoadedIds = async () => new Set([native]);
  internals.nativeStatus = { loadedIds: async () => [], stop: async () => {} } as unknown as NativeRuntimeStatus;
  try {
    assert.deepEqual(await internals.loadedList(original, { limit: 500 }), original);
    assert.equal(await internals.chatListSources(), undefined);
  } finally { await f.clean(); }
});

test("a live borrowed engine still hydrates while shared-host enumeration is incomplete", async () => {
  const f = await fixture(); const internals = f.backend;
  const connection = {
    closed: false,
    async request(method: string): Promise<Message> {
      if (method === "thread/loaded/list") return { data: [gateway], nextCursor: null };
      return { thread: { id: gateway, status: { type: "idle" }, model: "gateway/model" } };
    },
    stop() { this.closed = true; },
  };
  internals.engines.push({ connection, revision, aliases: new Set(["gateway/model"]), threads: new Set(), active: new Map(), requests: 0 });
  internals.sharedGateway = true;
  internals.poolClient = { closed: false, generations: async () => { throw new Error("host generations rejected"); } } as unknown as ExecutionHostClient;
  try {
    const hydrated = await internals.chatList.hydrate({ data: [{ id: gateway, status: { type: "notLoaded" } }], nextCursor: null });
    assert.deepEqual(hydrated.data, [{ id: gateway, status: { type: "idle" }, model: "gateway/model" }]);
    assert.equal(await internals.chatList.loadedIds(), undefined);
  } finally { await f.clean(); }
});

test("loaded-list falls back for incomplete native peers but paginates successful empties", async () => {
  const f = await fixture(); const internals = f.backend;
  const original = { data: ["native-sdk-page"], nextCursor: "native-sdk-cursor", extra: "unchanged" };
  (internals as unknown as { nativeLoadedIds: () => Promise<Set<string>> }).nativeLoadedIds = async () => new Set([native]);
  (internals.chatList as unknown as { loadedIds: () => Promise<Set<string>> }).loadedIds = async () => new Set([gateway]);
  internals.nativeStatus = { loadedIds: async () => undefined, stop: async () => {} } as unknown as NativeRuntimeStatus;
  try {
    assert.deepEqual(await internals.loadedList(original, { limit: 1 }), original);
    internals.nativeStatus = { loadedIds: async () => [], stop: async () => {} } as unknown as NativeRuntimeStatus;
    const first = await internals.loadedList(original, { limit: 1 });
    assert.deepEqual(first.data, [native]); assert.equal(first.nextCursor, native);
    const second = await internals.loadedList(original, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.data, [gateway]); assert.equal(second.nextCursor, null);
  } finally { await f.clean(); }
});
