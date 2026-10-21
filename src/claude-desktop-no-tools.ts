import type { ServerResponse } from "node:http";
import type { QwenTokenizer } from "./claude-desktop-tokenizer.js";

const pendingByteLimit = 16 * 1024 * 1024;
const frameByteLimit = 8 * 1024 * 1024;
const eventLimit = 100_000;
const outputTokenLimit = 131_072;
const promptTokenLimit = 500_000;
const eofGraceMs = 5000;

export interface NoToolsOutputRecovery {
  readonly model: string;
  readonly codec: QwenTokenizer;
  onRestored?(event: { outputTokens: number; recoveredBytes: number }): void;
}

type ChatEvent = Record<string, unknown>;
type ReadResult = { kind: "chunk"; value: Uint8Array } | { kind: "eof" | "abort" | "error" | "stall" };

const topFields = new Set([
  "id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier",
  "prompt_token_ids", "prompt_text",
]);
const choiceFields = new Set(["index", "delta", "finish_reason", "logprobs", "stop_reason", "token_ids"]);
const deltaFields = new Set(["role", "content", "reasoning", "reasoning_content", "tool_calls"]);
const allowedAdded = new Set(["</think>", "<tool_call>", "</tool_call>"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, fields: ReadonlySet<string>): boolean =>
  Object.keys(value).every(key => fields.has(key));
const emptyList = (value: unknown): boolean => value === undefined || Array.isArray(value) && value.length === 0;
const numberList = (value: unknown, limit: number): value is number[] =>
  Array.isArray(value) && value.length <= limit && value.every(item => Number.isSafeInteger(item) && item >= 0);
const exact = (actual: readonly number[], expected: readonly number[]): boolean =>
  actual.length === expected.length && actual.every((item, index) => item === expected[index]);

/** Adds only raw-token diagnostics to an exact eligible no-tools request. */
export function noToolsOutputRecoveryRequest(body: Buffer, recovery: NoToolsOutputRecovery): Buffer | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return; }
  if (!isRecord(parsed)
    || parsed.model !== recovery.model
    || parsed.stream !== true
    || parsed.n !== undefined && parsed.n !== 1
    || !emptyList(parsed.tools)
    || parsed.tool_choice !== undefined && parsed.tool_choice !== "none"
    || !emptyList(parsed.stop)
    || parsed.include_reasoning !== undefined && parsed.include_reasoning !== true
    || parsed.return_token_ids !== undefined && parsed.return_token_ids !== false
    || parsed.stream_options !== undefined && !isRecord(parsed.stream_options)) return;
  return Buffer.from(JSON.stringify({ ...parsed, return_token_ids: true }));
}

function eventFrame(event: ChatEvent): Buffer {
  return Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
}

function sanitize(event: ChatEvent): { event: ChatEvent; promptIds: unknown; tokenIds: unknown[] } {
  const { prompt_token_ids: promptIds, prompt_text: _promptText, ...withoutPrompt } = event;
  const tokenIds: unknown[] = [];
  const choices = Array.isArray(withoutPrompt.choices) ? withoutPrompt.choices.map(choice => {
    if (!isRecord(choice)) return choice;
    const { token_ids: ids, ...withoutIds } = choice;
    tokenIds.push(ids);
    return withoutIds;
  }) : withoutPrompt.choices;
  return { event: { ...withoutPrompt, ...(choices === undefined ? {} : { choices }) }, promptIds, tokenIds };
}

function usageFrame(event: ChatEvent): ChatEvent {
  const { usage, ...withoutUsage } = event;
  return { ...withoutUsage, choices: [], usage };
}

