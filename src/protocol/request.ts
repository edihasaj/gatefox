import type { OpenAIChatMessage, OpenAIChatRequest, OpenAITool, ResponsesRequest, ResponsesTool, ResponseToolIdentity } from "./types.js";

type Data = Record<string, unknown>;
export class ResponsesTranslationError extends Error {}
function reject(message: string): never { throw new ResponsesTranslationError(message); }
function record(value: unknown): Data {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("Expected an object in the Responses request");
  return value as Data;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) reject("Tool names and call IDs must be non-empty strings");
  return value;
}
function named(value: Data): string {
  const local = name(value.name);
  return value.namespace === undefined ? local : `${name(value.namespace)}.${local}`;
}
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) reject("Only string or text-part content is supported");
  const paragraphs: string[] = [];
  for (const entry of value) {
    const part = record(entry);
    if ((part.type !== "input_text" && part.type !== "output_text") || typeof part.text !== "string") reject("Only text content is supported by this adapter");
    paragraphs.push(part.text);
  }
  return paragraphs.join("\n");
}

/** Replay is compiled in order; opaque reasoning is never treated as text. */
export function responsesInputToMessages(input: ResponsesRequest["input"]): OpenAIChatMessage[] {
  if (typeof input === "string") return [{ content: input, role: "user" }];
  if (!Array.isArray(input)) reject("input must be text or a list of Responses items");
  const replay: OpenAIChatMessage[] = [];
  const issued = new Map<string, string>();
  for (const source of input) {
    const item = record(source);
    switch (item.type) {
      case "function_call": case "custom_tool_call": {
        const id = name(item.call_id); const tool = named(item);
        const raw = item.type === "custom_tool_call" ? item.input : item.arguments;
        if (typeof raw !== "string") reject("Tool call input must be a string");
        issued.set(id, tool);
        replay.push({ role: "assistant", content: null, tool_calls: [{ type: "function", id,
          function: { name: tool, arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: raw }) : raw } }] });
        break;
      }
      case "function_call_output": case "custom_tool_call_output": {
        const id = name(item.call_id);
        replay.push({ content: content(item.output), role: "tool", tool_call_id: id, name: item.name === undefined ? issued.get(id) : named(item) });
        break;
      }
      case "reasoning": {
        if (item.summary === undefined) break;
        if (!Array.isArray(item.summary)) reject("Reasoning summary must be a list");
        const summary = item.summary.map(value => {
          const part = record(value);
          if (part.type !== "summary_text" || typeof part.text !== "string") reject("Reasoning summary must contain summary text");
          return part.text;
        }).join("\n");
        if (summary) replay.push({ content: summary, role: "assistant" });
        break;
      }
      case undefined: case "message": {
        if (!["user", "assistant", "system", "developer"].includes(String(item.role))) reject("Unsupported message role");
        replay.push({ content: content(item.content), role: item.role as OpenAIChatMessage["role"] });
        break;
      }
      default: reject("Unsupported Responses input item type");
    }
  }
  return replay;
}

/** Compile a flat caller-tool catalog while retaining its original identities. */
export function normalizeResponsesTools(tools: ResponsesTool[] = []): OpenAITool[] {
  if (!Array.isArray(tools)) reject("tools must be an array");
  const catalog = new Map<string, OpenAITool>();
  const declare = (source: unknown, namespace?: string, groupDescription = "") => {
    const tool = record(source);
    if (tool.type !== "function" && tool.type !== "custom") reject("Unsupported Responses tool type");
    const definition = tool.type === "function" && tool.function !== undefined ? record(tool.function) : tool;
    const localName = name(definition.name); const alias = namespace ? `${namespace}.${localName}` : localName;
    if (catalog.has(alias)) reject("Duplicate tool name");
    if (definition.description !== undefined && typeof definition.description !== "string") reject("Tool descriptions must be strings");
    const identity: ResponseToolIdentity = { type: tool.type, name: localName, ...(namespace ? { namespace } : {}) };
    let description = [groupDescription, definition.description].filter(Boolean).join("\n");
    let parameters: Record<string, unknown> | undefined;
    if (tool.type === "function") {
      if (definition.parameters !== undefined) parameters = record(definition.parameters);
    } else {
      description += "\nReturn the complete raw tool input in the input field, preserving all characters.";
      parameters = { type: "object", required: ["input"], properties: { input: { type: "string" } }, additionalProperties: false };
      if (tool.format !== undefined) {
        const format = record(tool.format);
        if (format.type === "grammar") {
          if (!["lark", "regex"].includes(String(format.syntax)) || typeof format.definition !== "string") reject("Unsupported custom tool grammar");
          description += `\nRequired ${format.syntax} grammar:\n${format.definition}`;
        } else if (format.type !== "text") reject("Unsupported custom tool format");
      }
    }
    catalog.set(alias, { type: "function", function: { name: alias, description, responseTool: identity, ...(parameters ? { parameters } : {}) } });
  };
  for (const source of tools) {
    const tool = record(source);
    if (tool.type !== "namespace") { declare(tool); continue; }
    const group = name(tool.name);
    if (!Array.isArray(tool.tools)) reject("Namespace tools must be a list");
    if (tool.description !== undefined && typeof tool.description !== "string") reject("Namespace description must be text");
    for (const child of tool.tools) declare(child, group, tool.description as string | undefined);
  }
  return [...catalog.values()];
}

export function normalizeResponsesToolChoice(choice: ResponsesRequest["tool_choice"]): OpenAIChatRequest["tool_choice"] {
  if (choice === undefined) return;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  const selection = record(choice);
  if (selection.type === "function" && selection.function !== undefined) return { type: "function", function: { name: name(record(selection.function).name) } };
  if (selection.type !== "function" && selection.type !== "custom") reject("Unsupported Responses tool_choice");
  return { type: "function", function: { name: named(selection) } };
}

export function responsesToChatRequest(request: ResponsesRequest): OpenAIChatRequest {
  const tools = normalizeResponsesTools(request.tools);
  const tool_choice = normalizeResponsesToolChoice(request.tool_choice);
  if (tool_choice === "required" && !tools.length) reject("Required tool is not in the catalog");
  if (typeof tool_choice === "object" && !tools.find(tool => tool.function.name === tool_choice.function.name)) reject("Required tool is not in the catalog");
  const messages = responsesInputToMessages(request.input);
  if (request.instructions !== undefined) {
    if (typeof request.instructions !== "string") reject("instructions must be text");
    if (request.instructions) messages.splice(0, 0, { content: request.instructions, role: "system" });
  }
  return { messages, tools, tool_choice, model: request.model };
}
