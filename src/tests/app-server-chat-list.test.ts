import test from "node:test";
import assert from "node:assert/strict";
import { AppServerChatList, type ChatListConnection } from "../app-server-chat-list.js";
import { object, type Message } from "../app-server-connection.js";
import type { SocketAppServerConnection } from "../socket-app-server-connection.js";

const revision = "a".repeat(64);
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
class FakeConnection implements ChatListConnection {
  closed = false;
  calls: string[] = [];
  constructor(private readonly replies: Record<string, Message>) {}
  async request(method: string, _params: Message): Promise<Message> { this.calls.push(method); return this.replies[method] || {}; }
}
const row = (id: string): Message => ({ id, title: "saved title", updatedAt: 12, turns: [{ id: "saved-turn" }], status: { type: "notLoaded" }, model: "saved", extra: { persisted: true } });
const source = (connection: ChatListConnection) => [{ record: { revision, socketPath: "/unused", aliases: ["gateway/model"] }, connection }];
const live = (id: string, state: Message = { type: "idle" }): Message => ({ id, status: state, model: "gateway/model" });

class ReadGateConnection implements ChatListConnection {
  closed = false;
  calls: string[] = [];
  started: string[] = [];
  inFlight = 0;
  maximum = 0;
  private readonly pending = new Map<string, ReturnType<typeof deferred<Message>>>();

  async request(method: string, params: Message): Promise<Message> {
    this.calls.push(method);
    if (method === "thread/loaded/list") return { data: this.ids, nextCursor: null };
    if (method !== "thread/read") return {};
    const id = String(params.threadId);
    this.started.push(id); this.inFlight++; this.maximum = Math.max(this.maximum, this.inFlight);
    const wait = deferred<Message>(); this.pending.set(id, wait);
    try { return await wait.promise; }
    finally { this.pending.delete(id); this.inFlight--; }
  }

  constructor(private readonly ids: string[]) {}
  release(id: string, state: Message = { type: "idle" }): void {
    this.pending.get(id)?.resolve({ thread: live(id, state) });
  }
}

test("hydrates only loaded gateway rows and preserves native list shape", async () => {
  const engine = new FakeConnection({
    "thread/loaded/list": { data: ["gateway"], nextCursor: null },
    "thread/read": { thread: { id: "gateway", status: { type: "active", activeFlags: ["awaitingApproval"] }, model: "gateway/model", reasoningEffort: "high", environments: [{ id: "remote" }], canAcceptDirectInput: true, turns: [] } },
  });
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({ clientInfo: { name: "test", version: "1" } }), emit: async () => {}, intervalMs: 60_000 });
  try {
    const native = { data: [row("native"), row("gateway")], nextCursor: "native-cursor", backwardsCursor: null, extra: "unchanged" };
    const result = await bridge.hydrate(native);
    assert.deepEqual(result.nextCursor, "native-cursor"); assert.deepEqual(result.backwardsCursor, null); assert.equal(result.extra, "unchanged");
    assert.deepEqual((result.data as Message[])[0], row("native"));
    const live = (result.data as Message[])[1];
    assert.equal(live.title, "saved title"); assert.deepEqual(live.turns, [{ id: "saved-turn" }]); assert.deepEqual(live.status, { type: "active", activeFlags: ["awaitingApproval"] });
    assert.equal(live.model, "gateway/model"); assert.equal(live.reasoningEffort, "high"); assert.equal(live.canAcceptDirectInput, true);
    assert.deepEqual(engine.calls, ["thread/loaded/list", "thread/read"]);
  } finally { await bridge.stop(); }
});

test("never replaces a native row that is already live, even with the same gateway id", async () => {
  const engine = new FakeConnection({
    "thread/loaded/list": { data: ["saved", "already-live"], nextCursor: null },
    "thread/read": { thread: { id: "saved", status: { type: "idle" }, model: "gateway/model" } },
  });
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async () => {}, intervalMs: 60_000 });
  const nativeLive = { ...row("already-live"), status: { type: "active", activeFlags: ["awaitingUserInput"] }, model: "native/model" };
  try {
    const result = await bridge.hydrate({ data: [row("saved"), nativeLive], nextCursor: null });
    assert.deepEqual((result.data as Message[])[1], nativeLive);
    assert.deepEqual(engine.calls, ["thread/loaded/list", "thread/read"]);
  } finally { await bridge.stop(); }
});

