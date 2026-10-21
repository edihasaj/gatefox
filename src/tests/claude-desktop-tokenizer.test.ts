import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createByteLevelDecoderForTests, loadQwenTokenizer } from "../claude-desktop-tokenizer.js";

const tokens = new Map<number, string>([
  [32, "A"], [33, "B"], [34, "C"], [198, "Ċ"], [220, "Ġ"], [238, "Ĳ"], [247, "Ļ"], [271, "ĊĊ"], [357, "ĠA"], [417, "ĠB"],
  [10838, "ĠðŁ"], [11831, "Ã«"], [22824, "far"], [44382, "Ãĩ"], [99986, "ä¸Ńæĸĩ"],
]);
const added = new Map<number, string>([[248046, "<|im_end|>"], [248058, "<tool_call>"], [248068, "<think>"], [248069, "</think>"]]);
const decode = createByteLevelDecoderForTests(tokens, added);

test("Qwen ByteLevel decoder preserves runtime vectors without added-token spacing", () => {
  assert.equal(decode([32, 248058, 33]), "A<tool_call>B");
  assert.equal(decode([44382, 22824, 11831, 10838, 238, 247, 220, 99986, 198]), "Çfarë 🐙 中文\n");
  assert.equal(decode([357, 220, 417, 271, 34, 220]), " A  B\n\nC ");
  assert.equal(decode([248069, 32, 248046]), "</think>A<|im_end|>");
  assert.equal(createByteLevelDecoderForTests(new Map([[1, "ï»¿A"]]), new Map())([1]), "\uFEFFA");
});

test("Qwen ByteLevel decoder rejects invalid IDs and incomplete UTF-8", () => {
  assert.throws(() => decode([1]), /outside the pinned vocabulary/);
  assert.throws(() => decode([-1]), /outside the pinned vocabulary/);
  assert.throws(() => decode([1.5]), /safe integer/);
  assert.throws(() => decode([Number.MAX_SAFE_INTEGER + 1]), /safe integer/);
  assert.throws(() => decode(new Array(262_145).fill(32)), /exceed the decoder bound/);
  assert.throws(() => createByteLevelDecoderForTests(new Map([[1, "Ã"]]), new Map())([1]), /valid UTF-8/);
  const mutable = new Map<number, string>([[32, "A"]]);
  const copied = createByteLevelDecoderForTests(mutable, new Map());
  mutable.set(32, "B");
  assert.equal(copied([32]), "A");
  const labels = new Map<number, string>([[248058, "<tool_call>"]]);
  const copiedLabels = createByteLevelDecoderForTests(new Map(), labels);
  labels.set(248058, "<changed>");
  assert.equal(copiedLabels([248058]), "<tool_call>");
});

test("pinned tokenizer loader rejects an absolute asset with the wrong digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-qwen-tokenizer-"));
  const path = join(directory, "tokenizer.json");
  await writeFile(path, Buffer.alloc(12_809_320));
  await assert.rejects(loadQwenTokenizer(path), /digest does not match/);
});