function writeWait(response: ServerResponse, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (response.destroyed || response.writableEnded || signal.aborted) return Promise.resolve();
  if (response.write(bytes) || response.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function validUsage(value: unknown): value is Record<string, number> {
  if (!isRecord(value) || typeof value.completion_tokens !== "number" || !Number.isFinite(value.completion_tokens) || value.completion_tokens < 0) return false;
  return ["prompt_tokens", "completion_tokens", "total_tokens"].every(key => {
    const item = value[key];
    return item === undefined || typeof item === "number" && Number.isFinite(item) && item >= 0;
  });
}

function visibleOrTool(event: ChatEvent): boolean {
  return Array.isArray(event.choices) && event.choices.some(choice => isRecord(choice) && isRecord(choice.delta)
    && (typeof choice.delta.content === "string" && choice.delta.content.length > 0
      || Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0));
}

function postTerminalFragment(event: ChatEvent): boolean {
  return Array.isArray(event.choices) && event.choices.some(choice => isRecord(choice) && isRecord(choice.delta)
    && (typeof choice.delta.content === "string" && choice.delta.content.length > 0
      || typeof choice.delta.reasoning === "string" && choice.delta.reasoning.length > 0
      || typeof choice.delta.reasoning_content === "string" && choice.delta.reasoning_content.length > 0
      || Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0
      || Array.isArray(choice.token_ids) && choice.token_ids.length > 0));
}

function hasStop(event: ChatEvent): boolean {
  return Array.isArray(event.choices) && event.choices.some(choice => isRecord(choice) && choice.finish_reason === "stop");
}

function emptyInitialRoleFrame(event: ChatEvent, choice: unknown, index: number): boolean {
  if (index !== 0 || !Array.isArray(event.choices) || event.choices.length !== 1 || !isRecord(choice)
    || choice.token_ids !== undefined || choice.finish_reason !== null || !isRecord(choice.delta)) return false;
  return choice.delta.role === "assistant"
    && Object.keys(choice.delta).every(key => key === "role" || key === "content")
    && (choice.delta.content === undefined || choice.delta.content === "");
}

function strictEvent(event: ChatEvent, recovery: NoToolsOutputRecovery): boolean {
  if (!hasOnly(event, topFields) || !Array.isArray(event.choices) || event.choices.length > 1) return false;
  const created = event.created;
  if (event.model !== undefined && event.model !== recovery.model
    || event.id !== undefined && typeof event.id !== "string"
    || event.object !== undefined && event.object !== "chat.completion.chunk"
    || created !== undefined && (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0)
    || event.system_fingerprint !== undefined && event.system_fingerprint !== null && typeof event.system_fingerprint !== "string"
    || event.service_tier !== undefined && event.service_tier !== null && typeof event.service_tier !== "string"
    || event.prompt_text !== undefined && event.prompt_text !== null && typeof event.prompt_text !== "string") return false;
  for (const choice of event.choices) {
    if (!isRecord(choice) || !hasOnly(choice, choiceFields) || choice.index !== 0 || !isRecord(choice.delta)
      || !hasOnly(choice.delta, deltaFields) || event.model !== recovery.model) return false;
    const delta = choice.delta;
    if (delta.role !== undefined && (typeof delta.role !== "string" || delta.role !== "assistant")
      || delta.content !== undefined && typeof delta.content !== "string"
      || delta.reasoning !== undefined && typeof delta.reasoning !== "string"
      || delta.reasoning_content !== undefined && typeof delta.reasoning_content !== "string"
      || delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)
      || choice.logprobs !== undefined && choice.logprobs !== null
      || choice.stop_reason !== undefined && choice.stop_reason !== null
      || choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "stop") return false;
  }
  return true;
}

function recoveredSuffix(
  recovery: NoToolsOutputRecovery,
  prompt: number[] | undefined,
  output: number[],
  usage: Record<string, number> | undefined,
): string | undefined {
  if (!prompt || !usage || output.length < 1 || output.length > outputTokenLimit
    || usage.completion_tokens !== output.length
    || usage.prompt_tokens !== undefined && usage.prompt_tokens !== prompt.length) return;
  const start = prompt.lastIndexOf(recovery.codec.imStartId);
  if (start < 0) return;
  const promptSuffix = prompt.slice(start);
  const open = [248045, 74455, 198, 248068, 198];
  const closed = [248045, 74455, 198, 248068, 271, 248069, 271];
  const openPrompt = exact(promptSuffix, open);
  const closedPrompt = exact(promptSuffix, closed);
  if (!openPrompt && !closedPrompt) return;
  try {
    const expected = openPrompt ? "<|im_start|>assistant\n<think>\n" : "<|im_start|>assistant\n<think>\n\n</think>\n\n";
    if (recovery.codec.decode(promptSuffix) !== expected) return;
    const final = output.at(-1)!;
    if (!recovery.codec.eosIds.includes(final) || output.slice(0, -1).some(id =>
      recovery.codec.eosIds.includes(id) || id === recovery.codec.imStartId || id === recovery.codec.thinkStartId)) return;
    const rawIds = output.slice(0, -1);
    if (rawIds.map(id => recovery.codec.getAddedTokenLabel(id)).some(label => label !== undefined && !allowedAdded.has(label))) return;
    const raw = recovery.codec.decode(rawIds);
    if (!raw.trim() || raw.includes("<think>") || raw.includes("<|im_start|>")
      || raw.includes("<|endoftext|>") || raw.includes("<|im_end|>")) return;
    const literalEnds = raw.match(/<\/think>/g)?.length ?? 0;
    const tokenEnds = rawIds.filter(id => id === recovery.codec.endThinkId).length;
    if (closedPrompt) return literalEnds || tokenEnds || !raw.trim() ? undefined : raw;
    if (literalEnds !== 1 || tokenEnds !== 1) return;
    const resultSuffix = raw.slice(raw.indexOf("</think>") + "</think>".length);
    return resultSuffix.trim() ? resultSuffix : undefined;
  } catch {
    return;
  }
}

function nextRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, graceMs: number | undefined): Promise<ReadResult> {
  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: ReadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish({ kind: "abort" });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    if (graceMs !== undefined) timer = setTimeout(() => finish({ kind: "stall" }), graceMs);
    void reader.read().then(next => finish(next.done ? { kind: "eof" } : { kind: "chunk", value: next.value }), () => finish({ kind: "error" }));
  });
}

