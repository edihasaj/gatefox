import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { Message } from "../app-server-connection.js";
import { NativeRuntimeStatus, setNativeRuntimeRootForTests } from "../native-runtime-status.js";

let root = "";
let unixSockets = true;
before(async () => {
  root = await mkdtemp(join(process.env.GATEWAY_TEST_TMPDIR ?? tmpdir(), "gw-runtime-status-")); setNativeRuntimeRootForTests(root);
  const probe = createServer(); const path = `/tmp/gw-runtime-test-probe-${process.pid}.sock`;
  unixSockets = await new Promise(resolve => { probe.once("error", () => resolve(false)); probe.listen(path, () => probe.close(() => resolve(true))); });
  await unlink(path).catch(() => {});
});
after(async () => { setNativeRuntimeRootForTests(); await rm(root, { recursive: true, force: true }); });

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const saved = (id: string): Message => ({ id, title: "saved title", updatedAt: 12, turns: [{ id: "saved-turn" }], status: { type: "notLoaded" }, model: "saved", cursor: "preserved" });

function source(thread: Message, calls: string[]): (method: string, params: Message) => Promise<Message> {
  return async (method, params) => {
    calls.push(method);
    if (method === "thread/loaded/list") return { data: [thread.id], nextCursor: null };
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false, "runtime probing never reads turn history");
      return { thread };
    }
    throw new Error(`unexpected native method ${method}`);
  };
}

test("a peer overlays only saved notLoaded rows and relays actual status without resuming", { timeout: 10000 }, async t => {
  if (!unixSockets) return t.skip("the sandbox does not permit Unix-domain sockets");
  const calls: string[] = [];
  const thread: Message = { id: "native-live", status: { type: "active", activeFlags: ["waitingOnApproval"] }, model: "native-model", reasoningEffort: "high", canAcceptDirectInput: true, turns: [{ secret: "must-not-cross" }] };
  const emitted: Message[] = [];
  const nativeHome = join(root, "native-one");
  const publisher = new NativeRuntimeStatus({ nativeHome, readOnlyNativeRequest: source(thread, calls), emitStatus: () => {} });
  const observer = new NativeRuntimeStatus({ nativeHome, readOnlyNativeRequest: async () => ({}), emitStatus: message => { emitted.push(message); } });
  try {
    await publisher.start(); await observer.start();
    const native = { data: [saved("native-live"), { id: "local-live", status: { type: "active" }, turns: ["keep"] }], nextCursor: "native-cursor", extra: "unchanged" };
    const hydrated = await observer.hydrate(native);
    assert.equal(hydrated.nextCursor, "native-cursor"); assert.equal(hydrated.extra, "unchanged");
    const rows = hydrated.data as Message[];
    assert.deepEqual(rows[0]!.turns, [{ id: "saved-turn" }]); assert.equal(rows[0]!.cursor, "preserved");
    assert.deepEqual(rows[0]!.status, { type: "active", activeFlags: ["waitingOnApproval"] });
    assert.equal(rows[0]!.model, "native-model"); assert.equal(rows[0]!.reasoningEffort, "high"); assert.equal(rows[0]!.canAcceptDirectInput, true);
    assert.deepEqual(rows[1], native.data[1], "already-live local rows remain native authority");
    assert.ok(calls.every(method => method === "thread/loaded/list" || method === "thread/read"));
    assert.equal((calls as string[]).includes("turn/read"), false);

    publisher.observe({ method: "thread/status/changed", params: { threadId: "native-live", status: { type: "idle", activeFlags: [] } }, emittedAtMs: 42 });
    for (let wait = 0; wait < 20 && !emitted.length; wait++) await delay(10);
    assert.deepEqual(emitted.at(-1), { method: "thread/status/changed", params: { threadId: "native-live", status: { type: "idle" } }, emittedAtMs: 42 });
  } finally { await observer.stop(); await publisher.stop(); }
});

