import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { inlineResultBytes } from "../providers/copilot-render.js";
import type { ResponsesInputItem } from "../protocol/types.js";
import { adapter, callIds, harness, live, turn, until, user, type Entry, type Harness } from "./copilot-live-harness.js";

// Screenshots add up: each image may carry up to 8 MiB of base64, and one RPC message to the CLI is limited to 16 MiB.
// The bytes of a user item's images therefore never travel in a message; only a tool result's images do, within a budget.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const bytes = Buffer.concat([signature, Buffer.alloc(4_700_000, 7)]);
const big = `data:image/png;base64,${bytes.toString("base64")}`;
const sha = createHash("sha256").update(bytes).digest("hex");
const screenshots = (count: number) => Array.from({ length: count }, () => ({ type: "input_image" as const, image_url: big }));
const sends = async (h: Harness): Promise<Entry[]> => (await h.log()).filter(entry => entry.op === "session.sendMessages");

test("a history with more than 16 MiB of images is served, live and one-shot: the images are private files, not message bytes", async () => {
  assert.ok(3 * big.length > 16 * 1024 * 1024, "the images alone pass the RPC limit");
  for (const mode of ["live", "oneshot"]) {
    const h = await harness();
    try {
      const input: ResponsesInputItem[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, ...screenshots(3)] }];
      const a = await turn(adapter({ mode }), input, { context: { threadId: `big-${mode}` } });
      assert.match(a.text, /^answer/, mode);
      const [create] = (await h.log()).filter(entry => entry.op === "create"); const [send] = await sends(h);
      assert.equal(send.attachments[0].length, 3);
      for (const [index, attachment] of send.attachments[0].entries()) {
        assert.equal(attachment.type, "file", mode); assert.equal(attachment.data, undefined);
        assert.equal(attachment.path, join(create.directory, "images", `conversation-message-1-part-${index + 2}.png`));
        assert.deepEqual([send.files[0][index].sha, send.files[0][index].mode], [sha, 0o600], `${mode}: the file holds the image, private to its owner`);
      }
      await live().stop();
      assert.ok(await until(async () => (await h.liveDirs()).length === 0), `${mode}: the images go with the CLI's folder`);
    } finally { await h.restore(); }
  }
});

test("a tool result whose images pass the inline budget starts the thread over, where they become files; a smaller one is handed over inline", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tool]")];
    const a = await turn(provider, first);
    const [call] = callIds(a.output);
    const small: ResponsesInputItem[] = [{ type: "function_call_output", call_id: call, output: [{ type: "input_text", text: "one screenshot" }, ...screenshots(1)] }];
    const b = await turn(provider, [...first, ...a.output, ...small]);
    assert.match(b.text, /^answer/);
    const [delivered] = (await h.log()).filter(entry => entry.op === "deliver");
    assert.equal(delivered.result.binaryResultsForLlm.length, 1, "one screenshot fits a pending call's answer");
    // The next tool result carries three screenshots: more than one message can take inline.
    const second = [...first, ...a.output, ...small, ...b.output, user("again [tool]")];
    const c = await turn(provider, second); const [next] = callIds(c.output);
    const large: ResponsesInputItem[] = [{ type: "function_call_output", call_id: next, output: [{ type: "input_text", text: "three screenshots" }, ...screenshots(3)] }];
    assert.ok(3 * big.length > inlineResultBytes);
    const d = await turn(provider, [...second, ...c.output, ...large]);
    assert.match(d.text, /^answer/);
    assert.equal((await h.log()).filter(entry => entry.op === "deliver").length, 1, "the large result was not handed over inline");
    const outcomes = (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
    assert.ok(outcomes.includes("reseeded:large_tool_result"), outcomes.join(","));
    const seed = (await sends(h)).at(-1)!;
    const files = seed.attachments.flatMap((attachments: Array<Record<string, unknown>> | null) => attachments ?? []);
    assert.equal(files.length, 4, "the seed carries every image of the history as a file"); assert.ok(files.every((file: Record<string, unknown>) => file.type === "file"));
  } finally { await h.restore(); }
});
