import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppServerBackends } from "../app-server-backends.js";
import { CallbackHistoryFull, CallbackLedger, CallbackReplayed, COMPLETED_RANGES, COMPLETED_STRINGS, CompletedNumbers, PROTECTED_CALLBACKS } from "../callback-state.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { Id, Message } from "../app-server-connection.js";
import type { NativeRpcConnection } from "../shared-native-connection.js";
import type { GatewayConfig } from "../config.js";

test("completed ids merge only when both were actually completed", () => {
  const numbers = new CompletedNumbers();
  for (const value of [10, 12, 11, -3, -2]) numbers.add(value);
  assert.equal(numbers.size, 2); // [-3,-2] and [10,12]
  for (const value of [10, 11, 12, -3, -2]) assert.equal(numbers.has(value), true);
  for (const value of [9, 13, -4, -1, 0, 5]) assert.equal(numbers.has(value), false, `unseen ${value} is not claimed`);
  numbers.add(5); assert.equal(numbers.has(5), true); assert.equal(numbers.has(4), false); assert.equal(numbers.has(6), false);
});

test("the ledger keeps numeric and string ids apart and refuses ids it cannot remember exactly", () => {
  const ledger = new CallbackLedger();
  ledger.admit(1); ledger.track(1, "d1"); ledger.complete(1, "d1", "f");
  assert.equal(ledger.completed(1), true); assert.equal(ledger.completed("1"), false);
  for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Infinity]) assert.throws(() => ledger.admit(bad));
  ledger.admit(-7);
});

test("disjoint numeric and string history fail closed at their bounds", () => {
  const numbers = new CallbackLedger();
  for (let i = 0; i < COMPLETED_RANGES; i++) { numbers.admit(i * 2); numbers.complete(i * 2, `d${i}`, "f"); }
  assert.throws(() => numbers.admit(1_000_001), CallbackHistoryFull);
  const strings = new CallbackLedger();
  for (let i = 0; i < COMPLETED_STRINGS; i++) { strings.admit(`s${i}`); strings.complete(`s${i}`, `d${i}`, "f"); }
  assert.throws(() => strings.admit("one-more"), CallbackHistoryFull);
  strings.admit(5); // numbers have their own room
});

async function adapter() {
  const directory = await mkdtemp(join(tmpdir(), "gw-callback-state-"));
  const snapshot = () => ({ revision: "1".repeat(64), models: [] as Message[] });
  const catalog = { current: snapshot, refresh: async () => snapshot(), combined: (value: ReturnType<typeof snapshot>) => ({ models: value.models }) } as unknown as DesktopCatalog;
  const native: NativeRpcConnection = { closed: false, exited: Promise.resolve({ code: 0, signal: null }), drained: Promise.resolve(), request: async () => ({}), send: () => {}, stop: () => {} };
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [], clientOnly: true };
  const emitted: Message[] = [];
  const backends = new AppServerBackends("/fixture/codex", ["app-server"], config, {}, {}, catalog, async message => { emitted.push(message); }, () => {}, join(directory, "gateway.json"), () => native);
  interface Internals { forward(connection: unknown, message: Message): Promise<void>; forgetConnection(connection: unknown, preserve?: boolean): void; engines: unknown[]; serverSequence: number;
    approvals: Map<string, unknown>; uncertainApprovals: Map<string, unknown> }
  const internals = backends as unknown as Internals;
  const socket = { inode: "1", device: "1" };
  function connection(withEngine = false) {
    const value = { closed: false, sent: [] as Message[], send(message: Message) { this.sent.push(message); }, request: async () => ({}), stop() {} };
    if (withEngine) internals.engines.push({ connection: value, revision: "r", aliases: new Set(), threads: new Set(), active: new Map(), requests: 0, shared: true, socket });
    return value;
  }
  const call = (id: Id, extra: Message = {}, method = "item/tool/call"): Message => ({ id, method, params: { ...extra } });
  const threaded = (id: Id, method = "item/tool/call") => call(id, { threadId: "chat-1", tool: "t" }, method);
  const desktopId = (index = emitted.length - 1) => String(emitted[index].id);
  return { backends, internals, emitted, connection, call, threaded, desktopId };
}

