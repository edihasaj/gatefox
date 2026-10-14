import type { OpenAIChatMessage, OpenAIChatRequest, OpenAITool, ResponsesHostedWebSearchTool, ResponsesMessageItem, ResponsesRequest, ResponsesTool, ResponseToolIdentity, MessagePart } from "./types.js";
import { inlineImage } from "./images.js";

type Data = Record<string, unknown>;
/** Why a request could not be translated. Fixed values only; never caller text. */
export type TranslationReason = "invalid_shape" | "unsupported_input_item" | "unsupported_content" | "unsupported_role" |
  "invalid_tool_call" | "unsupported_tool" | "duplicate_tool" | "unsupported_tool_choice" | "invalid_image" |
  "invalid_reasoning_state" | "invalid_instructions" | "invalid_provider_output";
const translationReasonNames: TranslationReason[] = ["invalid_shape", "unsupported_input_item", "unsupported_content", "unsupported_role", "invalid_tool_call",
  "unsupported_tool", "duplicate_tool", "unsupported_tool_choice", "invalid_image", "invalid_reasoning_state", "invalid_instructions", "invalid_provider_output"] as const;
/** Item and tool type names a diagnostic may carry. Anything else reports as `other`. */
const translationItemNames = ["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning",
  "additional_tools", "agent_message", "item_reference", "compaction", "web_search_call", "file_search_call", "computer_call",
  "computer_call_output", "image_generation_call", "code_interpreter_call", "local_shell_call", "local_shell_call_output", "mcp_call",
  "mcp_list_tools", "mcp_approval_request", "mcp_approval_response", "tool_search_call", "tool_search_output", "function", "custom",
  "namespace", "web_search", "web_search_preview", "file_search", "computer_use_preview", "computer_use", "image_generation",
  "code_interpreter", "local_shell", "mcp", "tool_search", "shell", "apply_patch"] as const;
export type TranslationItemType = (typeof translationItemNames)[number] | "other";
export const translationReasons: ReadonlySet<string> = new Set<string>(translationReasonNames);
export const translationItemTypes: ReadonlySet<string> = new Set<string>([...translationItemNames, "other"]);
/** Reduce an arbitrary caller discriminator to the fixed allowlist. */
export function translationItemType(value: unknown): TranslationItemType {
  return typeof value === "string" && translationItemTypes.has(value) ? value as TranslationItemType : "other";
}
export class ResponsesTranslationError extends Error {
  constructor(message: string, readonly reason: TranslationReason, readonly itemType?: string) { super(message); }
}
function reject(message: string, reason: TranslationReason, itemType?: string): never { throw new ResponsesTranslationError(message, reason, itemType); }
function record(value: unknown): Data {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("Expected an object in the Responses request", "invalid_shape");
  return value as Data;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) reject("Tool names and call IDs must be non-empty strings", "invalid_shape");
  return value;
}
function named(value: Data): string {
  const local = name(value.name);
  return value.namespace === undefined ? local : `${name(value.namespace)}.${local}`;
}
function content(value: unknown, allowImages = false): Pick<OpenAIChatMessage, "content" | "parts"> {
  if (typeof value === "string") return { content: value };
  if (!Array.isArray(value)) reject("Only string or content-part arrays are supported", "unsupported_content");
  const paragraphs: string[] = [];
  const parts: MessagePart[] = []; let images = 0;
  for (const entry of value) {
    const part = record(entry);
    if (part.type === "input_image" && allowImages) { parts.push(inlineImage(part.image_url, part.detail)); paragraphs.push(`[Image ${++images} attached]`); continue; }
    if ((part.type !== "input_text" && part.type !== "output_text") || typeof part.text !== "string") reject("Only text content is supported by this adapter", "unsupported_content");
    paragraphs.push(part.text); parts.push({ type: "text", text: part.text });
  }
  return { content: paragraphs.join("\n"), ...(images ? { parts } : {}) };
}

