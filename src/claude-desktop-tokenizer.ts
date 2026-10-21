import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

const model = "qwen3.8-flash-next";
const revision = "fc694b54fb0174e0913e6adf86691ef85a4ead47";
const digest = "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3";
const assetBytes = 12_809_320;
const maxAssetBytes = 20 * 1024 * 1024;
const baseVocabularySize = 248_044;
const maxIds = 262_144;
const maxDecodedBytes = 16 * 1024 * 1024;
const addedTokenStart = 248_044;

const addedTokenLabels = [
  "<|endoftext|>", "<|im_start|>", "<|im_end|>", "<|object_ref_start|>", "<|object_ref_end|>", "<|box_start|>", "<|box_end|>",
  "<|quad_start|>", "<|quad_end|>", "<|vision_start|>", "<|vision_end|>", "<|vision_pad|>", "<|image_pad|>", "<|video_pad|>",
  "<tool_call>", "</tool_call>", "<|fim_prefix|>", "<|fim_middle|>", "<|fim_suffix|>", "<|fim_pad|>", "<|repo_name|>", "<|file_sep|>",
  "<tool_response>", "</tool_response>", "<think>", "</think>", "<|audio_start|>", "<|audio_end|>", "<tts_pad>", "<tts_text_bos>",
  "<tts_text_eod>", "<tts_text_bos_single>", "<|audio_pad|>",
] as const;
const addedTokenSpecial = [
  true, true, true, true, true, true, true, true, true, true, true, true, true, true,
  false, false, false, false, false, false, false, false, false, false, false, false,
  true, true, true, true, true, true, true,
] as const;

const byteDecoder = (() => {
  const bytes: number[] = [];
  for (let value = 33; value <= 126; value++) bytes.push(value);
  for (let value = 161; value <= 172; value++) bytes.push(value);
  for (let value = 174; value <= 255; value++) bytes.push(value);
  const known = new Set(bytes); const result = new Map<string, number>(); let extra = 0;
  for (let value = 0; value < 256; value++) {
    const codePoint = known.has(value) ? value : 256 + extra++;
    result.set(String.fromCodePoint(codePoint), value);
  }
  return result;
})();

export interface QwenTokenizer {
  readonly model: typeof model;
  readonly revision: typeof revision;
  readonly digest: typeof digest;
  readonly endThinkId: 248069;
  readonly thinkStartId: 248068;
  readonly eosIds: readonly number[];
  readonly imStartId: 248045;
  decode(ids: readonly number[]): string;
  /** Labels only the pinned added-token range; ordinary BPE IDs intentionally return undefined. */
  getAddedTokenLabel(id: number): string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => { throw new Error(`Invalid pinned Qwen tokenizer: ${message}`); };

function bytesFor(token: string): Buffer {
  const values: number[] = [];
  for (const character of token) {
    const value = byteDecoder.get(character);
    if (value === undefined) return invalid("BPE token is not ByteLevel encoded");
    values.push(value);
  }
  return Buffer.from(values);
}

function makeTokenizer(tokenAt: (id: number) => string | undefined, added: ReadonlyMap<number, string>): QwenTokenizer {
  const labels = new Map(added);
  const decode = (ids: readonly number[]): string => {
    if (!Array.isArray(ids) || ids.length > maxIds) throw new Error("Qwen token IDs exceed the decoder bound");
    const parts: Buffer[] = []; let bytes = 0;
    for (const id of ids) {
      if (!Number.isSafeInteger(id)) throw new Error("Qwen token ID must be a safe integer");
      const label = labels.get(id);
      const token = label === undefined ? tokenAt(id) : undefined;
      const part = label === undefined ? (token === undefined ? undefined : bytesFor(token)) : Buffer.from(label, "ascii");
      if (!part) throw new Error("Qwen token ID is outside the pinned vocabulary");
      bytes += part.length;
      if (bytes > maxDecodedBytes) throw new Error("Qwen decoded bytes exceed the decoder bound");
      parts.push(part);
    }
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts, bytes)); }
    catch { throw new Error("Qwen token IDs do not form valid UTF-8"); }
  };
  return Object.freeze({
    model, revision, digest, endThinkId: 248069 as const, thinkStartId: 248068 as const,
    eosIds: Object.freeze([248044, 248046] as const), imStartId: 248045 as const, decode,
    getAddedTokenLabel: (id: number) => Number.isSafeInteger(id) ? labels.get(id) : undefined,
  });
}