/**
 * Relays raw Qwen output only after a literal-token proof. It withholds DONE
 * until actual clean EOF so an incomplete upstream stream cannot look healthy.
 */
export async function relayNoToolsOutput(
  response: ServerResponse,
  upstream: Response,
  signal: AbortSignal,
  recovery: NoToolsOutputRecovery,
  headers: Record<string, string | string[]>,
): Promise<void> {
  response.writeHead(upstream.status, headers);
  if (!upstream.body) { response.destroy(); return; }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let source = "";
  let pending: ChatEvent[] = [];
  let pendingBytes = 0;
  let candidate = true;
  let fatal = false;
  let cleanEOF = false;
  let doneCount = 0;
  let terminalCount = 0;
  let jsonEvents = 0;
  let firstJson = true;
  let prompt: number[] | undefined;
  let output: number[] = [];
  let latestUsage: Record<string, number> | undefined;
  let doneDeadline: number | undefined;
  let normalCompleted = false;
  let visibleOutput = false;

  const destroyed = () => response.destroyed || response.writableEnded || signal.aborted;
  const write = (bytes: Uint8Array) => writeWait(response, bytes, signal);
  const forgetCandidate = () => {
    candidate = false;
    prompt = undefined;
    output = [];
    latestUsage = undefined;
  };
  const flush = async () => {
    for (const event of pending) {
      if (destroyed()) return;
      await write(eventFrame(event));
    }
    pending = [];
    pendingBytes = 0;
  };
  const release = async () => {
    if (candidate) forgetCandidate();
    await flush();
  };
  const invalidate = async () => { if (candidate) await release(); };
  const holdOrWrite = async (event: ChatEvent) => {
    if (!candidate) return write(eventFrame(event));
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > frameByteLimit || pendingBytes > pendingByteLimit - size) {
      await release();
      return write(eventFrame(event));
    }
    pending.push(event);
    pendingBytes += size;
  };
  const acceptJson = async (event: ChatEvent): Promise<void> => {
    const cleaned = sanitize(event);
    const strict = strictEvent(event, recovery);
    const initial = firstJson;
    if (firstJson) {
      firstJson = false;
      if (event.model !== recovery.model) await invalidate();
      else if (numberList(cleaned.promptIds, promptTokenLimit)) prompt = cleaned.promptIds;
      else await invalidate();
    } else if (cleaned.promptIds !== undefined) await invalidate();
    if (event.usage !== undefined) {
      await write(eventFrame(usageFrame(cleaned.event)));
      delete cleaned.event.usage;
      if (validUsage(event.usage)) latestUsage = event.usage;
      else if (event.usage !== null) await invalidate();
    }
    if (!strict) await invalidate();
    if (Array.isArray(event.choices)) {
      for (let index = 0; index < event.choices.length; index++) {
        const choice = event.choices[index];
        const ids = cleaned.tokenIds[index];
        if (candidate) {
          if (ids === undefined && initial && emptyInitialRoleFrame(event, choice, index)) continue;
          if (!numberList(ids, outputTokenLimit) || output.length > outputTokenLimit - ids.length) await invalidate();
          else for (const id of ids) output.push(id);
        }
        if (isRecord(choice) && choice.finish_reason === "stop") terminalCount++;
      }
    }
    if (terminalCount > 1) await invalidate();
    if (visibleOrTool(event)) {
      visibleOutput = true;
      await release();
    }
    if (candidate && !hasStop(event)) await write(eventFrame(cleaned.event));
    else await holdOrWrite(cleaned.event);
  };
  const consumeFrame = async (raw: string): Promise<void> => {
    if (Buffer.byteLength(raw) > frameByteLimit) { fatal = true; return; }
    const lines = raw.split(/\r\n|\n|\r/);
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (!line.startsWith("data:")) {
        await invalidate();
        continue;
      }
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    if (!data.length) return;
    const joined = data.join("\n");
    if (joined === "[DONE]") {
      doneCount++;
      if (doneCount !== 1 || terminalCount !== 1) fatal = true;
      else if (!visibleOutput) doneDeadline = Date.now() + eofGraceMs;
      else if (!destroyed()) {
        await write(Buffer.from("data: [DONE]\n\n"));
        if (!destroyed()) response.end();
        normalCompleted = true;
      }
      return;
    }
    let value: unknown;
    try { value = JSON.parse(joined); } catch { fatal = true; return; }
    if (!isRecord(value) || doneCount) { fatal = true; return; }
    if (candidate && ++jsonEvents > eventLimit) await release();
    if (terminalCount && postTerminalFragment(value)) await invalidate();
    await acceptJson(value);
  };
  const consumeAvailable = async () => {
    for (;;) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(source);
      if (!boundary) return;
      const raw = source.slice(0, boundary.index);
      source = source.slice(boundary.index + boundary[0].length);
      await consumeFrame(raw);
      if (fatal || doneDeadline !== undefined && Date.now() >= doneDeadline) {
        fatal ||= doneDeadline !== undefined;
        return;
      }
    }
  };

  try {
    while (!destroyed() && !fatal && !normalCompleted) {
      if (doneDeadline !== undefined && Date.now() >= doneDeadline) { fatal = true; break; }
      const grace = doneDeadline === undefined ? undefined : Math.max(0, doneDeadline - Date.now());
      const next = await nextRead(reader, signal, grace);
      if (next.kind === "abort" || next.kind === "error" || next.kind === "stall") { fatal = true; break; }
      if (next.kind === "eof") {
        try { source += decoder.decode(); } catch { fatal = true; break; }
        await consumeAvailable();
        if (source.length) fatal = true;
        cleanEOF = !fatal;
        break;
      }
      if (next.kind !== "chunk") { fatal = true; break; }
      try { source += decoder.decode(next.value, { stream: true }); } catch { fatal = true; break; }
      await consumeAvailable();
      if (Buffer.byteLength(source) > frameByteLimit) { fatal = true; break; }
    }

    if (normalCompleted) return;

    const restored = !fatal && cleanEOF && candidate && doneCount === 1 && terminalCount === 1
      ? recoveredSuffix(recovery, prompt, output, latestUsage)
      : undefined;
    if (restored !== undefined && !destroyed()) {
      const terminal = pending.findIndex(event => Array.isArray(event.choices)
        && event.choices.some(choice => isRecord(choice) && choice.finish_reason === "stop"));
      if (terminal < 0) fatal = true;
      else {
        const injected: ChatEvent = {
          object: "chat.completion.chunk",
          model: recovery.model,
          choices: [{ index: 0, delta: { content: restored }, finish_reason: null }],
        };
        const original = pending[terminal]!;
        const choice = Array.isArray(original.choices) ? original.choices[0] : undefined;
        const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
        if (isRecord(choice) && delta && (typeof delta.reasoning === "string" || typeof delta.reasoning_content === "string")) {
          const { finish_reason: _finish, ...beforeChoice } = choice;
          const { delta: _delta, ...terminalChoice } = choice;
          pending.splice(terminal, 1,
            { ...original, choices: [{ ...beforeChoice, finish_reason: null }] },
            injected,
            { ...original, choices: [{ ...terminalChoice, delta: {}, finish_reason: "stop" }] },
          );
        } else pending.splice(terminal, 0, injected);
        await flush();
      }
    } else await flush();

    if (!fatal && cleanEOF && doneCount === 1 && !destroyed()) {
      await write(Buffer.from("data: [DONE]\n\n"));
      const completed = !signal.aborted && !response.destroyed;
      if (completed) response.end();
      if (restored !== undefined && completed && !signal.aborted && !response.destroyed) {
        try { recovery.onRestored?.({ outputTokens: output.length, recoveredBytes: Buffer.byteLength(restored) }); } catch {}
      }
    } else if (!destroyed()) response.destroy();
  } catch {
    if (!destroyed()) {
      await flush().catch(() => undefined);
      response.destroy();
    }
  } finally {
    if (!cleanEOF || fatal || signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (signal.aborted && !response.destroyed && !response.writableEnded) response.destroy();
  }
}
