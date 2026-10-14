import test from "node:test";
import assert from "node:assert/strict";
import { ThreadStartOrder } from "../thread-start-order.js";

const started = (id: string) => ({ method: "thread/started", params: { thread: { id } } });
const event = (id: string, method = "turn/started") => ({ method, params: { threadId: id } });

test("a new thread's notifications wait for its reply and keep SDK order", () => {
  const order = new ThreadStartOrder();
  assert.equal(order.begin("thread/fork", { threadId: "parent" }), true);
  // Fork: the SDK sends token usage, then thread/started, after the reply.
  assert.deepEqual(order.admit(event("child", "thread/tokenUsage/updated")), []);
  assert.deepEqual(order.admit(started("child")), []);
  assert.deepEqual(order.admit(event("parent", "turn/completed")), [event("parent", "turn/completed")]);
  assert.deepEqual(order.settle("child"), [event("child", "thread/tokenUsage/updated"), started("child")]);
  assert.deepEqual(order.admit(event("child")), [event("child")]);
});

test("known chats keep streaming while a new chat is starting", () => {
  const order = new ThreadStartOrder();
  order.admit(event("active"));
  order.begin("thread/start", {});
  assert.deepEqual(order.admit(event("active", "item/agentMessage/delta")), [event("active", "item/agentMessage/delta")]);
});

test("another client's announcement is released, not dropped, when the start fails", () => {
  const order = new ThreadStartOrder();
  order.begin("thread/start", {});
  assert.deepEqual(order.admit(started("other")), []);
  assert.deepEqual(order.admit(event("other")), []);
  assert.deepEqual(order.settle(undefined), [started("other"), event("other")]);
});

test("a server request follows the notifications already held for its own chat", () => {
  const order = new ThreadStartOrder();
  order.begin("thread/start", {});
  // Another client loaded a chat this adapter has not seen, so its stream waits behind the reply.
  assert.deepEqual(order.admit(started("peer")), []);
  assert.deepEqual(order.admit(event("peer", "item/started")), []);
  assert.deepEqual(order.admit(event("other", "item/started")), []);
  const request = { id: "gateway-server-1", method: "item/commandExecution/requestApproval", params: { threadId: "peer" } };
  assert.deepEqual(order.before(request), [started("peer"), event("peer", "item/started")], "the request never overtakes its chat's own messages");
  assert.deepEqual(order.before(request), [], "released messages are never written twice");
  assert.deepEqual(order.settle(undefined), [event("other", "item/started")], "another chat's held messages still wait for the reply");
});

test("a request for a chat with nothing held is written on its own", () => {
  const order = new ThreadStartOrder();
  order.admit(event("active"));
  order.begin("thread/start", {});
  assert.deepEqual(order.before({ id: 1, method: "account/chatgptAuthTokens/refresh", params: {} }), []);
  assert.deepEqual(order.before({ id: 2, method: "item/plan/updated", params: { threadId: "unknown" } }), []);
});

test("a full buffer is written in order instead of growing", () => {
  const order = new ThreadStartOrder(2);
  order.begin("thread/start", {});
  order.admit(started("a")); order.admit(started("b"));
  assert.deepEqual(order.admit(started("c")), [started("a"), started("b"), started("c")]);
});