test("scope is native-home private and peer loss never invents idle", { timeout: 10000 }, async t => {
  if (!unixSockets) return t.skip("the sandbox does not permit Unix-domain sockets");
  const thread: Message = { id: "only-source", status: { type: "active", activeFlags: [] }, model: "native" };
  const publisher = new NativeRuntimeStatus({ nativeHome: join(root, "native-two"), readOnlyNativeRequest: source(thread, []), emitStatus: () => {} });
  const foreign = new NativeRuntimeStatus({ nativeHome: join(root, "other-native"), readOnlyNativeRequest: async () => ({}), emitStatus: () => {} });
  const observer = new NativeRuntimeStatus({ nativeHome: join(root, "native-two"), readOnlyNativeRequest: async () => ({}), emitStatus: () => {} });
  try {
    await publisher.start(); await foreign.start(); await observer.start();
    const original = { data: [saved("only-source")], nextCursor: null };
    assert.equal(((await observer.hydrate(original)).data as Message[])[0]!.status instanceof Object, true);
    await publisher.stop();
    const afterLoss = await observer.hydrate(original);
    assert.deepEqual(afterLoss, original, "an unavailable peer is discarded, not converted to idle");
    assert.equal((await foreign.loadedIds())?.includes("only-source") ?? false, false, "foreign native homes are excluded");
  } finally { await observer.stop(); await foreign.stop(); await publisher.stop(); }
});

type BridgeInternals = {
  runtimeRequest(method: string, params: Message): Promise<Message>;
  refreshPeers(): Promise<boolean>;
  discoverPeers(deadline: number): Promise<{ registrations: unknown[]; complete: boolean }>;
  peers: Map<string, unknown>;
  home: string;
  readRegistration(path: string): Promise<unknown>;
  receivePeer(peer: { available: boolean; connection?: { closed: boolean }; snapshots: Map<string, Message>; events?: Map<string, unknown>; revision: number }, message: Message): Promise<void>;
  invalidatePeer(peer: { available: boolean; connection?: { closed: boolean; stop?: () => void }; snapshots: Map<string, Message>; events?: Map<string, unknown>; revision: number }): void;
};

test("native cursor enumeration follows SDK cursors and publishes one complete broker snapshot", async () => {
  const cursors: unknown[] = []; const calls: string[] = [];
  const threads = Array.from({ length: 101 }, (_, index) => ({ id: `thread-${index}`, status: { type: "idle" }, reasoningEffort: index === 0 ? null : "low" }));
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "cursor-pages"), emitStatus: () => {}, readOnlyNativeRequest: async (method, params) => {
    calls.push(method);
    if (method === "thread/loaded/list") {
      cursors.push(params.cursor);
      return params.cursor === undefined ? { data: threads.slice(0, 100).map(thread => thread.id), nextCursor: "sdk-cursor-2" } :
        params.cursor === "sdk-cursor-2" ? { data: [threads[100]!.id], nextCursor: null } : Promise.reject(new Error("wrong native cursor"));
    }
    const thread = threads.find(candidate => candidate.id === params.threadId); assert.ok(thread); return { thread };
  } }) as unknown as BridgeInternals;
  const first = await bridge.runtimeRequest("runtime/list", {});
  assert.deepEqual(cursors, [undefined, "sdk-cursor-2"]);
  assert.equal((first.data as Message[]).length, 101); assert.equal(first.nextCursor, null);
  assert.equal((first.data as Message[])[100]!.reasoningEffort, "low");
  assert.ok(calls.filter(method => method === "thread/read").length === 101);
});

test("a timed-out snapshot retains its raw native flight and four read slots", { timeout: 5000 }, async () => {
  const pending: (() => void)[] = []; let reads = 0;
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "raw-flight"), emitStatus: () => {}, readOnlyNativeRequest: async (method, params) => {
    if (method === "thread/loaded/list") return { data: ["one", "two", "three", "four"], nextCursor: null };
    reads++;
    await new Promise<void>(resolve => pending.push(resolve));
    return { thread: { id: params.threadId, status: { type: "idle" } } };
  } }) as unknown as BridgeInternals;
  const first = bridge.runtimeRequest("runtime/list", {});
  for (let attempt = 0; attempt < 20 && reads !== 4; attempt++) await delay(5);
  assert.equal(reads, 4);
  await assert.rejects(first, /timed out/);
  await assert.rejects(bridge.runtimeRequest("runtime/list", {}), /timed out/);
  assert.equal(reads, 4, "repeat probes join raw pending reads instead of starting another four");
  pending.forEach(resolve => resolve());
});