test("more than 256 successful ordinary callbacks never exhaust the next callback", async () => {
  const a = await adapter(); const c = a.connection();
  for (let i = 1; i <= 600; i++) {
    await a.internals.forward(c, a.call(i, { attestation: i }));
    assert.equal(a.backends.reply({ id: a.desktopId(), result: { ok: true } }), true);
  }
  assert.equal(a.internals.approvals.size, 0);
  await a.internals.forward(c, a.call(601)); await a.internals.forward(c, a.call("str-1", {}, "item/commandExecution/requestApproval"));
  assert.equal(c.sent.length, 600); assert.equal(a.emitted.length, 602);
});

test("256 unanswered callbacks still refuse the next one until one is answered", async () => {
  const a = await adapter(); const c = a.connection();
  for (let i = 1; i <= 256; i++) await a.internals.forward(c, a.call(i));
  await assert.rejects(a.internals.forward(c, a.call(257)), /Invalid or excessive/);
  assert.equal(a.backends.reply({ id: a.desktopId(0), result: {} }), true);
  await a.internals.forward(c, a.call(257));
});

test("a duplicate is ignored, a changed duplicate fails, and an aged-out id never runs twice", async () => {
  const a = await adapter(); const c = a.connection();
  await a.internals.forward(c, a.call(1, { x: 1 })); const first = a.desktopId();
  await a.internals.forward(c, a.call(1, { x: 1 })); assert.equal(a.emitted.length, 2); // pending duplicate re-shows the same prompt
  assert.equal(a.emitted[1].id, first);
  await assert.rejects(a.internals.forward(c, a.call(1, { x: 2 })), /Inconsistent/);
  a.backends.reply({ id: first, result: {} });
  const before = a.emitted.length;
  await a.internals.forward(c, a.call(1, { x: 1 })); assert.equal(a.emitted.length, before, "a recent answered duplicate shows nothing");
  await assert.rejects(a.internals.forward(c, a.call(1, { x: 2 })), /Inconsistent/);
  for (let i = 2; i < 700; i++) { await a.internals.forward(c, a.call(i)); a.backends.reply({ id: a.desktopId(), result: {} }); }
  const emitted = a.emitted.length;
  await assert.rejects(a.internals.forward(c, a.call(1, { x: 1 })), CallbackReplayed);
  assert.equal(a.emitted.length, emitted); assert.equal(c.sent.length, 699);
});

test("an unseen lower numeric id still arrives after higher ids completed", async () => {
  const a = await adapter(); const c = a.connection();
  for (const id of [100, 101, 300, 301]) { await a.internals.forward(c, a.call(id)); a.backends.reply({ id: a.desktopId(), result: {} }); }
  await a.internals.forward(c, a.call(50)); assert.equal(a.emitted.length, 5);
  a.backends.reply({ id: a.desktopId(), result: {} });
  await a.internals.forward(c, a.call(200)); assert.equal(a.emitted.length, 6);
  await a.internals.forward(c, a.call("100")); assert.equal(a.emitted.length, 7, "string 100 is not numeric 100");
});

test("a resolved callback is cleaned up once and its id never runs again", async () => {
  const a = await adapter(); const c = a.connection();
  await a.internals.forward(c, a.call(7)); const id = a.desktopId();
  await a.internals.forward(c, { method: "serverRequest/resolved", params: { requestId: 7 } });
  assert.equal(a.emitted.length, 2); assert.equal((a.emitted[1].params as Message).requestId, id);
  await a.internals.forward(c, { method: "serverRequest/resolved", params: { requestId: 7 } }); assert.equal(a.emitted.length, 2);
  assert.equal(a.internals.approvals.size, 0); assert.equal(a.backends.reply({ id, result: {} }), false);
  await a.internals.forward(c, a.call(7)); assert.equal(a.emitted.length, 2, "a resolved duplicate shows nothing");
  // Answered first, resolved later: the desktop hears it once.
  await a.internals.forward(c, a.call(8)); const second = a.desktopId(); a.backends.reply({ id: second, result: {} });
  await a.internals.forward(c, { method: "serverRequest/resolved", params: { requestId: 8 } });
  await a.internals.forward(c, { method: "serverRequest/resolved", params: { requestId: 8 } });
  assert.equal(a.emitted.filter(m => m.method === "serverRequest/resolved").length, 2);
});