test("an unavailable source leaves the native page untouched", async () => {
  const engine = new FakeConnection({ "thread/loaded/list": { data: ["gateway"], nextCursor: "again" } });
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async () => {}, timeoutMs: 30, intervalMs: 60_000 });
  const native = { data: [row("gateway")], nextCursor: null };
  try { assert.deepEqual(await bridge.hydrate(native), native); }
  finally { await bridge.stop(); }
});

test("loaded ids require complete, non-looping pages", async () => {
  const engine = new FakeConnection({ "thread/loaded/list": { data: ["gateway"], nextCursor: null } });
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async () => {}, intervalMs: 60_000 });
  try { const ids = await bridge.loadedIds(); assert.ok(ids); assert.deepEqual([...ids], ["gateway"]); }
  finally { await bridge.stop(); }
});

test("hydrates every loaded row while keeping source reads at four", async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `gateway-${index}`);
  const engine = new ReadGateConnection(ids);
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async () => {}, intervalMs: 60_000 });
  try {
    const hydration = bridge.hydrate({ data: ids.map(row), nextCursor: null });
    await eventually(() => engine.started.length === 4);
    assert.equal(engine.maximum, 4);
    for (const id of engine.started.slice()) engine.release(id);
    await eventually(() => engine.started.length === 8);
    assert.equal(engine.maximum, 4);
    for (const id of engine.started.slice(4)) engine.release(id);
    await eventually(() => engine.started.length === 9);
    engine.release(engine.started[8]!);
    const result = await hydration;
    assert.deepEqual((result.data as Message[]).map(value => object(value).status), ids.map(() => ({ type: "idle" })));
    assert.equal(engine.maximum, 4);
  } finally { await bridge.stop(); }
});

test("concurrent timed-out lists do not release a source read slot", async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `gateway-${index}`);
  const engine = new ReadGateConnection(ids);
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async () => {}, timeoutMs: 25, intervalMs: 60_000 });
  const native = { data: ids.map(row), nextCursor: null };
  try {
    const first = bridge.hydrate(native);
    await eventually(() => engine.started.length === 4);
    const second = bridge.hydrate(native);
    assert.deepEqual(await first, native);
    assert.deepEqual(await second, native);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.maximum, 4);
    assert.equal(engine.started.length, 4);
  } finally { await bridge.stop(); }
});

test("a late raw reply cannot overwrite a status event for any joining hydrate", async () => {
  let receive: (message: Message) => Promise<void> = async () => {};
  const engine = new ReadGateConnection(["gateway"]) as ReadGateConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  engine.ready = Promise.resolve(); engine.send = () => {}; engine.stop = () => { engine.closed = true; };
  const bridge = new AppServerChatList({
    sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }],
    initialized: () => ({}), emit: async () => {}, intervalMs: 60_000,
    connection: (_path, onMessage) => { receive = onMessage; return engine as unknown as SocketAppServerConnection; },
  });
  const native = { data: [row("gateway")], nextCursor: null };
  try {
    const first = bridge.hydrate(native);
    await eventually(() => engine.started.length === 1);
    await receive({ method: "thread/status/changed", params: { threadId: "gateway", status: { type: "idle" } } });
    const second = bridge.hydrate(native);
    await eventually(() => engine.calls.filter(method => method === "thread/loaded/list").length === 2);
    await new Promise<void>(resolve => setImmediate(resolve));
    engine.release("gateway", { type: "active", activeFlags: ["awaitingApproval"] });
    for (const result of await Promise.all([first, second])) {
      assert.deepEqual(object((result.data as Message[])[0]).status, { type: "idle" });
    }
    assert.equal(engine.started.length, 1);
  } finally { await bridge.stop(); }
});

test("the final overlay applies a newer status after an earlier raw read settled", async () => {
  let receive: (message: Message) => Promise<void> = async () => {};
  const engine = new ReadGateConnection(["a", "b"]) as ReadGateConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  engine.ready = Promise.resolve(); engine.send = () => {}; engine.stop = () => { engine.closed = true; };
  const bridge = new AppServerChatList({
    sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }], initialized: () => ({}), emit: async () => {}, intervalMs: 60_000,
    connection: (_path, onMessage) => { receive = onMessage; return engine as unknown as SocketAppServerConnection; },
  });
  try {
    const hydration = bridge.hydrate({ data: [row("a"), row("b")], nextCursor: null });
    await eventually(() => engine.started.length === 2);
    engine.release("a", { type: "active", activeFlags: ["awaitingApproval"] });
    await eventually(() => engine.inFlight === 1);
    await receive({ method: "thread/status/changed", params: { threadId: "a", status: { type: "idle" } } });
    engine.release("b", { type: "active", activeFlags: ["awaitingUserInput"] });
    const result = await hydration;
    assert.deepEqual((result.data as Message[]).map(value => object(value).status), [
      { type: "idle" }, { type: "active", activeFlags: ["awaitingUserInput"] },
    ]);
  } finally { await bridge.stop(); }
});

