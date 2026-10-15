import type { ChatToolSelection, OpenAITool } from "../protocol/types.js";
import { claudeToolName } from "./claude-tool-names.js";
import { itemText, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";

/** What the caller's history looks like to Copilot, shared by the live seed and the one-shot fallback. */

export interface NativeTool { name: string; tool: OpenAITool }

/**
 * The caller's tools under the names the CLI sees: `tool_<local>_<hash>`, derived from each tool's identity so a
 * reordered catalog gives the same names. Sorted by name, so the system message and the tool list (and with them
 * the session fingerprint) do not depend on catalog order either. A repeated identity is one tool.
 */
export function nativeCatalog(tools: OpenAITool[]): NativeTool[] {
  const byName = new Map<string, OpenAITool>();
  for (const tool of tools) { const name = claudeToolName(tool); if (!byName.has(name)) byName.set(name, tool); }
  return [...byName].map(([name, tool]) => ({ name, tool })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const guidance = "You are an inference backend. Respect the caller instructions below and any system/developer items in the conversation. Use only supplied caller-dispatched tools. The caller executes actions and supplies results. Never execute native tools, spawn agents, or invent tool-call text. Otherwise answer normally.";

/**
 * The session's system message. It is fixed for the session's life, so the caller's leading system and developer
 * content and the tool names live here, and the history arrives as one user message per item.
 */
export function copilotSystem(caller: string[], catalog: NativeTool[]): string {
  return [
    guidance,
    `Tool names: ${JSON.stringify(catalog.map(({ name, tool }) => ({ caller: tool.function.name, native: name })))}`,
    "Conversation items arrive as user messages, oldest first, one item per message. Each message starts with an <<item>> header line and ends with a <</item>> line; everything between them is the item's exact content. Results of your tool calls arrive as tool results.",
    ...caller.filter(Boolean).map((text, index) => index === 0 ? `Caller instructions:\n${text}` : text),
  ].join("\n\n");
}

/** The tools as `session.create` takes them: every one answered by the caller, never deferred behind the CLI's tool search. */
export const nativeTools = (catalog: NativeTool[]) => catalog.map(({ name, tool }) => ({ name, description: `Caller tool ${tool.function.name}. ${tool.function.description || ""}`,
  parameters: tool.function.parameters || { type: "object", properties: {} }, skipPermission: true, defer: "never" }));

/** The final instruction for a forced, required or disabled tool choice; the catalog itself never changes. */
export function choiceLine(choice: ChatToolSelection | undefined, catalog: NativeTool[]): string | undefined {
  if (choice === "none") return "Do not call any caller tool; answer directly.";
  if (choice === "required") return "Use one of the caller tools.";
  if (typeof choice !== "object") return;
  const native = catalog.find(({ tool }) => tool.function.name === choice.function.name)?.name;
  return `Use the required caller tool ${native ?? choice.function.name}.`;
}

export interface Attachment { type: "blob"; data: string; mimeType: string; displayName: string }
export interface Prompt { prompt: string; attachments?: Attachment[] }
type Item = ClaudeConversation[number];

/** Images by the index of the conversation item that owns them (labels name item and part, 1-based). */
export function imagesByItem(images: ClaudeImages): Map<number, ClaudeImages> {
  const byItem = new Map<number, ClaudeImages>();
  for (const entry of images) {
    const index = Number(/^conversation-message-(\d+)-part-/.exec(entry.label)?.[1]) - 1;
    byItem.set(index, [...(byItem.get(index) || []), entry]);
  }
  return byItem;
}

/**
 * One user message per conversation item from `from`, oldest first, with each item's images as attachments and the
 * choice line closing the last message. Item numbers count from the start of the conversation, so a continuation
 * numbers its items the way a seed would have.
 */
export function copilotPrompts(conversation: ClaudeConversation, images: ClaudeImages, from: number, line?: string): Prompt[] {
  const owned = imagesByItem(images);
  const prompts: Prompt[] = conversation.slice(from).map((item, offset) => {
    const attachments = (owned.get(from + offset) || []).map(({ label, image }): Attachment => ({ type: "blob", data: image.data, mimeType: image.mediaType, displayName: label }));
    return { prompt: itemText(item, from + offset + 1), ...(attachments.length ? { attachments } : {}) };
  });
  if (!prompts.length) prompts.push({ prompt: "(the conversation has no items)" });
  if (line) prompts[prompts.length - 1].prompt += `\n${line}`;
  return prompts;
}

export interface ToolResult { textResultForLlm: string; resultType: "success"; binaryResultsForLlm?: Array<{ type: "image"; data: string; mimeType: string }> }

/** A caller's tool output for `session.tools.handlePendingToolCall`: a string, or text plus the images the output carried. An empty output gets a placeholder so the pending request is still answered. */
export function copilotToolResult(item: Item, images: ClaudeImages = []): string | ToolResult {
  const text = item.content || "(no output)";
  if (!images.length) return text;
  return { textResultForLlm: text, resultType: "success", binaryResultsForLlm: images.map(({ image }) => ({ type: "image", data: image.data, mimeType: image.mediaType })) };
}
