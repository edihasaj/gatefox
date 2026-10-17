import type { OpenAIChatMessage, OpenAIChatRequest, OpenAITool, ResponsesMessageItem, ResponsesRequest, ResponsesTool, ResponseToolIdentity, MessagePart } from "./types.js";
import { inlineImage } from "./images.js";
import { telemetry } from "../telemetry.js";

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
/**
 * `toolSearch` is set only for the Codex subscription route, which forwards the `tool_search` tool and the
 * `tool_search_call` / `tool_search_output` items to the ChatGPT backend unchanged. Every other route
 * rejects them as unsupported.
 */
export interface TranslationOptions { toolSearch?: boolean;
  /** Record `tool_declarations_merged` for this translation. The server sets it on its one validation pass, so a request is reported once. */
  reportMerges?: boolean }
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

/** Replay is compiled in order; opaque reasoning is never treated as text. */
export function responsesInputToMessages(input: ResponsesRequest["input"], options: TranslationOptions = {}): OpenAIChatMessage[] {
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
      // Search items replay as the client sent them; the Codex route forwards them without translation.
      case "tool_search_call": case "tool_search_output":
        if (!options.toolSearch) reject("Unsupported Responses input item type", "unsupported_input_item", translationItemType(item.type));
        break;
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
export function normalizeResponsesTools(tools: ResponsesTool[] = [], options: TranslationOptions = {}): OpenAITool[] {
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
  for (const source of tools) {
    const tool = record(source);
    if (options.toolSearch && tool.type === "tool_search") continue;
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

/** One declared tool, as the merge sees it: the tool itself, the namespace it came from (if any), and how it ranks. */
interface Declaration { tool: unknown; group?: { source: Data; name: string }; rank: number; text: string }
const topLevelRank = 2 ** 30;
/** Key order must not make two equal definitions look different. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => inner !== null && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner as Data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner);
}
/** Identity of a declaration: its catalog name for function and custom tools, its type for the rest. Undefined when malformed, so validation reports it. */
function declarationKey(tool: unknown, group?: string): string | undefined {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return;
  const source = tool as Data;
  if (source.type === "function" || source.type === "custom") {
    const definition = source.type === "function" && source.function !== undefined ? source.function : source;
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) return;
    const local = (definition as Data).name;
    if (typeof local !== "string" || !local.trim()) return;
    return `name:${group && group !== "functions" ? `${group}.${local}` : local}`;
  }
  return typeof source.type === "string" && source.type !== "namespace" ? `type:${source.type}` : undefined;
}
/**
 * Merge repeated declarations by identity. A request's own top-level tools win over history, a later `additional_tools`
 * item over an earlier one, and a later entry of one list over an earlier one. Position follows the first declaration.
 */
function mergeDeclarations(lists: Array<{ tools: unknown[]; top: boolean }>): { tools: ResponsesTool[]; replaced: number; identical: number } {
  const merged = new Map<string, Declaration>();
  let replaced = 0, identical = 0, sequence = 0;
  const add = (key: string | undefined, entry: Omit<Declaration, "rank">, top: boolean) => {
    const rank = (top ? topLevelRank : 0) + sequence++;
    const id = key ?? `unkeyed:${sequence}`;
    const known = merged.get(id);
    if (!known) { merged.set(id, { ...entry, rank }); return; }
    if (known.text === entry.text) identical++; else replaced++;
    if (rank > known.rank) merged.set(id, { ...entry, rank });
  };
  for (const { tools, top } of lists) for (const tool of tools) {
    const group = tool !== null && typeof tool === "object" && !Array.isArray(tool) && (tool as Data).type === "namespace" ? tool as Data : undefined;
    if (!group || typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.tools) || !group.tools.length) { add(declarationKey(tool), { tool, text: stable(tool) }, top); continue; }
    const description = typeof group.description === "string" ? group.description : "";
    for (const child of group.tools) add(declarationKey(child, group.name), { tool: child, group: { source: group, name: group.name }, text: `${description}\0${stable(child)}` }, top);
  }
  const tools: ResponsesTool[] = [], namespaces = new Map<string, Data & { tools: unknown[] }>();
  for (const { tool, group } of merged.values()) {
    if (!group) { tools.push(tool as ResponsesTool); continue; }
    // Children keep the description of the namespace they were declared in, so one namespace name can appear more than once.
    const slot = `${group.name}\0${String(group.source.description ?? "")}`;
    let namespace = namespaces.get(slot);
    if (!namespace) { namespace = { ...group.source, tools: [] }; namespaces.set(slot, namespace); tools.push(namespace as unknown as ResponsesTool); }
    namespace.tools.push(tool);
  }
  return { tools, replaced, identical };
}

/**
 * Tools a request declares, at the top level and in Responses lite `additional_tools` input items, with repeated
 * declarations merged: the current top-level list wins over history, and a later declaration wins over an earlier one.
 * Merging is silent apart from the counts in the `tool_declarations_merged` event, which carries no names or definitions
 * and is recorded only when the caller asks (`reportMerges`), so one request is never reported twice.
 */
export function declaredResponsesTools(request: ResponsesRequest, options: Pick<TranslationOptions, "reportMerges"> = {}): ResponsesTool[] {
  const lifted = Array.isArray(request.input) ? request.input.flatMap(source => {
    const item = record(source);
    if (item.type !== "additional_tools") return [];
    if (!Array.isArray(item.tools)) reject("additional_tools must contain a tool list", "invalid_shape");
    return item.tools as ResponsesTool[];
  }) : [];
  if (request.tools !== undefined && request.tools !== null && !Array.isArray(request.tools)) reject("tools must be an array", "invalid_shape");
  const result = mergeDeclarations([{ tools: request.tools ?? [], top: true }, { tools: lifted, top: false }]);
  if (options.reportMerges && (result.replaced || result.identical)) telemetry("tool_declarations_merged", { replaced: result.replaced, identical: result.identical });
  return result.tools;
}

export function responsesToChatRequest(request: ResponsesRequest, options: TranslationOptions = {}): OpenAIChatRequest {
  const declared = declaredResponsesTools(request, options);
  const tools = normalizeResponsesTools(declared, options);
  const tool_choice = normalizeResponsesToolChoice(request.tool_choice);
  if (tool_choice === "required" && !tools.length && !(options.toolSearch && declared.some(tool => tool.type === "tool_search"))) reject("Required tool is not in the catalog", "unsupported_tool_choice");
  if (typeof tool_choice === "object" && !tools.find(tool => tool.function.name === tool_choice.function.name)) reject("Required tool is not in the catalog", "unsupported_tool_choice");
  const messages = responsesInputToMessages(request.input, options);
  if (request.instructions !== undefined) {
    if (typeof request.instructions !== "string") reject("instructions must be text", "invalid_instructions");
    if (request.instructions) messages.splice(0, 0, { content: request.instructions, role: "system" });
  }
  return { messages, tools, tool_choice, model: request.model };
}