/** Encrypted agent-message parts stay opaque: only they are dropped. Anything else reaches `content`, which rejects it. */
function agentMessageContent(value: unknown): unknown {
  if (typeof value === "string" || !Array.isArray(value)) return value;
  return value.filter(part => !(part !== null && typeof part === "object" && !Array.isArray(part) && (part as Data).type === "encrypted_content"));
}

/** The one user-text form of an agent_message, shared by translated and Responses routes. Undefined when no text remains. */
export function agentMessageInput(item: Record<string, unknown>): ResponsesMessageItem | undefined {
  const text = content(agentMessageContent(item.content)).content;
  return text ? { type: "message", role: "user", content: [{ type: "input_text", text }] } : undefined;
}

const searchToolKeys = new Set(["type", "external_web_access", "indexed_web_access", "filters", "user_location", "search_context_size", "search_content_types"]);
const boundedText = (value: unknown, limit = 256) => typeof value === "string" && value.length <= limit && !value.includes("\0");
/**
 * Codex's hosted web_search tool, checked key by key. The object itself is forwarded untouched,
 * so this only decides whether the gateway may carry it; it never rewrites a field.
 */
function checkHostedWebSearch(tool: Data): void {
  const bad = () => reject("Unsupported web_search tool declaration", "unsupported_tool", "web_search");
  if (Object.keys(tool).some(key => !searchToolKeys.has(key))) bad();
  for (const key of ["external_web_access", "indexed_web_access"]) if (tool[key] !== undefined && typeof tool[key] !== "boolean") bad();
  if (tool.search_context_size !== undefined && !["low", "medium", "high"].includes(String(tool.search_context_size))) bad();
  if (tool.search_content_types !== undefined && (!Array.isArray(tool.search_content_types) || tool.search_content_types.length > 2 ||
    tool.search_content_types.some(kind => kind !== "text" && kind !== "image"))) bad();
  if (tool.filters !== undefined) {
    const filters = tool.filters; if (filters === null || typeof filters !== "object" || Array.isArray(filters)) bad();
    const { allowed_domains: domains, ...rest } = filters as Data;
    if (Object.keys(rest).length || (domains !== undefined && (!Array.isArray(domains) || domains.length > 100 || domains.some(entry => !boundedText(entry))))) bad();
  }
  if (tool.user_location !== undefined) {
    const place = tool.user_location; if (place === null || typeof place !== "object" || Array.isArray(place)) bad();
    for (const [key, value] of Object.entries(place as Data)) if (!["type", "country", "region", "city", "timezone"].includes(key) || !boundedText(value)) bad();
    if ((place as Data).type !== undefined && (place as Data).type !== "approximate") bad();
  }
}
function isHostedWebSearch(source: unknown): source is ResponsesHostedWebSearchTool {
  return source !== null && typeof source === "object" && !Array.isArray(source) && (source as Data).type === "web_search";
}
/** The hosted web_search declaration of a request, exactly as the caller sent it. At most one is allowed. */
export function hostedWebSearch(request: ResponsesRequest): ResponsesHostedWebSearchTool | undefined {
  const found = declaredResponsesTools(request).filter(isHostedWebSearch);
  if (found.length > 1) reject("Only one web_search tool is allowed", "duplicate_tool", "web_search");
  return found[0];
}
/** A replayed web_search_call item reduced to the fields a translated route can use. */
function webSearchCall(item: Data): NonNullable<OpenAIChatMessage["webSearch"]> {
  const id = item.id;
  if (typeof id !== "string" || !id || id.length > 1024 || id.includes("\0") || typeof item.status !== "string" || item.status.length > 64) reject("Invalid web_search_call item", "unsupported_input_item", "web_search_call");
  let action: Record<string, unknown> | undefined;
  if (item.action !== undefined) {
    if (item.action === null || typeof item.action !== "object" || Array.isArray(item.action) || JSON.stringify(item.action).length > 16 * 1024) reject("Invalid web_search_call action", "unsupported_input_item", "web_search_call");
    action = item.action as Record<string, unknown>;
  }
  return { id: id as string, status: item.status as string, ...(action ? { action } : {}) };
}

