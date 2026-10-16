import { ProviderError } from "../providers/provider.js";
import type { ResponsesContentPart, ResponsesFunctionTool, ResponsesInputItem, ResponsesRequest } from "./types.js";
import { inlineImage } from "./images.js";

type Data = Record<string, unknown>;
function invalid(): never { throw new ProviderError("invalid_request", "Messages request contains invalid or unsupported data", 400); }
const object = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : invalid();
const text = (value: unknown): string => typeof value === "string" ? value : invalid();
const nonempty = (value: unknown): string => {
  const result = text(value); if (!result.trim() || result.length > 1024 || result.includes("\0")) invalid(); return result;
};
const positiveInteger = (value: unknown): number => Number.isInteger(value) && Number(value) > 0 ? Number(value) : invalid();
const finiteProbability = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : invalid();
const plainObject = (value: unknown): Data => object(value);

function cacheControl(value: unknown): void {
  if (value === undefined || value === null) return;
  const control = object(value);
  if (control.type !== "ephemeral" || (control.ttl !== undefined && control.ttl !== "5m" && control.ttl !== "1h")) invalid();
  for (const key of Object.keys(control)) if (key !== "type" && key !== "ttl") invalid();
}

function image(part: Data): ResponsesContentPart {
  for (const key of Object.keys(part)) if (key !== "type" && key !== "source" && key !== "cache_control") invalid();
  const source = object(part.source);
  for (const key of Object.keys(source)) if (key !== "type" && key !== "media_type" && key !== "data") invalid();
  if (source.type !== "base64") invalid();
  const converted = inlineImage(`data:${text(source.media_type)};base64,${text(source.data)}`);
  return { type: "input_image", image_url: `data:${converted.mediaType};base64,${converted.data}`, ...(converted.detail ? { detail: converted.detail } : {}) };
}

function textPart(part: Data, output = false): ResponsesContentPart {
  if (part.type !== "text") invalid();
  cacheControl(part.cache_control);
  if (part.citations !== undefined && (!Array.isArray(part.citations) || part.citations.length)) invalid();
  for (const key of Object.keys(part)) if (key !== "type" && key !== "text" && key !== "cache_control" && key !== "citations") invalid();
  return { type: output ? "output_text" : "input_text", text: text(part.text) };
}

function resultContent(value: unknown, error: boolean): string | ResponsesContentPart[] {
  const prefix = "[Tool error] ";
  if (value === undefined) return error ? prefix : "";
  if (typeof value === "string") return error ? prefix + value : value;
  if (!Array.isArray(value)) invalid();
  const content: ResponsesContentPart[] = error ? [{ type: "input_text", text: prefix }] : [];
  for (const source of value as unknown[]) {
    const part = object(source);
    if (part.type === "text") content.push(textPart(part));
    else if (part.type === "image") { cacheControl(part.cache_control); content.push(image(part)); }
    else invalid();
  }
  return content;
}

