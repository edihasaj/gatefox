import test from "node:test";
import assert from "node:assert/strict";
import { inferenceContext, maxTurnStateLength } from "../providers/provider.js";

const metadata = (fields: Record<string, unknown>) => JSON.stringify(fields);

test("feature thread sources survive header and body projections without overriding headers", () => {
  const body = { client_metadata: { "x-codex-turn-metadata": metadata({ thread_source: "composer_predictions" }) } };
  const complete = { turn_id: "turn", request_kind: "turn" };
  assert.equal(inferenceContext({}, body).threadSource, "composer_predictions");
  assert.equal(inferenceContext({ "x-codex-turn-metadata": metadata(complete) }, body).threadSource, "composer_predictions");
  assert.equal(inferenceContext({ "x-codex-turn-metadata": metadata({ ...complete, thread_source: "user" }) }, body).threadSource, "user");
  for (const thread_source of [null, 1, {}, [], "x".repeat(129), "has spaces"]) {
    assert.equal(inferenceContext({ "x-codex-turn-metadata": metadata({ thread_source }) }).threadSource, undefined);
  }
});

test("Codex routing headers fill every context field", () => {
  assert.deepEqual(inferenceContext({
    "session-id": "019a-session", "thread-id": "019a-thread", "x-codex-window-id": "019a-thread:3",
    "x-codex-turn-state": "gts1:scope:YWJj", "x-codex-turn-metadata": metadata({ turn_id: "019a-turn", request_kind: "compaction", workspaces: { a: {} } }),
  }), { sessionId: "019a-session", threadId: "019a-thread", windowId: "019a-thread:3", turnState: "gts1:scope:YWJj", turnId: "019a-turn", requestKind: "compaction" });
  for (const kind of ["turn", "prewarm", "memory"]) assert.equal(inferenceContext({ "x-codex-turn-metadata": metadata({ request_kind: kind }) }).requestKind, kind);
  assert.deepEqual(inferenceContext({}), {});
});

test("body client_metadata fills only what the headers lack", () => {
  const body = { model: "m", input: "hi", client_metadata: {
    session_id: "body-session", thread_id: "body-thread", turn_id: "body-turn", "x-codex-window-id": "body-thread:1",
    "x-codex-turn-metadata": metadata({ turn_id: "meta-turn", request_kind: "memory", tool_namespaces_info: { tools: "x".repeat(64 * 1024) } }),
    "x-codex-turn-state": "never-read-from-body",
  } };
  assert.deepEqual(inferenceContext({}, body), { sessionId: "body-session", threadId: "body-thread", turnId: "body-turn", windowId: "body-thread:1", requestKind: "memory" });
  assert.deepEqual(inferenceContext({ "session-id": "header-session", "x-codex-turn-metadata": metadata({ turn_id: "header-turn", request_kind: "turn" }) }, body),
    { sessionId: "header-session", threadId: "body-thread", turnId: "header-turn", windowId: "body-thread:1", requestKind: "turn" });
  assert.equal(inferenceContext({}, { client_metadata: { "x-codex-turn-metadata": metadata({ turn_id: "meta-turn" }) } }).turnId, "meta-turn");
  assert.equal(inferenceContext({ "x-codex-turn-metadata": "{bad" }, body).requestKind, "memory", "a malformed header falls back to the body");
});

test("oversize, non-printable, repeated and malformed values are dropped", () => {
  const dropped = inferenceContext({
    "session-id": "a".repeat(129), "thread-id": "space here", "x-codex-window-id": "w".repeat(257),
    "x-codex-turn-state": "x".repeat(maxTurnStateLength + 1), "x-codex-turn-metadata": metadata({ turn_id: "t", pad: "p".repeat(16 * 1024) }),
  });
  assert.deepEqual(dropped, {});
  assert.equal(inferenceContext({ "x-codex-turn-state": "x".repeat(maxTurnStateLength) }).turnState?.length, maxTurnStateLength);
  for (const value of ["", "has space", "tab\there", "line\nbreak", "café", "a, b", ["a", "b"]]) {
    assert.deepEqual(inferenceContext({ "x-codex-turn-state": value as string, "x-codex-window-id": value as string }), {}, JSON.stringify(value));
  }
  for (const value of ["{bad", "[]", "null", "42", "\"turn\"", metadata({ turn_id: "bad id", request_kind: "review" }), metadata({ turn_id: 7, request_kind: ["turn"] })]) {
    assert.deepEqual(inferenceContext({ "x-codex-turn-metadata": value }), {}, value);
  }
  assert.deepEqual(inferenceContext({ "x-codex-turn-metadata": metadata({ turn_id: "ok", request_kind: "unknown" }) }), { turnId: "ok" });
  assert.deepEqual(inferenceContext({}, { client_metadata: { "x-codex-turn-metadata": metadata({ request_kind: "turn", pad: "p".repeat(1024 * 1024) }) } }), {});
});

test("inferenceContext never throws on hostile input", () => {
  const throwing = new Proxy({}, { get() { throw new Error("boom"); } });
  for (const body of [undefined, null, 42, "text", [], { client_metadata: null }, { client_metadata: [] }, { client_metadata: "x" }, throwing, { client_metadata: throwing }]) {
    assert.deepEqual(inferenceContext({}, body), {});
  }
  assert.deepEqual(inferenceContext({ "session-id": "kept" }, { client_metadata: throwing }), { sessionId: "kept" });
  assert.deepEqual(inferenceContext(throwing as Record<string, string>), {});
});
