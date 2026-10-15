import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { processStart } from "../providers/copilot-directories.js";
import { adapter, callIds, harness, live, lookupName, outputFor, png, tools, turn, until, user } from "./copilot-live-harness.js";

// The one-shot path is the fallback for every request a live session cannot take, and it seeds a live session the
// same way: caller instructions in the system message, one user message per item, the whole catalog every time.
const other = { type: "function" as const, name: "other", description: "Another", parameters: { type: "object", properties: {} } };

test("a one-shot request puts the caller's instructions in the system message and sends one message per conversation item", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const first = [user("first question")]; const provider = adapter({ mode: "oneshot" });
    const a = await turn(provider, first, { extra: { instructions: "Be brief and kind" } });
    await turn(provider, [...first, ...a.output, user("second question")], { extra: { instructions: "Be brief and kind" } });
    const entries = await h.log(); const creates = entries.filter(entry => entry.op === "create"); const sends = entries.filter(entry => entry.op === "session.sendMessages");
    assert.equal(live().sessions().length, 0, "a one-shot request leaves no session");
    assert.equal(creates.length, 2);
    assert.equal(creates[0].params.systemMessage.content, creates[1].params.systemMessage.content, "the system message is the same on every request of a thread, so it can be cached");
    assert.match(creates[0].params.systemMessage.content, /Caller instructions:\nBe brief and kind/);
    assert.ok(!creates[0].params.systemMessage.content.includes("first question"), "the history is not in the system message");
    assert.deepEqual(sends[0].prompts, ["<<item 1 user>>\nfirst question\n<</item>>"]);
    assert.equal(sends[1].prompts.length, 3, "one message per item: the question, the answer it got, the next question");
    assert.match(sends[1].prompts[2], /^<<item 3 user>>\nsecond question\n<<\/item>>$/);
    for (const { params, tmpdir, directory } of creates) {
      assert.equal(tmpdir, join(directory, "tmp"), "the one-shot CLI stages its temp files inside its private folder too");
      assert.deepEqual([params.toolSearch, params.largeOutput], [{ enabled: false }, { enabled: false }]);
      assert.deepEqual([params.tools[0].skipPermission, params.tools[0].defer, params.tools[0].name], [true, "never", lookupName]);
    }
  } finally { await h.restore(); }
});

test("a one-shot request's private folder carries its owner's pid and start time, so a later gateway can sweep it if this one is killed", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController(); const running = turn(adapter({ mode: "oneshot" }), [user("go [hang]")], { controller }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    try {
      const [name, ...rest] = await h.liveDirs(); assert.equal(rest.length, 0);
      assert.ok(name.startsWith(`gateway-copilot-run-${process.pid.toString(36)}-${(await processStart(process.pid))!.toString(36)}-`), name);
    } finally { controller.abort(); await running; }
    assert.ok(await until(async () => (await h.liveDirs()).length === 0));
  } finally { await h.restore(); }
});

test("a forced tool choice keeps the whole catalog in the one-shot session and names the tool on the last message", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "oneshot" });
    const forced = await turn(provider, [user("call it [tool]")], { extra: { tools: [tools[0], other], tool_choice: { type: "function", name: "lookup" } } });
    assert.equal(callIds(forced.output).length, 1);
    const entries = await h.log(); const [create] = entries.filter(entry => entry.op === "create"); const [send] = entries.filter(entry => entry.op === "session.sendMessages");
    assert.equal(create.params.tools.length, 2, "the catalog is not narrowed to the chosen tool");
    assert.deepEqual(create.params.availableTools, [...create.params.availableTools].sort());
    assert.match(send.prompts.at(-1), new RegExp(`\\nUse the required caller tool ${lookupName}\\.$`));
    // The same catalog in another order is the same system message and tool list.
    await turn(provider, [user("call it [tool]")], { extra: { tools: [other, tools[0]], tool_choice: { type: "function", name: "lookup" } } });
    const [, again] = (await h.log()).filter(entry => entry.op === "create");
    assert.equal(again.params.systemMessage.content, create.params.systemMessage.content); assert.deepEqual(again.params.tools, create.params.tools);
    // A model that calls another tool than the forced one fails the request.
    const error = await turn(provider, [user("call it [tool]")], { extra: { tools: [tools[0], other], tool_choice: { type: "function", name: "other" } } }).then(() => undefined, error => error as unknown);
    assert.ok(error instanceof ProviderError && error.code === "invalid_tool_call", String(error));
  } finally { await h.restore(); }
});

test("a one-shot request sends images as private file attachments on their item and answers a tool loop without a session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "oneshot" });
    const image = { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "look" }, { type: "input_image" as const, image_url: png }] };
    const a = await turn(provider, [image, user("what is it [tool]")]);
    const entries = await h.log(); const [send] = entries.filter(entry => entry.op === "session.sendMessages"); const [create] = entries.filter(entry => entry.op === "create");
    assert.deepEqual(send.attachments[0], [{ type: "file", path: join(create.directory, "images", "conversation-message-1-part-2.png"), displayName: "conversation-message-1-part-2" }]);
    assert.equal(send.files[0][0].sha, createHash("sha256").update(Buffer.from(png.split(",")[1], "base64")).digest("hex"));
    assert.ok(await until(async () => (await h.liveDirs()).length === 0), "the image goes with the request's folder");
    assert.ok(!send.attachments[1], "only the item that owns the image carries it");
    const b = await turn(provider, [image, user("what is it [tool]"), ...a.output, ...outputFor(a.output, "plain")]);
    assert.match(b.text, /^answer/); assert.equal(live().sessions().length, 0);
  } finally { await h.restore(); }
});
