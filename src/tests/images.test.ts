import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatRequest } from "../protocol/request.js";
import { inlineImage, imageConversation, anthropicParts } from "../protocol/images.js";
import { modelCatalog } from "../catalog.js";
import { validateConfig } from "../config.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image = { type: "input_image" as const, image_url: "data:image/png;base64," + png, detail: "original" as const };

test("inline images preserve content order, tool-result ownership, and native image blocks without text-encoding bytes", () => {
  const normalized = responsesToChatRequest({ model: "test", input: [
    { role: "user", content: [{ type: "input_text", text: "First:" }, image, { type: "input_text", text: "Last." }] },
    { type: "function_call", name: "view_image", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: [image] },
  ] });
  assert.deepEqual(normalized.messages[0].parts?.map(part => part.type), ["text", "image", "text"]);
  assert.equal(normalized.messages[2].role, "tool"); assert.equal(normalized.messages[2].tool_call_id, "c1");
  const { conversation, images } = imageConversation(normalized.messages);
  assert.equal(images.length, 2); assert.notEqual(images[0].label, images[1].label);
  assert.equal(JSON.stringify(conversation).includes(png), false);
  assert.deepEqual(anthropicParts(normalized.messages[0]), [{ type: "text", text: "First:" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "Last." }]);
});

test("image validation rejects remote/local paths, malformed encoding, unsupported MIME/detail, and oversized payloads", () => {
  for (const url of ["https://example.com/image.png", "file:///private/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,aGVsbG8=", "data:image/jpeg;base64," + png, "data:image/png;base64," + "a".repeat(8 * 1024 * 1024 + 1)]) assert.throws(() => inlineImage(url));
  assert.throws(() => inlineImage(image.image_url, "unknown"), /detail/);
  assert.throws(() => responsesToChatRequest({ model: "test", input: [{ role: "system", content: [image] }] }), /text/);
});

test("model catalogs advertise configured image capability and reject unsupported modalities", () => {
  const config = { version: 1, port: 0, stateDirectory: ".", providers: [{ id: "test", type: "claude-subscription", models: { test: "test" }, modelMetadata: { test: { inputModalities: ["text", "image"] } } }] };
  assert.deepEqual(modelCatalog(validateConfig(config)).models[0].input_modalities, ["text", "image"]);
  config.providers[0].modelMetadata.test.inputModalities = ["text", "audio"];
  assert.throws(() => validateConfig(config), /modalities/);
});
