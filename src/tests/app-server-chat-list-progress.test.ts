import assert from "node:assert/strict";
import test from "node:test";
import { AppServerChatList, type ChatListConnection } from "../app-server-chat-list.js";
import type { Message } from "../app-server-connection.js";
import type { SocketAppServerConnection } from "../socket-app-server-connection.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await pause(10);
  assert.ok(predicate(), "recovery must make progress without another client list");
}
const revision = "a".repeat(64);
const rows = (ids: string[]) => ({data: ids.map(id => ({id, status: {type: "notLoaded"}})), nextCursor: null});

test("a larger candidate page recovers across deadlines with at most four raw reads", async () => {
  const ids = Array.from({length: 12}, (_, index) => `chat-${index}`), recovered = new Set<string>();
  let available = false, active = 0, maximum = 0;
  const engine: ChatListConnection = {closed: false, async request(method, params) {
    if (method === "thread/loaded/list") return {data: ids, nextCursor: null};
    if (method === "thread/read") {
      active++; maximum = Math.max(maximum, active);
      try {await pause(20); return {thread: {id: params.threadId, status: {type: "active", activeFlags: []}}};}
      finally {active--;}
    }
    return {};
  }};
  const bridge = new AppServerChatList({sources: async () => available ? [{record: {revision, socketPath: "/unused", aliases: []}, connection: engine}] : [],
    initialized: () => ({}), emit: async message => {recovered.add(String((message.params as Message).threadId));}, timeoutMs: 50, intervalMs: 80});
  try {await bridge.hydrate(rows(ids)); available = true; await until(() => recovered.size === ids.length); assert.ok(maximum <= 4);}
  finally {await bridge.stop();}
});

test("one unanswered owned read cannot suppress successful neighbouring status snapshots", async () => {
  const ids = ["stalled", "healthy-1", "healthy-2", "healthy-3"], recovered = new Set<string>();
  let available = false;
  const observer = {closed: false, ready: Promise.resolve(), send() {}, stop() {this.closed = true;}, async request(method: string, params: Message) {
    if (method === "thread/loaded/list") return {data: ids, nextCursor: null};
    if (method === "thread/read") {
      if (params.threadId === "stalled") return new Promise<Message>(() => {});
      return {thread: {id: params.threadId, status: {type: "active", activeFlags: []}}};
    }
    return {};
  }};
  const bridge = new AppServerChatList({sources: async () => available ? [{record: {revision, socketPath: "/owned", aliases: []}}] : [],
    initialized: () => ({}), connection: () => observer as unknown as SocketAppServerConnection,
    emit: async message => {recovered.add(String((message.params as Message).threadId));}, timeoutMs: 35, intervalMs: 60});
  try {
    await bridge.hydrate(rows(ids)); available = true;
    await until(() => ids.slice(1).every(id => recovered.has(id)));
    assert.equal(recovered.has("stalled"), false);
  } finally {await bridge.stop();}
});