test("a true pending approval survives hundreds of answered attestations", async () => {
  const a = await adapter(); const c = a.connection(true);
  await a.internals.forward(c, a.threaded(1, "item/commandExecution/requestApproval")); const approval = a.desktopId();
  for (let i = 2; i < 600; i++) { await a.internals.forward(c, a.call(i, { attestation: true })); a.backends.reply({ id: a.desktopId(), result: {} }); }
  assert.equal(a.internals.uncertainApprovals.size, 0);
  assert.equal(a.backends.reply({ id: approval, result: { decision: "accept" } }), true);
  assert.deepEqual(c.sent.at(-1), { id: 1, result: { decision: "accept" } });
});

test("a threaded tool result lost with its socket replays under the original desktop id exactly once", async () => {
  const a = await adapter(); const first = a.connection(true);
  const request = a.threaded(5);
  await a.internals.forward(first, request); const id = a.desktopId(); const sequence = a.internals.serverSequence;
  assert.equal(a.backends.reply({ id, result: { ok: 1 } }), true); assert.equal(first.sent.length, 1);
  first.closed = true; a.internals.forgetConnection(first, true);
  const second = a.connection(true);
  await a.internals.forward(second, request);
  assert.equal(a.emitted.at(-1)!.id, id); assert.equal(a.internals.serverSequence, sequence, "no new desktop id");
  assert.equal(a.backends.reply({ id, result: { ok: 1 } }), true); assert.equal(second.sent.length, 1);
  assert.equal(a.backends.reply({ id, result: { ok: 1 } }), false, "a second answer is refused");
  const shown = a.emitted.length; await a.internals.forward(second, request);
  assert.equal(a.emitted.length, shown, "the answered duplicate shows nothing"); assert.equal(second.sent.length, 1);
});

test("protected threaded callbacks refuse new ones at capacity instead of evicting, and the oldest still replays", async () => {
  const a = await adapter(); const first = a.connection(true);
  for (let i = 1; i <= PROTECTED_CALLBACKS; i++) { await a.internals.forward(first, a.threaded(i)); assert.equal(a.backends.reply({ id: a.desktopId(), result: {} }), true); }
  const oldestDesktop = String(a.emitted[0].id);
  await assert.rejects(a.internals.forward(first, a.threaded(PROTECTED_CALLBACKS + 1)), CallbackHistoryFull);
  assert.equal(a.emitted.length, PROTECTED_CALLBACKS, "the refused callback executed nothing");
  // Ordinary unthreaded traffic is unaffected by the full protected set.
  await a.internals.forward(first, a.call(9000, { attestation: true }));
  first.closed = true; a.internals.forgetConnection(first, true);
  const second = a.connection(true);
  await a.internals.forward(second, a.threaded(1));
  assert.equal(a.emitted.at(-1)!.id, oldestDesktop);
  // A terminal turn releases the protected slots.
  await a.internals.forward(second, { method: "turn/completed", params: { threadId: "chat-1", turn: { id: "t1", status: "completed" } } });
  assert.equal(a.internals.uncertainApprovals.size, 0);
  await a.internals.forward(second, a.threaded(PROTECTED_CALLBACKS + 1));
});

test("a protected reply whose fingerprint aged out is still retired once by a genuine resolved", async () => {
  const a = await adapter(); const c = a.connection(true);
  await a.internals.forward(c, a.threaded(1)); const id = a.desktopId();
  assert.equal(a.backends.reply({ id, result: { ok: 1 } }), true); assert.equal(a.internals.uncertainApprovals.size, 1);
  for (let i = 2; i < 400; i++) { await a.internals.forward(c, a.call(i, { attestation: true })); a.backends.reply({ id: a.desktopId(), result: {} }); }
  assert.equal(a.internals.uncertainApprovals.size, 1, "attestation traffic does not touch the protected slot");
  const before = a.emitted.length;
  await a.internals.forward(c, { method: "serverRequest/resolved", params: { requestId: 1 } });
  assert.equal(a.emitted.length, before + 1); assert.equal((a.emitted.at(-1)!.params as Message).requestId, id);
  assert.equal(a.internals.uncertainApprovals.size, 0, "the slot is freed");
  await a.internals.forward(c, { method: "serverRequest/resolved", params: { requestId: 1 } });
  assert.equal(a.emitted.length, before + 1, "the desktop hears it once");
  await assert.rejects(a.internals.forward(c, a.threaded(1, "item/tool/call")), CallbackReplayed);
});