export interface ReplayOptions {
  /** Keep replayed hosted web_search_call items as neutral messages instead of skipping them. */
  hostedReplay?: boolean;
}
/** Replay is compiled in order; opaque reasoning is never treated as text. */
export function responsesInputToMessages(input: ResponsesRequest["input"], options: ReplayOptions = {}): OpenAIChatMessage[] {
  if (typeof input === "string") return [{ content: input, role: "user" }];
  if (!Array.isArray(input)) reject("input must be text or a list of Responses items", "invalid_shape");
  const replay: OpenAIChatMessage[] = [];
  const issued = new Map<string, string>();
  for (const source of input) {
    const item = record(source);
    switch (item.type) {
      case "function_call": case "custom_tool_call": {
        const id = name(item.call_id); const tool = named(item);
        const raw = item.type === "custom_tool_call" ? item.input : item.arguments;
        if (typeof raw !== "string") reject("Tool call input must be a string", "invalid_tool_call");
        issued.set(id, tool);
        replay.push({ role: "assistant", content: null, tool_calls: [{ type: "function", id,
          function: { name: tool, arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: raw }) : raw } }] });
        break;
      }
      case "function_call_output": case "custom_tool_call_output": {
        const id = name(item.call_id);
        replay.push({ ...content(item.output, true), role: "tool", tool_call_id: id, name: item.name === undefined ? issued.get(id) : named(item) });
        break;
      }
      case "reasoning": {
        if (item.summary === undefined) break;
        if (!Array.isArray(item.summary)) reject("Reasoning summary must be a list", "invalid_reasoning_state");
        const summary = item.summary.map(value => {
          const part = record(value);
          if (part.type !== "summary_text" || typeof part.text !== "string") reject("Reasoning summary must contain summary text", "invalid_reasoning_state");
          return part.text;
        }).join("\n");
        if (summary) replay.push({ content: summary, role: "assistant" });
        break;
      }
      // Responses lite declares tools inside the input; they join the tool catalog, not the transcript.
      case "additional_tools": break;
      // A hosted search the provider ran earlier. Routes without hosted search skip it; the item is
      // validated either way so a malformed one still fails before inference.
      case "web_search_call": {
        const call = webSearchCall(item);
        if (options.hostedReplay) replay.push({ role: "assistant", content: null, webSearch: call });
        break;
      }
      // Codex multi-agent replay: an agent's message to another agent. Its text is
      // the whole transcript content; encrypted parts are transport state, never text.
      case "agent_message": {
        const message = agentMessageInput(item);
        if (message) replay.push({ content: (message.content as Array<{ text: string }>)[0].text, role: "user" });
        break;
      }
      case undefined: case "message": {
        if (!["user", "assistant", "system", "developer"].includes(String(item.role))) reject("Unsupported message role", "unsupported_role", translationItemType(item.type));
        replay.push({ ...content(item.content, item.role === "user"), role: item.role as OpenAIChatMessage["role"] });
        break;
      }
      default: reject("Unsupported Responses input item type", "unsupported_input_item", translationItemType(item.type));
    }
  }
  return replay;
}