test("a notLoaded event wins over an older in-flight read", async () => {
  let resolveRead!: () => void; let reading = false;
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "event-race"), emitStatus: () => {}, readOnlyNativeRequest: async (method, params) => {
    if (method === "thread/loaded/list") return { data: ["race"], nextCursor: null };
    reading = true; await new Promise<void>(resolve => { resolveRead = resolve; });
    return { thread: { id: params.threadId, status: { type: "active", activeFlags: ["waitingOnApproval"], leak: "no" }, model: "old" } };
  } }) as unknown as BridgeInternals & { observe(message: Message): void };
  const listed = bridge.runtimeRequest("runtime/list", {});
  for (let attempt = 0; attempt < 20 && !reading; attempt++) await delay(5);
  bridge.observe({ method: "thread/status/changed", params: { threadId: "race", status: { type: "notLoaded" } } });
  resolveRead();
  const row = (await listed).data as Message[];
  assert.deepEqual(row[0]!.status, { type: "notLoaded" });
});

test("a refresh that discovers after stop cannot repopulate native peers", async () => {
  let resolveDiscovery!: (value: { registrations: unknown[]; complete: boolean }) => void;
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "stop-race"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals & { stop(): Promise<void> };
  bridge.discoverPeers = async () => await new Promise<{ registrations: unknown[]; complete: boolean }>(resolve => { resolveDiscovery = resolve; });
  const refresh = bridge.refreshPeers();
  await delay(0); await bridge.stop(); resolveDiscovery({ registrations: [], complete: true });
  assert.equal(await refresh, false); assert.equal(bridge.peers.size, 0);
});