test("a newer not-loaded status removes an earlier runtime overlay", async () => {
  let receive: (message: Message) => Promise<void> = async () => {};
  const engine = new ReadGateConnection(["a", "b"]) as ReadGateConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  engine.ready = Promise.resolve(); engine.send = () => {}; engine.stop = () => { engine.closed = true; };
  const bridge = new AppServerChatList({
    sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }], initialized: () => ({}), emit: async () => {}, intervalMs: 60_000,
    connection: (_path, onMessage) => { receive = onMessage; return engine as unknown as SocketAppServerConnection; },
  });
  const native = { data: [row("a"), row("b")], nextCursor: null };
  try {
    const hydration = bridge.hydrate(native);
    await eventually(() => engine.started.length === 2);
    engine.release("a", { type: "active", activeFlags: [] });
    await eventually(() => engine.inFlight === 1);
    await receive({ method: "thread/status/changed", params: { threadId: "a", status: { type: "notLoaded" } } });
    engine.release("b", { type: "idle" });
    const result = await hydration;
    assert.deepEqual((result.data as Message[])[0], row("a"));
    assert.deepEqual(object((result.data as Message[])[1]).status, { type: "idle" });
  } finally { await bridge.stop(); }
});

test("a source lost after an early read cannot overlay saved rows", async () => {
  const engine = new ReadGateConnection(["a", "b"]);
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async () => {}, intervalMs: 60_000 });
  const native = { data: [row("a"), row("b")], nextCursor: null };
  try {
    const hydration = bridge.hydrate(native);
    await eventually(() => engine.started.length === 2);
    engine.release("a", { type: "active", activeFlags: [] });
    await eventually(() => engine.inFlight === 1);
    engine.closed = true;
    engine.release("b", { type: "active", activeFlags: [] });
    assert.deepEqual(await hydration, native);
  } finally { await bridge.stop(); }
});

test("an owned socket replacement invalidates its in-flight runtime rows", async () => {
  let path = "/first";
  const first = new ReadGateConnection(["a", "b"]) as ReadGateConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  const replacement = new ReadGateConnection([]) as ReadGateConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  for (const engine of [first, replacement]) { engine.ready = Promise.resolve(); engine.send = () => {}; engine.stop = () => { engine.closed = true; }; }
  const bridge = new AppServerChatList({
    sources: async () => [{ record: { revision, socketPath: path, aliases: ["gateway/model"] } }], initialized: () => ({}), emit: async () => {}, intervalMs: 60_000,
    connection: (socketPath, _onMessage) => (socketPath === "/first" ? first : replacement) as unknown as SocketAppServerConnection,
  });
  const native = { data: [row("a"), row("b")], nextCursor: null };
  try {
    const hydration = bridge.hydrate(native);
    await eventually(() => first.started.length === 2);
    first.release("a", { type: "active", activeFlags: [] });
    await eventually(() => first.inFlight === 1);
    path = "/replacement";
    await bridge.hydrate({ data: [], nextCursor: null });
    assert.equal(first.closed, true);
    first.release("b", { type: "active", activeFlags: [] });
    assert.deepEqual(await hydration, native);
  } finally { await bridge.stop(); }
});

test("an observer initialization or loaded-list failure leaves the native response usable", async () => {
  const observer = new FakeConnection({}) as FakeConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  observer.ready = Promise.resolve(); observer.request = async method => {
    observer.calls.push(method);
    if (method === "initialize") throw new Error("initialize rejected");
    return {};
  };
  observer.send = () => {}; observer.stop = () => { observer.closed = true; };
  const rejectedOpen = new AppServerChatList({
    sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }],
    initialized: () => ({}), emit: async () => {}, intervalMs: 60_000,
    connection: () => observer as unknown as SocketAppServerConnection,
  });
  const native = { data: [row("gateway")], nextCursor: null };
  try {
    assert.deepEqual(await rejectedOpen.hydrate(native), native);
    assert.equal(observer.closed, true);
  } finally { await rejectedOpen.stop(); }

  const rejectedList: ChatListConnection = {
    closed: false,
    request: async method => {
      if (method === "thread/loaded/list") throw new Error("loaded list rejected");
      return {};
    },
  };
  const bridge = new AppServerChatList({ sources: async () => source(rejectedList), initialized: () => ({}), emit: async () => {}, intervalMs: 60_000 });
  try {
    assert.deepEqual(await bridge.hydrate(native), native);
    assert.equal(await bridge.loadedIds(), undefined);
  } finally { await bridge.stop(); }
});

