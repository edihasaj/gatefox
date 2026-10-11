import { object, type Message } from "./app-server-connection.js";

export const titleTool = "gateway_chat_title";
export function withTitleTool(params: Message): Message {
  const tools = Array.isArray(params.dynamicTools) ? params.dynamicTools : [];
  if (tools.some(tool => object(tool).name === titleTool)) throw new Error("The gateway chat-title tool name is reserved");
  return { ...params, dynamicTools: [...tools, { type: "function", name: titleTool,
    description: "Read or rename only the current chat's saved title. Read the current name before renaming. Use a short descriptive title for the task, respecting deliberate user titles.",
    inputSchema: { type: "object", properties: { operation: { type: "string", enum: ["read", "rename"] }, title: { type: "string" } }, required: ["operation"], additionalProperties: false } }] };
}
export async function handleTitleCall(params: Message, request: (method: string, params: Message) => Promise<Message>): Promise<Message> {
  const args = object(params.arguments);
  if (typeof params.threadId !== "string" || Object.keys(args).some(key => !["operation", "title"].includes(key)) || !["read", "rename"].includes(String(args.operation))) throw new Error("Invalid current-chat title request");
  if (args.operation === "rename") {
    if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 120 || /[\x00-\x1f\x7f]/.test(args.title)) throw new Error("Chat titles require 1 through 120 printable characters");
    await request("thread/name/set", { threadId: params.threadId, name: args.title.trim() });
  }
  const thread = object((await request("thread/read", { threadId: params.threadId, includeTurns: false })).thread);
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ name: thread.name ?? null }) }] };
}
