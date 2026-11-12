import type { ChatToolSelection, OpenAIChatMessage, OpenAITool, OpenAIToolCall } from "../protocol/types.js";
import type { imageConversation } from "../protocol/images.js";
import { claudeNativeToolName, claudeToolBindings } from "./claude-tool-names.js";

export type ContentBlock = Record<string, unknown>;
export type ReplayFormat = "text" | "json";
export type ClaudeConversation = ReturnType<typeof imageConversation>["conversation"];
export type ClaudeImages = ReturnType<typeof imageConversation>["images"];
type Item = ClaudeConversation[number];

const preamble: Record<ReplayFormat, string> = {
  text: "Conversation items follow, oldest first, one per block. Each block's first line is its <<item>> header and its last line is <</item>>; everything between them is the item's exact content.",
  json: "Conversation items follow, oldest first, one JSON item per block.",
};

/**
 * Block 0 plus one block per conversation item. Claude reuses its prompt cache
 * only for unchanged leading content blocks, so rendering is deterministic and
 * append-only: rendering items 0..n-1 gives a prefix of rendering 0..n.
 */
export function renderConversation(conversation: ClaudeConversation, images: ClaudeImages, format: ReplayFormat): ContentBlock[] {
  return [{ type: "text", text: preamble[format] }, ...renderItems(conversation, images, 0, format)];
}

/** Items from index `from` onward, each followed by its attached images. */
export function renderItems(conversation: ClaudeConversation, images: ClaudeImages, from: number, format: ReplayFormat): ContentBlock[] {
  return renderSelected(conversation, images, conversation.slice(from).map((_item, offset) => from + offset), format);
}

/** The content blocks of exactly these conversation indices, each labeled and with its images as `renderItems` would. */
export function renderSelected(conversation: ClaudeConversation, images: ClaudeImages, indices: number[], format: ReplayFormat): ContentBlock[] {
  const attached = new Map<number, ContentBlock[]>();
  for (const { label, image } of images) {
    const index = Number(/^conversation-message-(\d+)-part-/.exec(label)?.[1]) - 1;
    attached.set(index, [...(attached.get(index) || []), { type: "text", text: `Attached image ${label}:` }, { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }]);
  }
  return indices.filter(index => index >= 0 && index < conversation.length).flatMap(index => {
    const item = conversation[index];
    // The custom-call mark is a gateway annotation; JSON replay keeps today's exact items.
    const own = format === "json" ? [{ type: "text", text: JSON.stringify(item, (key, value) => key === "responseTool" ? undefined : value) }] : textBlocks(item, index + 1);
    return [...own, ...(attached.get(index) || [])];
  });
}

/**
 * How many leading messages (the caller's instructions, then system and developer messages
 * before the first other message) move into the CLI's system prompt. Later developer messages
 * stay in the history, and a history with nothing else keeps them all.
 */
export function leadingInstructions(messages: OpenAIChatMessage[]): number {
  const count = messages.findIndex(message => message.role !== "system" && message.role !== "developer");
  return count < 0 ? 0 : count;
}

/** The final instruction for a forced or required tool choice, if any. */
export function choiceBlock(choice: ChatToolSelection | undefined, tools: OpenAITool[]): ContentBlock | undefined {
  if (choice === "required") return { type: "text", text: "Use one of the caller tools." };
  if (typeof choice !== "object") return;
  const tool = tools.find(tool => tool.function.name === choice.function.name);
  return { type: "text", text: `Use the required caller tool ${tool ? claudeNativeToolName(tool) : choice.function.name}.` };
}

/** Marks replayed calls of custom caller tools, so text replay shows their raw input instead of a JSON wrapper. */
export function markCustomCalls(messages: OpenAIChatMessage[], tools: OpenAITool[]): OpenAIChatMessage[] {
  const bindings = claudeToolBindings(tools, true);
  return messages.map(message => !message.tool_calls ? message : { ...message, tool_calls: message.tool_calls.map(call => {
    const source = bindings.get(call.function.name)?.function.responseTool;
    return source?.type === "custom" ? { ...call, responseTool: source } : call;
  }) });
}

// Header fields are bounded printable tokens; anything else is JSON-quoted so it cannot add a line.
const field = (value: unknown) => typeof value === "string" && /^[\x21-\x7e]+$/.test(value) ? value : JSON.stringify(String(value ?? ""));
// Escaping is reversible: a body line that could read as a header or a closing line gains one backslash.
const escape = (text: string) => text.replace(/^(\\*)(<<item |<<\/item>>)/gm, "\\$1$2");
// The closing line keeps every block ending in a non-space character. Claude never reuses a cached
// prefix whose last block ends in whitespace once more blocks follow, and tool output ends in "\n".
const block = (header: string, body: string): ContentBlock => ({ type: "text", text: `<<item ${header}>>\n${escape(body)}\n<</item>>` });

/**
 * One conversation item in the text format as a single string: its blocks joined by newlines.
 * Copilot sends each item as one user message, so both providers share one encoding.
 */
export function itemText(item: Item, number: number): string { return textBlocks(item, number).map(block => String(block.text)).join("\n"); }

/** An item with images keeps its text once, from its parts, with each image at its place. */
function body(item: Item): string {
  if (!item.parts) return item.content ?? "";
  return item.parts.map(part => "label" in part ? `[Attached image ${part.label}]` : part.type === "text" ? part.text : "").join("\n");
}
function callInput(call: OpenAIToolCall): string {
  if (call.responseTool?.type !== "custom") return call.function.arguments;
  try { const input = (JSON.parse(call.function.arguments) as { input?: unknown }).input; if (typeof input === "string") return input; } catch { /* Keep the exact arguments. */ }
  return call.function.arguments;
}
function textBlocks(item: Item, number: number): ContentBlock[] {
  if (item.role === "tool") return [block(`${number} tool_result ${field(item.tool_call_id)}`, body(item))];
  if (!item.tool_calls?.length) return [block(`${number} ${item.reasoningSummary ? "reasoning_summary" : item.role}`, body(item))];
  return [...(item.content || item.parts ? [block(`${number} ${item.role}`, body(item))] : []),
    ...item.tool_calls.map(call => block(`${number} tool_call ${field(call.function.name)} ${field(call.id)}`, callInput(call)))];
}
