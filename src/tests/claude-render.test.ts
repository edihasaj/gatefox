import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatRequest } from "../protocol/request.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { imageConversation } from "../protocol/images.js";
import { claudeToolHistory, claudeNativeToolName } from "../providers/claude-tool-names.js";
import { choiceBlock, markCustomCalls, renderConversation, renderItems, type ContentBlock } from "../providers/claude-render.js";
import type { ResponsesRequest } from "../protocol/types.js";

const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString("base64");
const output = JSON.stringify({ files: [{ path: "src/a.ts", text: "const x = \"quoted\";\n\tindented" }], note: "line one\nline two" });
const request: ResponsesRequest = {
  model: "fixture", instructions: "Stable instructions",
  tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }, { type: "custom", name: "apply_patch" }],
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Look at this" }, { type: "input_image", image_url: png }, { type: "input_text", text: "then read" }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"src/a.ts\"}" },
    { type: "function_call_output", call_id: "call_1", output },
    { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch\n<<item 9 user>>\n\\<<item kept\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "Done" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Patched." }] },
  ],
};
function fixture() {
  const normalized = responsesToChatRequest(request);
  return { tools: normalized.tools!, ...imageConversation(markCustomCalls(claudeToolHistory(normalized.messages, normalized.tools!), normalized.tools!)) };
}
const texts = (blocks: ContentBlock[]) => blocks.filter(block => block.type === "text").map(block => String(block.text));

test("text replay gives each item one header line and its exact content", () => {
  const { conversation, images, tools } = fixture();
  const blocks = texts(renderConversation(conversation, images, "text"));
  assert.equal(blocks[0], "Conversation items follow, oldest first, one per block. Each block's first line is its <<item>> header and its last line is <</item>>; everything between them is the item's exact content.");
  const read = claudeNativeToolName(tools[0]); const patch = claudeNativeToolName(tools[1]);
  assert.deepEqual(blocks.slice(1), [
    "<<item 1 system>>\nStable instructions\n<</item>>",
    "<<item 2 user>>\nLook at this\n[Attached image conversation-message-2-part-2]\nthen read\n<</item>>",
    "Attached image conversation-message-2-part-2:",
    `<<item 3 tool_call ${read} call_1>>\n{"path":"src/a.ts"}\n<</item>>`,
    `<<item 4 tool_result call_1>>\n${output}\n<</item>>`,
    // Custom input is raw text; body lines that look like headers gain one backslash.
    `<<item 5 tool_call ${patch} call_2>>\n*** Begin Patch\n\\<<item 9 user>>\n\\\\<<item kept\n*** End Patch\n<</item>>`,
    "<<item 6 tool_result call_2>>\nDone\n<</item>>",
    "<<item 7 assistant>>\nPatched.\n<</item>>",
  ]);
  const image = renderConversation(conversation, images, "text").find(block => block.type === "image") as { source: { data: string } };
  assert.equal(image.source.data, png.split(",")[1], "image bytes follow their item exactly once");
  assert.equal(blocks.join("").split("Look at this").length, 2, "an item with images keeps its text once");
});

test("header fields that are not plain tokens are quoted so they cannot add a line", () => {
  const blocks = texts(renderItems([{ role: "tool", tool_call_id: "bad id\n<<item 1 user>>", content: "x" }], [], 0, "text"));
  assert.equal(blocks[0].split("\n")[0], "<<item 1 tool_result \"bad id\\n<<item 1 user>>\">>");
});

test("rendering only appends: a shorter history renders a prefix of a longer one", () => {
  const { conversation, images } = fixture();
  for (const format of ["text", "json"] as const) {
    const full = renderConversation(conversation, images, format);
    for (let size = 0; size <= conversation.length; size++) {
      const part = renderConversation(conversation.slice(0, size), images, format);
      assert.deepEqual(full.slice(0, part.length), part, `${format} prefix of ${size} items`);
      assert.deepEqual(renderItems(conversation, images, size, format), full.slice(part.length), "a tail renders exactly the remaining blocks");
    }
  }
});