/** Compile a flat caller-tool catalog while retaining its original identities. */
export function normalizeResponsesTools(tools: ResponsesTool[] = []): OpenAITool[] {
  if (!Array.isArray(tools)) reject("tools must be an array", "invalid_shape");
  const catalog = new Map<string, OpenAITool>();
  const declare = (source: unknown, namespace?: string, groupDescription = "") => {
    const tool = record(source);
    if (tool.type !== "function" && tool.type !== "custom") reject("Unsupported Responses tool type", "unsupported_tool", translationItemType(tool.type));
    const definition = tool.type === "function" && tool.function !== undefined ? record(tool.function) : tool;
    const localName = name(definition.name); const alias = namespace ? `${namespace}.${localName}` : localName;
    if (catalog.has(alias)) reject("Duplicate tool name", "duplicate_tool");
    if (definition.description !== undefined && typeof definition.description !== "string") reject("Tool descriptions must be strings", "unsupported_tool", translationItemType(tool.type));
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
          if (!["lark", "regex"].includes(String(format.syntax)) || typeof format.definition !== "string") reject("Unsupported custom tool grammar", "unsupported_tool", "custom");
          description += `\nRequired ${format.syntax} grammar:\n${format.definition}`;
        } else if (format.type !== "text") reject("Unsupported custom tool format", "unsupported_tool", "custom");
      }
    }
    catalog.set(alias, { type: "function", function: { name: alias, description, responseTool: identity, ...(parameters ? { parameters } : {}) } });
  };
  let searches = 0;
  for (const source of tools) {
    const tool = record(source);
    // The hosted search tool is carried verbatim by the route that runs it; it is not a caller function.
    if (tool.type === "web_search") { checkHostedWebSearch(tool); if (++searches > 1) reject("Only one web_search tool is allowed", "duplicate_tool", "web_search"); continue; }
    if (tool.type !== "namespace") { declare(tool); continue; }
    const group = name(tool.name);
    if (!Array.isArray(tool.tools)) reject("Namespace tools must be a list", "unsupported_tool", "namespace");
    if (tool.description !== undefined && typeof tool.description !== "string") reject("Namespace description must be text", "unsupported_tool", "namespace");
    // `functions` is the Responses default namespace: its calls come back without a
    // namespace, exactly like top-level tools, so its tools are declared unprefixed.
    for (const child of tool.tools) declare(child, group === "functions" ? undefined : group, tool.description as string | undefined);
  }
  return [...catalog.values()];
}

export function normalizeResponsesToolChoice(choice: ResponsesRequest["tool_choice"]): OpenAIChatRequest["tool_choice"] {
  if (choice === undefined) return;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  const selection = record(choice);
  if (selection.type === "function" && selection.function !== undefined) return { type: "function", function: { name: name(record(selection.function).name) } };
  if (selection.type !== "function" && selection.type !== "custom") reject("Unsupported Responses tool_choice", "unsupported_tool_choice", translationItemType(selection.type));
  return { type: "function", function: { name: named(selection) } };
}

/** Tools a request declares, at the top level and in Responses lite `additional_tools` input items. */
export function declaredResponsesTools(request: ResponsesRequest): ResponsesTool[] {
  const lifted = Array.isArray(request.input) ? request.input.flatMap(source => {
    const item = record(source);
    if (item.type !== "additional_tools") return [];
    if (!Array.isArray(item.tools)) reject("additional_tools must contain a tool list", "invalid_shape");
    return item.tools as ResponsesTool[];
  }) : [];
  if (request.tools !== undefined && request.tools !== null && !Array.isArray(request.tools)) reject("tools must be an array", "invalid_shape");
  return [...(request.tools ?? []), ...lifted];
}

export function responsesToChatRequest(request: ResponsesRequest, options: ReplayOptions = {}): OpenAIChatRequest {
  const tools = normalizeResponsesTools(declaredResponsesTools(request));
  const tool_choice = normalizeResponsesToolChoice(request.tool_choice);
  if (tool_choice === "required" && !tools.length) reject("Required tool is not in the catalog", "unsupported_tool_choice");
  if (typeof tool_choice === "object" && !tools.find(tool => tool.function.name === tool_choice.function.name)) reject("Required tool is not in the catalog", "unsupported_tool_choice");
  const messages = responsesInputToMessages(request.input, options);
  if (request.instructions !== undefined) {
    if (typeof request.instructions !== "string") reject("instructions must be text", "invalid_instructions");
    if (request.instructions) messages.splice(0, 0, { content: request.instructions, role: "system" });
  }
  return { messages, tools, tool_choice, model: request.model };
}
