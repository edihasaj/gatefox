import test from "node:test";
import assert from "node:assert/strict";
import { AppServerChatList, type ChatListConnection } from "../app-server-chat-list.js";
import type { Message } from "../app-server-connection.js";

const revision = "r".repeat(64);
const row = (id: string, status: Message = { type: "notLoaded" }): Message => ({ id, title: "saved", status, model: "gateway/model" });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await sleep(5); }
  assert.fail("condition did not become true");
}
const source = (connection: ChatListConnection) => [{ record: { revision, socketPath: "/gateway", aliases: ["gateway/model"] }, connection }];

class Engine implements ChatListConnection {
  closed = false; calls: string[] = []; failList = false; failRead = false;
  constructor(public state: Message = { type: "active", activeFlags: ["awaitingApproval"] }) {}
  async request(method: string, params: Message): Promise<Message> {
    this.calls.push(method);
    if (method === "thread/loaded/list") { if (this.failList) throw new Error("temporary list failure"); return { data: ["gateway"], nextCursor: null }; }
    if (method === "thread/read") { if (this.failRead) throw new Error("temporary read failure"); return { thread: { id: params.threadId, status: this.state, model: "gateway/model" } }; }
    return {};
  }
}

test("a requested saved row receives an active recovery snapshot after delayed discovery without another list", async () => {
  let available = false; const engine = new Engine(); const events: Message[] = [];
  const bridge = new AppServerChatList({ sources: async () => available ? source(engine) : [], initialized: () => ({}), emit: async event => { events.push(event); }, intervalMs: 5, timeoutMs: 50 });
  try {
    assert.deepEqual(await bridge.hydrate({ data: [row("gateway")], nextCursor: null }), { data: [row("gateway")], nextCursor: null });
    available = true;
    await eventually(() => events.length === 1);
    assert.deepEqual(events[0], { method: "thread/status/changed", params: { threadId: "gateway", status: { type: "active", activeFlags: ["awaitingApproval"] } } });
    assert.ok(engine.calls.includes("thread/loaded/list")); assert.ok(engine.calls.includes("thread/read"));
    await sleep(25); assert.equal(events.length, 1, "unchanged snapshots do not spam");
  } finally { await bridge.stop(); }
});

test("metadata failures retry a remembered unloaded candidate and preserve actual approval flags", async () => {
  const engine = new Engine({ type: "active", activeFlags: ["awaitingUserInput", "awaitingApproval"] }); engine.failList = true;
  const events: Message[] = [];
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async event => { events.push(event); }, intervalMs: 5, timeoutMs: 30 });
  try {
    await bridge.hydrate({ data: [row("gateway")], nextCursor: null });
    await sleep(15); assert.equal(events.length, 0);
    engine.failList = false;
    await eventually(() => events.length === 1);
    assert.deepEqual((events[0]!.params as Message).status, engine.state);
  } finally { await bridge.stop(); }
});

test("a timed-out metadata page settles later and is retried as a fresh recovery snapshot", async () => {
  let first = true; let release!: () => void; const engine = new Engine(); const events: Message[] = [];
  const delayed: ChatListConnection = { closed: false, request(method, params) {
    if (method === "thread/loaded/list" && first) { first = false; return new Promise<Message>(resolve => { release = () => resolve({ data: ["gateway"], nextCursor: null }); }); }
    return engine.request(method, params);
  } };
  const bridge = new AppServerChatList({ sources: async () => source(delayed), initialized: () => ({}), emit: async event => { events.push(event); }, intervalMs: 5, timeoutMs: 15 });
  try {
    await bridge.hydrate({ data: [row("gateway")], nextCursor: null });
    release();
    await eventually(() => events.length === 1);
  } finally { await bridge.stop(); }
});

test("a fallback list resets a previously delivered candidate so recovery can emit it again", async () => {
  let available = false; const engine = new Engine(); const events: Message[] = [];
  const bridge = new AppServerChatList({ sources: async () => available ? source(engine) : [], initialized: () => ({}), emit: async event => { events.push(event); }, intervalMs: 5, timeoutMs: 30 });
  try {
    await bridge.hydrate({ data: [row("gateway")], nextCursor: null });
    available = true;
    await eventually(() => events.length === 1);
    available = false;
    await bridge.hydrate({ data: [row("gateway")], nextCursor: null });
    available = true;
    await eventually(() => events.length === 2);
  } finally { await bridge.stop(); }
});