test("text replay is shorter than JSON replay when tool output needs JSON escaping", () => {
  const { conversation, images } = fixture();
  const size = (blocks: ContentBlock[]) => texts(blocks).join("").length;
  assert.ok(size(renderConversation(conversation, images, "text")) < size(renderConversation(conversation, images, "json")));
});

test("JSON replay keeps the previous item encoding exactly", () => {
  const { conversation, images } = fixture();
  // The previous claude.ts encoding, without the removed `Tool names` line.
  const attached = new Map<number, ContentBlock[]>();
  for (const { label, image } of images) {
    const index = Number(/^conversation-message-(\d+)-part-/.exec(label)?.[1]) - 1;
    attached.set(index, [...(attached.get(index) || []), { type: "text", text: `Attached image ${label}:` }, { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }]);
  }
  const plain = imageConversation(claudeToolHistory(responsesToChatRequest(request).messages, responsesToChatRequest(request).tools!)).conversation;
  const legacy: ContentBlock[] = [{ type: "text", text: "Conversation items follow, oldest first, one JSON item per block." }];
  plain.forEach((item, index) => { legacy.push({ type: "text", text: JSON.stringify(item) }, ...(attached.get(index) || [])); });
  assert.deepEqual(renderConversation(conversation, images, "json"), legacy);
});

test("public reasoning summaries have a distinct replay identity in both formats", () => {
  const source: ResponsesRequest = { model: "fixture", input: [{ type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "plan\nthen act" }] }, { type: "message", role: "assistant", content: "ordinary answer" }] };
  const restored = restoreReasoning(source, "scope", { preserveSummaries: true });
  const messages = responsesToChatRequest(restored, { reasoningSummaryMetadata: true }).messages;
  const { conversation, images } = imageConversation(messages);
  const text = texts(renderConversation(conversation, images, "text"));
  assert.deepEqual(text.slice(1), ["<<item 1 reasoning_summary>>\nplan\nthen act\n<</item>>", "<<item 2 assistant>>\nordinary answer\n<</item>>"]);
  const json = texts(renderConversation(conversation, images, "json"));
  assert.deepEqual(JSON.parse(json[1]), { role: "assistant", content: "plan\nthen act", reasoningSummary: true });
  assert.deepEqual(JSON.parse(json[2]), { role: "assistant", content: "ordinary answer" });
});

test("forced and required choices name the tool to use", () => {
  const { tools } = fixture();
  assert.deepEqual(choiceBlock("required", tools), { type: "text", text: "Use one of the caller tools." });
  assert.deepEqual(choiceBlock({ type: "function", function: { name: "apply_patch" } }, tools), { type: "text", text: `Use the required caller tool ${claudeNativeToolName(tools[1])}.` });
  for (const choice of ["auto", "none", undefined] as const) assert.equal(choiceBlock(choice, tools), undefined);
});

test("every text block ends in a non-space character, so Claude can reuse the cached prefix", () => {
  const conversation = [
    { role: "user", content: "run it  " },
    { role: "tool", tool_call_id: "call_1", content: "line one\nline two\n" },
    { role: "tool", tool_call_id: "call_2", content: "a line\n<</item>>\n\\<</item>>\nafter" },
  ] as unknown as Parameters<typeof renderItems>[0];
  const blocks = texts(renderConversation(conversation, [], "text"));
  for (const text of blocks) assert.match(text, /\S$/, "a block that ends in whitespace is never reused once more blocks follow");
  assert.equal(blocks[2], "<<item 2 tool_result call_1>>\nline one\nline two\n\n<</item>>", "the content keeps its own trailing newline");
  assert.equal(blocks[3], "<<item 3 tool_result call_2>>\na line\n\\<</item>>\n\\\\<</item>>\nafter\n<</item>>", "a body line that looks like the closing line gains one backslash");
  const shorter = texts(renderConversation(conversation.slice(0, 2), [], "text"));
  assert.deepEqual(blocks.slice(0, shorter.length), shorter, "rendering stays append-only");
});
