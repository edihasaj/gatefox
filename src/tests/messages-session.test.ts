import test from "node:test";
import assert from "node:assert/strict";
import { messagesAgentId, messagesRequestKind, messagesSessionId } from "../protocol/messages-session.js";
import { messagesToResponses } from "../protocol/messages-request.js";
import { inferenceContext, providerConversationId } from "../providers/provider.js";

const id = "019a1234-5678-7890-abcd-0123456789ab";
const metadata = { user_id: JSON.stringify({ device_id: "private-device", account_uuid: "private-account", session_id: id }) };

test("Claude Code session metadata reaches routing while device and account identities stay private", () => {
  const request = messagesToResponses({ model: "alias", max_tokens: 32, metadata, messages: [{ role: "user", content: "Hello" }] });
  assert.equal(messagesSessionId(metadata), id);
  assert.deepEqual(inferenceContext({}, request), { sessionId: id });
  assert.equal(JSON.stringify(request).includes("private-device"), false);
  assert.equal(JSON.stringify(request).includes("private-account"), false);
  assert.deepEqual(inferenceContext({ "session-id": "explicit-session", "thread-id": "explicit-thread" }, request),
    { sessionId: "explicit-session", threadId: "explicit-thread" });
});

test("arbitrary user identity, invalid metadata and hostile values never select a conversation", () => {
  for (const value of [undefined, null, [], "value", { user_id: "same-user-across-chats" }, { user_id: "{bad" },
    { user_id: JSON.stringify({ session_id: id }) }, { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "not-a-uuid" }) },
    { user_id: JSON.stringify({ ...JSON.parse(metadata.user_id), padding: "x".repeat(4096) }) },
    new Proxy({}, { get() { throw Error("hostile"); } })]) assert.equal(messagesSessionId(value), undefined);
});

test("session-only clients use a distinct provider key while existing threads keep their identity", () => {
  assert.equal(providerConversationId({ threadId: id, sessionId: "other" }), id);
  assert.notEqual(providerConversationId({ sessionId: id }), providerConversationId({ threadId: id }));
  assert.equal(providerConversationId({ sessionId: id }), providerConversationId({ sessionId: id }));
  assert.equal(providerConversationId({}), undefined);
});

test("a subagent keeps a stable conversation of its own, apart from its parent", () => {
  const parent = messagesSessionId(metadata); const child = messagesSessionId(metadata, "agent-a");
  assert.equal(parent, id);
  assert.notEqual(child, parent);
  assert.equal(messagesSessionId(metadata, "agent-a"), child, "every turn of one subagent joins the same conversation");
  assert.notEqual(messagesSessionId(metadata, "agent-b"), child);
  assert.ok(child!.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(child!), "the routing context accepts the key unchanged");
  assert.equal(messagesSessionId(metadata, "teammate-name")!.includes("teammate-name"), false, "the raw agent name never becomes a routing value");
  assert.equal(messagesSessionId({ user_id: "same-user" }, "agent-a"), undefined, "an agent alone never creates a conversation");
  const request = messagesToResponses({ model: "alias", max_tokens: 8, metadata, messages: [{ role: "user", content: "hi" }] }, { agentId: "agent-a" });
  assert.equal(inferenceContext({}, request).sessionId, child);
});

test("only Claude Code's explicit hints change a request's kind", () => {
  assert.equal(messagesRequestKind({ "x-claude-code-request-class": "compaction" }), "compaction");
  assert.equal(messagesRequestKind({ "x-claude-code-request-class": "main", "x-claude-code-compaction": "auto" }), "compaction");
  assert.equal(messagesRequestKind({ "x-claude-code-request-class": "auxiliary" }), "auxiliary");
  for (const value of ["main", "subagent", "workflow", "unknown-future-class"]) assert.equal(messagesRequestKind({ "x-claude-code-request-class": value }), undefined);
  assert.equal(messagesRequestKind({}), undefined);
  assert.equal(messagesRequestKind({ "x-claude-code-request-class": ["auxiliary", "main"] }), undefined, "a repeated header is ignored");
  assert.equal(messagesAgentId({ "x-claude-code-agent-id": "x".repeat(257) }), undefined);
  assert.equal(messagesAgentId({ "x-claude-code-agent-id": ["a", "b"] }), undefined);
});
