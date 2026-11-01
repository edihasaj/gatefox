import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatToolSelection, OpenAITool } from "../protocol/types.js";
import { claudeToolBindings, claudeToolName } from "./claude-tool-names.js";
import { itemText, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";
import { ProviderError } from "./provider.js";
import { canonicalSchema } from "./tool-catalog.js";

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
    "Request tools by their native names in the current declarations. Historical tool calls do not declare tools.",
    "Conversation items arrive as user messages, oldest first, one item per message. Each message starts with an <<item>> header line and ends with a <</item>> line; everything between them is the item's exact content. Results of your tool calls arrive as tool results.",
    ...caller.filter(Boolean).map((text, index) => index === 0 ? `Caller instructions:\n${text}` : text),
  ].join("\n\n");
}

/** The tools as `session.create` takes them: every one answered by the caller, never deferred behind the CLI's tool search. */
export const nativeTools = (catalog: NativeTool[]) => catalog.map(({ name, tool }) => ({ name, description: `Caller tool ${tool.function.name}. ${tool.function.description || ""}`,
  parameters: canonicalSchema(tool.function.parameters || { type: "object", properties: {} }), skipPermission: true, defer: "never" }));

/** The final instruction for a forced, required or disabled tool choice; the catalog itself never changes. */
export function choiceLine(choice: ChatToolSelection | undefined, catalog: NativeTool[]): string | undefined {
  if (choice === "none") return "Do not call any caller tool; answer directly.";
  if (choice === "required") return "Use one of the caller tools.";
  if (typeof choice !== "object") return;
  const native = catalog.find(({ tool }) => tool.function.name === choice.function.name)?.name;
  return `Use the required caller tool ${native ?? choice.function.name}.`;
}

export interface Attachment { type: "file"; path: string; displayName: string }
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

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Writes one image (0600) into the `images` folder of the CLI's private folder and returns it as a `file` attachment.
 * Images never travel inline in a prompt: one RPC message is limited to 16 MiB, and a few screenshots pass that.
 * The folder goes with the CLI's folder, so no image outlives the session. `images` is created without `recursive`, which would
 * also recreate the CLI's own folder: once that is removed (the session ended), staging fails instead of leaving a folder behind.
 */
async function stage(directory: string, { label, image }: ClaudeImages[number]): Promise<Attachment> {
  const folder = join(directory, "images"); const path = join(folder, `${label}.${extensions[image.mediaType] ?? "img"}`);
  try {
    await mkdir(folder, { mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
    await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
  } catch { throw new ProviderError("cli_failed", "Copilot image attachment could not be written"); }
  return { type: "file", path, displayName: label };
}

/**
 * One user message per conversation item from `from`, oldest first, with each item's images as file attachments in
 * `directory` (the CLI's private folder) and the choice line closing the last message. Item numbers count from the
 * start of the conversation, so a continuation numbers its items the way a seed would have.
 * `stopped` is asked before each image is written: once it says yes the rendering fails as cancelled, so a request that ended
 * (and whose folder is about to be removed) never keeps writing into it.
 */
export async function copilotPrompts(conversation: ClaudeConversation, images: ClaudeImages, from: number, line: string | undefined, directory: string, catalog: NativeTool[], stopped: () => boolean = () => false): Promise<Prompt[]> {
  const owned = imagesByItem(images);
  const bindings = claudeToolBindings(catalog.map(({ tool }) => tool));
  const prompts: Prompt[] = [];
  for (const [offset, item] of conversation.slice(from).entries()) {
    const attachments: Attachment[] = [];
    for (const image of owned.get(from + offset) || []) {
      if (stopped()) throw new ProviderError("cancelled", "Request cancelled", 499);
      attachments.push(await stage(directory, image));
    }
    // Render declared historical calls with the same names as the CLI's tool declarations. Keep the caller's
    // conversation untouched: the live ledger and returned calls use its original identities.
    const replay = item.tool_calls ? { ...item, tool_calls: item.tool_calls.map(call => {
      const tool = bindings.get(call.function.name);
      return tool ? { ...call, function: { ...call.function, name: claudeToolName(tool) } } : call;
    }) } : item;
    prompts.push({ prompt: itemText(replay, from + offset + 1), ...(attachments.length ? { attachments } : {}) });
  }
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

/**
 * The largest tool result with images that is handed to a waiting call inline (its images can only travel as base64
 * there). It stays well below the 16 MiB limit of one RPC message; a larger one starts the thread over, where the
 * images become file attachments.
 */
export const inlineResultBytes = 12 * 1024 * 1024;
export const fitsInline = (result: string | ToolResult): boolean => typeof result === "string" || Buffer.byteLength(JSON.stringify(result)) <= inlineResultBytes;
