import assert from "node:assert/strict";
import test from "node:test";
import { AdapterRuntimeMetadata, type RuntimeMetadataConnection, type RuntimeMetadataSource } from "../adapter-runtime-metadata.js";
import type { Message } from "../app-server-connection.js";

const id = (tail: number) => `018f5d11-1234-7abc-8def-${String(tail).padStart(12, "0")}`;

type FixtureConnection = RuntimeMetadataConnection & { calls: Array<{ method: string; params: Message }> };
function source(pages: string[][], reads: Record<string, Message> = {}): { source: RuntimeMetadataSource; connection: FixtureConnection } {
  let open = true;
  const connection: FixtureConnection = {
    closed: false, calls: [],
    async request(method, params) {
      connection.calls.push({ method, params });
      if (method === "thread/loaded/list") {
        const page = params.cursor === undefined ? 0 : Number(params.cursor);
        if (!Number.isInteger(page) || page < 0 || page >= pages.length) throw new Error("unexpected cursor");
        return { data: pages[page]!, nextCursor: page + 1 < pages.length ? String(page + 1) : null };
      }
      if (method === "thread/read") return { thread: reads[String(params.threadId)] ?? { id: params.threadId, status: { type: "idle" } } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { connection, source: { connection, current: () => open && !connection.closed } };
}

test("aggregates native and private SDK cursors into broker-sized sorted pages", async () => {
  const nativeIds = Array.from({ length: 101 }, (_, index) => id(index + 20));
  const gatewayId = id(1);
  const native = source([nativeIds.slice(0, 100), nativeIds.slice(100)]);
  const gateway = source([[gatewayId]], { [gatewayId]: { id: gatewayId, status: { type: "active", activeFlags: ["waitingOnApproval"] }, model: "gateway/model" } });
  const metadata = new AdapterRuntimeMetadata(() => native.source, () => [gateway.source]);

  const first = await metadata.request("thread/loaded/list", { limit: 100 });
  assert.deepEqual(native.connection.calls.filter(call => call.method === "thread/loaded/list").map(call => call.params.cursor), [undefined, "1"]);
  assert.equal((first.data as string[]).length, 100); assert.equal(first.nextCursor, nativeIds[98]);
  assert.equal((first.data as string[])[0], gatewayId);
  const second = await metadata.request("thread/loaded/list", { limit: 100, cursor: first.nextCursor });
  assert.deepEqual(second.data, nativeIds.slice(99)); assert.equal(second.nextCursor, null);

  const read = await metadata.request("thread/read", { threadId: gatewayId });
  assert.deepEqual(read.thread, { id: gatewayId, status: { type: "active", activeFlags: ["waitingOnApproval"] }, model: "gateway/model" });
  assert.deepEqual(gateway.connection.calls.at(-1)?.params, { threadId: gatewayId, includeTurns: false });
  assert.equal(gateway.connection.calls.some(call => call.method === "turn/read"), false);
});

test("fails closed for duplicate owners, stale sockets, and unknown metadata ids", async () => {
  const duplicate = id(7); const native = source([[duplicate]]); const gateway = source([[duplicate]]);
  const metadata = new AdapterRuntimeMetadata(() => native.source, () => [gateway.source]);
  await assert.rejects(metadata.request("thread/loaded/list", { limit: 100 }), /duplicate/);

  const live = source([[id(8)]]); const stale = new AdapterRuntimeMetadata(() => live.source, () => []);
  await stale.request("thread/loaded/list", { limit: 100 }); (live.connection as { closed: boolean }).closed = true;
  await assert.rejects(stale.request("thread/read", { threadId: id(8) }), /Unknown/);
  await assert.rejects(stale.request("thread/read", { threadId: id(9) }), /Unknown/);
});

test("coalesces concurrent complete enumerations without stopping borrowed SDKs", async () => {
  let resolveList!: (result: Message) => void; let lists = 0;
  const connection: FixtureConnection = {
    closed: false, calls: [],
    async request(method, params) {
      connection.calls.push({ method, params });
      if (method !== "thread/loaded/list") throw new Error("unexpected read");
      lists++;
      return await new Promise<Message>(resolve => { resolveList = resolve; });
    },
  };
  const metadata = new AdapterRuntimeMetadata(() => ({ connection, current: () => !connection.closed }), () => []);
  const first = metadata.request("thread/loaded/list", { limit: 100 });
  const second = metadata.request("thread/loaded/list", { limit: 100 });
  assert.equal(lists, 1);
  resolveList({ data: [id(10)], nextCursor: null });
  assert.deepEqual((await first).data, [id(10)]); assert.deepEqual((await second).data, [id(10)]);
  assert.equal(connection.closed, false);
});

test("an expired enumeration never requests another page or gateway source", async () => {
  let clock = 0; let requests = 0;
  const connection: RuntimeMetadataConnection = {
    closed: false,
    async request() {
      requests++; clock = 1001;
      return { data: [id(1)], nextCursor: id(1) };
    },
  };
  const native = { connection, current: () => true };
  const gateway = source([[id(2)]]);
  const metadata = new AdapterRuntimeMetadata(() => native, () => [gateway.source], () => clock);
  await assert.rejects(metadata.request("thread/loaded/list", { limit: 100 }), /timed out/);
  assert.equal(requests, 1);
  assert.equal(gateway.connection.calls.length, 0);
});