type Replay = { items: ResponsesInputItem[]; calls: Map<string, string>; results: Set<string> };
function messageContent(role: string, value: unknown, replay: Replay): void {
  const blocks = typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : invalid();
  const normal: ResponsesContentPart[] = [];
  const flush = () => {
    if (normal.length) {
      replay.items.push({ type: "message", role: role as "system" | "user" | "assistant", content: normal.splice(0) });
    }
  };
  for (const source of blocks) {
    const part = object(source);
    if (part.type === "text") {
      if (role === "system" || role === "user" || role === "assistant") normal.push(textPart(part, role === "assistant")); else invalid();
      continue;
    }
    if (part.type === "image" && role === "user") { cacheControl(part.cache_control); normal.push(image(part)); continue; }
    if (part.type === "tool_use" && role === "assistant") {
      flush(); cacheControl(part.cache_control);
      const id = nonempty(part.id); const name = nonempty(part.name);
      if (replay.calls.has(id) || !plainObject(part.input)) invalid();
      for (const key of Object.keys(part)) if (key !== "type" && key !== "id" && key !== "name" && key !== "input" && key !== "cache_control") invalid();
      replay.calls.set(id, name);
      replay.items.push({ type: "function_call", call_id: id, name, arguments: JSON.stringify(part.input) });
      continue;
    }
    if (part.type === "tool_result" && role === "user") {
      flush(); cacheControl(part.cache_control);
      const id = nonempty(part.tool_use_id);
      if (!replay.calls.has(id) || replay.results.has(id) || (part.is_error !== undefined && typeof part.is_error !== "boolean")) invalid();
      for (const key of Object.keys(part)) if (!["type", "tool_use_id", "content", "is_error", "cache_control"].includes(key)) invalid();
      replay.results.add(id);
      replay.items.push({ type: "function_call_output", call_id: id, name: replay.calls.get(id), output: resultContent(part.content, part.is_error === true) });
      continue;
    }
    // A readable prior thought is semantic history; signatures and redactions are opaque state.
    if (part.type === "thinking" && role === "assistant") {
      flush(); if (typeof part.thinking !== "string") invalid();
      if (part.signature !== undefined && typeof part.signature !== "string") invalid();
      for (const key of Object.keys(part)) if (key !== "type" && key !== "thinking" && key !== "signature") invalid();
      const thinking = part.thinking;
      replay.items.push({ type: "reasoning", summary: thinking ? [{ type: "summary_text", text: thinking }] : [] });
      continue;
    }
    if (part.type === "redacted_thinking" && role === "assistant") {
      flush(); if (typeof part.data !== "string") invalid();
      for (const key of Object.keys(part)) if (key !== "type" && key !== "data") invalid();
      // Never turn opaque native state into invented readable reasoning.
      replay.items.push({ type: "reasoning", encrypted_content: part.data as string, summary: [] });
      continue;
    }
    invalid();
  }
  flush();
}

function system(value: unknown, replay: Replay): void {
  if (typeof value === "string") { replay.items.push({ type: "message", role: "system", content: [{ type: "input_text", text: value }] }); return; }
  if (!Array.isArray(value)) invalid();
  // Keep every block separate: Claude's first attribution block has a distinct boundary.
  for (const source of value as unknown[]) {
    const part = object(source); const content = textPart(part);
    replay.items.push({ type: "message", role: "system", content: [content] });
  }
}

function tools(value: unknown): ResponsesFunctionTool[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid();
  const names = new Set<string>();
  return (value as unknown[]).map(source => {
    const tool = object(source); cacheControl(tool.cache_control);
    for (const key of Object.keys(tool)) if (!["type", "name", "description", "input_schema", "cache_control"].includes(key)) invalid();
    if (tool.type !== undefined && tool.type !== null && tool.type !== "custom") invalid();
    const name = nonempty(tool.name); if (names.has(name)) invalid(); names.add(name);
    if (tool.description !== undefined && typeof tool.description !== "string") invalid();
    const parameters = plainObject(tool.input_schema);
    return { type: "function", name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters };
  });
}

function outputEffort(value: unknown): string | undefined {
  if (value === undefined) return;
  const config = object(value);
  if (Object.keys(config).some(key => key !== "effort")) invalid();
  if (config.effort === undefined) return;
  if (typeof config.effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(config.effort)) invalid();
  return config.effort;
}

function controls(value: Data, catalog: Set<string>, effort: string | undefined): Pick<ResponsesRequest, "tool_choice"> & Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (value.temperature !== undefined) result.temperature = finiteProbability(value.temperature);
  if (value.top_p !== undefined) result.top_p = finiteProbability(value.top_p);
  if (value.stop_sequences !== undefined) {
    if (!Array.isArray(value.stop_sequences) || value.stop_sequences.some(entry => typeof entry !== "string" || !entry)) invalid();
    if (value.stop_sequences.length) result.stop = value.stop_sequences;
  }
  if (value.tool_choice !== undefined && value.tool_choice !== null) {
    const choice = object(value.tool_choice);
    if (choice.type === "auto" || choice.type === "none" || choice.type === "any") {
      if (Object.keys(choice).some(key => key !== "type" && key !== "disable_parallel_tool_use")) invalid();
      result.tool_choice = choice.type === "any" ? "required" : choice.type;
    } else if (choice.type === "tool") {
      if (Object.keys(choice).some(key => key !== "type" && key !== "name" && key !== "disable_parallel_tool_use")) invalid();
      const name = nonempty(choice.name); if (!catalog.has(name)) invalid(); result.tool_choice = { type: "function", name };
    } else invalid();
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== "boolean") invalid();
      if (choice.disable_parallel_tool_use) result.parallel_tool_calls = false;
    }
  }
  const thinking = value.thinking;
  let summary: "none" | "auto" | undefined;
  if (thinking !== undefined) {
    const setting = object(thinking);
    if (setting.type === "disabled") invalid();
    else if (setting.type === "adaptive") {
      if (Object.keys(setting).some(key => key !== "type" && key !== "display")) invalid();
      if (setting.display !== undefined && setting.display !== "omitted" && setting.display !== "summarized" && setting.display !== "updates") invalid();
      summary = setting.display === "summarized" ? "auto" : "none";
    } else invalid(); // Fixed thinking budgets cannot be preserved by this gateway.
  }
  if (summary !== undefined || effort !== undefined) result.reasoning = { ...(effort === undefined ? {} : { effort }), ...(summary === undefined ? {} : { summary }) };
  return result as Pick<ResponsesRequest, "tool_choice"> & Record<string, unknown>;
}