test("a failed emit stays eligible for a later recovery retry", async () => {
  let failures = 1, available = false; const engine = new Engine(); const events: Message[] = [];
  const bridge = new AppServerChatList({ sources: async () => available ? source(engine) : [], initialized: () => ({}), emit: async event => {
    if (failures-- > 0) throw new Error("client detached"); events.push(event);
  }, intervalMs: 5, timeoutMs: 30 });
  try { await bridge.hydrate({ data: [row("gateway")], nextCursor: null }); available = true; await eventually(() => events.length === 1); }
  finally { await bridge.stop(); }
});

test("a failed passive status delivery is retried by a verified recovery snapshot", async () => {
  let receive: (message: Message) => Promise<void> = async () => {}; let opened = 0; let failures = 1; const engine = new Engine(); engine.failList = true;
  const events: Message[] = [];
  const observer = engine as Engine & { ready: Promise<void>; send(message: Message): void; stop(): void };
  observer.ready = Promise.resolve(); observer.send = () => {}; observer.stop = () => { observer.closed = true; };
  const bridge = new AppServerChatList({ sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }], initialized: () => ({}), emit: async event => {
    if (failures-- > 0) throw new Error("client detached"); events.push(event);
  }, intervalMs: 5, timeoutMs: 30, connection: (_path, onMessage) => { opened++; observer.closed = false; receive = onMessage; return observer as never; } });
  try {
    await bridge.hydrate({ data: [row("gateway")], nextCursor: null });
    engine.failList = false;
    await eventually(() => opened >= 2);
    await receive({ method: "thread/status/changed", params: { threadId: "gateway", status: engine.state } });
    await eventually(() => events.length === 1);
    assert.deepEqual((events[0]!.params as Message).status, engine.state);
  } finally { await bridge.stop(); }
});

test("a native live row is never remembered or replaced by recovery", async () => {
  const engine = new Engine(); const events: Message[] = [];
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async event => { events.push(event); }, intervalMs: 5, timeoutMs: 30 });
  const native = { data: [row("gateway", { type: "active", activeFlags: ["native"] })], nextCursor: null };
  try { assert.deepEqual(await bridge.hydrate(native), native); await sleep(25); assert.equal(events.length, 0); }
  finally { await bridge.stop(); }
});

test("an empty requested page still periodically reconnects its passive observer", async () => {
  let opened = 0; let exit!: () => void; let receive: (message: Message) => Promise<void> = async () => {}; const received: Message[] = [];
  const observer = () => ({ closed: false, ready: Promise.resolve(),
    async request(method: string) { if (method === "initialize") return {}; if (method === "thread/loaded/list") return { data: [], nextCursor: null }; return {}; },
    send() {}, stop() {},
  });
  const bridge = new AppServerChatList({ sources: async () => [{ record: { revision, socketPath: "/observer", aliases: ["gateway/model"] } }], initialized: () => ({}), emit: async event => { received.push(event); }, intervalMs: 5, timeoutMs: 30,
    connection: (_path, onMessage, onExit) => { opened++; exit = onExit; receive = onMessage; const connection = observer(); return { ...connection, send: () => {}, stop: () => {}, request: connection.request, ready: connection.ready } as never; },
  });
  try {
    await bridge.hydrate({ data: [], nextCursor: null }); await eventually(() => opened === 1);
    exit(); await eventually(() => opened >= 2);
    await receive({ method: "thread/status/changed", params: { threadId: "gateway", status: { type: "idle" } } });
    assert.equal(received.length, 1);
  } finally { await bridge.stop(); }
});

test("a newer observed SDK status wins over a late recovery read and stop prevents future snapshots", async () => {
  let resolve!: (value: Message) => void;
  const engine: ChatListConnection = { closed: false, request(method) {
    if (method === "thread/loaded/list") return Promise.resolve({ data: ["gateway"], nextCursor: null });
    if (method === "thread/read") return new Promise(done => { resolve = done; });
    return Promise.resolve({});
  } };
  const events: Message[] = [];
  const bridge = new AppServerChatList({ sources: async () => source(engine), initialized: () => ({}), emit: async event => { events.push(event); }, intervalMs: 60_000, timeoutMs: 100 });
  try {
    const hydration = bridge.hydrate({ data: [row("gateway")], nextCursor: null });
    await eventually(() => typeof resolve === "function");
    assert.equal(bridge.observeStatus({ method: "thread/status/changed", params: { threadId: "gateway", status: { type: "idle" } } }, revision), true);
    resolve({ thread: { id: "gateway", status: { type: "active", activeFlags: [] } } });
    const result = await hydration;
    assert.deepEqual(((result.data as Message[])[0]!.status), { type: "idle" });
    await bridge.stop(); assert.equal(events.length, 0);
  } finally { await bridge.stop(); }
});