test("loaded ids distinguish a complete empty discovery from incomplete peer state", async () => {
  const empty = new NativeRuntimeStatus({ nativeHome: join(root, "empty-discovery"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals & { loadedIds(): Promise<string[] | undefined>; stop(): Promise<void> };
  empty.discoverPeers = async () => ({ registrations: [], complete: true });
  try { assert.deepEqual(await empty.loadedIds(), []); } finally { await empty.stop(); }

  const incomplete = new NativeRuntimeStatus({ nativeHome: join(root, "incomplete-discovery"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals & { loadedIds(): Promise<string[] | undefined>; stop(): Promise<void> };
  incomplete.discoverPeers = async () => ({ registrations: [], complete: false });
  try { assert.equal(await incomplete.loadedIds(), undefined); } finally { await incomplete.stop(); }

  const unavailable = new NativeRuntimeStatus({ nativeHome: join(root, "unavailable-peer"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals & {
    loadedIds(): Promise<string[] | undefined>;
    readPeer(peer: unknown, epoch: number, deadline: number): Promise<void>;
    stop(): Promise<void>;
  };
  unavailable.discoverPeers = async () => ({ registrations: [{ instance: "a".repeat(24) }], complete: true });
  unavailable.readPeer = async () => {};
  try { assert.equal(await unavailable.loadedIds(), undefined); } finally { await unavailable.stop(); }
});

test("the default broker socket root is refused in node:test before publication", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  setNativeRuntimeRootForTests();
  try {
    assert.throws(() => new NativeRuntimeStatus({ nativeHome: join(root, "fixed-socket-root"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }), /real native runtime status sockets/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    setNativeRuntimeRootForTests(root);
  }
});

test("registry reads reject symlinks and group-readable receipts before parsing", async () => {
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "registry-hardening"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals;
  await mkdir(bridge.home, { recursive: true, mode: 0o700 });
  const name = "runtime-0123456789abcdef01234567.json"; const receipt = join(bridge.home, name); const target = join(root, "outside-receipt.json");
  await writeFile(target, "{}", { mode: 0o600 }); await symlink(target, receipt);
  assert.equal(await bridge.readRegistration(receipt), undefined, "O_NOFOLLOW rejects a swapped receipt link");
  await unlink(receipt); await writeFile(receipt, "{}", { mode: 0o644 }); await chmod(receipt, 0o644);
  assert.equal(await bridge.readRegistration(receipt), undefined, "non-private receipt is ignored before its JSON is trusted");
});

test("notLoaded and connection invalidation immediately remove a peer claim", async () => {
  const emitted: Message[] = [];
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "peer-invalidation"), emitStatus: message => { emitted.push(message); }, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals;
  const peer = { available: true, connection: { closed: false, stop: () => {} }, snapshots: new Map<string, Message>([["loaded", { id: "loaded", status: { type: "active" } }]]), revision: 0 };
  await bridge.receivePeer(peer, { method: "thread/status/changed", params: { threadId: "loaded", status: "notLoaded" }, emittedAtMs: 99 });
  assert.equal(peer.snapshots.has("loaded"), false); assert.deepEqual(emitted, [{ method: "thread/status/changed", params: { threadId: "loaded", status: "notLoaded" }, emittedAtMs: 99 }]);
  peer.snapshots.set("another", { id: "another", status: { type: "idle" } }); bridge.invalidatePeer(peer);
  assert.equal(peer.available, false); assert.equal(peer.snapshots.size, 0);
});

test("pre-snapshot peer events merge into the verified peer snapshot", async () => {
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "peer-snapshot-race"), emitStatus: () => {}, readOnlyNativeRequest: async () => ({}) }) as unknown as BridgeInternals & {
    readPeer(peer: unknown, epoch: number, deadline: number): Promise<void>;
    peerStillValid(): Promise<boolean>;
  };
  bridge.peerStillValid = async () => true;
  const peer = {
    registration: { instance: "a".repeat(24) }, available: false, revision: 0, snapshots: new Map<string, Message>(), events: new Map<string, unknown>(),
    connection: { closed: false, request: async () => {
      await bridge.receivePeer(peer, { method: "thread/status/changed", params: { threadId: "live", status: { type: "idle" } } });
      return { data: [{ id: "live", status: { type: "active", activeFlags: [] }, model: "old" }], nextCursor: null };
    } },
  };
  await bridge.readPeer(peer, 0, Date.now() + 1000);
  assert.equal(peer.available, true);
  assert.deepEqual(peer.snapshots.get("live")!.status, { type: "idle" });
});

test("active flags preserve empty arrays through broker and event relay", async () => {
  const emitted: Message[] = []; const thread = { id: "empty-flags", status: { type: "active", activeFlags: [] } };
  const bridge = new NativeRuntimeStatus({ nativeHome: join(root, "empty-flags"), emitStatus: message => { emitted.push(message); }, readOnlyNativeRequest: source(thread, []) }) as unknown as BridgeInternals & { observe(message: Message): void };
  const listed = await bridge.runtimeRequest("runtime/list", {});
  assert.deepEqual((listed.data as Message[])[0]!.status, { type: "active", activeFlags: [] });
  const peer = { available: true, connection: { closed: false }, snapshots: new Map<string, Message>(), events: new Map<string, unknown>(), revision: 0 };
  await bridge.receivePeer(peer, { method: "thread/status/changed", params: { threadId: "empty-flags", status: { type: "active", activeFlags: [] } } });
  assert.deepEqual(emitted, [{ method: "thread/status/changed", params: { threadId: "empty-flags", status: { type: "active", activeFlags: [] } } }]);
  await bridge.receivePeer(peer, { id: 1, method: "thread/status/changed", params: { threadId: "empty-flags", status: { type: "active", activeFlags: [] } } });
  assert.equal(emitted.length, 1, "response callbacks do not become status events");
  await bridge.receivePeer(peer, { method: "thread/status/changed", params: { threadId: "empty-flags", status: { type: "active" } } });
  assert.equal(emitted.length, 1, "malformed active packets never gain invented flags");
});