function tokenizerFromFile(value: unknown): QwenTokenizer {
  if (!isRecord(value)) return invalid("root is not an object");
  const root = value;
  const decoder = root.decoder;
  if (!isRecord(decoder) || decoder.type !== "ByteLevel" || decoder.add_prefix_space !== false || decoder.trim_offsets !== false || decoder.use_regex !== false) {
    invalid("decoder is not the pinned ByteLevel configuration");
  }
  const modelConfig = root.model;
  if (!isRecord(modelConfig) || modelConfig.type !== "BPE") return invalid("model is not BPE vocabulary");
  const vocabulary = modelConfig.vocab;
  if (!isRecord(vocabulary)) return invalid("model is not BPE vocabulary");
  const entries = Object.entries(vocabulary);
  if (entries.length !== baseVocabularySize) invalid("BPE vocabulary has the wrong size");
  const tokens = new Array<string>(baseVocabularySize);
  for (const [token, id] of entries) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || id >= baseVocabularySize || tokens[id] !== undefined) return invalid("BPE IDs are not dense and unique");
    bytesFor(token); tokens[id] = token;
  }
  if (tokens.some(token => token === undefined)) invalid("BPE IDs are not dense");
  const addedTokens = root.added_tokens;
  if (!Array.isArray(addedTokens) || addedTokens.length !== addedTokenLabels.length) return invalid("added token count is wrong");
  const added = new Map<number, string>();
  for (let index = 0; index < addedTokenLabels.length; index++) {
    const entry = addedTokens[index];
    if (!isRecord(entry)) return invalid("added tokens do not match the pinned ASCII range");
    const id = entry.id; const content = entry.content;
    if (typeof id !== "number" || typeof content !== "string" || id !== addedTokenStart + index || content !== addedTokenLabels[index] || entry.special !== addedTokenSpecial[index]
      || !/^[\x20-\x7e]+$/.test(content)) return invalid("added tokens do not match the pinned ASCII range");
    added.set(id, content);
  }
  return makeTokenizer(id => id >= 0 && id < tokens.length ? tokens[id] : undefined, added);
}

const cache = new Map<string, Promise<QwenTokenizer>>();

export function loadQwenTokenizer(path: string): Promise<QwenTokenizer> {
  if (!isAbsolute(path)) return Promise.reject(new Error("Qwen tokenizer path must be absolute"));
  const existing = cache.get(path);
  if (existing) return existing;
  const loaded = (async () => {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || pathInfo.size !== assetBytes || pathInfo.size > maxAssetBytes) throw new Error("Pinned Qwen tokenizer must be the expected regular asset");
    const file = await open(path, "r");
    const bytes = await (async () => {
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== assetBytes || info.size > maxAssetBytes) throw new Error("Pinned Qwen tokenizer must be the expected regular asset");
        const result = Buffer.allocUnsafe(info.size); let offset = 0;
        while (offset < result.length) {
          const { bytesRead } = await file.read(result, offset, result.length - offset, offset);
          if (!bytesRead) throw new Error("Pinned Qwen tokenizer was truncated");
          offset += bytesRead;
        }
        return result;
      } finally { await file.close(); }
    })();
    if (bytes.length !== assetBytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Pinned Qwen tokenizer digest does not match");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { invalid("JSON is unreadable"); }
    return tokenizerFromFile(parsed);
  })().catch(error => { cache.delete(path); throw error; });
  cache.set(path, loaded);
  return loaded;
}

/** Test-only byte decoder seam; production always verifies the pinned asset above. */
export function createByteLevelDecoderForTests(tokens: ReadonlyMap<number, string>, added: ReadonlyMap<number, string>): (ids: readonly number[]) => string {
  const vocabulary = new Map(tokens);
  return makeTokenizer(id => vocabulary.get(id), added).decode;
}