/** Converts the supported native Anthropic Messages subset without weakening caller semantics. */
export function messagesToResponses(value: unknown, options: { countTokens?: boolean } = {}): ResponsesRequest {
  const request = object(value);
  const allowed = new Set(["model", "max_tokens", "messages", "system", "tools", "tool_choice", "temperature", "top_p", "stop_sequences", "stream", "thinking", "output_config", "context_management", "metadata", "cache_control"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) invalid();
  const model = nonempty(request.model);
  cacheControl(request.cache_control);
  if (!options.countTokens || request.max_tokens !== undefined) positiveInteger(request.max_tokens);
  if (!Array.isArray(request.messages) || !request.messages.length) invalid();
  if (request.stream !== undefined && typeof request.stream !== "boolean") invalid();
  if (request.metadata !== undefined) {
    const metadata = object(request.metadata);
    if (Object.keys(metadata).some(key => key !== "user_id") || (metadata.user_id !== undefined && typeof metadata.user_id !== "string")) invalid();
  }
  if (request.context_management !== undefined) {
    const context = object(request.context_management);
    if (Object.keys(context).some(key => key !== "edits")) invalid();
    if (!Array.isArray(context.edits) || context.edits.length !== 1) invalid();
    const edit = object((context.edits as unknown[])[0]);
    if (edit.type !== "clear_thinking_20251015" || edit.keep !== "all" || Object.keys(edit).length !== 2) invalid();
  }
  const catalog = tools(request.tools) || [];
  const replay: Replay = { items: [], calls: new Map(), results: new Set() };
  let effort = outputEffort(request.output_config);
  let pendingEffort: string | undefined;
  let awaitingReply = false;
  if (request.system !== undefined) system(request.system, replay);
  for (const source of request.messages as unknown[]) {
    const message = object(source); if (!["user", "assistant", "system"].includes(String(message.role)) || Object.keys(message).some(key => key !== "role" && key !== "content" && key !== "cache_control" && !(key === "output_config" && message.role === "system"))) invalid();
    cacheControl(message.cache_control);
    messageContent(String(message.role), message.content, replay);
    if (message.role === "user") {
      // Tool results continue the same turn; only new user input activates a
      // deferred effort change and opens the current reply's override window.
      awaitingReply = typeof message.content === "string" || (message.content as Data[]).some(part => part.type !== "tool_result");
      if (awaitingReply && pendingEffort !== undefined) { effort = pendingEffort; pendingEffort = undefined; }
    } else if (message.role === "assistant") awaitingReply = false;
    else {
      const override = outputEffort(message.output_config ?? undefined);
      if (override !== undefined) {
        if (awaitingReply) effort = override;
        else pendingEffort = override;
      }
    }
  }
  const declared = new Set(catalog.map(tool => tool.name));
  if ([...replay.calls.values()].some(name => !declared.has(name))) invalid();
  if ([...replay.calls.keys()].some(id => !replay.results.has(id))) invalid();
  const control = controls(request, declared, effort);
  const stream = request.stream;
  return { model, input: replay.items, ...(request.max_tokens === undefined ? {} : { max_output_tokens: positiveInteger(request.max_tokens) }), ...(stream === undefined ? {} : { stream: stream as boolean }),
    ...(catalog.length ? { tools: catalog } : {}), ...control };
}