test("a failed advertised observer makes hydration and loaded ids incomplete", async () => {
  const good = new FakeConnection({ initialize: {}, "thread/loaded/list": { data: ["gateway"], nextCursor: null }, "thread/read": { thread: live("gateway") } }) as FakeConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  const rejected = new FakeConnection({}) as FakeConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  for (const observer of [good, rejected]) { observer.ready = Promise.resolve(); observer.send = () => {}; observer.stop = () => { observer.closed = true; }; }
  rejected.request = async method => { rejected.calls.push(method); if (method === "initialize") throw new Error("initialize rejected"); return {}; };
  const bridge = new AppServerChatList({
    sources: async () => [
      { record: { revision, socketPath: "/good", aliases: ["gateway/model"] } },
      { record: { revision: "b".repeat(64), socketPath: "/rejected", aliases: ["gateway/model"] } },
    ],
    initialized: () => ({}), emit: async () => {}, intervalMs: 60_000,
    connection: path => (path === "/good" ? good : rejected) as unknown as SocketAppServerConnection,
  });
  const native = { data: [row("gateway")], nextCursor: null };
  try {
    assert.deepEqual(await bridge.hydrate(native), native);
    assert.equal(await bridge.loadedIds(), undefined);
  } finally { await bridge.stop(); }
});

test("an empty successful source discovery has an empty loaded-id union", async () => {
  const bridge = new AppServerChatList({ sources: async () => [], initialized: () => ({}), emit: async () => {}, intervalMs: 60_000 });
  try { assert.deepEqual(await bridge.loadedIds(), new Set()); }
  finally { await bridge.stop(); }
});

test("invalid empty-native cursors can be normalized by the backend", () => {
  assert.equal(AppServerChatList.validCursor("018f5d11-1234-7abc-8def-0123456789ab"), true);
  assert.equal(AppServerChatList.validCursor("00000000-0000-0000-0000-000000000000"), true);
  assert.equal(AppServerChatList.canonicalCursor("018F5D11-1234-7ABC-8DEF-0123456789AB"), "018f5d11-1234-7abc-8def-0123456789ab");
  assert.equal(AppServerChatList.validCursor("not-a-uuid"), false);
});

test("a passive observer only forwards status and releases its own new-chat subscription", async () => {
  let receive: (message: Message) => Promise<void> = async () => {}; const events: Message[] = [];
  const observer = new FakeConnection({
    initialize: {}, "thread/loaded/list": { data: [], nextCursor: null }, "thread/unsubscribe": { status: "notLoaded" },
  }) as FakeConnection & { ready: Promise<void>; send: (message: Message) => void; stop: () => void };
  observer.ready = Promise.resolve(); observer.send = message => observer.calls.push(String(message.method)); observer.stop = () => { observer.closed = true; };
  const bridge = new AppServerChatList({
    sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }], initialized: () => ({ clientInfo: { name: "mobile", version: "2" } }),
    emit: async message => { events.push(message); }, intervalMs: 60_000,
    connection: (_path, onMessage) => { receive = onMessage; return observer as unknown as SocketAppServerConnection; },
  });
  try {
    await bridge.hydrate({ data: [], nextCursor: null });
    await receive({ method: "turn/completed", params: { threadId: "ignored" } });
    await receive({ id: "server-callback", method: "thread/status/changed", params: { threadId: "callback", status: { type: "idle" } } });
    await receive({ method: "thread/status/changed", params: { threadId: "gateway", status: { type: "idle" } }, emittedAtMs: 123 });
    await receive({ method: "thread/started", params: { thread: { id: "new-gateway" } } });
    assert.deepEqual(events, [{ method: "thread/status/changed", params: { threadId: "gateway", status: { type: "idle" } }, emittedAtMs: 123 }]);
    assert.ok(observer.calls.includes("thread/unsubscribe"));
    assert.equal(observer.calls.includes("turn/completed"), false);
  } finally { await bridge.stop(); }
});
